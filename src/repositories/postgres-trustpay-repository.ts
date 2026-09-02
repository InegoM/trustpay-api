import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ActivityType as DbActivityType,
  AgreementStatus as DbAgreementStatus,
  DecisionAction,
  EvidenceScanStatus as DbEvidenceScanStatus,
  MilestoneStatus as DbMilestoneStatus,
  Prisma,
  ProjectPartyRole,
  ProjectStatus as DbProjectStatus,
  SubmissionStatus as DbSubmissionStatus,
} from "../generated/prisma/client.js";
import { DomainError } from "../domain/errors.js";
import type {
  ActivityEvent,
  ActivityType,
  AddEvidenceInput,
  AgreementContent,
  AgreementDecisionInput,
  AgreementDecisionResult,
  AgreementStatus,
  AgreementVersion,
  CreateAgreementVersionInput,
  CreateProjectInput,
  CreatedProjectInvitation,
  DecisionInput,
  DecisionResult,
  EvidenceDownloadRecord,
  EvidenceItemRecord,
  Milestone,
  MilestoneSubmissionRecord,
  MilestoneStatus,
  Project,
  ProjectInvitation,
  RespondToChangeRequestInput,
} from "../domain/types.js";
import {
  DEFAULT_MAX_FILES_PER_SUBMISSION,
  DEFAULT_ORGANIZATION_STORAGE_BYTES,
} from "../storage/file-validation.js";
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
        where: { status: DbSubmissionStatus.SUBMITTED },
        orderBy: { submissionNumber: "desc" },
        take: 1,
        include: { submittedBy: true },
      },
    },
  },
} as const satisfies Prisma.ProjectInclude;

const agreementInclude = {
  createdBy: true,
  acceptances: {
    orderBy: { acceptedAt: "desc" },
    include: { organization: true, acceptedBy: true },
  },
  amendmentRequests: {
    orderBy: { requestedAt: "desc" },
    include: { organization: true, requestedBy: true },
  },
} as const satisfies Prisma.AgreementVersionInclude;

const submissionInclude = {
  milestone: { include: { project: true } },
  agreementVersion: true,
  submittedBy: true,
  evidenceItems: {
    include: { uploadedBy: true, acceptanceCriterion: true },
    orderBy: { uploadedAt: "asc" },
  },
  decision: {
    include: {
      decidedBy: true,
      changeRequest: { include: { response: { include: { respondedBy: true } }, acceptanceCriteria: true, evidenceItems: true } },
    },
  },
  changeRequestResponse: { include: { changeRequest: true, respondedBy: true } },
} as const satisfies Prisma.MilestoneSubmissionInclude;

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
    IN_PROGRESS: "in-progress",
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

function agreementStatus(status: DbAgreementStatus): AgreementStatus {
  if (status === "ACTIVE") return "active";
  if (status === "SUPERSEDED") return "superseded";
  if (status === "AMENDMENT_REQUESTED") return "amendment-requested";
  return "draft";
}

function canonicalAgreementContent(content: AgreementContent): string {
  return JSON.stringify({
    title: content.title,
    scope: content.scope,
    terms: content.terms,
    currency: content.currency,
    projectValue: content.projectValue,
    milestones: content.milestones.map((milestone) => ({
      sequenceNumber: milestone.sequenceNumber,
      name: milestone.name,
      ...(milestone.description ? { description: milestone.description } : {}),
      value: milestone.value,
      acceptanceCriteria: [...milestone.acceptanceCriteria],
    })),
  });
}

function agreementContentFromJson(content: Prisma.JsonValue): AgreementContent | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const value = content as Record<string, unknown>;
  if (
    typeof value.title !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.terms !== "string" ||
    typeof value.currency !== "string" ||
    typeof value.projectValue !== "number" ||
    !Array.isArray(value.milestones)
  ) {
    return null;
  }
  const milestones = value.milestones.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const milestone = item as Record<string, unknown>;
    if (
      typeof milestone.sequenceNumber !== "number" ||
      typeof milestone.name !== "string" ||
      typeof milestone.value !== "number" ||
      !Array.isArray(milestone.acceptanceCriteria) ||
      !milestone.acceptanceCriteria.every((criterion) => typeof criterion === "string")
    ) {
      return [];
    }
    return [{
      sequenceNumber: milestone.sequenceNumber,
      name: milestone.name,
      ...(typeof milestone.description === "string" ? { description: milestone.description } : {}),
      value: milestone.value,
      acceptanceCriteria: milestone.acceptanceCriteria,
    }];
  });
  return milestones.length === value.milestones.length
    ? { title: value.title, scope: value.scope, terms: value.terms, currency: value.currency, projectValue: value.projectValue, milestones }
    : null;
}

type AgreementRow = Prisma.AgreementVersionGetPayload<{ include: typeof agreementInclude }>;

function mapAgreement(row: AgreementRow): AgreementVersion {
  const content = agreementContentFromJson(row.content);
  if (!content) throw new Error("Agreement content is invalid");
  const acceptance = row.acceptances[0];
  const amendmentRequest = row.amendmentRequests[0];
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    label: agreementVersionLabel(row.versionNumber),
    status: agreementStatus(row.status),
    content,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy.displayName,
    ...(acceptance
      ? {
          acceptance: {
            id: acceptance.id,
            organization: acceptance.organization.name,
            acceptedBy: acceptance.acceptedBy.displayName,
            acceptedAt: acceptance.acceptedAt.toISOString(),
            reference: acceptance.reference,
          },
        }
      : {}),
    ...(amendmentRequest
      ? {
          amendmentRequest: {
            id: amendmentRequest.id,
            reason: amendmentRequest.reason,
            requestedBy: amendmentRequest.requestedBy.displayName,
            requestedAt: amendmentRequest.requestedAt.toISOString(),
            reference: amendmentRequest.reference,
          },
        }
      : {}),
  };
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
    ...(agreement ? { agreementId: agreement.id } : {}),
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
        acceptanceCriteriaDetailed: milestone.acceptanceCriteria.map((criterion) => ({
          id: criterion.id,
          position: criterion.position,
          description: criterion.description,
        })),
        ...(submission ? { submittedBy: submission.submittedBy.displayName } : {}),
        ...(submission?.submittedAt ? { submittedAt: submission.submittedAt.toISOString() } : {}),
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
  AGREEMENT_SENT: "agreement-version-created",
  AGREEMENT_AMENDMENT_REQUESTED: "agreement-amendment-requested",
  EVIDENCE_SUBMITTED: "evidence-submitted",
  MILESTONE_APPROVED: "milestone-approved",
  CHANGES_REQUESTED: "changes-requested",
  CHANGE_REQUEST_RESPONDED: "change-request-responded",
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

type SubmissionRow = Prisma.MilestoneSubmissionGetPayload<{
  include: typeof submissionInclude;
}>;

function evidenceScanStatus(status: DbEvidenceScanStatus): EvidenceItemRecord["scanStatus"] {
  return status.toLowerCase() as EvidenceItemRecord["scanStatus"];
}

function mapEvidence(row: SubmissionRow["evidenceItems"][number], projectSlug: string, milestoneId: string): EvidenceItemRecord {
  const sizeBytes = Number(row.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes)) throw new Error("Evidence size exceeds JavaScript's safe integer range");
  return {
    id: row.id,
    originalName: row.originalName,
    mimeType: row.mimeType,
    detectedMimeType: row.detectedMimeType,
    sizeBytes,
    sha256: row.sha256,
    scanStatus: evidenceScanStatus(row.scanStatus),
    ...(row.description ? { description: row.description } : {}),
    ...(row.acceptanceCriterionId ? { acceptanceCriterionId: row.acceptanceCriterionId } : {}),
    ...(row.acceptanceCriterion ? { acceptanceCriterion: row.acceptanceCriterion.description } : {}),
    uploadedBy: row.uploadedBy.displayName,
    uploadedAt: row.uploadedAt.toISOString(),
    ...(row.capturedAt ? { capturedAt: row.capturedAt.toISOString() } : {}),
    downloadPath: `/api/v1/projects/${encodeURIComponent(projectSlug)}/milestones/${milestoneId}/submissions/${row.submissionId}/evidence/${row.id}/download`,
  };
}

function mapSubmission(row: SubmissionRow, canEdit: boolean): MilestoneSubmissionRecord {
  const decision = row.decision;
  const changeRequest = decision?.changeRequest;
  const response = row.changeRequestResponse;
  return {
    id: row.id,
    projectId: row.milestone.project.slug,
    milestoneId: row.milestoneId,
    milestoneSequenceNumber: row.milestone.sequenceNumber,
    milestoneName: row.milestone.name,
    submissionNumber: row.submissionNumber,
    status: row.status === DbSubmissionStatus.SUBMITTED ? "submitted" : "draft",
    ...(row.notes ? { notes: row.notes } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.submittedAt ? { submittedAt: row.submittedAt.toISOString() } : {}),
    submittedBy: row.submittedBy.displayName,
    agreementVersionId: row.agreementVersionId,
    agreementVersion: agreementVersionLabel(row.agreementVersion.versionNumber),
    evidence: row.evidenceItems.map((item) => mapEvidence(item, row.milestone.project.slug, row.milestoneId)),
    canEdit: canEdit && row.status === DbSubmissionStatus.DRAFT,
    ...(decision ? {
      decision: {
        id: decision.id,
        action: decision.action === DecisionAction.APPROVE ? "approve" : decision.action === DecisionAction.REQUEST_CHANGES ? "request-changes" : "raise-dispute",
        decidedBy: decision.decidedBy.displayName,
        decidedAt: decision.decidedAt.toISOString(),
        reference: decision.reference,
      },
    } : {}),
    ...(changeRequest ? {
      changeRequest: {
        id: changeRequest.id, reasonCategory: changeRequest.reason, requiredChanges: changeRequest.comment,
        reason: changeRequest.reason,
        comment: changeRequest.comment,
        responseDueAt: changeRequest.responseDueAt.toISOString(),
        requestedBy: decision!.decidedBy.displayName,
        requestedAt: decision!.decidedAt.toISOString(),
        decisionReference: decision!.reference,
        acceptanceCriterionIds: changeRequest.acceptanceCriteria.map((item) => item.acceptanceCriterionId),
        evidenceItemIds: changeRequest.evidenceItems.map((item) => item.evidenceItemId),
      },
    } : {}),
    ...(response ? {
      responseToChangeRequest: {
        id: response.id,
        changeRequestId: response.changeRequestId,
        response: response.response,
        respondedBy: response.respondedBy.displayName,
        respondedAt: response.createdAt.toISOString(),
      },
    } : {}),
  };
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

        const agreementContent: AgreementContent = {
          title: input.agreement.title,
          scope: input.agreement.scope,
          terms: input.agreement.terms,
          currency: input.currencyCode.toUpperCase(),
          projectValue: money(agreedValueMinor),
          milestones: input.milestones.map((milestone, index) => ({
            sequenceNumber: index + 1,
            name: milestone.name,
            ...(milestone.description ? { description: milestone.description } : {}),
            value: milestone.value,
            acceptanceCriteria: milestone.acceptanceCriteria,
          })),
        };
        await tx.agreementVersion.create({
          data: {
            projectId: project.id,
            versionNumber: 1,
            status: "DRAFT",
            content: agreementContent as unknown as Prisma.InputJsonValue,
            contentHash: createHash("sha256").update(canonicalAgreementContent(agreementContent)).digest("hex"),
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

  async listAgreements(projectId: string, userId: string): Promise<AgreementVersion[]> {
    const project = await this.prisma.project.findFirst({
      where: { slug: projectId, OR: projectAccess(userId) },
      select: { id: true },
    });
    if (!project) return [];
    const agreements = await this.prisma.agreementVersion.findMany({
      where: { projectId: project.id },
      include: agreementInclude,
      orderBy: { versionNumber: "desc" },
    });
    return agreements.map(mapAgreement);
  }

  async findAgreement(
    projectId: string,
    agreementId: string,
    userId: string,
  ): Promise<AgreementVersion | null> {
    const agreement = await this.prisma.agreementVersion.findFirst({
      where: {
        id: agreementId,
        project: { slug: projectId, OR: projectAccess(userId) },
      },
      include: agreementInclude,
    });
    return agreement ? mapAgreement(agreement) : null;
  }

  async createSubmission(
    projectId: string,
    milestoneId: string,
    notes: string | undefined,
    userId: string,
  ): Promise<MilestoneSubmissionRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const project = await tx.project.findFirst({
          where: {
            slug: projectId,
            owningOrganization: {
              memberships: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } },
            },
          },
          include: {
            agreementVersions: {
              where: { status: DbAgreementStatus.ACTIVE },
              include: { acceptances: true },
            },
            milestones: { where: { id: milestoneId }, include: { submissions: true } },
          },
        });
        if (!project) throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
        const milestone = project.milestones[0];
        if (!milestone) throw new DomainError("Milestone not found", 404, "MILESTONE_NOT_FOUND");
        const agreement = project.agreementVersions.find((item) => item.acceptances.length > 0);
        if (!agreement) {
          throw new DomainError(
            "A recorded agreement acceptance is required before evidence can be submitted",
            409,
            "AGREEMENT_NOT_ACCEPTED",
          );
        }
        const existingDraft = milestone.submissions.find((item) => item.status === DbSubmissionStatus.DRAFT);
        if (existingDraft) {
          return mapSubmission(
            await tx.milestoneSubmission.findUniqueOrThrow({
              where: { id: existingDraft.id },
              include: submissionInclude,
            }),
            true,
          );
        }
        if (milestone.submissions.some((item) => item.status === DbSubmissionStatus.SUBMITTED)) {
          throw new DomainError(
            "This milestone already has a submitted evidence package",
            409,
            "MILESTONE_ALREADY_SUBMITTED",
          );
        }
        if (milestone.status !== DbMilestoneStatus.NOT_STARTED && milestone.status !== DbMilestoneStatus.IN_PROGRESS) {
          throw new DomainError(
            "This milestone cannot receive a new evidence submission in its current state",
            409,
            "MILESTONE_NOT_SUBMITTABLE",
          );
        }
        const latest = await tx.milestoneSubmission.aggregate({
          where: { milestoneId: milestone.id },
          _max: { submissionNumber: true },
        });
        const created = await tx.milestoneSubmission.create({
          data: {
            milestoneId: milestone.id,
            agreementVersionId: agreement.id,
            submissionNumber: (latest._max.submissionNumber ?? 0) + 1,
            submittedByUserId: userId,
            ...(notes ? { notes } : {}),
          },
          include: submissionInclude,
        });
        if (milestone.status === DbMilestoneStatus.NOT_STARTED) {
          await tx.milestone.update({
            where: { id: milestone.id },
            data: { status: DbMilestoneStatus.IN_PROGRESS },
          });
        }
        return mapSubmission(created, true);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
        throw new DomainError("A submission was created concurrently; retry safely", 409, "SUBMISSION_CONFLICT");
      }
      throw error;
    }
  }

  async updateSubmissionNotes(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    notes: string | undefined,
    userId: string,
  ): Promise<MilestoneSubmissionRecord> {
    const submission = await this.prisma.milestoneSubmission.findFirst({
      where: {
        id: submissionId,
        milestoneId,
        status: DbSubmissionStatus.DRAFT,
        milestone: {
          project: {
            slug: projectId,
            owningOrganization: {
              memberships: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } },
            },
          },
        },
      },
      select: { id: true },
    });
    if (!submission) throw new DomainError("Submission not found", 404, "SUBMISSION_NOT_FOUND");
    return mapSubmission(
      await this.prisma.milestoneSubmission.update({
        where: { id: submission.id },
        data: { notes: notes || null },
        include: submissionInclude,
      }),
      true,
    );
  }

  async respondToChangeRequest(
    projectId: string,
    milestoneId: string,
    changeRequestId: string,
    input: RespondToChangeRequestInput,
    userId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MilestoneSubmissionRecord & { replayed?: boolean }> {
    const scope = `change-request-response:${userId}`;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ projectId, milestoneId, changeRequestId, input }))
      .digest("hex");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingKey = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key: idempotencyKey } } });
        if (existingKey) {
          if (existingKey.requestHash !== requestHash) throw new DomainError("This idempotency key was used for another request", 409, "IDEMPOTENCY_KEY_REUSED");
          if (existingKey.responseBody) return { ...(existingKey.responseBody as unknown as MilestoneSubmissionRecord), replayed: true };
          throw new DomainError("This change-request response is already being processed", 409, "IDEMPOTENCY_IN_PROGRESS");
        }
        await tx.idempotencyKey.create({
          data: { userId, scope, key: idempotencyKey, requestHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
        });
        const changeRequest = await tx.changeRequest.findFirst({
          where: {
            id: changeRequestId,
            decision: {
              action: DecisionAction.REQUEST_CHANGES,
              submission: {
                milestoneId,
                milestone: {
                  status: DbMilestoneStatus.CHANGES_REQUESTED,
                  project: { slug: projectId, owningOrganization: { memberships: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } } } },
                },
              },
            },
          },
          include: { decision: { include: { submission: { include: { milestone: { include: { project: true } } } } } }, response: true },
        });
        if (!changeRequest) throw new DomainError("Change request not found", 404, "CHANGE_REQUEST_NOT_FOUND");
        if (changeRequest.response) throw new DomainError("This change request has already received a response", 409, "CHANGE_REQUEST_ALREADY_RESPONDED");
        const project = changeRequest.decision.submission.milestone.project;
        const agreement = await tx.agreementVersion.findFirst({
          where: { projectId: project.id, status: DbAgreementStatus.ACTIVE, acceptances: { some: {} } },
          orderBy: { versionNumber: "desc" },
        });
        if (!agreement) throw new DomainError("A recorded agreement acceptance is required before resubmission", 409, "AGREEMENT_NOT_ACCEPTED");
        const existingDraft = await tx.milestoneSubmission.findFirst({ where: { milestoneId, status: DbSubmissionStatus.DRAFT } });
        if (existingDraft) throw new DomainError("A resubmission draft already exists", 409, "RESUBMISSION_DRAFT_EXISTS");
        const latest = await tx.milestoneSubmission.aggregate({ where: { milestoneId }, _max: { submissionNumber: true } });
        const created = await tx.milestoneSubmission.create({
          data: {
            milestoneId,
            agreementVersionId: agreement.id,
            submissionNumber: (latest._max.submissionNumber ?? 0) + 1,
            submittedByUserId: userId,
            ...(input.notes ? { notes: input.notes } : {}),
          },
        });
        const response = await tx.changeRequestResponse.create({
          data: { changeRequestId, resubmissionId: created.id, respondedByUserId: userId, response: input.response },
          include: { respondedBy: true },
        });
        const actor = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        await tx.activityEvent.create({
          data: {
            projectId: project.id, milestoneId, actorUserId: userId, actorOrganizationId: project.owningOrganizationId,
            actorName: actor.displayName, actorType: "sme", type: DbActivityType.CHANGE_REQUEST_RESPONDED,
            description: `Response recorded for change request; evidence submission ${(latest._max.submissionNumber ?? 0) + 1} opened for resubmission`,
            payload: { changeRequestId, responseId: response.id, resubmissionId: created.id, requestId },
          },
        });
        const mapped = mapSubmission(await tx.milestoneSubmission.findUniqueOrThrow({ where: { id: created.id }, include: submissionInclude }), true);
        await tx.idempotencyKey.update({
          where: { scope_key: { scope, key: idempotencyKey } },
          data: { responseStatus: 201, responseBody: mapped as unknown as Prisma.InputJsonValue },
        });
        return mapped;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
        throw new DomainError("This change request changed before the response completed", 409, "CHANGE_REQUEST_STALE");
      }
      throw error;
    }
  }

  async listSubmissions(
    projectId: string,
    milestoneId: string,
    userId: string,
  ): Promise<MilestoneSubmissionRecord[]> {
    const project = await this.prisma.project.findFirst({
      where: { slug: projectId, OR: projectAccess(userId) },
      select: {
        id: true,
        owningOrganization: {
          select: { memberships: { where: { userId }, select: { role: true } } },
        },
        milestones: { where: { id: milestoneId }, select: { id: true } },
      },
    });
    if (!project) throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
    if (!project.milestones[0]) throw new DomainError("Milestone not found", 404, "MILESTONE_NOT_FOUND");
    const canEdit = project.owningOrganization.memberships.some((membership) =>
      ["OWNER", "ADMIN"].includes(membership.role),
    );
    const rows = await this.prisma.milestoneSubmission.findMany({
      where: {
        milestoneId,
        ...(!canEdit ? { status: DbSubmissionStatus.SUBMITTED } : {}),
      },
      include: submissionInclude,
      orderBy: { submissionNumber: "desc" },
    });
    return rows.map((row) => mapSubmission(row, canEdit));
  }

  async findSubmission(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    userId: string,
  ): Promise<MilestoneSubmissionRecord | null> {
    const project = await this.prisma.project.findFirst({
      where: { slug: projectId, OR: projectAccess(userId) },
      select: {
        id: true,
        owningOrganization: {
          select: { memberships: { where: { userId }, select: { role: true } } },
        },
        milestones: { where: { id: milestoneId }, select: { id: true } },
      },
    });
    if (!project || !project.milestones[0]) return null;
    const canEdit = project.owningOrganization.memberships.some((membership) =>
      ["OWNER", "ADMIN"].includes(membership.role),
    );
    const row = await this.prisma.milestoneSubmission.findFirst({
      where: {
        id: submissionId,
        milestoneId,
        ...(!canEdit ? { status: DbSubmissionStatus.SUBMITTED } : {}),
      },
      include: submissionInclude,
    });
    return row ? mapSubmission(row, canEdit) : null;
  }

  async listChangeRequests(projectId: string, milestoneId: string, userId: string) {
    const milestone = await this.prisma.milestone.findFirst({
      where: { id: milestoneId, project: { slug: projectId, OR: projectAccess(userId) } },
      select: { id: true },
    });
    if (!milestone) throw new DomainError("Milestone not found", 404, "MILESTONE_NOT_FOUND");
    const rows = await this.prisma.changeRequest.findMany({
      where: { decision: { submission: { milestoneId } } },
      include: { decision: { include: { decidedBy: true } }, acceptanceCriteria: true, evidenceItems: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((item) => ({
      id: item.id, reasonCategory: item.reason, reason: item.reason, requiredChanges: item.comment, comment: item.comment,
      responseDueAt: item.responseDueAt.toISOString(), requestedBy: item.decision.decidedBy.displayName,
      requestedAt: item.createdAt.toISOString(), decisionReference: item.decision.reference,
      acceptanceCriterionIds: item.acceptanceCriteria.map((reference) => reference.acceptanceCriterionId),
      evidenceItemIds: item.evidenceItems.map((reference) => reference.evidenceItemId),
    }));
  }

  async addEvidence(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    input: AddEvidenceInput,
    userId: string,
  ): Promise<EvidenceItemRecord> {
    return this.prisma.$transaction(async (tx) => {
      const submission = await tx.milestoneSubmission.findFirst({
        where: {
          id: submissionId,
          milestoneId,
          status: DbSubmissionStatus.DRAFT,
          milestone: {
            project: {
              slug: projectId,
              owningOrganization: {
                memberships: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } },
              },
            },
          },
        },
        include: {
          milestone: { include: { project: true, acceptanceCriteria: true } },
          evidenceItems: { select: { id: true } },
        },
      });
      if (!submission) throw new DomainError("Submission not found", 404, "SUBMISSION_NOT_FOUND");
      if (submission.evidenceItems.length >= DEFAULT_MAX_FILES_PER_SUBMISSION) {
        throw new DomainError(
          `A submission can contain at most ${DEFAULT_MAX_FILES_PER_SUBMISSION} files`,
          409,
          "EVIDENCE_FILE_LIMIT_REACHED",
        );
      }
      if (
        input.acceptanceCriterionId &&
        !submission.milestone.acceptanceCriteria.some((criterion) => criterion.id === input.acceptanceCriterionId)
      ) {
        throw new DomainError("Acceptance criterion not found", 400, "ACCEPTANCE_CRITERION_INVALID");
      }
      const stored = await tx.evidenceItem.aggregate({
        where: {
          submission: {
            milestone: { project: { owningOrganizationId: submission.milestone.project.owningOrganizationId } },
          },
        },
        _sum: { sizeBytes: true },
      });
      if ((stored._sum.sizeBytes ?? 0n) + BigInt(input.sizeBytes) > BigInt(DEFAULT_ORGANIZATION_STORAGE_BYTES)) {
        throw new DomainError("Organization evidence storage quota reached", 413, "ORGANIZATION_STORAGE_QUOTA_REACHED");
      }
      const created = await tx.evidenceItem.create({
        data: {
          submissionId,
          uploadedByUserId: userId,
          storageKey: input.storageKey,
          originalName: input.originalName,
          mimeType: input.mimeType,
          detectedMimeType: input.detectedMimeType,
          sizeBytes: BigInt(input.sizeBytes),
          sha256: input.sha256,
          scanStatus: DbEvidenceScanStatus.CLEAN,
          validatedAt: new Date(),
          ...(input.acceptanceCriterionId ? { acceptanceCriterionId: input.acceptanceCriterionId } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
        },
      });
      const refreshed = await tx.milestoneSubmission.findUniqueOrThrow({
        where: { id: submissionId },
        include: submissionInclude,
      });
      const mapped = refreshed.evidenceItems.find((item) => item.id === created.id);
      if (!mapped) throw new Error("Created evidence could not be loaded");
      return mapEvidence(mapped, projectId, milestoneId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async removeEvidence(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    evidenceId: string,
    userId: string,
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const evidence = await tx.evidenceItem.findFirst({
        where: {
          id: evidenceId,
          submissionId,
          submission: {
            milestoneId,
            status: DbSubmissionStatus.DRAFT,
            milestone: {
              project: {
                slug: projectId,
                owningOrganization: {
                  memberships: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } },
                },
              },
            },
          },
        },
      });
      if (!evidence) throw new DomainError("Evidence not found", 404, "EVIDENCE_NOT_FOUND");
      await tx.evidenceItem.delete({ where: { id: evidence.id } });
      return evidence.storageKey;
    });
  }

  async submitSubmission(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    userId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MilestoneSubmissionRecord & { replayed?: boolean }> {
    const scope = `evidence-submit:${userId}`;
    const requestHash = createHash("sha256").update(`${projectId}:${milestoneId}:${submissionId}`).digest("hex");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingKey = await tx.idempotencyKey.findUnique({
          where: { scope_key: { scope, key: idempotencyKey } },
        });
        if (existingKey) {
          if (existingKey.requestHash !== requestHash) {
            throw new DomainError("This idempotency key was used for another request", 409, "IDEMPOTENCY_KEY_REUSED");
          }
          if (existingKey.responseBody) {
            return { ...(existingKey.responseBody as unknown as MilestoneSubmissionRecord), replayed: true };
          }
          throw new DomainError("This submission is already being processed", 409, "IDEMPOTENCY_IN_PROGRESS");
        }
        await tx.idempotencyKey.create({
          data: {
            userId,
            scope,
            key: idempotencyKey,
            requestHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        const submission = await tx.milestoneSubmission.findFirst({
          where: {
            id: submissionId,
            milestoneId,
            status: DbSubmissionStatus.DRAFT,
            milestone: {
              project: {
                slug: projectId,
                owningOrganization: {
                  memberships: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } },
                },
              },
            },
          },
          include: {
            milestone: { include: { project: { include: { parties: true } } } },
            agreementVersion: { include: { acceptances: true } },
            evidenceItems: true,
            submittedBy: true,
          },
        });
        if (!submission) throw new DomainError("Submission not found", 404, "SUBMISSION_NOT_FOUND");
        if (submission.agreementVersion.status !== DbAgreementStatus.ACTIVE || submission.agreementVersion.acceptances.length === 0) {
          throw new DomainError("The governing agreement is not active", 409, "AGREEMENT_NOT_ACCEPTED");
        }
        if (submission.evidenceItems.length === 0) {
          throw new DomainError("Add at least one evidence file before submitting", 409, "EVIDENCE_REQUIRED");
        }
        if (submission.evidenceItems.some((item) => item.scanStatus !== DbEvidenceScanStatus.CLEAN)) {
          throw new DomainError("Every evidence file must pass validation before submission", 409, "EVIDENCE_NOT_READY");
        }
        const submittedAt = new Date();
        const updated = await tx.milestoneSubmission.updateMany({
          where: { id: submission.id, status: DbSubmissionStatus.DRAFT },
          data: { status: DbSubmissionStatus.SUBMITTED, submittedAt },
        });
        if (updated.count !== 1) throw new DomainError("This submission is no longer editable", 409, "SUBMISSION_ALREADY_FINALIZED");
        const milestoneUpdated = await tx.milestone.updateMany({
          where: {
            id: milestoneId,
            OR: [
              { status: DbMilestoneStatus.IN_PROGRESS },
              { status: DbMilestoneStatus.CHANGES_REQUESTED, submissions: { some: { id: submission.id, changeRequestResponse: { is: { } } } } },
            ],
          },
          data: { status: DbMilestoneStatus.AWAITING_DECISION },
        });
        if (milestoneUpdated.count !== 1) {
          throw new DomainError("This milestone cannot be submitted in its current state", 409, "MILESTONE_NOT_SUBMITTABLE");
        }
        const reference = `TP-EVD-${randomUUID().slice(0, 8)}`.toUpperCase();
        await tx.activityEvent.create({
          data: {
            projectId: submission.milestone.project.id,
            milestoneId,
            actorUserId: userId,
            actorOrganizationId: submission.milestone.project.owningOrganizationId,
            actorName: submission.submittedBy.displayName,
            actorType: "sme",
            type: DbActivityType.EVIDENCE_SUBMITTED,
            description: `Evidence submission ${submission.submissionNumber} recorded for Milestone ${submission.milestone.sequenceNumber} — ${submission.milestone.name}`,
            reference,
            payload: {
              submissionId,
              agreementVersionId: submission.agreementVersionId,
              evidenceCount: submission.evidenceItems.length,
              resultingState: "AWAITING_DECISION",
              requestId,
              actorRole: "SME_ADMIN",
              source: "web",
            },
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: "submission",
            aggregateId: submissionId,
            eventType: DbActivityType.EVIDENCE_SUBMITTED,
            payload: { projectId, milestoneId, submissionId, reference },
          },
        });
        const customer = submission.milestone.project.parties.find((party) => party.role === ProjectPartyRole.CUSTOMER);
        if (customer) {
          await tx.notification.create({
            data: {
              organizationId: customer.organizationId,
              ...(customer.authorizedApproverUserId ? { userId: customer.authorizedApproverUserId } : {}),
              channel: "in-app",
              subject: `Evidence ready for Milestone ${submission.milestone.sequenceNumber}`,
              body: `Submission ${submission.submissionNumber} is ready for review.`,
            },
          });
        }
        const refreshed = await tx.milestoneSubmission.findUniqueOrThrow({
          where: { id: submissionId },
          include: submissionInclude,
        });
        const result = mapSubmission(refreshed, false);
        await tx.idempotencyKey.update({
          where: { scope_key: { scope, key: idempotencyKey } },
          data: { responseStatus: 201, responseBody: result as unknown as Prisma.InputJsonValue },
        });
        return result;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
        throw new DomainError("This submission changed before completion", 409, "SUBMISSION_CONFLICT");
      }
      throw error;
    }
  }

  async findEvidenceDownload(
    projectId: string,
    milestoneId: string,
    submissionId: string,
    evidenceId: string,
    userId: string,
  ): Promise<EvidenceDownloadRecord | null> {
    const project = await this.prisma.project.findFirst({
      where: { slug: projectId, OR: projectAccess(userId) },
      select: {
        id: true,
        owningOrganization: {
          select: { memberships: { where: { userId }, select: { role: true } } },
        },
      },
    });
    if (!project) return null;
    const canReadDraft = project.owningOrganization.memberships.some((membership) =>
      ["OWNER", "ADMIN"].includes(membership.role),
    );
    const evidence = await this.prisma.evidenceItem.findFirst({
      where: {
        id: evidenceId,
        submissionId,
        scanStatus: DbEvidenceScanStatus.CLEAN,
        submission: {
          milestoneId,
          ...(!canReadDraft ? { status: DbSubmissionStatus.SUBMITTED } : {}),
          milestone: { projectId: project.id },
        },
      },
    });
    if (!evidence) return null;
    const sizeBytes = Number(evidence.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes)) throw new Error("Evidence size exceeds JavaScript's safe integer range");
    return {
      id: evidence.id,
      storageKey: evidence.storageKey,
      originalName: evidence.originalName,
      mimeType: evidence.detectedMimeType,
      sizeBytes,
      sha256: evidence.sha256,
    };
  }

  async listEvidenceStorageKeys(): Promise<string[]> {
    const rows = await this.prisma.evidenceItem.findMany({ select: { storageKey: true } });
    return rows.map((row) => row.storageKey);
  }

  async createAgreementVersion(
    projectId: string,
    input: CreateAgreementVersionInput,
    userId: string,
  ): Promise<AgreementVersion> {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: {
          slug: projectId,
          owningOrganization: {
            memberships: { some: { userId, role: { in: ["OWNER", "ADMIN"] } } },
          },
        },
        include: { owningOrganization: true },
      });
      if (!project) throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");

      const base = await tx.agreementVersion.findFirst({
        where: {
          id: input.baseVersionId,
          projectId: project.id,
          status: DbAgreementStatus.AMENDMENT_REQUESTED,
        },
        include: agreementInclude,
      });
      if (!base) {
        throw new DomainError(
          "This agreement is no longer awaiting an amendment",
          409,
          "AGREEMENT_VERSION_STALE",
        );
      }
      const baseContent = agreementContentFromJson(base.content);
      if (!baseContent) throw new DomainError("Agreement content is invalid", 409, "AGREEMENT_INVALID");
      const content: AgreementContent = {
        ...baseContent,
        title: input.title,
        scope: input.scope,
        terms: input.terms,
        // The schedule is copied from the authoritative original snapshot, never inferred from a UI array position.
        milestones: baseContent.milestones.map((milestone) => ({ ...milestone, acceptanceCriteria: [...milestone.acceptanceCriteria] })),
      };
      const latest = await tx.agreementVersion.aggregate({
        where: { projectId: project.id },
        _max: { versionNumber: true },
      });
      const superseded = await tx.agreementVersion.updateMany({
        where: { id: base.id, status: DbAgreementStatus.AMENDMENT_REQUESTED },
        data: { status: DbAgreementStatus.SUPERSEDED },
      });
      if (superseded.count !== 1) {
        throw new DomainError("This agreement changed before it could be amended", 409, "AGREEMENT_VERSION_STALE");
      }
      const createdAgreement = await tx.agreementVersion.create({
        data: {
          projectId: project.id,
          versionNumber: (latest._max.versionNumber ?? 0) + 1,
          status: DbAgreementStatus.DRAFT,
          content: content as unknown as Prisma.InputJsonValue,
          contentHash: createHash("sha256").update(canonicalAgreementContent(content)).digest("hex"),
          createdByUserId: userId,
        },
      });
      const created = await tx.agreementVersion.findUniqueOrThrow({
        where: { id: createdAgreement.id },
        include: agreementInclude,
      });
      const actor = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      await tx.activityEvent.create({
        data: {
          projectId: project.id,
          actorUserId: userId,
          actorOrganizationId: project.owningOrganizationId,
          actorName: actor.displayName,
          actorType: "sme",
          type: DbActivityType.AGREEMENT_SENT,
          description: `Agreement ${agreementVersionLabel(created.versionNumber)} created in response to an amendment request`,
          payload: { agreementVersionId: created.id, replacesAgreementVersionId: base.id, source: "web" },
        },
      });
      return mapAgreement(created);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async recordAgreementDecision(
    projectId: string,
    agreementId: string,
    decision: AgreementDecisionInput,
    userId: string,
    idempotencyKey: string,
    metadata: { ipAddress?: string; userAgent?: string },
  ): Promise<AgreementDecisionResult> {
    const requestHash = createHash("sha256").update(JSON.stringify(decision)).digest("hex");
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingKey = await tx.idempotencyKey.findUnique({
          where: { scope_key: { scope: `agreement-decision:${userId}`, key: idempotencyKey } },
        });
        if (existingKey) {
          if (existingKey.requestHash !== requestHash) {
            throw new DomainError("This idempotency key was used for a different request", 409, "IDEMPOTENCY_KEY_REUSED");
          }
          if (existingKey.responseBody) {
            return { ...(existingKey.responseBody as unknown as AgreementDecisionResult), replayed: true };
          }
          throw new DomainError("This request is already being processed", 409, "IDEMPOTENCY_IN_PROGRESS");
        }
        await tx.idempotencyKey.create({
          data: {
            userId,
            scope: `agreement-decision:${userId}`,
            key: idempotencyKey,
            requestHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });

        const project = await tx.project.findFirst({
          where: { slug: projectId, OR: projectAccess(userId) },
          include: { parties: { include: { organization: true, authorizedApprover: true } } },
        });
        if (!project) throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
        const customer = project.parties.find((party) => party.role === ProjectPartyRole.CUSTOMER);
        if (!customer?.authorizedApproverUserId || !customer.authorizedApprover) {
          throw new DomainError("No authorized customer approver is assigned", 409, "APPROVER_NOT_ASSIGNED");
        }
        if (customer.authorizedApproverUserId !== userId) {
          throw new DomainError("Only the authorized customer approver can decide on this agreement", 403, "AGREEMENT_DECISION_FORBIDDEN");
        }
        if (decision.expectedVersionId !== agreementId) {
          throw new DomainError("The agreement version is stale", 409, "AGREEMENT_VERSION_STALE");
        }
        const agreement = await tx.agreementVersion.findFirst({
          where: { id: agreementId, projectId: project.id },
          include: agreementInclude,
        });
        if (!agreement) throw new DomainError("Agreement not found", 404, "AGREEMENT_NOT_FOUND");
        if (agreement.status !== DbAgreementStatus.DRAFT) {
          throw new DomainError("This agreement version is no longer awaiting a decision", 409, "AGREEMENT_VERSION_STALE");
        }

        const reference = `TP-AGR-${randomUUID().slice(0, 8)}`.toUpperCase();
        let eventType: DbActivityType;
        let description: string;
        if (decision.action === "accept") {
          const activated = await tx.agreementVersion.updateMany({
            where: { id: agreement.id, status: DbAgreementStatus.DRAFT },
            data: { status: DbAgreementStatus.ACTIVE },
          });
          if (activated.count !== 1) throw new DomainError("This agreement changed before acceptance", 409, "AGREEMENT_VERSION_STALE");
          await tx.agreementAcceptance.create({
            data: {
              agreementVersionId: agreement.id,
              organizationId: customer.organizationId,
              acceptedByUserId: userId,
              reference,
              ...(metadata.ipAddress ? { ipAddress: metadata.ipAddress } : {}),
              ...(metadata.userAgent ? { userAgent: metadata.userAgent.slice(0, 512) } : {}),
            },
          });
          eventType = DbActivityType.AGREEMENT_ACCEPTED;
          description = `Agreement ${agreementVersionLabel(agreement.versionNumber)} acceptance recorded by ${customer.authorizedApprover.displayName}`;
        } else {
          const requested = await tx.agreementVersion.updateMany({
            where: { id: agreement.id, status: DbAgreementStatus.DRAFT },
            data: { status: DbAgreementStatus.AMENDMENT_REQUESTED },
          });
          if (requested.count !== 1) throw new DomainError("This agreement changed before the amendment request", 409, "AGREEMENT_VERSION_STALE");
          await tx.agreementAmendmentRequest.create({
            data: {
              agreementVersionId: agreement.id,
              organizationId: customer.organizationId,
              requestedByUserId: userId,
              reason: decision.reason,
              reference,
            },
          });
          eventType = DbActivityType.AGREEMENT_AMENDMENT_REQUESTED;
          description = `Amendment requested for agreement ${agreementVersionLabel(agreement.versionNumber)}: ${decision.reason}`;
        }
        const event = await tx.activityEvent.create({
          data: {
            projectId: project.id,
            actorUserId: userId,
            actorOrganizationId: customer.organizationId,
            actorName: customer.authorizedApprover.displayName,
            actorType: "customer",
            type: eventType,
            description,
            reference,
            payload: { agreementVersionId: agreement.id, actorRole: "APPROVER", source: "web" },
          },
          include: { milestone: true },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: "agreement",
            aggregateId: agreement.id,
            eventType,
            payload: { projectId: project.slug, agreementVersionId: agreement.id, action: decision.action, reference },
          },
        });
        const refreshed = await tx.agreementVersion.findUniqueOrThrow({ where: { id: agreement.id }, include: agreementInclude });
        const result: AgreementDecisionResult = { agreement: mapAgreement(refreshed), event: mapActivity(event, project.slug) };
        await tx.idempotencyKey.update({
          where: { scope_key: { scope: `agreement-decision:${userId}`, key: idempotencyKey } },
          data: { responseStatus: 201, responseBody: result as unknown as Prisma.InputJsonValue },
        });
        return result;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
        throw new DomainError("This agreement changed before the request completed", 409, "AGREEMENT_VERSION_STALE");
      }
      throw error;
    }
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
            agreementVersions: {
              where: { status: DbAgreementStatus.ACTIVE },
              include: { acceptances: true },
            },
            milestones: {
              where: { id: milestoneId },
              include: {
                acceptanceCriteria: { select: { id: true } },
                submissions: {
                  where: { status: DbSubmissionStatus.SUBMITTED },
                  orderBy: { submissionNumber: "desc" },
                  take: 1,
                  include: { evidenceItems: { select: { id: true } } },
                },
              },
            },
          },
        });
        if (!project) {
          throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
        }
        if (!project.agreementVersions.some((agreement) => agreement.acceptances.length > 0)) {
          throw new DomainError(
            "A recorded agreement acceptance is required before milestone decisions",
            409,
            "AGREEMENT_NOT_ACCEPTED",
          );
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
        if (decision.action === "request-changes") {
          const criterionIds = new Set(milestone.acceptanceCriteria.map((criterion) => criterion.id));
          const evidenceIds = new Set(submission.evidenceItems.map((evidence) => evidence.id));
          if ((decision.acceptanceCriterionIds ?? []).some((id) => !criterionIds.has(id))) {
            throw new DomainError("A referenced acceptance criterion does not belong to this milestone", 400, "CHANGE_REQUEST_CRITERION_INVALID");
          }
          if ((decision.evidenceItemIds ?? []).some((id) => !evidenceIds.has(id))) {
            throw new DomainError("A referenced evidence item does not belong to this submission", 400, "CHANGE_REQUEST_EVIDENCE_INVALID");
          }
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
              ...(decision.acceptanceCriterionIds?.length
                ? { acceptanceCriteria: { create: decision.acceptanceCriterionIds.map((acceptanceCriterionId) => ({ acceptanceCriterionId })) } }
                : {}),
              ...(decision.evidenceItemIds?.length
                ? { evidenceItems: { create: decision.evidenceItemIds.map((evidenceItemId) => ({ evidenceItemId })) } }
                : {}),
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
