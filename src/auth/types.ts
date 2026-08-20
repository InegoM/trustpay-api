export interface AuthOrganization {
  id: string;
  name: string;
  type: "SME" | "CUSTOMER" | "SUPPLIER" | "BANK_PARTNER";
  role: "OWNER" | "ADMIN" | "APPROVER" | "MEMBER";
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  organizations: AuthOrganization[];
}

export interface AuthenticatedSession {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

export interface AcceptInvitationInput {
  token: string;
  displayName: string;
  password: string;
}
