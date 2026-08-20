import type {
  ActivityEvent,
  DecisionInput,
  DecisionResult,
  Project,
} from "../domain/types.js";

export interface TrustPayRepository {
  listProjects(): Promise<Project[]>;
  findProject(projectId: string): Promise<Project | null>;
  listActivity(projectId: string): Promise<ActivityEvent[]>;
  recordDecision(
    projectId: string,
    milestoneId: number,
    decision: DecisionInput,
  ): Promise<DecisionResult>;
}
