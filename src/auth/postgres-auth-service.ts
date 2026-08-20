import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { TrustPayPrismaClient } from "../database/prisma.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { AuthService } from "./auth-service.js";
import type {
  AcceptInvitationInput,
  AuthenticatedSession,
  AuthUser,
} from "./types.js";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapUser(user: {
  id: string;
  email: string;
  displayName: string;
  memberships: Array<{
    role: "OWNER" | "ADMIN" | "APPROVER" | "MEMBER";
    organization: {
      id: string;
      name: string;
      type: "SME" | "CUSTOMER" | "SUPPLIER" | "BANK_PARTNER";
    };
  }>;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    organizations: user.memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      type: membership.organization.type,
      role: membership.role,
    })),
  };
}

export default class PostgresAuthService implements AuthService {
  constructor(private readonly prisma: TrustPayPrismaClient) {}

  private async createSession(userId: string): Promise<AuthenticatedSession> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    const session = await this.prisma.authSession.create({
      data: { userId, tokenHash: tokenHash(token), expiresAt },
      include: {
        user: {
          include: { memberships: { include: { organization: true } } },
        },
      },
    });
    return { user: mapUser(session.user), token, expiresAt };
  }

  async login(email: string, password: string): Promise<AuthenticatedSession> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: {
        credential: true,
        memberships: { include: { organization: true } },
      },
    });
    const valid =
      user?.status === "ACTIVE" &&
      user.credential &&
      (await verifyPassword(
        password,
        user.credential.passwordSalt,
        user.credential.passwordHash,
      ));
    if (!valid || !user) {
      throw new DomainError(
        "The email or password is incorrect",
        401,
        "INVALID_CREDENTIALS",
      );
    }
    return this.createSession(user.id);
  }

  async authenticate(token: string): Promise<AuthUser | null> {
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: {
        user: {
          include: { memberships: { include: { organization: true } } },
        },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.status !== "ACTIVE"
    ) {
      return null;
    }
    void this.prisma.authSession
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    return mapUser(session.user);
  }

  async logout(token: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { tokenHash: tokenHash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async acceptInvitation(
    input: AcceptInvitationInput,
  ): Promise<AuthenticatedSession> {
    const invitationHash = tokenHash(input.token.trim());
    const password = await hashPassword(input.password);
    const credential = {
      passwordHash: password.hash,
      passwordSalt: password.salt,
    };
    const userId = await this.prisma.$transaction(async (tx) => {
      const invitation = await tx.invitation.findUnique({
        where: { tokenHash: invitationHash },
      });
      if (
        !invitation ||
        invitation.status !== "PENDING" ||
        invitation.expiresAt <= new Date()
      ) {
        throw new DomainError(
          "This invitation is invalid or has expired",
          400,
          "INVALID_INVITATION",
        );
      }

      const existing = await tx.user.findUnique({
        where: { email: invitation.email.toLowerCase() },
        include: { credential: true },
      });
      if (existing?.credential) {
        throw new DomainError(
          "An account already exists for this email. Log in to continue.",
          409,
          "ACCOUNT_EXISTS",
        );
      }

      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: { displayName: input.displayName.trim(), status: "ACTIVE" },
          })
        : await tx.user.create({
            data: {
              email: invitation.email.toLowerCase(),
              displayName: input.displayName.trim(),
            },
          });
      await tx.userCredential.upsert({
        where: { userId: user.id },
        update: credential,
        create: { userId: user.id, ...credential },
      });
      await tx.organizationMembership.upsert({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: user.id,
          },
        },
        update: { role: invitation.role },
        create: {
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
        },
      });
      if (invitation.projectId) {
        const assigned = await tx.projectParty.updateMany({
          where: {
            projectId: invitation.projectId,
            organizationId: invitation.organizationId,
            role: "CUSTOMER",
            authorizedApproverUserId: null,
          },
          data: { authorizedApproverUserId: user.id },
        });
        if (assigned.count !== 1) {
          throw new DomainError(
            "The project already has an approver or is no longer available",
            409,
            "APPROVER_ASSIGNMENT_FAILED",
          );
        }
        await tx.activityEvent.create({
          data: {
            projectId: invitation.projectId,
            actorUserId: user.id,
            actorOrganizationId: invitation.organizationId,
            actorName: user.displayName,
            actorType: "customer",
            type: "CUSTOMER_APPROVER_JOINED",
            description: `${user.displayName} joined as the authorized customer approver`,
            payload: { invitationId: invitation.id },
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: "invitation",
            aggregateId: invitation.id,
            eventType: "CUSTOMER_APPROVER_JOINED",
            payload: {
              projectId: invitation.projectId,
              invitationId: invitation.id,
              userId: user.id,
            },
          },
        });
      }
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED" },
      });
      return user.id;
    });
    return this.createSession(userId);
  }
}
