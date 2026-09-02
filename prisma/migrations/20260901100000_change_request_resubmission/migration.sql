-- M04 preserves each customer request and creates a distinct evidence package for every resubmission.
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CHANGE_REQUEST_RESPONDED';

CREATE TABLE "change_request_responses" (
  "id" UUID NOT NULL,
  "change_request_id" UUID NOT NULL,
  "resubmission_id" UUID NOT NULL,
  "responded_by_user_id" UUID NOT NULL,
  "response" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "change_request_responses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "change_request_responses_change_request_id_key" UNIQUE ("change_request_id"),
  CONSTRAINT "change_request_responses_resubmission_id_key" UNIQUE ("resubmission_id"),
  CONSTRAINT "change_request_responses_change_request_id_fkey"
    FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "change_request_responses_resubmission_id_fkey"
    FOREIGN KEY ("resubmission_id") REFERENCES "milestone_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "change_request_responses_responded_by_user_id_fkey"
    FOREIGN KEY ("responded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "change_request_responses_responded_by_user_id_idx"
  ON "change_request_responses"("responded_by_user_id");

CREATE TABLE "change_request_acceptance_criteria" (
  "change_request_id" UUID NOT NULL,
  "acceptance_criterion_id" UUID NOT NULL,
  CONSTRAINT "change_request_acceptance_criteria_pkey" PRIMARY KEY ("change_request_id", "acceptance_criterion_id"),
  CONSTRAINT "change_request_acceptance_criteria_change_request_id_fkey"
    FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "change_request_acceptance_criteria_acceptance_criterion_id_fkey"
    FOREIGN KEY ("acceptance_criterion_id") REFERENCES "acceptance_criteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "change_request_acceptance_criteria_acceptance_criterion_id_idx"
  ON "change_request_acceptance_criteria"("acceptance_criterion_id");

CREATE TABLE "change_request_evidence_items" (
  "change_request_id" UUID NOT NULL,
  "evidence_item_id" UUID NOT NULL,
  CONSTRAINT "change_request_evidence_items_pkey" PRIMARY KEY ("change_request_id", "evidence_item_id"),
  CONSTRAINT "change_request_evidence_items_change_request_id_fkey"
    FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "change_request_evidence_items_evidence_item_id_fkey"
    FOREIGN KEY ("evidence_item_id") REFERENCES "evidence_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "change_request_evidence_items_evidence_item_id_idx"
  ON "change_request_evidence_items"("evidence_item_id");

CREATE OR REPLACE FUNCTION trustpay_prevent_change_request_response_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('trustpay.allow_history_cleanup', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'change request responses are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER change_request_responses_append_only
BEFORE UPDATE OR DELETE ON "change_request_responses"
FOR EACH ROW EXECUTE FUNCTION trustpay_prevent_change_request_response_mutation();

-- Decisions, requests, their references, and activity are historical records.
-- The application database role must never rewrite or remove them.  The guarded
-- escape hatch is for isolated test cleanup only; it is set transaction-locally
-- in the PostgreSQL test suite and is not used by application code.
CREATE OR REPLACE FUNCTION trustpay_prevent_historical_record_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('trustpay.allow_history_cleanup', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER milestone_decisions_append_only
BEFORE UPDATE OR DELETE ON "milestone_decisions"
FOR EACH ROW EXECUTE FUNCTION trustpay_prevent_historical_record_mutation();

CREATE TRIGGER change_requests_append_only
BEFORE UPDATE OR DELETE ON "change_requests"
FOR EACH ROW EXECUTE FUNCTION trustpay_prevent_historical_record_mutation();

CREATE TRIGGER change_request_acceptance_criteria_append_only
BEFORE UPDATE OR DELETE ON "change_request_acceptance_criteria"
FOR EACH ROW EXECUTE FUNCTION trustpay_prevent_historical_record_mutation();

CREATE TRIGGER change_request_evidence_items_append_only
BEFORE UPDATE OR DELETE ON "change_request_evidence_items"
FOR EACH ROW EXECUTE FUNCTION trustpay_prevent_historical_record_mutation();

CREATE TRIGGER activity_events_append_only
BEFORE UPDATE OR DELETE ON "activity_events"
FOR EACH ROW EXECUTE FUNCTION trustpay_prevent_historical_record_mutation();
