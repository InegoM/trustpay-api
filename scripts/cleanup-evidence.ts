import "dotenv/config";
import { createPrismaClient } from "../src/database/prisma.js";
import EvidenceService from "../src/evidence/evidence-service.js";
import PostgresTrustPayRepository from "../src/repositories/postgres-trustpay-repository.js";
import { AllowAllTestScanner } from "../src/storage/malware-scanner.js";
import S3ObjectStorage from "../src/storage/s3-object-storage.js";

const prisma = createPrismaClient();
const repository = new PostgresTrustPayRepository(prisma);
const storage = new S3ObjectStorage({
  bucket: process.env.STORAGE_BUCKET ?? "trustpay-evidence",
  endpoint: process.env.STORAGE_ENDPOINT ?? "http://127.0.0.1:59000",
  region: process.env.STORAGE_REGION ?? "me-central-1",
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "test",
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "test",
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== "false",
  ...(process.env.STORAGE_SERVER_SIDE_ENCRYPTION === "AES256" || process.env.STORAGE_SERVER_SIDE_ENCRYPTION === "aws:kms"
    ? { serverSideEncryption: process.env.STORAGE_SERVER_SIDE_ENCRYPTION }
    : {}),
});

try {
  const retentionHours = Number(process.env.ABANDONED_UPLOAD_RETENTION_HOURS ?? 24);
  if (!Number.isFinite(retentionHours) || retentionHours < 1) {
    throw new Error("ABANDONED_UPLOAD_RETENTION_HOURS must be at least 1");
  }
  const service = new EvidenceService(repository, storage, new AllowAllTestScanner());
  const result = await service.cleanupAbandoned(new Date(Date.now() - retentionHours * 60 * 60 * 1000));
  process.stdout.write(`Removed ${result.deleted} abandoned private evidence object(s).\n`);
} finally {
  await prisma.$disconnect();
}
