import { extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { DomainError } from "../domain/errors.js";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_FILES_PER_SUBMISSION = 10;
export const DEFAULT_ORGANIZATION_STORAGE_BYTES = 500 * 1024 * 1024;

const allowedTypes = new Map([
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/png", new Set([".png"])],
  ["application/pdf", new Set([".pdf"])],
]);

export interface ValidatedFile {
  detectedMimeType: string;
  extension: string;
}

export async function validateEvidenceFile(
  body: Buffer,
  originalName: string,
  declaredMimeType: string,
  maximumBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
): Promise<ValidatedFile> {
  if (body.byteLength === 0) {
    throw new DomainError("The selected file is empty", 400, "EVIDENCE_FILE_EMPTY");
  }
  if (body.byteLength > maximumBytes) {
    throw new DomainError(
      `Files must be ${Math.floor(maximumBytes / 1024 / 1024)} MB or smaller`,
      413,
      "EVIDENCE_FILE_TOO_LARGE",
    );
  }
  const normalizedDeclaredType = declaredMimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  const extension = extname(originalName).toLowerCase();
  const allowedExtensions = allowedTypes.get(normalizedDeclaredType);
  if (!allowedExtensions?.has(extension)) {
    throw new DomainError(
      "Only JPEG, PNG, and PDF evidence files are accepted",
      415,
      "EVIDENCE_TYPE_NOT_ALLOWED",
    );
  }
  const detected = await fileTypeFromBuffer(body);
  if (!detected || detected.mime !== normalizedDeclaredType || !allowedExtensions.has(`.${detected.ext}`)) {
    throw new DomainError(
      "The file content does not match its filename and declared type",
      415,
      "EVIDENCE_TYPE_MISMATCH",
    );
  }
  return { detectedMimeType: detected.mime, extension };
}

export async function sanitizeEvidenceImage(
  body: Buffer,
  detectedMimeType: string,
): Promise<Buffer> {
  if (detectedMimeType === "application/pdf") return body;
  try {
    const pipeline = sharp(body, { failOn: "warning", limitInputPixels: 40_000_000 }).rotate();
    return detectedMimeType === "image/jpeg"
      ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer();
  } catch {
    throw new DomainError(
      "The image could not be safely processed",
      422,
      "EVIDENCE_IMAGE_INVALID",
    );
  }
}

export function safeDownloadName(originalName: string): string {
  const base = originalName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim()
    .slice(0, 160);
  return base || "evidence-file";
}
