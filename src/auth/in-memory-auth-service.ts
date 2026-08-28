import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { AuthService } from "./auth-service.js";
import type {
  AcceptInvitationInput,
  AuthenticatedSession,
  AuthUser,
} from "./types.js";

export const testUsers = {
  nadia: {
    id: "20000000-0000-4000-8000-000000000001",
    email: "nadia@example.test",
    displayName: "Nadia Rahman",
    organizations: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        name: "Alba Fit-Out",
        type: "SME" as const,
        role: "OWNER" as const,
      },
    ],
  },
  omar: {
    id: "20000000-0000-4000-8000-000000000002",
    email: "omar@example.test",
    displayName: "Omar Hassan",
    organizations: [
      {
        id: "10000000-0000-4000-8000-000000000002",
        name: "Cedar Café",
        type: "CUSTOMER" as const,
        role: "APPROVER" as const,
      },
    ],
  },
  samir: {
    id: "20000000-0000-4000-8000-000000000099",
    email: "samir@bank.example.test",
    displayName: "Samir Khan",
    organizations: [
      {
        id: "10000000-0000-4000-8000-000000000099",
        name: "Partner Bank",
        type: "BANK_PARTNER" as const,
        role: "MEMBER" as const,
      },
    ],
  },
};

export default class InMemoryAuthService implements AuthService {
  private readonly sessions = new Map<string, AuthUser>();

  async login(email: string, password: string): Promise<AuthenticatedSession> {
    const user = Object.values(testUsers).find(
      (candidate) => candidate.email === email.trim().toLowerCase(),
    );
    if (!user || password !== "TrustPayDemo!2026") {
      throw new DomainError(
        "The email or password is incorrect",
        401,
        "INVALID_CREDENTIALS",
      );
    }
    const token = randomUUID();
    this.sessions.set(token, user);
    return {
      user,
      token,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    };
  }

  async authenticate(token: string): Promise<AuthUser | null> {
    return this.sessions.get(token) ?? null;
  }

  async rotateSession(token: string): Promise<AuthenticatedSession> {
    const user = this.sessions.get(token);
    if (!user) throw new DomainError("Authentication is required", 401, "UNAUTHENTICATED");
    this.sessions.delete(token);
    const nextToken = randomUUID();
    this.sessions.set(nextToken, user);
    return { user, token: nextToken, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000) };
  }

  async logout(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async acceptInvitation(
    _input: AcceptInvitationInput,
  ): Promise<AuthenticatedSession> {
    throw new DomainError(
      "The invitation is invalid or has expired",
      400,
      "INVALID_INVITATION",
    );
  }
}
