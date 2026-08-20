# TrustPay API

Backend service for the TrustPay prototype. It records project agreements, milestone decisions, and audit activity. It does **not** hold, release, or transfer money.

## Run locally

```powershell
npm install
Copy-Item .env.example .env
npm run db:up
npm run db:deploy
npm run db:seed
npm run dev
```

The API listens on `http://localhost:3001` by default. PostgreSQL listens locally on port `55432`, and the frontend is allowed from `http://localhost:8443` with credentialed requests.

## Current endpoints

- `GET /health`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/me`
- `POST /api/v1/invitations/accept`
- `POST /api/v1/projects` — SME owner/admin project, draft agreement, and milestone creation
- `GET /api/v1/projects/:projectId/invitations` — SME invitation history
- `POST /api/v1/projects/:projectId/invitations` — create or replace a customer-approver invitation
- `GET /api/v1/projects`
- `GET /api/v1/projects/:projectId`
- `GET /api/v1/projects/:projectId/activity`
- `POST /api/v1/projects/:projectId/milestones/:milestoneId/decisions`

Every endpoint except health, login, and invitation acceptance requires the `HttpOnly` session cookie. Project queries are restricted to organizations the user belongs to. Only the customer user assigned as the project's authorized approver can record a milestone decision.

Local demo accounts share the password `TrustPayDemo!2026`:

- `nadia@example.test` — Alba Fit-Out SME owner
- `omar@example.test` — Cedar Café customer approver

The local invitation token `TRUSTPAY-DEMO-INVITE` creates `layla@example.test` as an Alba Fit-Out member. It is development data only.

Project invitations return the raw one-time token only when created; the database stores only its SHA-256 hash. The frontend turns the token into a seven-day manual sharing link. Outbound email delivery is not connected yet.

Decision request examples:

```json
{ "action": "approve" }
```

```json
{
  "action": "request-changes",
  "reason": "Evidence is incomplete",
  "comment": "Upload a close-up of the corrected outlet boxes.",
  "responseDate": "2026-08-30"
}
```

```json
{
  "action": "raise-dispute",
  "reason": "Layout mismatch",
  "explanation": "The installed electrical layout differs from the accepted drawing."
}
```

## Database

Prisma migrations define the PostgreSQL schema. The runtime API uses `PostgresTrustPayRepository`; the in-memory implementation remains available for fast API contract tests.

Database records use UUID primary keys and explicit foreign keys. Contractual records use restrictive deletion rules, milestone decisions run in serializable transactions, and each decision writes an append-only activity record plus an outbox event.
