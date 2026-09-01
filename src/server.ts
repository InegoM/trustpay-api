import "dotenv/config";
import createApp from "./app.js";
import { createPrismaClient } from "./database/prisma.js";
import PostgresTrustPayRepository from "./repositories/postgres-trustpay-repository.js";
import PostgresAuthService from "./auth/postgres-auth-service.js";
import EvidenceService from "./evidence/evidence-service.js";
import S3ObjectStorage from "./storage/s3-object-storage.js";
import ClamAvScanner from "./storage/clamav-scanner.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";
const storageEndpoint = process.env.STORAGE_ENDPOINT ?? (isProduction ? undefined : "http://127.0.0.1:59000");
if (isProduction && storageEndpoint && !storageEndpoint.startsWith("https://")) {
  throw new Error("A configured production object-storage endpoint must use HTTPS");
}

const prisma = createPrismaClient();
const repository = new PostgresTrustPayRepository(prisma);
const objectStorage = new S3ObjectStorage({
  bucket: process.env.STORAGE_BUCKET ?? "trustpay-evidence",
  region: process.env.STORAGE_REGION ?? "me-central-1",
  ...(storageEndpoint ? { endpoint: storageEndpoint } : {}),
  ...(storageEndpoint
    ? {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "test",
      }
    : {}),
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE
    ? process.env.STORAGE_FORCE_PATH_STYLE === "true"
    : Boolean(storageEndpoint),
  ...(process.env.STORAGE_SERVER_SIDE_ENCRYPTION === "AES256" || process.env.STORAGE_SERVER_SIDE_ENCRYPTION === "aws:kms"
    ? { serverSideEncryption: process.env.STORAGE_SERVER_SIDE_ENCRYPTION }
    : {}),
});
const app = await createApp({
  repository,
  authService: new PostgresAuthService(prisma),
  evidenceService: new EvidenceService(
    repository,
    objectStorage,
    new ClamAvScanner({
      host: process.env.CLAMAV_HOST ?? "127.0.0.1",
      port: Number(process.env.CLAMAV_PORT ?? 53310),
      timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS ?? 15_000),
    }),
  ),
  logger: true,
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:8443",
  secureCookies: process.env.NODE_ENV === "production",
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
