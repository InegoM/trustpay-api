import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import createApp from "./app.js";
import EvidenceService from "./evidence/evidence-service.js";
import InMemoryTrustPayRepository from "./repositories/in-memory-trustpay-repository.js";
import InMemoryAuthService from "./auth/in-memory-auth-service.js";
import type { MalwareScanner } from "./storage/malware-scanner.js";
import { AllowAllTestScanner } from "./storage/malware-scanner.js";
import { InMemoryObjectStorage } from "./storage/object-storage.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

function multipartEvidence(
  fields: Record<string, string>,
  file: { name: string; type: string; body: Buffer },
): { payload: Buffer; contentType: string } {
  const boundary = "----trustpay-test-boundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    file.body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function testApp(options: { scanner?: MalwareScanner } = {}) {
  const repository = new InMemoryTrustPayRepository();
  const app = await createApp({
    repository,
    authService: new InMemoryAuthService(),
    evidenceService: new EvidenceService(
      repository,
      new InMemoryObjectStorage(),
      options.scanner ?? new AllowAllTestScanner(),
    ),
  });
  apps.push(app);
  return app;
}

async function login(
  app: Awaited<ReturnType<typeof createApp>>,
  email = "omar@example.test",
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "TrustPayDemo!2026" },
  });
  expect(response.statusCode).toBe(200);
  return response.headers["set-cookie"]?.split(";")[0];
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("TrustPay API", () => {
  it("reports service health", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "trustpay-api" });
  });

  it("returns the seeded project", async () => {
    const app = await testApp();
    const cookie = await login(app, "nadia@example.test");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/cafe-renovation",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      id: "cafe-renovation",
      agreedValue: 90_000,
      approvedValue: 18_000,
    });
  });

  it("approves a milestone and records its audit events", async () => {
    const app = await testApp();
    const cookie = await login(app);
    const decision = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/30000000-0000-4000-8000-000000000002/decisions",
      payload: { action: "approve" },
      headers: { cookie },
    });

    expect(decision.statusCode).toBe(201);
    expect(decision.json().data).toMatchObject({
      milestone: {
        id: "30000000-0000-4000-8000-000000000002",
        sequenceNumber: 2,
        status: "approved",
      },
      project: { approvedValue: 63_000, outstandingValue: 27_000 },
    });

    const activity = await app.inject({
      method: "GET",
      url: "/api/v1/projects/cafe-renovation/activity",
      headers: { cookie },
    });
    expect(activity.json().data.slice(0, 2).map((event: { type: string }) => event.type)).toEqual([
      "milestone-approved",
      "decision-recorded",
    ]);
  });

  it("prevents a second decision for the same milestone", async () => {
    const app = await testApp();
    const cookie = await login(app);
    const request = {
      method: "POST" as const,
      url: "/api/v1/projects/cafe-renovation/milestones/30000000-0000-4000-8000-000000000002/decisions",
      payload: { action: "approve" },
      headers: { cookie },
    };

    expect((await app.inject(request)).statusCode).toBe(201);
    const duplicate = await app.inject(request);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("MILESTONE_NOT_DECIDABLE");
  });

  it("validates dispute details", async () => {
    const app = await testApp();
    const cookie = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/30000000-0000-4000-8000-000000000002/decisions",
      payload: { action: "raise-dispute", reason: "Layout mismatch", explanation: "short" },
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("requires a session for project data", async () => {
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("returns the signed-in user and revokes the session on logout", async () => {
    const app = await testApp();
    const cookie = await login(app, "nadia@example.test");
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(me.json().data).toMatchObject({
      email: "nadia@example.test",
      organizations: [{ name: "Alba Fit-Out", role: "OWNER" }],
    });
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("returns a server-managed session only through an HttpOnly cookie", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nadia@example.test", password: "TrustPayDemo!2026" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).not.toHaveProperty("token");
    expect(response.headers["set-cookie"]).toContain("trustpay_session=");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
  });

  it("blocks an SME user from making the customer's decision", async () => {
    const app = await testApp();
    const cookie = await login(app, "nadia@example.test");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/30000000-0000-4000-8000-000000000002/decisions",
      headers: { cookie },
      payload: { action: "approve" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("DECISION_FORBIDDEN");
  });

  it("does not expose projects to a user from an unrelated organization", async () => {
    const app = await testApp();
    const cookie = await login(app, "samir@bank.example.test");
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([]);
    const project = await app.inject({
      method: "GET",
      url: "/api/v1/projects/cafe-renovation",
      headers: { cookie },
    });
    expect(project.statusCode).toBe(404);

    const milestoneDecision = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/30000000-0000-4000-8000-000000000002/decisions",
      headers: { cookie },
      payload: { action: "approve" },
    });
    expect(milestoneDecision.statusCode).toBe(404);
    expect(milestoneDecision.json().error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("rejects non-UUID milestone route identifiers", async () => {
    const app = await testApp();
    const cookie = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/2/decisions",
      headers: { cookie },
      payload: { action: "approve" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("lets an SME owner create a project, draft agreement, and milestones", async () => {
    const app = await testApp();
    const cookie = await login(app, "nadia@example.test");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie },
      payload: {
        name: "Marina Office Refresh",
        code: "MAR-001",
        customerName: "Harbour Consulting",
        currencyCode: "AED",
        agreement: {
          title: "Marina Office Refresh Agreement",
          scope: "Refresh the reception, meeting rooms, and shared office areas.",
          terms: "Each milestone is reviewed against its acceptance criteria before approval.",
        },
        milestones: [
          {
            name: "Design package",
            description: "Prepare the final layouts and finishes schedule.",
            value: 12_500,
            acceptanceCriteria: ["Customer receives the approved layout and finishes schedule"],
          },
          {
            name: "Fit-out and handover",
            value: 37_500,
            acceptanceCriteria: ["Completed work matches the approved design package"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      name: "Marina Office Refresh",
      customer: "Harbour Consulting",
      agreedValue: 50_000,
      approvedValue: 0,
      agreementStatus: "draft",
      authorizedApprover: "Not yet assigned",
      milestones: [
        { sequenceNumber: 1, value: 12_500, status: "not-started" },
        { sequenceNumber: 2, value: 37_500, status: "not-started" },
      ],
    });
  });

  it("prevents customer users from creating SME projects", async () => {
    const app = await testApp();
    const cookie = await login(app, "omar@example.test");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie },
      payload: {
        name: "Unauthorized Project",
        code: "NO-001",
        customerName: "Example Customer",
        currencyCode: "AED",
        agreement: {
          title: "Unauthorized Agreement",
          scope: "This sufficiently long project scope must not be persisted.",
          terms: "These sufficiently long agreement terms must not be persisted.",
        },
        milestones: [
          {
            name: "Unauthorized milestone",
            value: 1000,
            acceptanceCriteria: ["This criterion must never be stored"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("PROJECT_CREATE_FORBIDDEN");
  });

  it("creates and lists a one-time customer approver invitation", async () => {
    const app = await testApp();
    const cookie = await login(app, "nadia@example.test");
    const project = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie },
      payload: {
        name: "Invitation Workflow Test",
        code: "INV-001",
        customerName: "Invitation Customer",
        currencyCode: "AED",
        agreement: {
          title: "Invitation Workflow Agreement",
          scope: "Prepare a project that can receive a customer approver invitation.",
          terms: "The invited approver must join before the agreement can be accepted.",
        },
        milestones: [
          {
            name: "Initial delivery",
            value: 5000,
            acceptanceCriteria: ["The initial delivery is available for customer review"],
          },
        ],
      },
    });
    const projectId = project.json().data.id as string;
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/invitations`,
      headers: { cookie },
      payload: { email: "approver@invitation.test" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      invitation: {
        projectId,
        email: "approver@invitation.test",
        role: "APPROVER",
        status: "pending",
      },
    });
    expect(created.json().data.token).toBeTypeOf("string");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/invitations`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).not.toHaveProperty("token");
  });

  it("does not create another invitation after an approver is assigned", async () => {
    const app = await testApp();
    const cookie = await login(app, "nadia@example.test");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/invitations",
      headers: { cookie },
      payload: { email: "replacement@example.test" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("APPROVER_ALREADY_ASSIGNED");
  });

  it("lets the assigned customer approver accept one exact draft agreement version", async () => {
    const app = await testApp();
    const cookie = await login(app, "omar@example.test");
    const agreements = await app.inject({
      method: "GET",
      url: "/api/v1/projects/agreement-review/agreements",
      headers: { cookie },
    });
    expect(agreements.statusCode).toBe(200);
    const agreementId = agreements.json().data[0].id as string;
    const acceptance = await app.inject({
      method: "POST",
      url: `/api/v1/projects/agreement-review/agreements/${agreementId}/decisions`,
      headers: { cookie, "idempotency-key": "aaaaaaaaaaaaaaaa" },
      payload: { action: "accept", authorityConfirmed: true, expectedVersionId: agreementId },
    });
    expect(acceptance.statusCode).toBe(201);
    expect(acceptance.json().data).toMatchObject({
      agreement: { id: agreementId, status: "active", acceptance: { acceptedBy: "Omar Hassan", organization: "Cedar Café" } },
      event: { type: "agreement-accepted", projectId: "agreement-review" },
    });
    expect(acceptance.json().data.agreement.acceptance.reference).toMatch(/^TP-AGR-/);
    expect(acceptance.headers["set-cookie"]).toContain("trustpay_session=");
  });

  it("replays an agreement acceptance only for the same idempotency key and rejects duplicates", async () => {
    const app = await testApp();
    const originalCookie = await login(app, "omar@example.test");
    const agreementId = "50000000-0000-4000-8000-000000000002";
    const payload = { action: "accept", authorityConfirmed: true, expectedVersionId: agreementId };
    const first = await app.inject({
      method: "POST", url: `/api/v1/projects/agreement-review/agreements/${agreementId}/decisions`,
      headers: { cookie: originalCookie, "idempotency-key": "bbbbbbbbbbbbbbbb" }, payload,
    });
    const replacementCookie = first.headers["set-cookie"]?.split(";")[0];
    const replay = await app.inject({
      method: "POST", url: `/api/v1/projects/agreement-review/agreements/${agreementId}/decisions`,
      headers: { cookie: replacementCookie, "idempotency-key": "bbbbbbbbbbbbbbbb" }, payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.agreement.acceptance.reference).toBe(first.json().data.agreement.acceptance.reference);
    const duplicate = await app.inject({
      method: "POST", url: `/api/v1/projects/agreement-review/agreements/${agreementId}/decisions`,
      headers: { cookie: replacementCookie, "idempotency-key": "cccccccccccccccc" }, payload,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("AGREEMENT_VERSION_STALE");
  });

  it("records an amendment request and creates an immutable replacement version", async () => {
    const app = await testApp();
    const customerCookie = await login(app, "omar@example.test");
    const agreementId = "50000000-0000-4000-8000-000000000002";
    const requested = await app.inject({
      method: "POST", url: `/api/v1/projects/agreement-review/agreements/${agreementId}/decisions`,
      headers: { cookie: customerCookie, "idempotency-key": "dddddddddddddddd" },
      payload: { action: "request-amendment", reason: "Please clarify the handover criteria.", expectedVersionId: agreementId },
    });
    expect(requested.statusCode).toBe(201);
    expect(requested.json().data.agreement).toMatchObject({ status: "amendment-requested", amendmentRequest: { requestedBy: "Omar Hassan" } });

    const smeCookie = await login(app, "nadia@example.test");
    const replacement = await app.inject({
      method: "POST", url: "/api/v1/projects/agreement-review/agreements", headers: { cookie: smeCookie },
      payload: {
        baseVersionId: agreementId,
        title: "Agreement Review Project Agreement — clarified",
        scope: "Renovate the agreed customer area with the clarified handover scope.",
        terms: "Each milestone is reviewed against its acceptance criteria, including the clarified handover criteria.",
      },
    });
    expect(replacement.statusCode).toBe(201);
    expect(replacement.json().data).toMatchObject({ versionNumber: 2, status: "draft", content: { title: "Agreement Review Project Agreement — clarified" } });
    const history = await app.inject({ method: "GET", url: "/api/v1/projects/agreement-review/agreements", headers: { cookie: smeCookie } });
    expect(history.json().data.map((agreement: { status: string }) => agreement.status)).toEqual(["draft", "superseded"]);
  });

  it("rejects unassigned, cross-organization, stale, and malformed agreement actions", async () => {
    const app = await testApp();
    const agreementId = "50000000-0000-4000-8000-000000000002";
    const smeCookie = await login(app, "nadia@example.test");
    const forbidden = await app.inject({
      method: "POST", url: `/api/v1/projects/agreement-review/agreements/${agreementId}/decisions`,
      headers: { cookie: smeCookie, "idempotency-key": "eeeeeeeeeeeeeeee" },
      payload: { action: "accept", authorityConfirmed: true, expectedVersionId: agreementId },
    });
    expect(forbidden.statusCode).toBe(403);

    const bankCookie = await login(app, "samir@bank.example.test");
    const crossTenant = await app.inject({
      method: "GET", url: `/api/v1/projects/agreement-review/agreements/${agreementId}`, headers: { cookie: bankCookie },
    });
    expect(crossTenant.statusCode).toBe(404);

    const customerCookie = await login(app, "omar@example.test");
    const stale = await app.inject({
      method: "POST", url: `/api/v1/projects/agreement-review/agreements/${agreementId}/decisions`,
      headers: { cookie: customerCookie, "idempotency-key": "ffffffffffffffff" },
      payload: { action: "accept", authorityConfirmed: true, expectedVersionId: "50000000-0000-4000-8000-000000000001" },
    });
    expect(stale.statusCode).toBe(409);
    const missingKey = await app.inject({
      method: "POST", url: `/api/v1/projects/agreement-review/agreements/${agreementId}/decisions`, headers: { cookie: customerCookie },
      payload: { action: "accept", authorityConfirmed: true, expectedVersionId: agreementId },
    });
    expect(missingKey.statusCode).toBe(400);
  });

  it("lets the SME upload and immutably submit real evidence for an accepted project", async () => {
    const app = await testApp();
    const smeCookie = await login(app, "nadia@example.test");
    const milestoneId = "30000000-0000-4000-8000-000000000003";
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`,
      headers: { cookie: smeCookie },
      payload: { notes: "Finishing and handover evidence ready for review." },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ submissionNumber: 1, status: "draft", canEdit: true });
    const submissionId = created.json().data.id as string;
    const multipart = multipartEvidence(
      {
        description: "Completed finish sample",
        acceptanceCriterionId: "31000000-0000-4000-8000-000000000004",
      },
      { name: "finish.png", type: "image/png", body: onePixelPng },
    );
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/evidence`,
      headers: { cookie: smeCookie, "content-type": multipart.contentType },
      payload: multipart.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().data).toMatchObject({
      originalName: "finish.png",
      detectedMimeType: "image/png",
      scanStatus: "clean",
      acceptanceCriterion: "Finishes match the approved schedule",
    });
    expect(uploaded.json().data.sha256).toMatch(/^[a-f0-9]{64}$/);

    const customerCookie = await login(app, "omar@example.test");
    const hiddenDraft = await app.inject({
      method: "GET",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`,
      headers: { cookie: customerCookie },
    });
    expect(hiddenDraft.json().data).toEqual([]);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/submit`,
      headers: { cookie: smeCookie, "idempotency-key": "m03-submit-00000001" },
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().data).toMatchObject({ status: "submitted", canEdit: false });
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/submit`,
      headers: { cookie: smeCookie, "idempotency-key": "m03-submit-00000001" },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.replayed).toBe(true);

    const customerList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`,
      headers: { cookie: customerCookie },
    });
    expect(customerList.json().data).toHaveLength(1);
    const evidenceId = uploaded.json().data.id as string;
    const download = await app.inject({
      method: "GET",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/evidence/${evidenceId}/download`,
      headers: { cookie: customerCookie },
    });
    expect(download.statusCode).toBe(200);
    expect((await sharp(download.rawPayload).metadata()).format).toBe("png");
    expect(download.rawPayload).not.toEqual(onePixelPng);
    expect(download.headers["cache-control"]).toBe("private, no-store");

    const immutableDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/evidence/${evidenceId}`,
      headers: { cookie: smeCookie },
    });
    expect(immutableDelete.statusCode).toBe(404);
  });

  it("rejects mismatched and cross-organization evidence access", async () => {
    const app = await testApp();
    const smeCookie = await login(app, "nadia@example.test");
    const milestoneId = "30000000-0000-4000-8000-000000000003";
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`,
      headers: { cookie: smeCookie },
      payload: {},
    });
    const submissionId = created.json().data.id as string;
    const mismatched = multipartEvidence({}, { name: "fake.pdf", type: "application/pdf", body: onePixelPng });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/evidence`,
      headers: { cookie: smeCookie, "content-type": mismatched.contentType },
      payload: mismatched.payload,
    });
    expect(rejected.statusCode).toBe(415);
    expect(rejected.json().error.code).toBe("EVIDENCE_TYPE_MISMATCH");

    const unrelatedCookie = await login(app, "samir@bank.example.test");
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}`,
      headers: { cookie: unrelatedCookie },
    });
    expect(hidden.statusCode).toBe(404);
  });

  it("fails oversized uploads before evidence is stored", async () => {
    const app = await testApp();
    const cookie = await login(app, "nadia@example.test");
    const milestoneId = "30000000-0000-4000-8000-000000000003";
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`,
      headers: { cookie },
      payload: {},
    });
    const submissionId = created.json().data.id as string;
    const oversized = multipartEvidence(
      {},
      { name: "too-large.png", type: "image/png", body: Buffer.alloc(10 * 1024 * 1024 + 1) },
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/evidence`,
      headers: { cookie, "content-type": oversized.contentType },
      payload: oversized.payload,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("EVIDENCE_FILE_TOO_LARGE");
  });

  it("enforces the evidence-file count and keeps drafts private from customer and unrelated users", async () => {
    const app = await testApp();
    const smeCookie = await login(app, "nadia@example.test");
    const milestoneId = "30000000-0000-4000-8000-000000000003";
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`,
      headers: { cookie: smeCookie },
      payload: {},
    });
    const submissionId = created.json().data.id as string;
    let evidenceId = "";
    for (let index = 0; index < 10; index += 1) {
      const multipart = multipartEvidence(
        {},
        { name: `finish-${index}.png`, type: "image/png", body: onePixelPng },
      );
      const uploaded = await app.inject({
        method: "POST",
        url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/evidence`,
        headers: { cookie: smeCookie, "content-type": multipart.contentType },
        payload: multipart.payload,
      });
      expect(uploaded.statusCode).toBe(201);
      evidenceId = uploaded.json().data.id as string;
    }
    const limitAttempt = multipartEvidence({}, { name: "one-too-many.png", type: "image/png", body: onePixelPng });
    const limited = await app.inject({
      method: "POST",
      url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/evidence`,
      headers: { cookie: smeCookie, "content-type": limitAttempt.contentType },
      payload: limitAttempt.payload,
    });
    expect(limited.statusCode).toBe(409);
    expect(limited.json().error.code).toBe("EVIDENCE_FILE_LIMIT_REACHED");

    for (const email of ["omar@example.test", "samir@bank.example.test"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${submissionId}/evidence/${evidenceId}/download`,
        headers: { cookie: await login(app, email) },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("fails closed when malware scanning reports infection or is unavailable", async () => {
    const milestoneId = "30000000-0000-4000-8000-000000000003";
    for (const { scanner, expectedCode, expectedStatus } of [
      { scanner: { scan: async () => "infected" as const }, expectedCode: "EVIDENCE_MALWARE_DETECTED", expectedStatus: 422 },
      { scanner: { scan: async () => { throw new Error("scanner offline"); } }, expectedCode: "EVIDENCE_SCAN_UNAVAILABLE", expectedStatus: 503 },
    ]) {
      const app = await testApp({ scanner });
      const cookie = await login(app, "nadia@example.test");
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`,
        headers: { cookie },
        payload: {},
      });
      const multipart = multipartEvidence({}, { name: "finish.png", type: "image/png", body: onePixelPng });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${created.json().data.id as string}/evidence`,
        headers: { cookie, "content-type": multipart.contentType },
        payload: multipart.payload,
      });
      expect(response.statusCode).toBe(expectedStatus);
      expect(response.json().error.code).toBe(expectedCode);
    }
  });

  it("preserves a change request and creates a linked resubmission for a new customer decision", async () => {
    const app = await testApp();
    const smeCookie = await login(app, "nadia@example.test");
    const customerCookie = await login(app, "omar@example.test");
    const milestoneId = "30000000-0000-4000-8000-000000000003";
    const create = await app.inject({ method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`, headers: { cookie: smeCookie }, payload: {} });
    const firstId = create.json().data.id as string;
    const firstFile = multipartEvidence({}, { name: "before.png", type: "image/png", body: onePixelPng });
    const uploaded = await app.inject({ method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${firstId}/evidence`, headers: { cookie: smeCookie, "content-type": firstFile.contentType }, payload: firstFile.payload });
    expect(uploaded.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${firstId}/submit`, headers: { cookie: smeCookie, "idempotency-key": "m04-first-submit-0001" } })).statusCode).toBe(201);
    const requested = await app.inject({
      method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/decisions`, headers: { cookie: customerCookie },
      payload: { action: "request-changes", reason: "Finishes", comment: "Replace the incomplete finish photographs.", responseDate: "2026-09-15", evidenceItemIds: [uploaded.json().data.id] },
    });
    expect(requested.statusCode).toBe(201);
    const history = await app.inject({ method: "GET", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/change-requests`, headers: { cookie: customerCookie } });
    expect(history.statusCode).toBe(200);
    const changeRequest = history.json().data[0];
    expect(changeRequest).toMatchObject({ reason: "Finishes", evidenceItemIds: [uploaded.json().data.id] });
    const response = await app.inject({
      method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/change-requests/${changeRequest.id}/respond`,
      headers: { cookie: smeCookie, "idempotency-key": "m04-change-response-01" }, payload: { response: "We replaced the photographs and added final evidence." },
    });
    expect(response.statusCode).toBe(201);
    const secondId = response.json().data.id as string;
    expect(response.json().data).toMatchObject({ submissionNumber: 2, status: "draft", responseToChangeRequest: { changeRequestId: changeRequest.id } });
    const repeatResponse = await app.inject({
      method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/change-requests/${changeRequest.id}/respond`,
      headers: { cookie: smeCookie, "idempotency-key": "m04-change-response-01" }, payload: { response: "We replaced the photographs and added final evidence." },
    });
    expect(repeatResponse.json().data.replayed).toBe(true);
    const secondFile = multipartEvidence({}, { name: "after.png", type: "image/png", body: onePixelPng });
    expect((await app.inject({ method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${secondId}/evidence`, headers: { cookie: smeCookie, "content-type": secondFile.contentType }, payload: secondFile.payload })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions/${secondId}/submit`, headers: { cookie: smeCookie, "idempotency-key": "m04-second-submit-01" } })).statusCode).toBe(201);
    const approved = await app.inject({ method: "POST", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/decisions`, headers: { cookie: customerCookie }, payload: { action: "approve" } });
    expect(approved.statusCode).toBe(201);
    const submissions = await app.inject({ method: "GET", url: `/api/v1/projects/cafe-renovation/milestones/${milestoneId}/submissions`, headers: { cookie: customerCookie } });
    expect(submissions.json().data).toHaveLength(2);
    expect(submissions.json().data.map((item: { submissionNumber: number }) => item.submissionNumber)).toEqual([2, 1]);
  });
});
