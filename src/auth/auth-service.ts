import type {
  AcceptInvitationInput,
  AuthenticatedSession,
  AuthUser,
} from "./types.js";

export interface AuthService {
  login(email: string, password: string): Promise<AuthenticatedSession>;
  authenticate(token: string): Promise<AuthUser | null>;
  logout(token: string): Promise<void>;
  acceptInvitation(input: AcceptInvitationInput): Promise<AuthenticatedSession>;
}
