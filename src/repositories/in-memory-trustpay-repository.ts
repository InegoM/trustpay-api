import { randomUUID } from "node:crypto";
import { seedActivity, seedProject } from "../data/seed.js";
import { DomainError } from "../domain/errors.js";
import type {
  ActivityEvent,
  DecisionInput,
  DecisionResult,
  Milestone,
  Project,
} from "../domain/types.js";
import type { TrustPayRepository } from "./trustpay-repository.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function reference(projectId: string, milestoneId: number): string {
  const suffix = Date.now().toString(36).toUpperCase();
  return `TP-${projectId.toUpperCase()}-M${milestoneId}-${suffix}`;
}

export default class InMemoryTrustPayRepository implements TrustPayRepository {
  private readonly projects = new Map<string, Project>([
    [seedProject.id, copy(seedProject)],
  ]);

  private activity = copy(seedActivity);

  async listProjects(): Promise<Project[]> {
    return copy([...this.projects.values()]);
  }

  async findProject(projectId: string): Promise<Project | null> {
    const project = this.projects.get(projectId);
    return project ? copy(project) : null;
  }

  async listActivity(projectId: string): Promise<ActivityEvent[]> {
    return copy(this.activity.filter((event) => event.projectId === projectId));
  }

  async recordDecision(
    projectId: string,
    milestoneId: number,
    decision: DecisionInput,
  ): Promise<DecisionResult> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    }

    const milestone = project.milestones.find((item) => item.id === milestoneId);
    if (!milestone) {
      throw new DomainError("Milestone not found", 404, "MILESTONE_NOT_FOUND");
    }
    if (milestone.status !== "awaiting-decision") {
      throw new DomainError(
        "This milestone is not awaiting a decision",
        409,
        "MILESTONE_NOT_DECIDABLE",
      );
    }

    const occurredAt = new Date().toISOString();
    const decisionReference = reference(projectId, milestoneId);
    const events = this.applyDecision(
      project,
      milestone,
      decision,
      occurredAt,
      decisionReference,
    );

    this.activity = [...events, ...this.activity];
    return { project: copy(project), milestone: copy(milestone), events: copy(events) };
  }

  private applyDecision(
    project: Project,
    milestone: Milestone,
    decision: DecisionInput,
    occurredAt: string,
    decisionReference: string,
  ): ActivityEvent[] {
    const base = {
      projectId: project.id,
      milestoneId: milestone.id,
      occurredAt,
      reference: decisionReference,
    };

    if (decision.action === "approve") {
      milestone.status = "approved";
      milestone.completedAt = occurredAt;
      project.approvedValue = project.milestones
        .filter((item) => item.status === "approved")
        .reduce((total, item) => total + item.value, 0);
      project.outstandingValue = project.agreedValue - project.approvedValue;

      return [
        {
          ...base,
          id: randomUUID(),
          actor: project.authorizedApprover,
          actorType: "customer",
          description: `Milestone ${milestone.id} approved — ${milestone.name}`,
          type: "milestone-approved",
        },
        {
          ...base,
          id: randomUUID(),
          actor: "System",
          actorType: "system",
          description: "Customer decision recorded. Payment is handled externally.",
          type: "decision-recorded",
        },
      ];
    }

    if (decision.action === "request-changes") {
      milestone.status = "changes-requested";
      return [
        {
          ...base,
          id: randomUUID(),
          actor: project.authorizedApprover,
          actorType: "customer",
          description: `Changes requested — ${decision.reason}. ${decision.comment} Response requested by ${decision.responseDate}.`,
          type: "changes-requested",
        },
      ];
    }

    milestone.status = "disputed";
    return [
      {
        ...base,
        id: randomUUID(),
        actor: project.authorizedApprover,
        actorType: "customer",
        description: `Dispute recorded — ${decision.reason}. ${decision.explanation}`,
        type: "dispute-recorded",
      },
    ];
  }
}
