-- M02 adds immutable agreement acceptance references and append-only amendment requests.
-- This is additive: existing historical agreement records are retained unchanged.
ALTER TYPE "AgreementStatus" ADD VALUE IF NOT EXISTS 'AMENDMENT_REQUESTED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'AGREEMENT_AMENDMENT_REQUESTED';

ALTER TABLE "agreement_acceptances" ADD COLUMN "reference" TEXT;
UPDATE "agreement_acceptances"
SET "reference" = CONCAT('TP-AGR-', UPPER(REPLACE("id"::text, '-', '')))
WHERE "reference" IS NULL;
ALTER TABLE "agreement_acceptances" ALTER COLUMN "reference" SET NOT NULL;
CREATE UNIQUE INDEX "agreement_acceptances_reference_key" ON "agreement_acceptances"("reference");

CREATE TABLE "agreement_amendment_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "agreement_version_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agreement_amendment_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agreement_amendment_requests_reference_key"
  ON "agreement_amendment_requests"("reference");
CREATE UNIQUE INDEX "agreement_amendment_requests_agreement_version_id_organization_id_key"
  ON "agreement_amendment_requests"("agreement_version_id", "organization_id");
CREATE INDEX "agreement_amendment_requests_requested_by_user_id_idx"
  ON "agreement_amendment_requests"("requested_by_user_id");

ALTER TABLE "agreement_amendment_requests"
  ADD CONSTRAINT "agreement_amendment_requests_agreement_version_id_fkey"
  FOREIGN KEY ("agreement_version_id") REFERENCES "agreement_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agreement_amendment_requests"
  ADD CONSTRAINT "agreement_amendment_requests_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agreement_amendment_requests"
  ADD CONSTRAINT "agreement_amendment_requests_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
