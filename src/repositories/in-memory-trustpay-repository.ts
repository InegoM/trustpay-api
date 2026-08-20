import { randomUUID } from "node:crypto";
import { seedActivity, seedProject } from "../data/seed.js";
import { DomainError } from "../domain/errors.js";
import type {
  ActivityEvent,
  CreateProjectInput,
  CreatedProjectInvitation,
  DecisionInput,
  DecisionResult,
  Milestone,
  Project,
  ProjectInvitation,
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
  private readonly allowedUsers = new Set([
    "20000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
  ]);
  private readonly projects = new Map<string, Project>([
    [seedProject.id, copy(seedProject)],
  ]);

  private activity = copy(seedActivity);
  private invitations: ProjectInvitation[] = [];

  async createCustomerInvitation(
    projectId: string,
    email: string,
    userId: string,
  ): Promise<CreatedProjectInvitation> {
    if (userId !== "20000000-0000-4000-8000-000000000001") {
      throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    }
    const project = this.projects.get(projectId);
    if (!project) {
      throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    }
    if (project.authorizedApprover !== "Not yet assigned") {
      throw new DomainError(
        "This project already has an authorized customer approver",
        409,
        "APPROVER_ALREADY_ASSIGNED",
      );
    }
    this.invitations = this.invitations.map((invitation) =>
      invitation.projectId === projectId && invitation.status === "pending"
        ? { ...invitation, status: "revoked" }
        : invitation,
    );
    const now = new Date();
    const invitation: ProjectInvitation = {
      id: randomUUID(),
      projectId,
      email: email.trim().toLowerCase(),
      role: "APPROVER",
      status: "pending",
      invitedBy: "Nadia Rahman",
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: now.toISOString(),
    };
    this.invitations.unshift(invitation);
    this.activity.unshift({
      id: randomUUID(),
      projectId,
      actor: "Nadia Rahman",
      actorType: "sme",
      occurredAt: now.toISOString(),
      description: `Customer approver invitation created for ${invitation.email}`,
      type: "customer-invited",
    });
    return { invitation: copy(invitation), token: randomUUID() };
  }

  async listProjectInvitations(
    projectId: string,
    userId: string,
  ): Promise<ProjectInvitation[]> {
    if (
      userId !== "20000000-0000-4000-8000-000000000001" ||
      !this.projects.has(projectId)
    ) {
      throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    }
    return copy(
      this.invitations.filter((invitation) => invitation.projectId === projectId),
    );
  }

  async createProject(
    input: CreateProjectInput,
    userId: string,
  ): Promise<Project> {
    if (userId !== "20000000-0000-4000-8000-000000000001") {
      throw new DomainError(
        "Only an SME owner or administrator can create a project",
        403,
        "PROJECT_CREATE_FORBIDDEN",
      );
    }
    const slugBase = input.name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project";
    const slug = `${slugBase}-${randomUUID().slice(0, 6)}`;
    const agreedValue = input.milestones.reduce(
      (total, milestone) => total + milestone.value,
      0,
    );
    const project: Project = {
      id: slug,
      name: input.name,
      customer: input.customerName,
      sme: "Alba Fit-Out",
      agreedValue,
      approvedValue: 0,
      outstandingValue: agreedValue,
      status: "in-progress",
      agreementVersion: "v1.0",
      agreementStatus: "draft",
      agreementTitle: input.agreement.title,
      agreementScope: input.agreement.scope,
      agreementTerms: input.agreement.terms,
      authorizedApprover: "Not yet assigned",
      milestones: input.milestones.map((milestone, index) => ({
        id: index + 1,
        name: milestone.name,
        value: milestone.value,
        status: "not-started",
        ...(milestone.description
          ? { description: milestone.description }
          : {}),
        acceptanceCriteria: milestone.acceptanceCriteria,
      })),
    };
    this.projects.set(slug, project);
    this.activity.unshift({
      id: randomUUID(),
      projectId: slug,
      actor: "Nadia Rahman",
      actorType: "sme",
      occurredAt: new Date().toISOString(),
      description: `Project created with a draft agreement and ${project.milestones.length} milestones`,
      type: "project-created",
    });
    return copy(project);
  }

  async listProjects(userId: string): Promise<Project[]> {
    if (!this.allowedUsers.has(userId)) return [];
    return copy([...this.projects.values()]);
  }

  async findProject(projectId: string, userId: string): Promise<Project | null> {
    if (!this.allowedUsers.has(userId)) return null;
    const project = this.projects.get(projectId);
    return project ? copy(project) : null;
  }

  async listActivity(projectId: string, userId: string): Promise<ActivityEvent[]> {
    if (!this.allowedUsers.has(userId)) return [];
    return copy(this.activity.filter((event) => event.projectId === projectId));
  }

  async recordDecision(
    projectId: string,
    milestoneId: number,
    decision: DecisionInput,
    userId: string,
  ): Promise<DecisionResult> {
    if (userId !== "20000000-0000-4000-8000-000000000002") {
      throw new DomainError(
        "Only the authorized customer approver can decide this milestone",
        403,
        "DECISION_FORBIDDEN",
      );
    }
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
