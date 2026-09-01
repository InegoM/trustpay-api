export type MilestoneStatus =
  | "approved"
  | "awaiting-decision"
  | "changes-requested"
  | "disputed"
  | "in-progress"
  | "not-started";

export interface AcceptanceCriterionView {
  id: string;
  position: number;
  description: string;
}

export interface Milestone {
  id: string;
  sequenceNumber: number;
  name: string;
  value: number;
  status: MilestoneStatus;
  description?: string;
  acceptanceCriteria?: string[];
  acceptanceCriteriaDetailed?: AcceptanceCriterionView[];
  submittedBy?: string;
  submittedAt?: string;
  responseDeadline?: string;
  completedAt?: string;
}

export type SubmissionStatus = "draft" | "submitted";
export type EvidenceScanStatus = "pending" | "clean" | "infected" | "error";

export interface EvidenceItemRecord {
  id: string;
  originalName: string;
  mimeType: string;
  detectedMimeType: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: EvidenceScanStatus;
  description?: string;
  acceptanceCriterionId?: string;
  acceptanceCriterion?: string;
  uploadedBy: string;
  uploadedAt: string;
  capturedAt?: string;
  downloadPath: string;
}

export interface MilestoneSubmissionRecord {
  id: string;
  projectId: string;
  milestoneId: string;
  milestoneSequenceNumber: number;
  milestoneName: string;
  submissionNumber: number;
  status: SubmissionStatus;
  notes?: string;
  createdAt: string;
  submittedAt?: string;
  submittedBy: string;
  agreementVersionId: string;
  agreementVersion: string;
  evidence: EvidenceItemRecord[];
  canEdit: boolean;
}

export interface AddEvidenceInput {
  acceptanceCriterionId?: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  detectedMimeType: string;
  sizeBytes: number;
  sha256: string;
  description?: string;
  capturedAt?: Date;
}

export interface EvidenceDownloadRecord {
  id: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface Project {
  id: string;
  name: string;
  customer: string;
  sme: string;
  agreedValue: number;
  approvedValue: number;
  outstandingValue: number;
  status: "in-progress" | "completed" | "on-hold";
  agreementVersion: string;
  agreementId?: string;
  agreementStatus: "draft" | "active";
  agreementTitle?: string;
  agreementScope?: string;
  agreementTerms?: string;
  agreementAcceptedAt?: string;
  authorizedApprover: string;
  milestones: Milestone[];
}

export type AgreementStatus = "draft" | "active" | "superseded" | "amendment-requested";

export interface AgreementMilestoneSnapshot {
  sequenceNumber: number;
  name: string;
  description?: string;
  value: number;
  acceptanceCriteria: string[];
}

export interface AgreementContent {
  title: string;
  scope: string;
  terms: string;
  currency: string;
  projectValue: number;
  milestones: AgreementMilestoneSnapshot[];
}

export interface AgreementAcceptance {
  id: string;
  organization: string;
  acceptedBy: string;
  acceptedAt: string;
  reference: string;
}

export interface AgreementAmendmentRequest {
  id: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  reference: string;
}

export interface AgreementVersion {
  id: string;
  versionNumber: number;
  label: string;
  status: AgreementStatus;
  content: AgreementContent;
  contentHash: string;
  createdAt: string;
  createdBy: string;
  acceptance?: AgreementAcceptance;
  amendmentRequest?: AgreementAmendmentRequest;
}

export interface CreateAgreementVersionInput {
  baseVersionId: string;
  title: string;
  scope: string;
  terms: string;
}

export type AgreementDecisionInput =
  | { action: "accept"; authorityConfirmed: true; expectedVersionId: string }
  | { action: "request-amendment"; reason: string; expectedVersionId: string };

export interface AgreementDecisionResult {
  agreement: AgreementVersion;
  event: ActivityEvent;
  replayed?: boolean;
}

export interface CreateProjectInput {
  name: string;
  code: string;
  customerName: string;
  currencyCode: string;
  agreement: {
    title: string;
    scope: string;
    terms: string;
  };
  milestones: Array<{
    name: string;
    description?: string | undefined;
    value: number;
    acceptanceCriteria: string[];
  }>;
}

export interface ProjectInvitation {
  id: string;
  projectId: string;
  email: string;
  role: "APPROVER";
  status: "pending" | "accepted" | "expired" | "revoked";
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedProjectInvitation {
  invitation: ProjectInvitation;
  token: string;
}

export type DecisionInput =
  | { action: "approve" }
  | {
      action: "request-changes";
      reason: string;
      comment: string;
      responseDate: string;
    }
  | {
      action: "raise-dispute";
      reason: string;
      explanation: string;
    };

export type ActivityType =
  | "project-created"
  | "customer-invited"
  | "customer-approver-joined"
  | "agreement-accepted"
  | "agreement-amendment-requested"
  | "agreement-version-created"
  | "milestone-approved"
  | "evidence-submitted"
  | "changes-requested"
  | "dispute-recorded"
  | "decision-recorded";

export interface ActivityEvent {
  id: string;
  projectId: string;
  milestoneId?: string;
  milestoneSequenceNumber?: number;
  actor: string;
  actorType: "sme" | "customer" | "system";
  occurredAt: string;
  description: string;
  type: ActivityType;
  reference?: string;
}

export interface DecisionResult {
  project: Project;
  milestone: Milestone;
  events: ActivityEvent[];
}
