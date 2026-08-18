import { getDemoStore } from "@/lib/demo/store";
import { researchClientService } from "@/lib/competitors/service";
import { logger } from "@/lib/observability/logger";
import { defineJobTask } from "./optional-task";

export type RefreshCompetitorsPayload = {
  clientId?: string;
  serviceId?: string;
  /** Prevents duplicate brief generation for the same scope/day. */
  idempotencyKey?: string;
};

export type RefreshCompetitorsResult = {
  briefsGenerated: number;
  skipped: number;
  briefIds: string[];
};

/**
 * Refresh competitor briefs. Diagnose/research only — no Execute mutations.
 */
export async function runRefreshCompetitors(
  payload: RefreshCompetitorsPayload = {},
): Promise<RefreshCompetitorsResult> {
  const store = getDemoStore();
  const day = new Date().toISOString().slice(0, 10);
  const services = store.clientServices.filter((s) => {
    if (!s.is_active) return false;
    if (payload.clientId && s.client_id !== payload.clientId) return false;
    if (payload.serviceId && s.id !== payload.serviceId) return false;
    return true;
  });

  let briefsGenerated = 0;
  let skipped = 0;
  const briefIds: string[] = [];

  for (const service of services) {
    const key =
      payload.idempotencyKey ??
      `competitors:${service.client_id}:${service.id}:${day}`;

    const already = store.competitorBriefs.find(
      (b) =>
        b.client_id === service.client_id &&
        b.client_service_id === service.id &&
        (b.raw_research as { idempotency_key?: string } | null)
          ?.idempotency_key === key,
    );
    if (already) {
      skipped += 1;
      briefIds.push(already.id);
      continue;
    }

    const brief = await researchClientService({
      clientId: service.client_id,
      serviceId: service.id,
    });
    brief.raw_research = {
      ...(brief.raw_research ?? {}),
      idempotency_key: key,
    };
    briefsGenerated += 1;
    briefIds.push(brief.id);
  }

  logger.info("Refresh competitors completed", {
    briefsGenerated,
    skipped,
  });

  return { briefsGenerated, skipped, briefIds };
}

export const refreshCompetitorsTask = defineJobTask(
  "refresh-competitors",
  runRefreshCompetitors,
);
