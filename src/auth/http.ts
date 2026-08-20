import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import type { AuthService } from "./auth-service.js";
import type { AuthUser } from "./types.js";

export const SESSION_COOKIE = "trustpay_session";

export function readSessionToken(request: FastifyRequest): string | null {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === SESSION_COOKIE) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return null;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) attributes.push("Secure");
  reply.header("Set-Cookie", attributes.join("; "));
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  reply.header("Set-Cookie", attributes.join("; "));
}

export async function requireUser(
  request: FastifyRequest,
  authService: AuthService,
): Promise<AuthUser> {
  const token = readSessionToken(request);
  const user = token ? await authService.authenticate(token) : null;
  if (!user) {
    throw new DomainError("Authentication is required", 401, "UNAUTHENTICATED");
  }
  return user;
}
