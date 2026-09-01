import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { AuthService } from "../auth/auth-service.js";
import { readSessionToken, requireUser, setSessionCookie } from "../auth/http.js";
import type { TrustPayRepository } from "../repositories/trustpay-repository.js";
import EvidenceService from "../evidence/evidence-service.js";
import { safeDownloadName } from "../storage/file-validation.js";

const projectParams = z.object({ projectId: z.string().min(1) });
const milestoneParams = projectParams.extend({
  milestoneId: z.uuid(),
});
const submissionParams = milestoneParams.extend({ submissionId: z.uuid() });
const changeRequestParams = milestoneParams.extend({ changeRequestId: z.uuid() });
const evidenceParams = submissionParams.extend({ evidenceId: z.uuid() });
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
      acceptanceCriterionIds: z.array(z.uuid()).max(10).optional(),
      evidenceItemIds: z.array(z.uuid()).max(10).optional(),
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
const submissionNotesBody = z.object({ notes: z.string().trim().max(5_000).optional() }).strict();
const changeRequestResponseBody = z.object({
  response: z.string().trim().min(5).max(4_000),
  notes: z.string().trim().max(5_000).optional(),
}).strict();
const evidenceFields = z.object({
  description: z.string().trim().max(2_000).optional(),
  acceptanceCriterionId: z.uuid().optional(),
  capturedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

function validationError(error: z.ZodError): DomainError {
  const message = error.issues
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("; ");
  return new DomainError(message, 400, "VALIDATION_ERROR");
}

function multipartField(fields: Record<string, unknown>, name: string): string | undefined {
  const raw = fields[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== "object" || !("value" in value)) return undefined;
  return typeof (value as { value?: unknown }).value === "string"
    ? (value as { value: string }).value
    : undefined;
}

export function trustPayRoutes(
  repository: TrustPayRepository,
  authService: AuthService,
  evidenceService: EvidenceService,
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
      "/projects/:projectId/milestones/:milestoneId/submissions",
      { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
      async (request, reply) => {
        const user = await requireUser(request, authService);
        const params = milestoneParams.safeParse(request.params);
        if (!params.success) throw validationError(params.error);
        const body = submissionNotesBody.safeParse(request.body ?? {});
        if (!body.success) throw validationError(body.error);
        const submission = await repository.createSubmission(
          params.data.projectId,
          params.data.milestoneId,
          body.data.notes,
          user.id,
        );
        return reply.code(201).send({ data: submission });
      },
    );

    app.get("/projects/:projectId/milestones/:milestoneId/submissions", async (request) => {
      const user = await requireUser(request, authService);
      const params = milestoneParams.safeParse(request.params);
      if (!params.success) throw validationError(params.error);
      return {
        data: await repository.listSubmissions(params.data.projectId, params.data.milestoneId, user.id),
      };
    });

    app.get("/projects/:projectId/milestones/:milestoneId/change-requests", async (request) => {
      const user = await requireUser(request, authService);
      const params = milestoneParams.safeParse(request.params);
      if (!params.success) throw validationError(params.error);
      return { data: await repository.listChangeRequests(params.data.projectId, params.data.milestoneId, user.id) };
    });

    app.post(
      "/projects/:projectId/milestones/:milestoneId/change-requests/:changeRequestId/respond",
      { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
      async (request, reply) => {
        const user = await requireUser(request, authService);
        const params = changeRequestParams.safeParse(request.params);
        if (!params.success) throw validationError(params.error);
        const body = changeRequestResponseBody.safeParse(request.body);
        if (!body.success) throw validationError(body.error);
        const key = idempotencyKey.safeParse(request.headers["idempotency-key"]);
        if (!key.success) throw new DomainError("An Idempotency-Key header is required", 400, "IDEMPOTENCY_KEY_REQUIRED");
        const submission = await repository.respondToChangeRequest(
          params.data.projectId, params.data.milestoneId, params.data.changeRequestId,
          { response: body.data.response, ...(body.data.notes ? { notes: body.data.notes } : {}) }, user.id, key.data, request.id,
        );
        return reply.code(201).send({ data: submission });
      },
    );

    app.get("/projects/:projectId/milestones/:milestoneId/submissions/:submissionId", async (request) => {
      const user = await requireUser(request, authService);
      const params = submissionParams.safeParse(request.params);
      if (!params.success) throw validationError(params.error);
      const submission = await repository.findSubmission(
        params.data.projectId,
        params.data.milestoneId,
        params.data.submissionId,
        user.id,
      );
      if (!submission) throw new DomainError("Submission not found", 404, "SUBMISSION_NOT_FOUND");
      return { data: submission };
    });

    app.patch("/projects/:projectId/milestones/:milestoneId/submissions/:submissionId", async (request) => {
      const user = await requireUser(request, authService);
      const params = submissionParams.safeParse(request.params);
      if (!params.success) throw validationError(params.error);
      const body = submissionNotesBody.safeParse(request.body ?? {});
      if (!body.success) throw validationError(body.error);
      return {
        data: await repository.updateSubmissionNotes(
          params.data.projectId,
          params.data.milestoneId,
          params.data.submissionId,
          body.data.notes,
          user.id,
        ),
      };
    });

    app.post(
      "/projects/:projectId/milestones/:milestoneId/submissions/:submissionId/evidence",
      { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
      async (request, reply) => {
        const user = await requireUser(request, authService);
        const params = submissionParams.safeParse(request.params);
        if (!params.success) throw validationError(params.error);
        const file = await request.file();
        if (!file) throw new DomainError("Select one evidence file", 400, "EVIDENCE_FILE_REQUIRED");
        const body = await file.toBuffer();
        const rawFields = file.fields as unknown as Record<string, unknown>;
        const fields = evidenceFields.safeParse({
          description: multipartField(rawFields, "description"),
          acceptanceCriterionId: multipartField(rawFields, "acceptanceCriterionId"),
          capturedAt: multipartField(rawFields, "capturedAt"),
        });
        if (!fields.success) throw validationError(fields.error);
        const evidence = await evidenceService.upload({
          ...params.data,
          userId: user.id,
          originalName: file.filename,
          declaredMimeType: file.mimetype,
          body,
          ...(fields.data.description ? { description: fields.data.description } : {}),
          ...(fields.data.acceptanceCriterionId ? { acceptanceCriterionId: fields.data.acceptanceCriterionId } : {}),
          ...(fields.data.capturedAt ? { capturedAt: new Date(fields.data.capturedAt) } : {}),
        });
        return reply.code(201).send({ data: evidence });
      },
    );

    app.delete(
      "/projects/:projectId/milestones/:milestoneId/submissions/:submissionId/evidence/:evidenceId",
      async (request, reply) => {
        const user = await requireUser(request, authService);
        const params = evidenceParams.safeParse(request.params);
        if (!params.success) throw validationError(params.error);
        await evidenceService.remove(
          params.data.projectId,
          params.data.milestoneId,
          params.data.submissionId,
          params.data.evidenceId,
          user.id,
        );
        return reply.code(204).send();
      },
    );

    app.post(
      "/projects/:projectId/milestones/:milestoneId/submissions/:submissionId/submit",
      { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
      async (request, reply) => {
        const user = await requireUser(request, authService);
        const params = submissionParams.safeParse(request.params);
        if (!params.success) throw validationError(params.error);
        const key = idempotencyKey.safeParse(request.headers["idempotency-key"]);
        if (!key.success) throw new DomainError("An Idempotency-Key header is required", 400, "IDEMPOTENCY_KEY_REQUIRED");
        const submission = await evidenceService.submit(
          params.data.projectId,
          params.data.milestoneId,
          params.data.submissionId,
          user.id,
          key.data,
          request.id,
        );
        return reply.code(201).send({ data: submission });
      },
    );

    app.get(
      "/projects/:projectId/milestones/:milestoneId/submissions/:submissionId/evidence/:evidenceId/download",
      async (request, reply) => {
        const user = await requireUser(request, authService);
        const params = evidenceParams.safeParse(request.params);
        if (!params.success) throw validationError(params.error);
        const { metadata, object } = await evidenceService.download(
          params.data.projectId,
          params.data.milestoneId,
          params.data.submissionId,
          params.data.evidenceId,
          user.id,
        );
        const filename = encodeURIComponent(safeDownloadName(metadata.originalName));
        return reply
          .header("Cache-Control", "private, no-store")
          .header("Content-Security-Policy", "sandbox")
          .header("X-Content-Type-Options", "nosniff")
          .header("Content-Disposition", `attachment; filename*=UTF-8''${filename}`)
          .type(object.contentType)
          .send(object.body);
      },
    );

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
          body.data.action === "request-changes"
            ? {
                ...body.data,
                ...(body.data.acceptanceCriterionIds ? { acceptanceCriterionIds: body.data.acceptanceCriterionIds } : {}),
                ...(body.data.evidenceItemIds ? { evidenceItemIds: body.data.evidenceItemIds } : {}),
              }
            : body.data,
          user.id,
        );
        return reply.code(201).send({ data: result });
      },
    );
  };
}
