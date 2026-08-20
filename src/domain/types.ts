export type MilestoneStatus =
  | "approved"
  | "awaiting-decision"
  | "changes-requested"
  | "disputed"
  | "not-started";

export interface Milestone {
  id: number;
  name: string;
  value: number;
  status: MilestoneStatus;
  description?: string;
  acceptanceCriteria?: string[];
  submittedBy?: string;
  submittedAt?: string;
  responseDeadline?: string;
  completedAt?: string;
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
  agreementStatus: "draft" | "active";
  agreementTitle?: string;
  agreementScope?: string;
  agreementTerms?: string;
  agreementAcceptedAt?: string;
  authorizedApprover: string;
  milestones: Milestone[];
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
  | "milestone-approved"
  | "evidence-submitted"
  | "changes-requested"
  | "dispute-recorded"
  | "decision-recorded";

export interface ActivityEvent {
  id: string;
  projectId: string;
  milestoneId?: number;
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
