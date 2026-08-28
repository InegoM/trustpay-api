import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { AuthService } from "../auth/auth-service.js";
import { readSessionToken, requireUser, setSessionCookie } from "../auth/http.js";
import type { TrustPayRepository } from "../repositories/trustpay-repository.js";

const projectParams = z.object({ projectId: z.string().min(1) });
const milestoneParams = projectParams.extend({
  milestoneId: z.uuid(),
});
const agreementParams = projectParams.extend({ agreementId: z.uuid() });
const idempotencyKey = z.string().trim().min(16).max(128).regex(/^[A-Za-z0-9._-]+$/);
const agreementDecisionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), authorityConfirmed: z.literal(true), expectedVersionId: z.uuid() }).strict(),
  z.object({ action: z.literal("request-amendment"), reason: z.string().trim().min(5).max(2_000), expectedVersionId: z.uuid() }).strict(),
]);
const createAgreementVersionBody = z.object({
  baseVersionId: z.uuid(),
  title: z.string().trim().min(3).max(200),
  scope: z.string().trim().min(20).max(5_000),
  terms: z.string().trim().min(20).max(10_000),
}).strict();
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
const moneyValue = z
  .number()
  .positive()
  .max(100_000_000)
  .refine((value) => Number.isInteger(value * 100), {
    message: "must have no more than two decimal places",
  });
const createProjectBody = z
  .object({
    name: z.string().trim().min(3).max(160),
    code: z
      .string()
      .trim()
      .min(3)
      .max(30)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must use letters, numbers, hyphens, or underscores"),
    customerName: z.string().trim().min(2).max(160),
    currencyCode: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/),
    agreement: z
      .object({
        title: z.string().trim().min(3).max(200),
        scope: z.string().trim().min(20).max(5_000),
        terms: z.string().trim().min(20).max(10_000),
      })
      .strict(),
    milestones: z
      .array(
        z
          .object({
            name: z.string().trim().min(3).max(160),
            description: z.string().trim().max(2_000).optional(),
            value: moneyValue,
            acceptanceCriteria: z
              .array(z.string().trim().min(5).max(500))
              .min(1)
              .max(10),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
const createInvitationBody = z
  .object({ email: z.email().transform((email) => email.trim().toLowerCase()) })
  .strict();

function validationError(error: z.ZodError): DomainError {
  const message = error.issues
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("; ");
  return new DomainError(message, 400, "VALIDATION_ERROR");
}

export function trustPayRoutes(
  repository: TrustPayRepository,
  authService: AuthService,
  secureCookies = false,
): FastifyPluginAsync {
  return async (app) => {
    app.post("/projects", async (request, reply) => {
      const user = await requireUser(request, authService);
      const body = createProjectBody.safeParse(request.body);
      if (!body.success) throw validationError(body.error);
      const project = await repository.createProject(body.data, user.id);
      return reply.code(201).send({ data: project });
    });

    app.get("/projects", async (request) => {
      const user = await requireUser(request, authService);
      return { data: await repository.listProjects(user.id) };
    });

    app.get("/projects/:projectId", async (request) => {
      const user = await requireUser(request, authService);
      const parsed = projectParams.safeParse(request.params);
      if (!parsed.success) throw validationError(parsed.error);

      const project = await repository.findProject(parsed.data.projectId, user.id);
      if (!project) {
        throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
      }
      return { data: project };
    });

    app.get("/projects/:projectId/agreements", async (request) => {
      const user = await requireUser(request, authService);
      const parsed = projectParams.safeParse(request.params);
      if (!parsed.success) throw validationError(parsed.error);
      const project = await repository.findProject(parsed.data.projectId, user.id);
      if (!project) throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
      return { data: await repository.listAgreements(parsed.data.projectId, user.id) };
    });

    app.get("/projects/:projectId/agreements/:agreementId", async (request) => {
      const user = await requireUser(request, authService);
      const parsed = agreementParams.safeParse(request.params);
      if (!parsed.success) throw validationError(parsed.error);
      const agreement = await repository.findAgreement(parsed.data.projectId, parsed.data.agreementId, user.id);
      if (!agreement) throw new DomainError("Agreement not found", 404, "AGREEMENT_NOT_FOUND");
      return { data: agreement };
    });

    app.post("/projects/:projectId/agreements", async (request, reply) => {
      const user = await requireUser(request, authService);
      const params = projectParams.safeParse(request.params);
      if (!params.success) throw validationError(params.error);
      const body = createAgreementVersionBody.safeParse(request.body);
      if (!body.success) throw validationError(body.error);
      const agreement = await repository.createAgreementVersion(params.data.projectId, body.data, user.id);
      return reply.code(201).send({ data: agreement });
    });

    app.post("/projects/:projectId/agreements/:agreementId/decisions", async (request, reply) => {
      const user = await requireUser(request, authService);
      const params = agreementParams.safeParse(request.params);
      if (!params.success) throw validationError(params.error);
      const body = agreementDecisionBody.safeParse(request.body);
      if (!body.success) throw validationError(body.error);
      const key = idempotencyKey.safeParse(request.headers["idempotency-key"]);
      if (!key.success) throw new DomainError("An Idempotency-Key header is required", 400, "IDEMPOTENCY_KEY_REQUIRED");
      const result = await repository.recordAgreementDecision(
        params.data.projectId,
        params.data.agreementId,
        body.data,
        user.id,
        key.data,
        {
          ipAddress: request.ip,
          ...(typeof request.headers["user-agent"] === "string"
            ? { userAgent: request.headers["user-agent"] }
            : {}),
        },
      );
      if (body.data.action === "accept" && !result.replayed) {
        const sessionToken = readSessionToken(request);
        if (!sessionToken) throw new DomainError("Authentication is required", 401, "UNAUTHENTICATED");
        const replacement = await authService.rotateSession(sessionToken);
        setSessionCookie(reply, replacement.token, replacement.expiresAt, secureCookies);
      }
      return reply.code(201).send({ data: result });
    });

    app.get("/projects/:projectId/activity", async (request) => {
      const user = await requireUser(request, authService);
      const parsed = projectParams.safeParse(request.params);
      if (!parsed.success) throw validationError(parsed.error);

      const project = await repository.findProject(parsed.data.projectId, user.id);
      if (!project) {
        throw new DomainError("Project not found", 404, "PROJECT_NOT_FOUND");
      }
      return { data: await repository.listActivity(parsed.data.projectId, user.id) };
    });

    app.get("/projects/:projectId/invitations", async (request) => {
      const user = await requireUser(request, authService);
      const parsed = projectParams.safeParse(request.params);
      if (!parsed.success) throw validationError(parsed.error);
      return {
        data: await repository.listProjectInvitations(
          parsed.data.projectId,
          user.id,
        ),
      };
    });

    app.post("/projects/:projectId/invitations", async (request, reply) => {
      const user = await requireUser(request, authService);
      const parsed = projectParams.safeParse(request.params);
      if (!parsed.success) throw validationError(parsed.error);
      const body = createInvitationBody.safeParse(request.body);
      if (!body.success) throw validationError(body.error);
      const invitation = await repository.createCustomerInvitation(
        parsed.data.projectId,
        body.data.email,
        user.id,
      );
      return reply.code(201).send({ data: invitation });
    });

    app.post(
      "/projects/:projectId/milestones/:milestoneId/decisions",
      async (request, reply) => {
        const user = await requireUser(request, authService);
        const params = milestoneParams.safeParse(request.params);
        if (!params.success) throw validationError(params.error);

        const body = decisionBody.safeParse(request.body);
        if (!body.success) throw validationError(body.error);

        const result = await repository.recordDecision(
          params.data.projectId,
          params.data.milestoneId,
          body.data,
          user.id,
        );
        return reply.code(201).send({ data: result });
      },
    );
  };
}
