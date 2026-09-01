# M03 evidence storage and security operations

M03 stores evidence as private objects and stores only authorization, integrity, and display metadata in PostgreSQL. TrustPay remains a record-and-workflow product: submission does not move money or imply escrow, payment protection, or guaranteed work quality.

## Data flow and trust boundaries

1. The browser sends one authenticated multipart upload to the API. It never receives object-storage credentials or a public object URL.
2. The API authorizes the user, project, milestone, and editable draft before it reads file content.
3. Filename extension, declared MIME type, detected signature, size, and per-submission/per-organization quotas are checked server-side.
4. JPEG and PNG files are decoded and re-encoded without EXIF or other unnecessary metadata. PDFs are retained byte-for-byte for evidentiary integrity.
5. The sanitized bytes enter a random opaque `quarantine/` key and are sent to ClamAV using `INSTREAM`. Scanner errors fail closed; infected objects are deleted and never become evidence records.
6. Clean bytes are copied to an opaque `evidence/` key. PostgreSQL records the detected type, sanitized-byte size, SHA-256 digest, uploader, timestamps, optional description, and optional acceptance-criterion link.
7. Downloads pass through the API. Authorization is repeated at request time and the stored bytes are checked against the recorded size and SHA-256 digest. Responses use `private, no-store`, `nosniff`, a sandbox content policy, and attachment disposition.
8. Submission verifies every referenced object again, changes the milestone to `AWAITING_DECISION`, writes the activity/outbox/notification records in the same database transaction, and makes the package immutable. Database triggers provide a second protection layer.

Customers cannot list or download drafts. Unrelated organizations receive a safe not-found response. SME owners/admins can remove files only while the package is a draft.

## Providers and configuration

Local development uses LocalStack S3 on port `59000` and ClamAV on port `53310` from `compose.yaml`. `scripts/localstack-init.sh` creates a private, encrypted bucket. Production uses the same S3-compatible adapter with a private AWS S3 bucket (or a reviewed compatible provider), HTTPS, block-public-access, encryption, versioning, access logging, lifecycle rules, and least-privilege workload credentials. Do not put long-lived production keys in `.env` or GitHub.

Required production configuration:

- `STORAGE_BUCKET`, `STORAGE_REGION`; omit `STORAGE_ENDPOINT` for AWS S3.
- Workload credentials supplied by the deployment platform, not committed access keys.
- `STORAGE_SERVER_SIDE_ENCRYPTION=aws:kms` when the production KMS design is approved; otherwise `AES256` is the safe local default.
- A private ClamAV service address through `CLAMAV_HOST`, `CLAMAV_PORT`, and a bounded `CLAMAV_TIMEOUT_MS`.
- `WEB_ORIGIN` set to the exact HTTPS frontend origin and secure session cookies enabled by the production environment.

## Limits, retention, and recovery

The default limits are 10 MB per file, 10 files per submission, and 500 MB per SME organization. Accepted formats are JPEG, PNG, and PDF. These limits are enforced at HTTP, validation, repository, and database layers where applicable.

`npm run storage:cleanup` deletes unreferenced `quarantine/` and `evidence/` objects older than `ABANDONED_UPLOAD_RETENTION_HOURS` (24 hours by default). Schedule it at least daily and alert on failures. Submitted evidence is not deleted by this job. A formal production retention/deletion schedule, legal-hold process, customer export process, and backup restore drill require privacy/legal approval before launch.

Back up PostgreSQL and enable object versioning in production. Restore tests must verify both metadata rows and object hashes; restoring only one side is incomplete. Storage reconciliation should flag missing, modified, and unreferenced objects without exposing filenames or customer content in logs.

## Operational failure behavior

- Storage or scanner unavailable: return a retryable error; never claim upload or scanning succeeded.
- Malware detected: delete quarantine content, record no evidence metadata, and show a safe rejection.
- Database write fails after object promotion: best-effort delete the promoted object; the cleanup job is the recovery backstop.
- Object missing or hash/size mismatch: deny download/submission and alert operations; do not serve unverifiable bytes.
- Partial browser upload: no evidence record is created and the user can retry.

Security controls implemented for M03: AUTHZ-005, AUTHZ-007, API-001, API-009, API-013, FILE-001–FILE-012, DATA-003–DATA-005, CRYPTO-002–CRYPTO-003, and the applicable PRIV controls. Residual provider, legal-retention, malware-engine availability, and disaster-recovery risks remain deployment prerequisites rather than claims made by this repository.
