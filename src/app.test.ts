import { afterEach, describe, expect, it } from "vitest";
import createApp from "./app.js";
import InMemoryTrustPayRepository from "./repositories/in-memory-trustpay-repository.js";
import InMemoryAuthService from "./auth/in-memory-auth-service.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

async function testApp() {
  const app = await createApp({
    repository: new InMemoryTrustPayRepository(),
    authService: new InMemoryAuthService(),
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
      url: "/api/v1/projects/cafe-renovation/milestones/2/decisions",
      payload: { action: "approve" },
      headers: { cookie },
    });

    expect(decision.statusCode).toBe(201);
    expect(decision.json().data).toMatchObject({
      milestone: { id: 2, status: "approved" },
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
      url: "/api/v1/projects/cafe-renovation/milestones/2/decisions",
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
      url: "/api/v1/projects/cafe-renovation/milestones/2/decisions",
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

  it("blocks an SME user from making the customer's decision", async () => {
    const app = await testApp();
    const cookie = await login(app, "nadia@example.test");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/2/decisions",
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
        { id: 1, value: 12_500, status: "not-started" },
        { id: 2, value: 37_500, status: "not-started" },
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
});
