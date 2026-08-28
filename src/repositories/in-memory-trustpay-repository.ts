import { randomUUID } from "node:crypto";
import { seedActivity, seedProject } from "../data/seed.js";
import { DomainError } from "../domain/errors.js";
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
  Milestone,
  Project,
  ProjectInvitation,
} from "../domain/types.js";
import type { TrustPayRepository } from "./trustpay-repository.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

const { agreementAcceptedAt: _seedAcceptance, ...seedProjectWithoutAcceptance } = copy(seedProject);
const agreementDraftProject: Project = {
  ...seedProjectWithoutAcceptance,
  id: "agreement-review",
  name: "Agreement Review Project",
  agreementVersion: "v1.0",
  agreementId: "50000000-0000-4000-8000-000000000002",
  agreementStatus: "draft",
  authorizedApprover: "Omar Hassan",
  milestones: copy(seedProject.milestones).slice(0, 1),
};

function reference(projectId: string, sequenceNumber: number): string {
  const suffix = Date.now().toString(36).toUpperCase();
  return `TP-${projectId.toUpperCase()}-M${sequenceNumber}-${suffix}`;
}

export default class InMemoryTrustPayRepository implements TrustPayRepository {
  private readonly allowedUsers = new Set([
    "20000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
  ]);
  private readonly projects = new Map<string, Project>([
    [seedProject.id, copy(seedProject)],
    [agreementDraftProject.id, copy(agreementDraftProject)],
  ]);

  private activity = copy(seedActivity);
  private invitations: ProjectInvitation[] = [];
  private readonly agreements = new Map<string, AgreementVersion[]>([
    [
      seedProject.id,
      [
        {
          id: "50000000-0000-4000-8000-000000000001",
          versionNumber: 12,
          label: "v1.2",
          status: "active",
          content: {
            title: seedProject.agreementTitle ?? "Agreement",
            scope: seedProject.agreementScope ?? "",
            terms: "Each milestone is reviewed against its acceptance criteria before the customer records a decision.",
            currency: "AED",
            projectValue: seedProject.agreedValue,
            milestones: seedProject.milestones.map((milestone) => ({
              sequenceNumber: milestone.sequenceNumber,
              name: milestone.name,
              value: milestone.value,
              acceptanceCriteria: milestone.acceptanceCriteria ?? [],
            })),
          },
          contentHash: "seed-agreement-hash",
          createdAt: "2026-08-01T08:00:00.000Z",
          createdBy: "Nadia Rahman",
          acceptance: {
            id: "51000000-0000-4000-8000-000000000001",
            organization: "Cedar Café",
            acceptedBy: "Omar Hassan",
            acceptedAt: "2026-08-08T12:05:00.000Z",
            reference: "TP-AGR-SEED-0001",
          },
        },
      ],
    ],
    [
      agreementDraftProject.id,
      [
        {
          id: "50000000-0000-4000-8000-000000000002",
          versionNumber: 1,
          label: "v1.0",
          status: "draft",
          content: {
            title: "Agreement Review Project Agreement",
            scope: "Renovate the agreed customer area in line with the documented scope.",
            terms: "Each milestone is reviewed against its acceptance criteria before the customer records a decision.",
            currency: "AED",
            projectValue: agreementDraftProject.agreedValue,
            milestones: agreementDraftProject.milestones.map((milestone) => ({ sequenceNumber: milestone.sequenceNumber, name: milestone.name, value: milestone.value, acceptanceCriteria: milestone.acceptanceCriteria ?? [] })),
          },
          contentHash: "draft-agreement-hash",
          createdAt: "2026-08-27T08:00:00.000Z",
          createdBy: "Nadia Rahman",
        },
      ],
    ],
  ]);
  private readonly idempotentAgreementDecisions = new Map<string, { requestHash: string; result: AgreementDecisionResult }>();

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
        id: randomUUID(),
        sequenceNumber: index + 1,
        name: milestone.name,
        value: milestone.value,
        status: "not-started",
        ...(milestone.description
          ? { description: milestone.description }
          : {}),
        acceptanceCriteria: milestone.acceptanceCriteria,
      })),
    };
    const agreementId = randomUUID();
    project.agreementId = agreementId;
    this.projects.set(slug, project);
    this.agreements.set(slug, [
      {
        id: agreementId,
        versionNumber: 1,
        label: "v1.0",
        status: "draft",
        content: {
          title: input.agreement.title,
          scope: input.agreement.scope,
          terms: input.agreement.terms,
          currency: input.currencyCode.toUpperCase(),
          projectValue: agreedValue,
          milestones: project.milestones.map((milestone) => ({
            sequenceNumber: milestone.sequenceNumber,
            name: milestone.name,
            ...(milestone.description ? { description: milestone.description } : {}),
            value: milestone.value,
            acceptanceCriteria: milestone.acceptanceCriteria ?? [],
          })),
        },
        contentHash: randomUUID().replaceAll("-", ""),
        createdAt: new Date().toISOString(),
        createdBy: "Nadia Rahman",
      },
    ]);
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

  async listAgreements(projectId: string, userId: string): Promise<AgreementVersion[]> {
    if (!this.allowedUsers.has(userId) || !this.projects.has(projectId)) return [];
    return copy([...(this.agreements.get(projectId) ?? [])].sort((a, b) => b.versionNumber - a.versionNumber));
  }

  async findAgreement(
    projectId: string,
    agreementId: string,
    userId: string,
  ): Promise<AgreementVersion | null> {
    if (!this.allowedUsers.has(userId) || !this.projects.has(projectId)) return null;
    return copy(this.agreements.get(projectId)?.find((agreement) => agreement.id === agreementId) ?? null);
  }

  async createAgreementVersion(
    projectId: string,
    input: CreateAgreementVersionInput,
    userId: string,
  ): Promise<AgreementVersion> {
    const project = this.projects.get(projectId);
    if (userId !== "20000000-0000-4000-8000-000000000001" || !project) {
      throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    }
    const agreements = this.agreements.get(projectId) ?? [];
    const base = agreements.find((agreement) => agreement.id === input.baseVersionId);
    if (!base || base.status !== "amendment-requested") {
      throw new DomainError("This agreement is no longer awaiting an amendment", 409, "AGREEMENT_VERSION_STALE");
    }
    base.status = "superseded";
    const created: AgreementVersion = {
      id: randomUUID(),
      versionNumber: Math.max(...agreements.map((agreement) => agreement.versionNumber), 0) + 1,
      label: `v${Math.max(...agreements.map((agreement) => agreement.versionNumber), 0) + 1}.0`,
      status: "draft",
      content: { ...copy(base.content), title: input.title, scope: input.scope, terms: input.terms },
      contentHash: randomUUID().replaceAll("-", ""),
      createdAt: new Date().toISOString(),
      createdBy: "Nadia Rahman",
    };
    project.agreementId = created.id;
    project.agreementVersion = created.label;
    project.agreementStatus = "draft";
    agreements.push(created);
    this.activity.unshift({
      id: randomUUID(), projectId, actor: "Nadia Rahman", actorType: "sme", occurredAt: created.createdAt,
      description: `Agreement ${created.label} created in response to an amendment request`, type: "agreement-version-created",
    });
    return copy(created);
  }

  async recordAgreementDecision(
    projectId: string,
    agreementId: string,
    decision: AgreementDecisionInput,
    userId: string,
    idempotencyKey: string,
    _metadata: { ipAddress?: string; userAgent?: string },
  ): Promise<AgreementDecisionResult> {
    const project = this.projects.get(projectId);
    if (!this.allowedUsers.has(userId) || !project) {
      throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    }
    if (userId !== "20000000-0000-4000-8000-000000000002") {
      throw new DomainError("Only the authorized customer approver can decide on this agreement", 403, "AGREEMENT_DECISION_FORBIDDEN");
    }
    if (decision.expectedVersionId !== agreementId) {
      throw new DomainError("The agreement version is stale", 409, "AGREEMENT_VERSION_STALE");
    }
    const key = `${userId}:${idempotencyKey}`;
    const requestHash = JSON.stringify(decision);
    const previous = this.idempotentAgreementDecisions.get(key);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new DomainError("This idempotency key was used for a different request", 409, "IDEMPOTENCY_KEY_REUSED");
      return { ...copy(previous.result), replayed: true };
    }
    const agreement = this.agreements.get(projectId)?.find((item) => item.id === agreementId);
    if (!agreement) throw new DomainError("Agreement not found", 404, "AGREEMENT_NOT_FOUND");
    if (agreement.status !== "draft") throw new DomainError("This agreement version is no longer awaiting a decision", 409, "AGREEMENT_VERSION_STALE");
    const occurredAt = new Date().toISOString();
    const reference = `TP-AGR-${randomUUID().slice(0, 8)}`.toUpperCase();
    if (decision.action === "accept") {
      agreement.status = "active";
      agreement.acceptance = { id: randomUUID(), organization: project.customer, acceptedBy: project.authorizedApprover, acceptedAt: occurredAt, reference };
      project.agreementStatus = "active";
      project.agreementVersion = agreement.label;
      project.agreementAcceptedAt = occurredAt;
    } else {
      agreement.status = "amendment-requested";
      agreement.amendmentRequest = { id: randomUUID(), reason: decision.reason, requestedBy: project.authorizedApprover, requestedAt: occurredAt, reference };
    }
    const event: ActivityEvent = {
      id: randomUUID(), projectId, actor: project.authorizedApprover, actorType: "customer", occurredAt, reference,
      description: decision.action === "accept" ? `Agreement ${agreement.label} acceptance recorded by ${project.authorizedApprover}` : `Amendment requested for agreement ${agreement.label}: ${decision.reason}`,
      type: decision.action === "accept" ? "agreement-accepted" : "agreement-amendment-requested",
    };
    const result = { agreement: copy(agreement), event: copy(event) };
    this.idempotentAgreementDecisions.set(key, { requestHash, result });
    this.activity.unshift(event);
    return copy(result);
  }

  async listActivity(projectId: string, userId: string): Promise<ActivityEvent[]> {
    if (!this.allowedUsers.has(userId)) return [];
    return copy(this.activity.filter((event) => event.projectId === projectId));
  }

  async recordDecision(
    projectId: string,
    milestoneId: string,
    decision: DecisionInput,
    userId: string,
  ): Promise<DecisionResult> {
    const project = this.projects.get(projectId);
    if (!this.allowedUsers.has(userId) || !project) {
      throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    }
    if (userId !== "20000000-0000-4000-8000-000000000002") {
      throw new DomainError(
        "Only the authorized customer approver can decide this milestone",
        403,
        "DECISION_FORBIDDEN",
      );
    }
    if (project.agreementStatus !== "active") {
      throw new DomainError(
        "A recorded agreement acceptance is required before milestone decisions",
        409,
        "AGREEMENT_NOT_ACCEPTED",
      );
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
    const decisionReference = reference(projectId, milestone.sequenceNumber);
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
      milestoneSequenceNumber: milestone.sequenceNumber,
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
          description: `Milestone ${milestone.sequenceNumber} approved — ${milestone.name}`,
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
