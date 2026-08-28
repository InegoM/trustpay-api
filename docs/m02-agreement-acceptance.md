# M02 agreement acceptance

M02 records a customer's acceptance of a specific, immutable agreement version. It does not provide electronic-signature, payment, escrow, or legal-conclusiveness claims.

## Database change

Apply the additive migration with `npm run db:deploy` (or `npm run db:test:deploy` for the isolated test database). It adds an acceptance reference and append-only amendment-request records; it does not delete or overwrite historical agreements.

## Commands

- `GET /api/v1/projects/:projectId/agreements`
- `GET /api/v1/projects/:projectId/agreements/:agreementId`
- `POST /api/v1/projects/:projectId/agreements/:agreementId/decisions`
- `POST /api/v1/projects/:projectId/agreements`

The agreement-decision endpoint requires a 16–128 character `Idempotency-Key` header. It accepts either a confirmed acceptance or an amendment request and requires `expectedVersionId` to equal the path agreement ID. Replaying the same key returns the original result; a new key against a finalized version returns a safe conflict.

Only the project’s assigned customer approver can record an agreement decision. SME owners and administrators can create a replacement draft only after a recorded amendment request. All actions are server-authorized, timestamped in UTC, and recorded in the activity/outbox history.
