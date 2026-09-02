import type {
  ActivityEvent,
  AgreementDecisionInput,
  AgreementDecisionResult,
  AgreementVersion,
  AddEvidenceInput,
  CreateAgreementVersionInput,
  CreateProjectInput,
  CreatedProjectInvitation,
  DecisionInput,
  DecisionResult,
  EvidenceDownloadRecord,
  EvidenceItemRecord,
  MilestoneSubmissionRecord,
  Project,
  ProjectInvitation,
  RespondToChangeRequestInput,
} from "../domain/types.js";

export interface TrustPayRepository {
  createProject(input: CreateProjectInput, userId: string): Promise<Project>;
  createCustomerInvitation(
    projectId: string,
    email: string,
    userId: string,
  ): Promise<CreatedProjectInvitation>;
  listProjectInvitations(
    projectId: string,
    userId: string,
  ): Promise<ProjectInvitation[]>;
  listProjects(userId: string): Promise<Project[]>;
  findProject(projectId: string, userId: string): Promise<Project | null>;
  listAgreements(projectId: string, userId: string): Promise<AgreementVersion[]>;
  findAgreement(
    projectId: string,
    agreementId: string,
    userId: string,
  ): Promise<AgreementVersion | null>;
  createSubmission(
    projectId: string,
    milestoneId: string,
    notes: string | undefined,
    userId: string,
  ): Promise<MilestoneSubmissionRecord>;
  respondToChangeRequest(
    projectId: string,
    milestoneId: string,
    changeRequestId: string,
    input: RespondToChangeRequestInput,
    userId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MilestoneSubmissionRecord & { replayed?: boolean }>;
  updateSubmissionNotes(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    notes: string | undefined,
    userId: string,
  ): Promise<MilestoneSubmissionRecord>;
  listSubmissions(
    projectId: string,
    milestoneId: string,
    userId: string,
  ): Promise<MilestoneSubmissionRecord[]>;
  listChangeRequests(
    projectId: string,
    milestoneId: string,
    userId: string,
  ): Promise<import("../domain/types.js").ChangeRequestRecord[]>;
  findSubmission(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    userId: string,
  ): Promise<MilestoneSubmissionRecord | null>;
  addEvidence(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    input: AddEvidenceInput,
    userId: string,
  ): Promise<EvidenceItemRecord>;
  removeEvidence(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    evidenceId: string,
    userId: string,
  ): Promise<string>;
  submitSubmission(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    userId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MilestoneSubmissionRecord & { replayed?: boolean }>;
  findEvidenceDownload(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    evidenceId: string,
    userId: string,
  ): Promise<EvidenceDownloadRecord | null>;
  listEvidenceStorageKeys(): Promise<string[]>;
  createAgreementVersion(
    projectId: string,
    input: CreateAgreementVersionInput,
    userId: string,
  ): Promise<AgreementVersion>;
  recordAgreementDecision(
    projectId: string,
    agreementId: string,
    decision: AgreementDecisionInput,
    userId: string,
    idempotencyKey: string,
    metadata: { ipAddress?: string; userAgent?: string },
  ): Promise<AgreementDecisionResult>;
  listActivity(projectId: string, userId: string): Promise<ActivityEvent[]>;
  recordDecision(
    projectId: string,
    milestoneId: string,
    decision: DecisionInput,
    userId: string,
  ): Promise<DecisionResult>;
}
