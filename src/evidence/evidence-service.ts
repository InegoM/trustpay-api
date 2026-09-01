import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { EvidenceItemRecord, MilestoneSubmissionRecord } from "../domain/types.js";
import type { TrustPayRepository } from "../repositories/trustpay-repository.js";
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  sanitizeEvidenceImage,
  validateEvidenceFile,
} from "../storage/file-validation.js";
import type { MalwareScanner } from "../storage/malware-scanner.js";
import type { ObjectStorage, StoredObject } from "../storage/object-storage.js";

export interface UploadEvidenceInput {
  projectId: string;
  milestoneId: string;
  submissionId: string;
  userId: string;
  originalName: string;
  declaredMimeType: string;
  body: Buffer;
  description?: string;
  acceptanceCriterionId?: string;
  capturedAt?: Date;
}

export default class EvidenceService {
  constructor(
    private readonly repository: TrustPayRepository,
    private readonly storage: ObjectStorage,
    private readonly scanner: MalwareScanner,
    private readonly maximumFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
  ) {}

  async upload(input: UploadEvidenceInput): Promise<EvidenceItemRecord> {
    const submission = await this.repository.findSubmission(
      input.projectId,
      input.milestoneId,
      input.submissionId,
      input.userId,
    );
    if (!submission?.canEdit) {
      throw new DomainError("Submission not found", 404, "SUBMISSION_NOT_FOUND");
    }
    const validation = await validateEvidenceFile(
      input.body,
      input.originalName,
      input.declaredMimeType,
      this.maximumFileSizeBytes,
    );
    const safeBody = await sanitizeEvidenceImage(input.body, validation.detectedMimeType);
    const objectId = randomUUID();
    const quarantineKey = `quarantine/${objectId}`;
    const finalKey = `evidence/${objectId}`;
    await this.storage.putObject(quarantineKey, safeBody, validation.detectedMimeType);
    let scanResult: Awaited<ReturnType<MalwareScanner["scan"]>>;
    try {
      scanResult = await this.scanner.scan(safeBody);
    } catch {
      throw new DomainError(
        "The file could not be security scanned. It remains private and was not added to the submission.",
        503,
        "EVIDENCE_SCAN_UNAVAILABLE",
      );
    }
    if (scanResult === "infected") {
      await this.storage.deleteObject(quarantineKey);
      throw new DomainError(
        "The file failed the security scan and was not added",
        422,
        "EVIDENCE_MALWARE_DETECTED",
      );
    }
    await this.storage.copyObject(quarantineKey, finalKey, validation.detectedMimeType);
    await this.storage.deleteObject(quarantineKey);
    try {
      return await this.repository.addEvidence(
        input.projectId,
        input.milestoneId,
        input.submissionId,
        {
          storageKey: finalKey,
          originalName: input.originalName,
          mimeType: input.declaredMimeType,
          detectedMimeType: validation.detectedMimeType,
          sizeBytes: safeBody.byteLength,
          sha256: createHash("sha256").update(safeBody).digest("hex"),
          ...(input.description ? { description: input.description } : {}),
          ...(input.acceptanceCriterionId ? { acceptanceCriterionId: input.acceptanceCriterionId } : {}),
          ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
        },
        input.userId,
      );
    } catch (error) {
      await this.storage.deleteObject(finalKey).catch(() => undefined);
      throw error;
    }
  }

  async remove(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    evidenceId: string,
    userId: string,
  ): Promise<void> {
    const storageKey = await this.repository.removeEvidence(
      projectId,
      milestoneId,
      submissionId,
      evidenceId,
      userId,
    );
    await this.storage.deleteObject(storageKey).catch(() => undefined);
  }

  async download(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    evidenceId: string,
    userId: string,
  ): Promise<{ metadata: NonNullable<Awaited<ReturnType<TrustPayRepository["findEvidenceDownload"]>>>; object: StoredObject }> {
    const metadata = await this.repository.findEvidenceDownload(
      projectId,
      milestoneId,
      submissionId,
      evidenceId,
      userId,
    );
    if (!metadata) throw new DomainError("Evidence not found", 404, "EVIDENCE_NOT_FOUND");
    const object = await this.storage.getObject(metadata.storageKey);
    if (!object) throw new DomainError("Evidence is temporarily unavailable", 503, "EVIDENCE_STORAGE_UNAVAILABLE");
    const hash = createHash("sha256").update(object.body).digest("hex");
    if (hash !== metadata.sha256 || object.sizeBytes !== metadata.sizeBytes) {
      throw new DomainError("Evidence integrity verification failed", 503, "EVIDENCE_INTEGRITY_FAILED");
    }
    return { metadata, object };
  }

  async submit(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    userId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MilestoneSubmissionRecord & { replayed?: boolean }> {
    const submission = await this.repository.findSubmission(projectId, milestoneId, submissionId, userId);
    if (!submission) throw new DomainError("Submission not found", 404, "SUBMISSION_NOT_FOUND");
    if (!submission.canEdit) {
      return this.repository.submitSubmission(
        projectId,
        milestoneId,
        submissionId,
        userId,
        idempotencyKey,
        requestId,
      );
    }
    for (const evidence of submission.evidence) {
      await this.download(projectId, milestoneId, submissionId, evidence.id, userId);
    }
    return this.repository.submitSubmission(
      projectId,
      milestoneId,
      submissionId,
      userId,
      idempotencyKey,
      requestId,
    );
  }

  async cleanupAbandoned(cutoff: Date): Promise<{ deleted: number }> {
    const referenced = new Set(await this.repository.listEvidenceStorageKeys());
    const candidates = [
      ...(await this.storage.listObjects("quarantine/")),
      ...(await this.storage.listObjects("evidence/")),
    ];
    let deleted = 0;
    for (const candidate of candidates) {
      if (referenced.has(candidate.key) || !candidate.lastModified || candidate.lastModified >= cutoff) continue;
      await this.storage.deleteObject(candidate.key);
      deleted += 1;
    }
    return { deleted };
  }
}
