import type {
  ActivityEvent,
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
  listActivity(projectId: string, userId: string): Promise<ActivityEvent[]>;
  recordDecision(
    projectId: string,
    milestoneId: string,
    decision: DecisionInput,
    userId: string,
  ): Promise<DecisionResult>;
}
