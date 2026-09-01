import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import ClamAvScanner from "./clamav-scanner.js";
import { sanitizeEvidenceImage, validateEvidenceFile } from "./file-validation.js";
import { InMemoryObjectStorage } from "./object-storage.js";
import S3ObjectStorage from "./s3-object-storage.js";

const servers: Array<ReturnType<typeof createServer> | ReturnType<typeof createHttpServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function scannerFor(response: string): Promise<ClamAvScanner> {
  const server = createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (request.length >= 4 && request.subarray(-4).equals(Buffer.alloc(4))) socket.end(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test scanner did not bind");
  return new ClamAvScanner({ host: "127.0.0.1", port: address.port, timeoutMs: 1_000 });
}

describe("evidence storage and validation", () => {
  it("keeps objects private behind the storage interface throughout copy and cleanup", async () => {
    const storage = new InMemoryObjectStorage();
    await storage.putObject("quarantine/one", Buffer.from("private"), "application/pdf");
    await storage.copyObject("quarantine/one", "evidence/one", "application/pdf");
    await storage.deleteObject("quarantine/one");
    expect(await storage.getObject("quarantine/one")).toBeNull();
    expect((await storage.getObject("evidence/one"))?.body.toString()).toBe("private");
    expect(await storage.listObjects("evidence/")).toMatchObject([{ key: "evidence/one" }]);
  });

  it("validates content signatures and removes image metadata", async () => {
    const original = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const validation = await validateEvidenceFile(original, "site.jpg", "image/jpeg");
    const sanitized = await sanitizeEvidenceImage(original, validation.detectedMimeType);
    const metadata = await sharp(sanitized).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects oversized files before processing content", async () => {
    await expect(validateEvidenceFile(Buffer.alloc(9), "large.pdf", "application/pdf", 8))
      .rejects.toMatchObject({ code: "EVIDENCE_FILE_TOO_LARGE", statusCode: 413 });
  });

  it("parses clean and infected ClamAV INSTREAM responses", async () => {
    await expect((await scannerFor("stream: OK\0")).scan(Buffer.from("clean"))).resolves.toBe("clean");
    await expect((await scannerFor("stream: Eicar-Test-Signature FOUND\0")).scan(Buffer.from("test"))).resolves.toBe("infected");
  });

  it("uses encrypted, private S3 operations through the adapter", async () => {
    const requests: Array<{ method?: string; path: string; headers: Record<string, string | string[] | undefined> }> = [];
    const server = createHttpServer(async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      requests.push({ method: request.method, path: request.url ?? "", headers: request.headers });
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && path.endsWith("/evidence/copied")) {
        response.writeHead(200, { "content-type": "application/pdf", "content-length": "7" });
        response.end("private");
        return;
      }
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end("<?xml version=\"1.0\"?><ListBucketResult><Contents><Key>evidence/copied</Key><LastModified>2026-08-31T12:00:00.000Z</LastModified></Contents></ListBucketResult>");
        return;
      }
      if (request.method === "PUT" && request.headers["x-amz-copy-source"]) {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end("<?xml version=\"1.0\"?><CopyObjectResult><LastModified>2026-08-31T12:00:00.000Z</LastModified><ETag>etag</ETag></CopyObjectResult>");
        return;
      }
      response.writeHead(200);
      response.end();
    });
    servers.push(server);
    server.on("checkContinue", (request, response) => {
      response.writeContinue();
      server.emit("request", request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test S3 server did not bind");
    const storage = new S3ObjectStorage({
      bucket: "trustpay-evidence",
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "me-central-1",
      accessKeyId: "test",
      secretAccessKey: "test",
      forcePathStyle: true,
      serverSideEncryption: "AES256",
    });

    await storage.putObject("quarantine/original", Buffer.from("private"), "application/pdf");
    await storage.copyObject("quarantine/original", "evidence/copied", "application/pdf");
    expect(await storage.getObject("evidence/copied")).toMatchObject({
      body: Buffer.from("private"), contentType: "application/pdf", sizeBytes: 7,
    });
    expect(await storage.listObjects("evidence/")).toMatchObject([{ key: "evidence/copied" }]);
    await storage.deleteObject("evidence/copied");

    const writeRequests = requests.filter((request) => request.method === "PUT");
    expect(writeRequests).toHaveLength(2);
    expect(writeRequests.every((request) => request.headers["x-amz-server-side-encryption"] === "AES256")).toBe(true);
    expect(writeRequests.every((request) => request.headers["x-amz-acl"] === undefined)).toBe(true);
    expect(writeRequests[1]?.headers["x-amz-copy-source"]).toBe("trustpay-evidence/quarantine/original");
  });
});
