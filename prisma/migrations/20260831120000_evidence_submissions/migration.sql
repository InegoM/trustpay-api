-- M03 adds draft/submitted evidence packages and authoritative file-validation metadata.
ALTER TYPE "MilestoneStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';

CREATE TYPE "SubmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED');
CREATE TYPE "EvidenceScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'ERROR');

ALTER TABLE "milestone_submissions"
  ADD COLUMN "agreement_version_id" UUID,
  ADD COLUMN "status" "SubmissionStatus",
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "submitted_at" DROP NOT NULL,
  ALTER COLUMN "submitted_at" DROP DEFAULT;

-- Existing seeded submissions represented completed submissions. Bind each one to
-- the governing agreement snapshot without altering the historical row.
UPDATE "milestone_submissions" AS submission
SET
  "agreement_version_id" = (
    SELECT agreement."id"
    FROM "milestones" AS milestone
    JOIN "agreement_versions" AS agreement
      ON agreement."project_id" = milestone."project_id"
    WHERE milestone."id" = submission."milestone_id"
    ORDER BY (agreement."status" = 'ACTIVE') DESC, agreement."version_number" DESC
    LIMIT 1
  ),
  "status" = 'SUBMITTED';

ALTER TABLE "milestone_submissions"
  ALTER COLUMN "agreement_version_id" SET NOT NULL,
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'DRAFT';

ALTER TABLE "evidence_items"
  ADD COLUMN "acceptance_criterion_id" UUID,
  ADD COLUMN "detected_mime_type" TEXT,
  ADD COLUMN "scan_status" "EvidenceScanStatus",
  ADD COLUMN "validated_at" TIMESTAMP(3);

UPDATE "evidence_items"
SET
  "detected_mime_type" = "mime_type",
  "scan_status" = 'CLEAN',
  "validated_at" = "uploaded_at";

ALTER TABLE "evidence_items"
  ALTER COLUMN "detected_mime_type" SET NOT NULL,
  ALTER COLUMN "scan_status" SET NOT NULL,
  ALTER COLUMN "scan_status" SET DEFAULT 'PENDING';

ALTER TABLE "milestone_submissions"
  ADD CONSTRAINT "milestone_submissions_agreement_version_id_fkey"
  FOREIGN KEY ("agreement_version_id") REFERENCES "agreement_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "evidence_items"
  ADD CONSTRAINT "evidence_items_acceptance_criterion_id_fkey"
  FOREIGN KEY ("acceptance_criterion_id") REFERENCES "acceptance_criteria"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "milestone_submissions_agreement_version_id_idx"
  ON "milestone_submissions"("agreement_version_id");
CREATE UNIQUE INDEX "milestone_submissions_one_draft_per_milestone"
  ON "milestone_submissions"("milestone_id")
  WHERE "status" = 'DRAFT';
CREATE INDEX "evidence_items_acceptance_criterion_id_idx"
  ON "evidence_items"("acceptance_criterion_id");

ALTER TABLE "evidence_items"
  DROP CONSTRAINT "evidence_items_nonnegative_size",
  ADD CONSTRAINT "evidence_items_positive_size" CHECK ("size_bytes" > 0);

CREATE OR REPLACE FUNCTION trustpay_prevent_submitted_submission_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'SUBMITTED' THEN
    RAISE EXCEPTION 'submitted evidence packages are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER milestone_submissions_immutable_after_submit
BEFORE UPDATE OR DELETE ON "milestone_submissions"
FOR EACH ROW EXECUTE FUNCTION trustpay_prevent_submitted_submission_mutation();

CREATE OR REPLACE FUNCTION trustpay_protect_submitted_evidence()
RETURNS TRIGGER AS $$
DECLARE
  target_submission UUID;
  target_status "SubmissionStatus";
BEGIN
  target_submission := CASE WHEN TG_OP = 'DELETE' THEN OLD."submission_id" ELSE NEW."submission_id" END;
  SELECT "status" INTO target_status
  FROM "milestone_submissions"
  WHERE "id" = target_submission;

  IF target_status = 'SUBMITTED' THEN
    RAISE EXCEPTION 'submitted evidence is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_items_immutable_after_submit
BEFORE INSERT OR UPDATE OR DELETE ON "evidence_items"
FOR EACH ROW EXECUTE FUNCTION trustpay_protect_submitted_evidence();
