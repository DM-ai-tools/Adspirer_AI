import { runMonitorClient, type MonitorMode } from "@/lib/monitoring/scheduled";
import { defineJobTask } from "./optional-task";

/**
 * On-demand monitoring of one client. Read-only on Meta: it records a
 * snapshot, raises de-duplicated alerts and queues fixes as draft approvals.
 *
 * The daily and hourly schedules run from a Railway cron calling
 * POST /api/cron/monitoring (see src/app/api/cron/monitoring/route.ts), not
 * from Trigger.dev, so each check runs once.
 */

export type MonitorClientPayload = { clientId: string; mode?: MonitorMode };

export const monitorClientTask = defineJobTask("monitor-client", (payload: MonitorClientPayload) =>
  runMonitorClient(payload),
);
