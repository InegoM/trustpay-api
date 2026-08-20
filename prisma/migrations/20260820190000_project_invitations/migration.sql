ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CUSTOMER_INVITED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'CUSTOMER_APPROVER_JOINED';

ALTER TABLE "invitations" ADD COLUMN "project_id" UUID;

CREATE INDEX "invitations_project_id_status_idx"
ON "invitations"("project_id", "status");

ALTER TABLE "invitations"
ADD CONSTRAINT "invitations_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
