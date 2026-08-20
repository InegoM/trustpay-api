# TrustPay API

Backend service for the TrustPay prototype. It records project agreements, milestone decisions, and audit activity. It does **not** hold, release, or transfer money.

## Run locally

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The API listens on `http://127.0.0.1:3001` by default. The existing frontend is allowed from `http://localhost:8443`.

## Current endpoints

- `GET /health`
- `GET /api/v1/projects`
- `GET /api/v1/projects/:projectId`
- `GET /api/v1/projects/:projectId/activity`
- `POST /api/v1/projects/:projectId/milestones/:milestoneId/decisions`

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

## Architecture note

Routes depend on a repository interface. The initial repository is intentionally in-memory so the API contract and business rules can be tested first. PostgreSQL persistence is the next backend layer.
