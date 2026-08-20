import { afterEach, describe, expect, it } from "vitest";
import createApp from "./app.js";
import InMemoryTrustPayRepository from "./repositories/in-memory-trustpay-repository.js";

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

async function testApp() {
  const app = await createApp({ repository: new InMemoryTrustPayRepository() });
  apps.push(app);
  return app;
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
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/cafe-renovation",
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
    const decision = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/2/decisions",
      payload: { action: "approve" },
    });

    expect(decision.statusCode).toBe(201);
    expect(decision.json().data).toMatchObject({
      milestone: { id: 2, status: "approved" },
      project: { approvedValue: 63_000, outstandingValue: 27_000 },
    });

    const activity = await app.inject({
      method: "GET",
      url: "/api/v1/projects/cafe-renovation/activity",
    });
    expect(activity.json().data.slice(0, 2).map((event: { type: string }) => event.type)).toEqual([
      "milestone-approved",
      "decision-recorded",
    ]);
  });

  it("prevents a second decision for the same milestone", async () => {
    const app = await testApp();
    const request = {
      method: "POST" as const,
      url: "/api/v1/projects/cafe-renovation/milestones/2/decisions",
      payload: { action: "approve" },
    };

    expect((await app.inject(request)).statusCode).toBe(201);
    const duplicate = await app.inject(request);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("MILESTONE_NOT_DECIDABLE");
  });

  it("validates dispute details", async () => {
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/cafe-renovation/milestones/2/decisions",
      payload: { action: "raise-dispute", reason: "Layout mismatch", explanation: "short" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});
