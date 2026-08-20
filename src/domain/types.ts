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
  agreementAcceptedAt: string;
  authorizedApprover: string;
  milestones: Milestone[];
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
