import "dotenv/config";
import { createHash } from "node:crypto";
import { createPrismaClient } from "../src/database/prisma.js";
import { hashPassword } from "../src/auth/password.js";

const ids = {
  alba: "10000000-0000-4000-8000-000000000001",
  cedar: "10000000-0000-4000-8000-000000000002",
  nadia: "20000000-0000-4000-8000-000000000001",
  omar: "20000000-0000-4000-8000-000000000002",
  project: "30000000-0000-4000-8000-000000000001",
  milestone1: "40000000-0000-4000-8000-000000000001",
  milestone2: "40000000-0000-4000-8000-000000000002",
  milestone3: "40000000-0000-4000-8000-000000000003",
  agreement: "50000000-0000-4000-8000-000000000001",
  submission: "60000000-0000-4000-8000-000000000001",
  invitation: "80000000-0000-4000-8000-000000000001",
} as const;

const prisma = createPrismaClient();

async function main() {
  const demoPassword = "TrustPayDemo!2026";
  await prisma.organization.upsert({
    where: { id: ids.alba },
    update: { name: "Alba Fit-Out", legalName: "Alba Fit-Out LLC" },
    create: {
      id: ids.alba,
      name: "Alba Fit-Out",
      legalName: "Alba Fit-Out LLC",
      registrationNumber: "ALBA-DEMO-001",
      type: "SME",
    },
  });
  await prisma.organization.upsert({
    where: { id: ids.cedar },
    update: { name: "Cedar Café", legalName: "Cedar Café LLC" },
    create: {
      id: ids.cedar,
      name: "Cedar Café",
      legalName: "Cedar Café LLC",
      registrationNumber: "CEDAR-DEMO-001",
      type: "CUSTOMER",
    },
  });

  await prisma.user.upsert({
    where: { id: ids.nadia },
    update: { email: "nadia@example.test", displayName: "Nadia Rahman" },
    create: {
      id: ids.nadia,
      email: "nadia@example.test",
      displayName: "Nadia Rahman",
    },
  });
  await prisma.user.upsert({
    where: { id: ids.omar },
    update: { email: "omar@example.test", displayName: "Omar Hassan" },
    create: {
      id: ids.omar,
      email: "omar@example.test",
      displayName: "Omar Hassan",
    },
  });

  await prisma.organizationMembership.upsert({
    where: {
      organizationId_userId: { organizationId: ids.alba, userId: ids.nadia },
    },
    update: { role: "OWNER" },
    create: {
      organizationId: ids.alba,
      userId: ids.nadia,
      role: "OWNER",
    },
  });

  for (const userId of [ids.nadia, ids.omar]) {
    const password = await hashPassword(demoPassword);
    const credential = {
      passwordHash: password.hash,
      passwordSalt: password.salt,
    };
    await prisma.userCredential.upsert({
      where: { userId },
      update: {},
      create: { userId, ...credential },
    });
  }

  await prisma.invitation.upsert({
    where: { id: ids.invitation },
    update: {
      email: "layla@example.test",
      role: "MEMBER",
      expiresAt: new Date("2027-08-20T23:59:59+04:00"),
    },
    create: {
      id: ids.invitation,
      organizationId: ids.alba,
      email: "layla@example.test",
      role: "MEMBER",
      tokenHash: createHash("sha256")
        .update("TRUSTPAY-DEMO-INVITE")
        .digest("hex"),
      invitedByUserId: ids.nadia,
      expiresAt: new Date("2027-08-20T23:59:59+04:00"),
    },
  });
  await prisma.organizationMembership.upsert({
    where: {
      organizationId_userId: { organizationId: ids.cedar, userId: ids.omar },
    },
    update: { role: "APPROVER" },
    create: {
      organizationId: ids.cedar,
      userId: ids.omar,
      role: "APPROVER",
    },
  });

  await prisma.project.upsert({
    where: { id: ids.project },
    update: {
      name: "Café Renovation",
      agreedValueMinor: 9_000_000n,
    },
    create: {
      id: ids.project,
      owningOrganizationId: ids.alba,
      createdByUserId: ids.nadia,
      code: "CAF-2026-001",
      slug: "cafe-renovation",
      name: "Café Renovation",
      agreedValueMinor: 9_000_000n,
      approvedValueMinor: 1_800_000n,
      currencyCode: "AED",
    },
  });

  for (const party of [
    { organizationId: ids.alba, role: "SME" as const, approver: null },
    { organizationId: ids.cedar, role: "CUSTOMER" as const, approver: ids.omar },
  ]) {
    await prisma.projectParty.upsert({
      where: {
        projectId_organizationId_role: {
          projectId: ids.project,
          organizationId: party.organizationId,
          role: party.role,
        },
      },
      update: { authorizedApproverUserId: party.approver },
      create: {
        projectId: ids.project,
        organizationId: party.organizationId,
        role: party.role,
        authorizedApproverUserId: party.approver,
      },
    });
  }

  const agreementContent = {
    title: "Café Renovation Agreement",
    scope: "Design, structural work, electrical work, finishing and handover",
    currency: "AED",
    projectValueMinor: 9_000_000,
  };
  await prisma.agreementVersion.upsert({
    where: { id: ids.agreement },
    update: { status: "ACTIVE", content: agreementContent },
    create: {
      id: ids.agreement,
      projectId: ids.project,
      versionNumber: 12,
      status: "ACTIVE",
      content: agreementContent,
      contentHash: createHash("sha256")
        .update(JSON.stringify(agreementContent))
        .digest("hex"),
      createdByUserId: ids.nadia,
    },
  });
  await prisma.agreementAcceptance.upsert({
    where: {
      agreementVersionId_organizationId: {
        agreementVersionId: ids.agreement,
        organizationId: ids.cedar,
      },
    },
    update: { acceptedByUserId: ids.omar },
    create: {
      agreementVersionId: ids.agreement,
      organizationId: ids.cedar,
      acceptedByUserId: ids.omar,
      acceptedAt: new Date("2026-08-08T16:05:00+04:00"),
    },
  });

  const milestones = [
    {
      id: ids.milestone1,
      sequenceNumber: 1,
      name: "Design and planning",
      valueMinor: 1_800_000n,
      status: "APPROVED" as const,
      completedAt: new Date("2026-08-10T11:30:00+04:00"),
    },
    {
      id: ids.milestone2,
      sequenceNumber: 2,
      name: "Structural and electrical work",
      valueMinor: 4_500_000n,
      status: "AWAITING_DECISION" as const,
      description:
        "Rough-in phase completed with structural partitions, electrical wiring, and plumbing lines installed.",
      responseDeadline: new Date("2026-08-27T17:00:00+04:00"),
    },
    {
      id: ids.milestone3,
      sequenceNumber: 3,
      name: "Finishing and handover",
      valueMinor: 2_700_000n,
      status: "NOT_STARTED" as const,
    },
  ];
  for (const milestone of milestones) {
    await prisma.milestone.upsert({
      where: { id: milestone.id },
      update: {
        name: milestone.name,
        valueMinor: milestone.valueMinor,
        ...(milestone.description
          ? { description: milestone.description }
          : {}),
        ...(milestone.responseDeadline
          ? { responseDeadline: milestone.responseDeadline }
          : {}),
      },
      create: { ...milestone, projectId: ids.project },
    });
  }

  const criteria = [
    "Structural partitions match the approved layout",
    "Electrical and plumbing rough-in is complete",
    "Submitted evidence clearly shows completed work",
  ];
  for (const [index, description] of criteria.entries()) {
    await prisma.acceptanceCriterion.upsert({
      where: {
        milestoneId_position: {
          milestoneId: ids.milestone2,
          position: index + 1,
        },
      },
      update: { description },
      create: {
        milestoneId: ids.milestone2,
        position: index + 1,
        description,
      },
    });
  }

  await prisma.milestoneSubmission.upsert({
    where: { id: ids.submission },
    update: { notes: "Initial evidence package for customer review" },
    create: {
      id: ids.submission,
      milestoneId: ids.milestone2,
      submissionNumber: 1,
      submittedByUserId: ids.nadia,
      notes: "Initial evidence package for customer review",
      submittedAt: new Date("2026-08-20T09:25:00+04:00"),
    },
  });

  await prisma.activityEvent.upsert({
    where: { id: "70000000-0000-4000-8000-000000000001" },
    update: {},
    create: {
      id: "70000000-0000-4000-8000-000000000001",
      projectId: ids.project,
      milestoneId: ids.milestone2,
      actorUserId: ids.nadia,
      actorOrganizationId: ids.alba,
      actorName: "Nadia Rahman",
      actorType: "sme",
      type: "EVIDENCE_SUBMITTED",
      description: "Evidence submitted for Milestone 2 — 4 items uploaded for customer review",
      occurredAt: new Date("2026-08-20T09:25:00+04:00"),
    },
  });
  await prisma.activityEvent.upsert({
    where: { id: "70000000-0000-4000-8000-000000000002" },
    update: {},
    create: {
      id: "70000000-0000-4000-8000-000000000002",
      projectId: ids.project,
      milestoneId: ids.milestone1,
      actorUserId: ids.omar,
      actorOrganizationId: ids.cedar,
      actorName: "Omar Hassan",
      actorType: "customer",
      type: "MILESTONE_APPROVED",
      description: "Milestone 1 approved — Design and planning",
      occurredAt: new Date("2026-08-10T11:30:00+04:00"),
    },
  });
  await prisma.activityEvent.upsert({
    where: { id: "70000000-0000-4000-8000-000000000003" },
    update: {},
    create: {
      id: "70000000-0000-4000-8000-000000000003",
      projectId: ids.project,
      actorUserId: ids.omar,
      actorOrganizationId: ids.cedar,
      actorName: "Omar Hassan",
      actorType: "customer",
      type: "AGREEMENT_ACCEPTED",
      description: "Agreement v1.2 accepted by Omar Hassan (Cedar Café)",
      occurredAt: new Date("2026-08-08T16:05:00+04:00"),
    },
  });
}

main()
  .then(() => console.log("TrustPay demo data seeded"))
  .finally(async () => prisma.$disconnect());
