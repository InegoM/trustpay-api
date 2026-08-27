# TrustPay API

TrustPay is a milestone-governance and audit platform for project-based SMEs and their customers. This API records project agreements, milestone decisions, and activity. It does **not** hold, release, transfer, safeguard, or guarantee money.

## M00 baseline

The M00 baseline was recorded on 2026-08-26. Its architecture, security-control evidence, known discrepancies, and manual release prerequisites are in [docs/m00-baseline.md](docs/m00-baseline.md). M00 does not add product features.

## Requirements

- Node.js 22 (Mise configuration: `.mise.toml`)
- npm 10.9.2 (`packageManager` in `package.json`)
- Docker Desktop with Compose v2
- PostgreSQL 18.3, supplied by `compose.yaml`

Use the committed lockfile with `npm ci`; do not substitute `npm install` for repeatable checks or CI.

## Environments and local setup

Copy the template and use only the local synthetic-data credentials created by the seed. Never put production credentials or customer data in `.env` files or tests.

```powershell
Copy-Item .env.example .env
npm ci
npm run db:up
npm run db:deploy
npm run db:seed
npm run dev
```

The development API listens at `http://127.0.0.1:3001` by default. It allows credentialed requests only from `http://localhost:8443` unless `WEB_ORIGIN` is changed deliberately.

| Variable | Development default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | API listener port |
| `HOST` | `127.0.0.1` | API listener host |
| `WEB_ORIGIN` | `http://localhost:8443` | Allowed browser origin |
| `DATABASE_URL` | local port `55432`, database `trustpay` | Development database |
| `TEST_DATABASE_URL` | local port `55433`, database `trustpay_test` | Isolated automated-test database |

`GET /health` is the local health endpoint. It does not authenticate and returns no customer data.

## Database commands

Development and test PostgreSQL services use different ports, databases, and Docker volumes. This prevents persistence tests from changing development records.

```powershell
# Development data
npm run db:up
npm run db:deploy
npm run db:seed

# Isolated persistence-test data
npm run db:test:up
npm run db:test:deploy
npm run db:test:seed
npm run test:db
```

`db:test:deploy`, `db:test:seed`, and `test:db` fail clearly unless `TEST_DATABASE_URL` targets `trustpay_test`. The committed migrations can be applied to an empty database using `db:deploy` or `db:test:deploy`.

Do not use `prisma migrate reset` unless you explicitly intend to erase the named local database. To stop containers without deleting data, run `npm run db:down` (development) and `npm run db:test:down` (test). Docker volume deletion is deliberately not scripted.

## Checks

```powershell
npm run typecheck
npm test
npm run test:db
npm run build
npm run check
npm run security:password-benchmark
```

`npm test` runs fast in-memory API and password tests. `npm run test:db` runs PostgreSQL persistence tests and needs the seeded test database. CI runs both paths against an ephemeral PostgreSQL service.

## Current endpoints

- `GET /health`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/me`
- `POST /api/v1/invitations/accept`
- `POST /api/v1/projects`
- `GET /api/v1/projects`
- `GET /api/v1/projects/:projectId`
- `GET /api/v1/projects/:projectId/activity`
- `GET /api/v1/projects/:projectId/invitations`
- `POST /api/v1/projects/:projectId/milestones/:milestoneId/decisions`

All endpoints except health, login, and invitation acceptance require a server-managed HTTP-only session cookie. Project data is scoped on the server to the authenticated user's organization memberships; unrelated organizations receive a safe `404` for a project outside their scope.
