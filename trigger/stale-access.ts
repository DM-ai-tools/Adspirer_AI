import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";
import type { Notification } from "@/types";
import { defineJobTask } from "./optional-task";

export type StaleAccessPayload = {
  staleDays?: number;
  idempotencyKey?: string;
};

export type StaleAccessResult = {
  markedStale: number;
  skipped: number;
  requestIds: string[];
};

/**
 * Mark aging access requests as stale. Idempotent per request.
 */
export async function runStaleAccess(
  payload: StaleAccessPayload = {},
): Promise<StaleAccessResult> {
  const config = getConfig();
  const staleDays = payload.staleDays ?? config.ACCESS_REQUEST_STALE_DAYS;
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const ts = nowIso();

  let markedStale = 0;
  let skipped = 0;
  const requestIds: string[] = [];

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    for (const req of store.clientAccessRequests) {
      if (req.status !== "requested" && req.status !== "not_requested") {
        skipped += 1;
        continue;
      }
      if (req.marked_stale_at) {
        skipped += 1;
        continue;
      }
      const anchor = req.sent_at ?? req.created_at;
      if (new Date(anchor).getTime() > cutoff) {
        skipped += 1;
        continue;
      }

      req.status = "stale";
      req.marked_stale_at = ts;
      req.updated_at = ts;
      markedStale += 1;
      requestIds.push(req.id);

      const notifId = `notif_stale_${req.id}`;
      if (!store.notifications.some((n) => n.id === notifId)) {
        const admin = store.profiles.find((p) => p.role === "admin");
        if (admin) {
          const notification: Notification = {
            id: notifId,
            user_id: admin.id,
            client_id: req.client_id,
            type: "access_stale",
            title: "Access request marked stale",
            body: `Access request ${req.id} exceeded ${staleDays} days without grant.`,
            href: `/admin/access`,
            read_at: null,
            created_at: ts,
          };
          store.notifications.push(notification);
        }
      }
    }
  }

  logger.info("Stale access job completed", {
    markedStale,
    skipped,
    staleDays,
    idempotencyKey: payload.idempotencyKey,
  });

  return { markedStale, skipped, requestIds };
}

export const staleAccessTask = defineJobTask(
  "stale-access",
  runStaleAccess,
);
