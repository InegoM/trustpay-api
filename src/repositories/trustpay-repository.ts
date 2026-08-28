import type {
  ActivityEvent,
  AgreementDecisionInput,
  AgreementDecisionResult,
  AgreementVersion,
  CreateAgreementVersionInput,
  CreateProjectInput,
  CreatedProjectInvitation,
  DecisionInput,
  DecisionResult,
  Project,
  ProjectInvitation,
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
