import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ActivityType as DbActivityType,
  DecisionAction,
  MilestoneStatus as DbMilestoneStatus,
  Prisma,
  ProjectPartyRole,
  ProjectStatus as DbProjectStatus,
} from "../generated/prisma/client.js";
import { DomainError } from "../domain/errors.js";
import type {
  ActivityEvent,
  ActivityType,
  CreateProjectInput,
  CreatedProjectInvitation,
  DecisionInput,
  DecisionResult,
  Milestone,
  MilestoneStatus,
  Project,
  ProjectInvitation,
} from "../domain/types.js";
import type { TrustPayPrismaClient } from "../database/prisma.js";
import type { TrustPayRepository } from "./trustpay-repository.js";

const projectInclude = {
  parties: {
    include: { organization: true, authorizedApprover: true },
  },
  agreementVersions: {
    orderBy: { versionNumber: "desc" },
    take: 1,
    include: {
      acceptances: { orderBy: { acceptedAt: "desc" } },
    },
  },
  milestones: {
    orderBy: { sequenceNumber: "asc" },
    include: {
      acceptanceCriteria: { orderBy: { position: "asc" } },
      submissions: {
        orderBy: { submissionNumber: "desc" },
        take: 1,
        include: { submittedBy: true },
      },
    },
  },
} as const satisfies Prisma.ProjectInclude;

type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

function money(value: bigint): number {
  const result = Number(value) / 100;
  if (!Number.isSafeInteger(result)) {
    throw new Error("Money value exceeds JavaScript's safe integer range");
  }
  return result;
}

function milestoneStatus(status: DbMilestoneStatus): MilestoneStatus {
  const statuses: Record<DbMilestoneStatus, MilestoneStatus> = {
    APPROVED: "approved",
    AWAITING_DECISION: "awaiting-decision",
    CHANGES_REQUESTED: "changes-requested",
    DISPUTED: "disputed",
    NOT_STARTED: "not-started",
  };
  return statuses[status];
}

function projectStatus(status: DbProjectStatus): Project["status"] {
  if (status === "COMPLETED") return "completed";
  if (status === "ON_HOLD" || status === "ARCHIVED") return "on-hold";
  return "in-progress";
}

function agreementVersionLabel(versionNumber: number): string {
  return versionNumber >= 10
    ? `v${Math.floor(versionNumber / 10)}.${versionNumber % 10}`
    : `v${versionNumber}.0`;
}

function mapProject(row: ProjectRow): Project {
  const customer = row.parties.find((party) => party.role === ProjectPartyRole.CUSTOMER);
  const sme = row.parties.find((party) => party.role === ProjectPartyRole.SME);
  const agreement = row.agreementVersions[0];
  const acceptance = agreement?.acceptances[0];
  const agreementContent =
    agreement?.content &&
    typeof agreement.content === "object" &&
    !Array.isArray(agreement.content)
      ? (agreement.content as Record<string, unknown>)
      : undefined;

  return {
    id: row.slug,
    name: row.name,
    customer: customer?.organization.name ?? "Unknown customer",
    sme: sme?.organization.name ?? "Unknown SME",
    agreedValue: money(row.agreedValueMinor),
    approvedValue: money(row.approvedValueMinor),
    outstandingValue: money(row.agreedValueMinor - row.approvedValueMinor),
    status: projectStatus(row.status),
    agreementVersion: agreement
      ? agreementVersionLabel(agreement.versionNumber)
      : "Not accepted",
    agreementStatus: agreement?.status === "ACTIVE" ? "active" : "draft",
    ...(typeof agreementContent?.title === "string"
      ? { agreementTitle: agreementContent.title }
      : {}),
    ...(typeof agreementContent?.scope === "string"
      ? { agreementScope: agreementContent.scope }
      : {}),
    ...(typeof agreementContent?.terms === "string"
      ? { agreementTerms: agreementContent.terms }
      : {}),
    ...(acceptance
      ? { agreementAcceptedAt: acceptance.acceptedAt.toISOString() }
      : {}),
    authorizedApprover:
      customer?.authorizedApprover?.displayName ?? "No approver assigned",
    milestones: row.milestones.map((milestone): Milestone => {
      const submission = milestone.submissions[0];
      return {
        id: milestone.id,
        sequenceNumber: milestone.sequenceNumber,
        name: milestone.name,
        value: money(milestone.valueMinor),
        status: milestoneStatus(milestone.status),
        ...(milestone.description ? { description: milestone.description } : {}),
        acceptanceCriteria: milestone.acceptanceCriteria.map(
          (criterion) => criterion.description,
        ),
        ...(submission ? { submittedBy: submission.submittedBy.displayName } : {}),
        ...(submission ? { submittedAt: submission.submittedAt.toISOString() } : {}),
        ...(milestone.responseDeadline
          ? { responseDeadline: milestone.responseDeadline.toISOString() }
          : {}),
        ...(milestone.completedAt
          ? { completedAt: milestone.completedAt.toISOString() }
          : {}),
      };
    }),
  };
}

const activityTypes: Record<DbActivityType, ActivityType> = {
  PROJECT_CREATED: "project-created",
  CUSTOMER_INVITED: "customer-invited",
  CUSTOMER_APPROVER_JOINED: "customer-approver-joined",
  AGREEMENT_ACCEPTED: "agreement-accepted",
  AGREEMENT_SENT: "agreement-accepted",
  EVIDENCE_SUBMITTED: "evidence-submitted",
  MILESTONE_APPROVED: "milestone-approved",
  CHANGES_REQUESTED: "changes-requested",
  DISPUTE_RECORDED: "dispute-recorded",
  DECISION_RECORDED: "decision-recorded",
  VARIATION_APPROVED: "decision-recorded",
};

type ActivityRow = Prisma.ActivityEventGetPayload<{
  include: { milestone: true };
}>;

function mapActivity(row: ActivityRow, projectSlug: string): ActivityEvent {
  return {
    id: row.id,
    projectId: projectSlug,
    ...(row.milestone
      ? {
          milestoneId: row.milestone.id,
          milestoneSequenceNumber: row.milestone.sequenceNumber,
        }
      : {}),
    actor: row.actorName,
    actorType:
      row.actorType === "customer"
        ? "customer"
        : row.actorType === "sme"
          ? "sme"
          : "system",
    occurredAt: row.occurredAt.toISOString(),
    description: row.description,
    type: activityTypes[row.type],
    ...(row.reference ? { reference: row.reference } : {}),
  };
}

function decisionReference(projectCode: string, sequenceNumber: number): string {
  return `TP-${projectCode}-M${sequenceNumber}-${randomUUID().slice(0, 8)}`.toUpperCase();
}

function projectSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project";
  return `${base}-${randomUUID().slice(0, 6)}`;
}

function minorUnits(value: number): bigint {
  return BigInt(Math.round(value * 100));
}

function mapInvitation(row: {
  id: string;
  email: string;
  status: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";
  expiresAt: Date;
  createdAt: Date;
  invitedBy: { displayName: string };
  project: { slug: string } | null;
}): ProjectInvitation {
  const status =
    row.status === "PENDING" && row.expiresAt <= new Date()
      ? "expired"
      : row.status.toLowerCase() as ProjectInvitation["status"];
  return {
    id: row.id,
    projectId: row.project?.slug ?? "",
    email: row.email,
    role: "APPROVER",
    status,
    invitedBy: row.invitedBy.displayName,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function projectAccess(userId: string): Prisma.ProjectWhereInput[] {
  return [
    {
      owningOrganization: {
        memberships: { some: { userId } },
      },
    },
    {
      parties: {
        some: {
          organization: { memberships: { some: { userId } } },
        },
      },
    },
  ];
}

export default class PostgresTrustPayRepository implements TrustPayRepository {
  constructor(private readonly prisma: TrustPayPrismaClient) {}

  async createProject(
    input: CreateProjectInput,
    userId: string,
  ): Promise<Project> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const membership = await tx.organizationMembership.findFirst({
          where: {
            userId,
            role: { in: ["OWNER", "ADMIN"] },
            organization: { type: "SME", status: "ACTIVE" },
          },
          include: { organization: true, user: true },
        });
        if (!membership) {
          throw new DomainError(
            "Only an SME owner or administrator can create a project",
            403,
            "PROJECT_CREATE_FORBIDDEN",
          );
        }

        const customer = await tx.organization.create({
          data: {
            name: input.customerName,
            legalName: input.customerName,
            type: "CUSTOMER",
          },
        });
        const agreedValueMinor = input.milestones.reduce(
          (total, milestone) => total + minorUnits(milestone.value),
          0n,
        );
        const project = await tx.project.create({
          data: {
            owningOrganizationId: membership.organizationId,
            createdByUserId: userId,
            code: input.code.toUpperCase(),
            slug: projectSlug(input.name),
            name: input.name,
            agreedValueMinor,
            currencyCode: input.currencyCode.toUpperCase(),
          },
        });
        await tx.projectParty.createMany({
          data: [
            {
              projectId: project.id,
              organizationId: membership.organizationId,
              role: "SME",
            },
            {
              projectId: project.id,
              organizationId: customer.id,
              role: "CUSTOMER",
            },
          ],
        });

        const agreementContent = {
          title: input.agreement.title,
          scope: input.agreement.scope,
          terms: input.agreement.terms,
          currency: input.currencyCode.toUpperCase(),
          projectValueMinor: Number(agreedValueMinor),
        };
        await tx.agreementVersion.create({
          data: {
            projectId: project.id,
            versionNumber: 1,
            status: "DRAFT",
            content: agreementContent,
            contentHash: createHash("sha256")
              .update(JSON.stringify(agreementContent))
              .digest("hex"),
            createdByUserId: userId,
          },
        });

        for (const [index, milestone] of input.milestones.entries()) {
          await tx.milestone.create({
            data: {
              projectId: project.id,
              sequenceNumber: index + 1,
              name: milestone.name,
              ...(milestone.description
                ? { description: milestone.description }
                : {}),
              valueMinor: minorUnits(milestone.value),
              acceptanceCriteria: {
                create: milestone.acceptanceCriteria.map(
                  (description, criterionIndex) => ({
                    position: criterionIndex + 1,
                    description,
                  }),
                ),
              },
            },
          });
        }

        await tx.activityEvent.create({
          data: {
            projectId: project.id,
            actorUserId: userId,
            actorOrganizationId: membership.organizationId,
            actorName: membership.user.displayName,
            actorType: "sme",
            type: DbActivityType.PROJECT_CREATED,
            description: `Project created with a draft agreement and ${input.milestones.length} milestones`,
          },
        });

        const created = await tx.project.findUniqueOrThrow({
          where: { id: project.id },
          include: projectInclude,
        });
        return mapProject(created);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new DomainError(
          "A project with this code already exists for your organization",
          409,
          "PROJECT_CODE_EXISTS",
        );
      }
      throw error;
    }
  }

  async createCustomerInvitation(
    projectId: string,
    email: string,
    userId: string,
  ): Promise<CreatedProjectInvitation> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invitation = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: {
          slug: projectId,
          owningOrganization: {
            memberships: {
              some: { userId, role: { in: ["OWNER", "ADMIN"] } },
            },
          },
        },
        include: {
          owningOrganization: true,
          createdBy: true,
          parties: { where: { role: "CUSTOMER" } },
        },
      });
      if (!project) {
        throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
      }
      const customerParty = project.parties[0];
      if (!customerParty) {
        throw new DomainError(
          "The project has no customer organization",
          409,
          "CUSTOMER_NOT_ASSIGNED",
        );
      }
      if (customerParty.authorizedApproverUserId) {
        throw new DomainError(
          "This project already has an authorized customer approver",
          409,
          "APPROVER_ALREADY_ASSIGNED",
        );
      }

      await tx.invitation.updateMany({
        where: { projectId: project.id, status: "PENDING" },
        data: { status: "REVOKED" },
      });
      const created = await tx.invitation.create({
        data: {
          organizationId: customerParty.organizationId,
          projectId: project.id,
          email: email.trim().toLowerCase(),
          role: "APPROVER",
          tokenHash: createHash("sha256").update(token).digest("hex"),
          invitedByUserId: userId,
          expiresAt,
        },
        include: { invitedBy: true, project: true },
      });
      await tx.activityEvent.create({
        data: {
          projectId: project.id,
          actorUserId: userId,
          actorOrganizationId: project.owningOrganizationId,
          actorName: created.invitedBy.displayName,
          actorType: "sme",
          type: DbActivityType.CUSTOMER_INVITED,
          description: `Customer approver invitation created for ${created.email}`,
          payload: { invitationId: created.id, expiresAt: expiresAt.toISOString() },
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateType: "invitation",
          aggregateId: created.id,
          eventType: "CUSTOMER_INVITATION_CREATED",
          payload: {
            projectId: project.slug,
            invitationId: created.id,
            recipientEmail: created.email,
          },
        },
      });
      return created;
    });
    return { invitation: mapInvitation(invitation), token };
  }

  async listProjectInvitations(
    projectId: string,
    userId: string,
  ): Promise<ProjectInvitation[]> {
    const project = await this.prisma.project.findFirst({
      where: {
        slug: projectId,
        owningOrganization: {
          memberships: {
            some: { userId, role: { in: ["OWNER", "ADMIN"] } },
          },
        },
      },
      select: { id: true },
    });
    if (!project) {
      throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    }
    const rows = await this.prisma.invitation.findMany({
      where: { projectId: project.id },
      include: { invitedBy: true, project: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapInvitation);
  }

  async listProjects(userId: string): Promise<Project[]> {
    const rows = await this.prisma.project.findMany({
      where: { archivedAt: null, OR: projectAccess(userId) },
      include: projectInclude,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(mapProject);
  }

  async findProject(projectId: string, userId: string): Promise<Project | null> {
    const row = await this.prisma.project.findFirst({
      where: { slug: projectId, OR: projectAccess(userId) },
      include: projectInclude,
    });
    return row ? mapProject(row) : null;
  }

  async listActivity(projectId: string, userId: string): Promise<ActivityEvent[]> {
    const project = await this.prisma.project.findFirst({
      where: { slug: projectId, OR: projectAccess(userId) },
      select: { id: true, slug: true },
    });
    if (!project) return [];

    const rows = await this.prisma.activityEvent.findMany({
      where: { projectId: project.id },
      include: { milestone: true },
      orderBy: { occurredAt: "desc" },
    });
    return rows.map((row) => mapActivity(row, project.slug));
  }

  async recordDecision(
    projectId: string,
    milestoneId: string,
    decision: DecisionInput,
    userId: string,
  ): Promise<DecisionResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const project = await tx.project.findFirst({
          where: { slug: projectId, OR: projectAccess(userId) },
          include: {
            parties: { include: { authorizedApprover: true } },
            milestones: {
              where: { id: milestoneId },
              include: {
                submissions: {
                  orderBy: { submissionNumber: "desc" },
                  take: 1,
                },
              },
            },
          },
        });
        if (!project) {
          throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
        }

        const milestone = project.milestones[0];
        if (!milestone) {
          throw new DomainError("Milestone not found", 404, "MILESTONE_NOT_FOUND");
        }
        const submission = milestone.submissions[0];
        if (!submission) {
          throw new DomainError(
            "The milestone has no submission to decide",
            409,
            "MILESTONE_NOT_SUBMITTED",
          );
        }

        const updated = await tx.milestone.updateMany({
          where: { id: milestone.id, status: DbMilestoneStatus.AWAITING_DECISION },
          data: {
            status:
              decision.action === "approve"
                ? DbMilestoneStatus.APPROVED
                : decision.action === "request-changes"
                  ? DbMilestoneStatus.CHANGES_REQUESTED
                  : DbMilestoneStatus.DISPUTED,
            ...(decision.action === "approve" ? { completedAt: new Date() } : {}),
          },
        });
        if (updated.count !== 1) {
          throw new DomainError(
            "This milestone is not awaiting a decision",
            409,
            "MILESTONE_NOT_DECIDABLE",
          );
        }

        const customer = project.parties.find(
          (party) => party.role === ProjectPartyRole.CUSTOMER,
        );
        if (!customer?.authorizedApproverUserId || !customer.authorizedApprover) {
          throw new DomainError(
            "No authorized customer approver is assigned",
            409,
            "APPROVER_NOT_ASSIGNED",
          );
        }
        if (customer.authorizedApproverUserId !== userId) {
          throw new DomainError(
            "Only the authorized customer approver can decide this milestone",
            403,
            "DECISION_FORBIDDEN",
          );
        }

        const reference = decisionReference(project.code, milestone.sequenceNumber);
        const dbDecision = await tx.milestoneDecision.create({
          data: {
            submissionId: submission.id,
            decidedByUserId: userId,
            reference,
            action:
              decision.action === "approve"
                ? DecisionAction.APPROVE
                : decision.action === "request-changes"
                  ? DecisionAction.REQUEST_CHANGES
                  : DecisionAction.RAISE_DISPUTE,
          },
        });

        let description: string;
        let eventType: DbActivityType;
        if (decision.action === "approve") {
          description = `Milestone ${milestone.sequenceNumber} approved — ${milestone.name}`;
          eventType = DbActivityType.MILESTONE_APPROVED;
          const approved = await tx.milestone.aggregate({
            where: { projectId: project.id, status: DbMilestoneStatus.APPROVED },
            _sum: { valueMinor: true },
          });
          await tx.project.update({
            where: { id: project.id },
            data: { approvedValueMinor: approved._sum.valueMinor ?? 0n },
          });
        } else if (decision.action === "request-changes") {
          description = `Changes requested — ${decision.reason}. ${decision.comment} Response requested by ${decision.responseDate}.`;
          eventType = DbActivityType.CHANGES_REQUESTED;
          await tx.changeRequest.create({
            data: {
              decisionId: dbDecision.id,
              reason: decision.reason,
              comment: decision.comment,
              responseDueAt: new Date(`${decision.responseDate}T23:59:59.999Z`),
            },
          });
        } else {
          description = `Dispute recorded — ${decision.reason}. ${decision.explanation}`;
          eventType = DbActivityType.DISPUTE_RECORDED;
          await tx.dispute.create({
            data: {
              decisionId: dbDecision.id,
              reason: decision.reason,
              explanation: decision.explanation,
            },
          });
        }

        const customerEvent = await tx.activityEvent.create({
          data: {
            projectId: project.id,
            milestoneId: milestone.id,
            actorUserId: userId,
            actorOrganizationId: customer.organizationId,
            actorName: customer.authorizedApprover.displayName,
            actorType: "customer",
            type: eventType,
            description,
            reference,
          },
          include: { milestone: true },
        });
        const createdEvents = [customerEvent];
        if (decision.action === "approve") {
          createdEvents.push(
            await tx.activityEvent.create({
              data: {
                projectId: project.id,
                milestoneId: milestone.id,
                actorName: "System",
                actorType: "system",
                type: DbActivityType.DECISION_RECORDED,
                description:
                  "Customer decision recorded. Payment is handled externally.",
                reference,
              },
              include: { milestone: true },
            }),
          );
        }

        await tx.outboxEvent.create({
          data: {
            aggregateType: "milestone",
            aggregateId: milestone.id,
            eventType,
            payload: {
              projectId: project.slug,
              milestoneId: milestone.id,
              milestoneSequenceNumber: milestone.sequenceNumber,
              decision: decision.action,
              reference,
            },
          },
        });

        const refreshed = await tx.project.findUniqueOrThrow({
          where: { id: project.id },
          include: projectInclude,
        });
        const mappedProject = mapProject(refreshed);
        const mappedMilestone = mappedProject.milestones.find(
          (item) => item.id === milestoneId,
        );
        if (!mappedMilestone) throw new Error("Updated milestone was not returned");

        return {
          project: mappedProject,
          milestone: mappedMilestone,
          events: createdEvents.map((event) => mapActivity(event, project.slug)),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
