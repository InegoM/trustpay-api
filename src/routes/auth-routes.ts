import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/auth-service.js";
import {
  clearSessionCookie,
  readSessionToken,
  requireUser,
  setSessionCookie,
} from "../auth/http.js";
import { DomainError } from "../domain/errors.js";

const loginBody = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(200),
  })
  .strict();
const invitationBody = z
  .object({
    token: z.string().trim().min(12).max(500),
    displayName: z.string().trim().min(2).max(120),
    password: z
      .string()
      .min(12)
      .max(200)
      .regex(/[a-z]/, "must contain a lowercase letter")
      .regex(/[A-Z]/, "must contain an uppercase letter")
      .regex(/[0-9]/, "must contain a number"),
  })
  .strict();

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new DomainError(
    parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; "),
    400,
    "VALIDATION_ERROR",
  );
}

export function authRoutes(
  authService: AuthService,
  secureCookies: boolean,
): FastifyPluginAsync {
  return async (app) => {
    app.post("/auth/login", async (request, reply) => {
      const body = validate(loginBody, request.body);
      const session = await authService.login(body.email, body.password);
      setSessionCookie(reply, session.token, session.expiresAt, secureCookies);
      return { data: session.user };
    });

    app.post("/auth/logout", async (request, reply) => {
      const token = readSessionToken(request);
      if (token) await authService.logout(token);
      clearSessionCookie(reply, secureCookies);
      return reply.code(204).send();
    });

    app.get("/me", async (request) => ({
      data: await requireUser(request, authService),
    }));

    app.post("/invitations/accept", async (request, reply) => {
      const body = validate(invitationBody, request.body);
      const session = await authService.acceptInvitation(body);
      setSessionCookie(reply, session.token, session.expiresAt, secureCookies);
      return reply.code(201).send({ data: session.user });
    });
  };
}
