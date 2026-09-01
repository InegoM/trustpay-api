import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import createApp from "./app.js";
import { createPrismaClient } from "./database/prisma.js";
import PostgresTrustPayRepository from "./repositories/postgres-trustpay-repository.js";
import PostgresAuthService from "./auth/postgres-auth-service.js";

const testUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = testUrl ? describe : describe.skip;

describeDatabase("TrustPay PostgreSQL persistence", () => {
  if (!testUrl) return;

  const prisma = createPrismaClient(testUrl);

  async function authenticatedApp(email = "omar@example.test") {
    const app = await createApp({
      repository: new PostgresTrustPayRepository(prisma),
      authService: new PostgresAuthService(prisma),
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "TrustPayDemo!2026" },
    });
    expect(login.statusCode).toBe(200);
    return { app, cookie: login.headers["set-cookie"]?.split(";")[0] };
  }

  beforeEach(async () => {
    const invitedUser = await prisma.user.findUnique({
      where: { email: "layla@example.test" },
      select: { id: true },
    });
    if (invitedUser) {
      await prisma.authSession.deleteMany({ where: { userId: invitedUser.id } });
      await prisma.organizationMembership.deleteMany({ where: { userId: invitedUser.id } });
      await prisma.userCredential.deleteMany({ where: { userId: invitedUser.id } });
      await prisma.user.delete({ where: { id: invitedUser.id } });
    }
    await prisma.invitation.updateMany({
      where: { id: "80000000-0000-4000-8000-000000000001" },
      data: { status: "PENDING" },
    });
    const project = await prisma.project.findUniqueOrThrow({
      where: { slug: "cafe-renovation" },
      include: {
        milestones: {
          where: { sequenceNumber: 2 },
          include: { submissions: true },
        },
      },
    });
    const milestone = project.milestones[0];
    if (!milestone) throw new Error("Seeded milestone 2 is missing");
    const submissionIds = milestone.submissions.map((submission) => submission.id);
    const decisions = await prisma.milestoneDecision.findMany({
      where: { submissionId: { in: submissionIds } },
      select: { id: true },
    });
    const decisionIds = decisions.map((decision) => decision.id);

    await prisma.$transaction(async (tx) => {
      await tx.changeRequest.deleteMany({ where: { decisionId: { in: decisionIds } } });
      await tx.dispute.deleteMany({ where: { decisionId: { in: decisionIds } } });
      await tx.milestoneDecision.deleteMany({ where: { id: { in: decisionIds } } });
      await tx.activityEvent.deleteMany({
        where: { projectId: project.id, reference: { not: null } },
      });
      await tx.outboxEvent.deleteMany({
        where: { aggregateType: "milestone", aggregateId: milestone.id },
      });
      await tx.milestone.update({
        where: { id: milestone.id },
        data: { status: "AWAITING_DECISION", completedAt: null },
      });
      await tx.project.update({
        where: { id: project.id },
        data: { approvedValueMinor: 1_800_000n },
      });
    });
  });

  afterAll(async () => prisma.$disconnect());

  it("persists approval, totals, activity and an outbox event", async () => {
    const { app, cookie } = await authenticatedApp();

    const decision = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/40000000-0000-4000-8000-000000000002/decisions",
      payload: { action: "approve" },
      headers: { cookie },
    });
    expect(decision.statusCode).toBe(201);
    expect(decision.json().data).toMatchObject({
      milestone: {
        id: "40000000-0000-4000-8000-000000000002",
        sequenceNumber: 2,
        status: "approved",
      },
      project: { approvedValue: 63_000, outstandingValue: 27_000 },
    });
    await app.close();

    const secondConnection = createPrismaClient(testUrl);
    const persisted = await new PostgresTrustPayRepository(secondConnection).findProject(
      "cafe-renovation",
      "20000000-0000-4000-8000-000000000002",
    );
    const outboxCount = await secondConnection.outboxEvent.count({
      where: { eventType: "MILESTONE_APPROVED" },
    });
    await secondConnection.$disconnect();

    expect(persisted?.milestones[1]?.status).toBe("approved");
    expect(persisted?.approvedValue).toBe(63_000);
    expect(outboxCount).toBeGreaterThan(0);
  });

  it("persists a change request linked to the decision", async () => {
    const { app, cookie } = await authenticatedApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/40000000-0000-4000-8000-000000000002/decisions",
      payload: {
        action: "request-changes",
        reason: "Evidence is incomplete",
        comment: "Please upload close-up evidence of the corrected outlet boxes.",
        responseDate: "2026-08-30",
      },
      headers: { cookie },
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    expect(response.json().data.milestone.status).toBe("changes-requested");
    expect(await prisma.changeRequest.count()).toBe(1);
  });

  it("persists a dispute linked to the decision", async () => {
    const { app, cookie } = await authenticatedApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/40000000-0000-4000-8000-000000000002/decisions",
      payload: {
        action: "raise-dispute",
        reason: "Layout mismatch",
        explanation:
          "The installed electrical layout differs from the accepted drawing.",
      },
      headers: { cookie },
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    expect(response.json().data.milestone.status).toBe("disputed");
    expect(await prisma.dispute.count()).toBe(1);
  });

  it("accepts an invitation, creates membership, and starts a session", async () => {
    const app = await createApp({
      repository: new PostgresTrustPayRepository(prisma),
      authService: new PostgresAuthService(prisma),
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: {
        token: "TRUSTPAY-DEMO-INVITE",
        displayName: "Layla Ahmed",
        password: "LaylaSecure2026",
      },
    });
    expect(accepted.statusCode).toBe(201);
    const cookie = accepted.headers["set-cookie"]?.split(";")[0];
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data).toMatchObject({
      email: "layla@example.test",
      organizations: [{ name: "Alba Fit-Out", role: "MEMBER" }],
    });
    await app.close();
  });

  it("persists project creation and assigns an invited customer approver", async () => {
    const { app, cookie } = await authenticatedApp("nadia@example.test");
    const code = `TEST-${Date.now()}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie },
      payload: {
        name: "API Creation Test",
        code,
        customerName: "Temporary Test Customer",
        currencyCode: "AED",
        agreement: {
          title: "API Creation Test Agreement",
          scope: "Create and verify a complete project structure in PostgreSQL.",
          terms: "Milestones must be reviewed against their recorded acceptance criteria.",
        },
        milestones: [
          {
            name: "Planning",
            value: 2500,
            acceptanceCriteria: ["The approved plan is attached to the project record"],
          },
          {
            name: "Delivery",
            value: 7500,
            acceptanceCriteria: ["The completed work matches the approved plan"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const slug = response.json().data.id as string;
    const created = await prisma.project.findUniqueOrThrow({
      where: { slug },
      include: {
        agreementVersions: true,
        milestones: { include: { acceptanceCriteria: true } },
        activityEvents: true,
        parties: true,
      },
    });
    expect(created.agreedValueMinor).toBe(1_000_000n);
    expect(created.agreementVersions).toMatchObject([{ status: "DRAFT" }]);
    expect(created.milestones).toHaveLength(2);
    expect(created.milestones[0]?.acceptanceCriteria).toHaveLength(1);
    expect(created.activityEvents).toMatchObject([{ type: "PROJECT_CREATED" }]);

    const customerParty = created.parties.find((party) => party.role === "CUSTOMER");
    const invitedEmail = `approver-${Date.now()}@example.test`;
    const invitationResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${slug}/invitations`,
      headers: { cookie },
      payload: { email: invitedEmail },
    });
    expect(invitationResponse.statusCode).toBe(201);
    const invitationToken = invitationResponse.json().data.token as string;
    const invitationId = invitationResponse.json().data.invitation.id as string;
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: {
        token: invitationToken,
        displayName: "Customer Approver",
        password: "CustomerSecure2026",
      },
    });
    expect(accepted.statusCode).toBe(201);
    const customerCookie = accepted.headers["set-cookie"]?.split(";")[0];
    const customerProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${slug}`,
      headers: { cookie: customerCookie },
    });
    expect(customerProject.statusCode).toBe(200);
    expect(customerProject.json().data).toMatchObject({
      authorizedApprover: "Customer Approver",
      agreementStatus: "draft",
    });
    const assignedParty = await prisma.projectParty.findFirstOrThrow({
      where: { projectId: created.id, role: "CUSTOMER" },
    });
    expect(assignedParty.authorizedApproverUserId).not.toBeNull();
    expect(
      await prisma.activityEvent.count({
        where: {
          projectId: created.id,
          type: { in: ["CUSTOMER_INVITED", "CUSTOMER_APPROVER_JOINED"] },
        },
      }),
    ).toBe(2);

    const invitedUser = await prisma.user.findUniqueOrThrow({
      where: { email: invitedEmail },
    });
    await prisma.$transaction(async (tx) => {
      await tx.activityEvent.deleteMany({ where: { projectId: created.id } });
      await tx.outboxEvent.deleteMany({
        where: { aggregateType: "invitation", aggregateId: invitationId },
      });
      await tx.invitation.deleteMany({ where: { projectId: created.id } });
      await tx.acceptanceCriterion.deleteMany({
        where: { milestone: { projectId: created.id } },
      });
      await tx.milestone.deleteMany({ where: { projectId: created.id } });
      await tx.agreementVersion.deleteMany({ where: { projectId: created.id } });
      await tx.projectParty.deleteMany({ where: { projectId: created.id } });
      await tx.project.delete({ where: { id: created.id } });
      await tx.authSession.deleteMany({ where: { userId: invitedUser.id } });
      await tx.organizationMembership.deleteMany({ where: { userId: invitedUser.id } });
      await tx.userCredential.deleteMany({ where: { userId: invitedUser.id } });
      await tx.user.delete({ where: { id: invitedUser.id } });
      if (customerParty) {
        await tx.organization.delete({ where: { id: customerParty.organizationId } });
      }
    });
    await app.close();
  });

  it("persists exactly one authorized agreement acceptance and its immutable history", async () => {
    const { app, cookie: smeCookie } = await authenticatedApp("nadia@example.test");
    const code = `AGR-${Date.now()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie: smeCookie },
      payload: {
        name: "Agreement Acceptance Test",
        code,
        customerName: "Agreement Test Customer",
        currencyCode: "AED",
        agreement: {
          title: "Agreement Acceptance Test Agreement",
          scope: "Record an exact agreement version before any milestone can be submitted.",
          terms: "Only the assigned customer approver can record acceptance of this version.",
        },
        milestones: [{ name: "Initial scope", value: 5000, acceptanceCriteria: ["The documented scope is available"] }],
      },
    });
    expect(created.statusCode).toBe(201);
    const projectSlug = created.json().data.id as string;
    const project = await prisma.project.findUniqueOrThrow({ where: { slug: projectSlug }, include: { parties: true, agreementVersions: true } });
    const agreement = project.agreementVersions[0];
    if (!agreement) throw new Error("Created agreement is missing");
    const invitedEmail = `agreement-approver-${Date.now()}@example.test`;
    const invitation = await app.inject({ method: "POST", url: `/api/v1/projects/${projectSlug}/invitations`, headers: { cookie: smeCookie }, payload: { email: invitedEmail } });
    expect(invitation.statusCode).toBe(201);
    const acceptedInvitation = await app.inject({
      method: "POST", url: "/api/v1/invitations/accept",
      payload: { token: invitation.json().data.token, displayName: "Agreement Approver", password: "AgreementSecure2026" },
    });
    const customerCookie = acceptedInvitation.headers["set-cookie"]?.split(";")[0];
    const acceptance = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectSlug}/agreements/${agreement.id}/decisions`,
      headers: { cookie: customerCookie, "idempotency-key": "gggggggggggggggg" },
      payload: { action: "accept", authorityConfirmed: true, expectedVersionId: agreement.id },
    });
    expect(acceptance.statusCode).toBe(201);
    expect(acceptance.json().data).toMatchObject({
      agreement: { id: agreement.id, status: "active", acceptance: { acceptedBy: "Agreement Approver" } },
      event: { type: "agreement-accepted" },
    });
    const persisted = await prisma.agreementVersion.findUniqueOrThrow({
      where: { id: agreement.id },
      include: { acceptances: true, amendmentRequests: true },
    });
    expect(persisted.status).toBe("ACTIVE");
    expect(persisted.acceptances).toHaveLength(1);
    expect(persisted.acceptances[0]?.reference).toMatch(/^TP-AGR-/);
    expect(persisted.amendmentRequests).toHaveLength(0);

    const invitedUser = await prisma.user.findUniqueOrThrow({ where: { email: invitedEmail } });
    const customerParty = project.parties.find((party) => party.role === "CUSTOMER");
    await prisma.$transaction(async (tx) => {
      await tx.activityEvent.deleteMany({ where: { projectId: project.id } });
      await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: [agreement.id, invitation.json().data.invitation.id] } } });
      await tx.idempotencyKey.deleteMany({ where: { userId: invitedUser.id } });
      await tx.invitation.deleteMany({ where: { projectId: project.id } });
      await tx.agreementAcceptance.deleteMany({ where: { agreementVersionId: agreement.id } });
      await tx.acceptanceCriterion.deleteMany({ where: { milestone: { projectId: project.id } } });
      await tx.milestone.deleteMany({ where: { projectId: project.id } });
      await tx.agreementVersion.deleteMany({ where: { projectId: project.id } });
      await tx.projectParty.deleteMany({ where: { projectId: project.id } });
      await tx.project.delete({ where: { id: project.id } });
      await tx.authSession.deleteMany({ where: { userId: invitedUser.id } });
      await tx.organizationMembership.deleteMany({ where: { userId: invitedUser.id } });
      await tx.userCredential.deleteMany({ where: { userId: invitedUser.id } });
      await tx.user.delete({ where: { id: invitedUser.id } });
      if (customerParty) await tx.organization.delete({ where: { id: customerParty.organizationId } });
    });
    await app.close();
  });

  it("enforces submitted evidence immutability inside PostgreSQL", async () => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { slug: "cafe-renovation" },
      include: {
        agreementVersions: { where: { status: "ACTIVE" }, take: 1 },
        milestones: { where: { sequenceNumber: 3 }, take: 1 },
      },
    });
    const agreement = project.agreementVersions[0];
    const milestone = project.milestones[0];
    if (!agreement || !milestone) throw new Error("M03 seed prerequisites are missing");
    const nadia = await prisma.user.findUniqueOrThrow({ where: { email: "nadia@example.test" } });

    await expect(
      prisma.$transaction(async (tx) => {
        const record = await tx.milestoneSubmission.create({
          data: {
            milestoneId: milestone.id,
            agreementVersionId: agreement.id,
            submissionNumber: 99,
            status: "DRAFT",
            submittedByUserId: nadia.id,
          },
        });
        await tx.milestoneSubmission.update({
          where: { id: record.id },
          data: { status: "SUBMITTED", submittedAt: new Date() },
        });
        await tx.milestoneSubmission.update({
          where: { id: record.id },
          data: { notes: "This mutation must be rejected" },
        });
      }),
    ).rejects.toThrow(/submitted evidence packages are immutable/);
  });
});
