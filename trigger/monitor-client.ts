import { schedules } from "@trigger.dev/sdk";
import { runMonitorAllClients, runMonitorClient, type MonitorMode } from "@/lib/monitoring/scheduled";
import { defineJobTask } from "./optional-task";

/**
 * Scheduled monitoring. Read-only on Meta: it records a snapshot, raises
 * de-duplicated alerts to the client's team (and Slack when configured) and
 * queues fixes as draft approvals. It never pauses, edits or spends anything.
 */

export type MonitorClientPayload = { clientId: string; mode?: MonitorMode };

export const monitorClientTask = defineJobTask("monitor-client", (payload: MonitorClientPayload) =>
  runMonitorClient(payload),
);

/** Every morning (08:00 Sydney, 21:00 UTC): everything, down to ads. */
export const monitorAllClientsTask = schedules.task({
  id: "monitor-all-clients",
  cron: "0 21 * * *",
  run: () => runMonitorAllClients("daily"),
});

/** Every hour: delivery, tracking and account status only. */
export const monitorDeliveryHourlyTask = schedules.task({
  id: "monitor-delivery-hourly",
  cron: "15 * * * *",
  run: () => runMonitorAllClients("hourly"),
});
