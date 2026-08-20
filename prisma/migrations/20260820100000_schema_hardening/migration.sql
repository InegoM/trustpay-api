-- Financial values are stored as integer minor units and cannot be negative.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_value_bounds"
  CHECK (
    "agreed_value_minor" >= 0
    AND "approved_value_minor" >= 0
    AND "approved_value_minor" <= "agreed_value_minor"
  ),
  ADD CONSTRAINT "projects_currency_code_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$');

ALTER TABLE "milestones"
  ADD CONSTRAINT "milestones_positive_sequence"
  CHECK ("sequence_number" > 0),
  ADD CONSTRAINT "milestones_positive_value"
  CHECK ("value_minor" > 0);

ALTER TABLE "milestone_submissions"
  ADD CONSTRAINT "milestone_submissions_positive_number"
  CHECK ("submission_number" > 0);

ALTER TABLE "evidence_items"
  ADD CONSTRAINT "evidence_items_nonnegative_size"
  CHECK ("size_bytes" >= 0),
  ADD CONSTRAINT "evidence_items_sha256_format"
  CHECK ("sha256" ~ '^[A-Fa-f0-9]{64}$');

ALTER TABLE "activity_events"
  ADD CONSTRAINT "activity_events_actor_type"
  CHECK ("actor_type" IN ('sme', 'customer', 'system'));

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_has_recipient"
  CHECK ("organization_id" IS NOT NULL OR "user_id" IS NOT NULL);

-- A project has at most one SME and one customer party, while allowing
-- multiple future payment partners.
CREATE UNIQUE INDEX "project_parties_one_sme"
  ON "project_parties" ("project_id")
  WHERE "role" = 'SME';

CREATE UNIQUE INDEX "project_parties_one_customer"
  ON "project_parties" ("project_id")
  WHERE "role" = 'CUSTOMER';

-- Only one agreement version can be active for a project at a time.
CREATE UNIQUE INDEX "agreement_versions_one_active"
  ON "agreement_versions" ("project_id")
  WHERE "status" = 'ACTIVE';

-- A decision subtype must match the action recorded on its parent decision.
CREATE FUNCTION "enforce_decision_subtype"() RETURNS trigger AS $$
DECLARE
  expected_action "DecisionAction";
BEGIN
  expected_action := CASE TG_TABLE_NAME
    WHEN 'change_requests' THEN 'REQUEST_CHANGES'::"DecisionAction"
    WHEN 'disputes' THEN 'RAISE_DISPUTE'::"DecisionAction"
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM "milestone_decisions"
    WHERE "id" = NEW."decision_id"
      AND "action" = expected_action
  ) THEN
    RAISE EXCEPTION '% does not match its milestone decision action', TG_TABLE_NAME;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "change_requests_match_decision"
  BEFORE INSERT OR UPDATE ON "change_requests"
  FOR EACH ROW EXECUTE FUNCTION "enforce_decision_subtype"();

CREATE TRIGGER "disputes_match_decision"
  BEFORE INSERT OR UPDATE ON "disputes"
  FOR EACH ROW EXECUTE FUNCTION "enforce_decision_subtype"();
