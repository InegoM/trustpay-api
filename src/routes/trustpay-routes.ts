import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { TrustPayRepository } from "../repositories/trustpay-repository.js";

const projectParams = z.object({ projectId: z.string().min(1) });
const milestoneParams = projectParams.extend({
  milestoneId: z.coerce.number().int().positive(),
});
const decisionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }).strict(),
  z
    .object({
      action: z.literal("request-changes"),
      reason: z.string().trim().min(3).max(200),
      comment: z.string().trim().min(5).max(2_000),
      responseDate: z.iso.date(),
    })
    .strict(),
  z
    .object({
      action: z.literal("raise-dispute"),
      reason: z.string().trim().min(3).max(200),
      explanation: z.string().trim().min(10).max(4_000),
    })
    .strict(),
]);

function validationError(error: z.ZodError): DomainError {
  const message = error.issues
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("; ");
  return new DomainError(message, 400, "VALIDATION_ERROR");
}

export function trustPayRoutes(
  repository: TrustPayRepository,
): FastifyPluginAsync {
  return async (app) => {
    app.get("/projects", async () => ({ data: await repository.listProjects() }));

    app.get("/projects/:projectId", async (request) => {
      const parsed = projectParams.safeParse(request.params);
      if (!parsed.success) throw validationError(parsed.error);

      const project = await repository.findProject(parsed.data.projectId);
      if (!project) {
        throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
      }
      return { data: project };
    });

    app.get("/projects/:projectId/activity", async (request) => {
      const parsed = projectParams.safeParse(request.params);
      if (!parsed.success) throw validationError(parsed.error);

      const project = await repository.findProject(parsed.data.projectId);
      if (!project) {
        throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
      }
      return { data: await repository.listActivity(parsed.data.projectId) };
    });

    app.post(
      "/projects/:projectId/milestones/:milestoneId/decisions",
      async (request, reply) => {
        const params = milestoneParams.safeParse(request.params);
        if (!params.success) throw validationError(params.error);

        const body = decisionBody.safeParse(request.body);
        if (!body.success) throw validationError(body.error);

        const result = await repository.recordDecision(
          params.data.projectId,
          params.data.milestoneId,
          body.data,
        );
        return reply.code(201).send({ data: result });
      },
    );
  };
}
