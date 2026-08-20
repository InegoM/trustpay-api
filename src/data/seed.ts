import type { ActivityEvent, Project } from "../domain/types.js";

export const seedProject: Project = {
  id: "cafe-renovation",
  name: "Café Renovation",
  customer: "Cedar Café",
  sme: "Alba Fit-Out",
  agreedValue: 90_000,
  approvedValue: 18_000,
  outstandingValue: 72_000,
  status: "in-progress",
  agreementVersion: "v1.2",
  agreementAcceptedAt: "2026-08-08T16:05:00+04:00",
  authorizedApprover: "Omar Hassan",
  milestones: [
    {
      id: 1,
      name: "Design and planning",
      value: 18_000,
      status: "approved",
      completedAt: "2026-08-10T11:30:00+04:00",
    },
    {
      id: 2,
      name: "Structural and electrical work",
      value: 45_000,
      status: "awaiting-decision",
      description:
        "Rough-in phase completed with structural partitions, electrical wiring, and plumbing lines installed.",
      acceptanceCriteria: [
        "Structural partitions match the approved layout",
        "Electrical and plumbing rough-in is complete",
        "Submitted evidence clearly shows completed work",
      ],
      submittedBy: "Alba Fit-Out",
      submittedAt: "2026-08-20T09:25:00+04:00",
      responseDeadline: "2026-08-27T17:00:00+04:00",
    },
    {
      id: 3,
      name: "Finishing and handover",
      value: 27_000,
      status: "not-started",
    },
  ],
};

export const seedActivity: ActivityEvent[] = [
  {
    id: "event-1",
    projectId: "cafe-renovation",
    milestoneId: 2,
    actor: "Nadia Rahman",
    actorType: "sme",
    occurredAt: "2026-08-20T09:25:00+04:00",
    description: "Evidence submitted for Milestone 2 — 4 items uploaded for customer review",
    type: "evidence-submitted",
  },
  {
    id: "event-2",
    projectId: "cafe-renovation",
    milestoneId: 1,
    actor: "Omar Hassan",
    actorType: "customer",
    occurredAt: "2026-08-10T11:30:00+04:00",
    description: "Milestone 1 approved — Design and planning",
    type: "milestone-approved",
  },
  {
    id: "event-3",
    projectId: "cafe-renovation",
    actor: "Omar Hassan",
    actorType: "customer",
    occurredAt: "2026-08-08T16:05:00+04:00",
    description: "Agreement v1.2 accepted by Omar Hassan (Cedar Café)",
    type: "agreement-accepted",
  },
];
