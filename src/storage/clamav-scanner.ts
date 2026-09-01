import { createConnection } from "node:net";
import type { MalwareScanner, MalwareScanResult } from "./malware-scanner.js";

interface ClamAvScannerOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export default class ClamAvScanner implements MalwareScanner {
  constructor(private readonly options: ClamAvScannerOptions) {}

  async scan(body: Buffer): Promise<MalwareScanResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      let response = "";
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Malware scan timed out"));
      }, this.options.timeoutMs ?? 15_000);

      const finish = (error?: Error) => {
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
      };

      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < body.byteLength; offset += chunkSize) {
          const chunk = body.subarray(offset, Math.min(offset + chunkSize, body.byteLength));
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(chunk.byteLength);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (!response.includes("\0")) return;
        clearTimeout(timeout);
        socket.end();
        if (response.includes(" FOUND")) return resolve("infected");
        if (response.includes(" OK")) return resolve("clean");
        reject(new Error("Malware scanner returned an unrecognized response"));
      });
      socket.on("end", () => {
        if (!response.includes("\0")) finish(new Error("Malware scanner closed before returning a result"));
      });
      socket.on("error", (error) => finish(error));
    });
  }
}
