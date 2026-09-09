import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { analyzeBrandFromUrl } from "@/lib/brand/analyze-url";
import {
  buildVisualVariantConcepts,
  generateCreativeConcepts,
} from "@/lib/creatives/generator";
import { generateImageForDraft } from "@/lib/creatives/generate-draft-image";
import {
  toPublicDraft,
  upsertCreativeDraftAsync,
  type CreativeDraft,
} from "@/lib/creatives/drafts";
import { logger } from "@/lib/observability/logger";
import { appendWorkflowMessage } from "@/lib/workflow/events";
import { patchTaskAgentState } from "@/lib/workflow/state";
import { createAdminClient } from "@/lib/supabase/admin";

export type GenerateCreativesInput = {
  clientId: string;
  serviceId?: string;
  conversationId?: string;
  taskId?: string;
  count?: number;
  generateImages?: boolean;
  landingPageUrl?: string;
  /** Preferred URL for brand colour / logo scrape when distinct from landing. */
  brandUrl?: string;
  headline?: string;
  primaryText?: string;
  /** Competitor / reference notes for art direction. */
  referenceBrief?: string;
  analyzeBrand?: boolean;
};

export type GenerateCreativesResult = {
  drafts: CreativeDraft[];
  concepts: ReturnType<typeof toPublicDraft>[];
  brandAnalysis: Awaited<ReturnType<typeof analyzeBrandFromUrl>> | null;
  briefId: string | null;
  openaiConfigured: boolean;
  imageModel: string;
};

async function loadScope(input: GenerateCreativesInput) {
  const config = getConfig();
  let client: {
    id: string;
    name: string;
    brand_voice: string | null;
    brand_colors: string[] | null;
    brand_guidelines?: string | null;
    website_url?: string | null;
    target_audience?: string | null;
    value_proposition?: string | null;
  };
  let service: {
    id: string;
    name: string;
    description: string | null;
    landing_page_url?: string | null;
  } | null = null;
  let brief: { id: string; opportunities?: string[] | null; messaging_themes?: string[] | null } | null =
    null;

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const c = store.clients.find((x) => x.id === input.clientId);
    if (!c) throw new Error("Client not found");
    client = c;
    service =
      (input.serviceId
        ? store.clientServices.find(
            (s) => s.id === input.serviceId && s.client_id === input.clientId,
          )
        : store.clientServices.find((s) => s.client_id === input.clientId)) ??
      null;
    if (service) {
      brief =
        store.competitorBriefs
          .filter(
            (b) =>
              b.client_id === input.clientId &&
              b.client_service_id === service!.id,
          )
          .sort((a, b) =>
            (b.generated_at ?? b.created_at).localeCompare(
              a.generated_at ?? a.created_at,
            ),
          )[0] ?? null;
    }
  } else {
    const admin = createAdminClient();
    const { data: clientRow } = await admin
      .from("clients")
      .select("*")
      .eq("id", input.clientId)
      .single();
    if (!clientRow) throw new Error("Client not found");
    client = clientRow;
    if (input.serviceId) {
      const { data: serviceRow } = await admin
        .from("client_services")
        .select("*")
        .eq("id", input.serviceId)
        .eq("client_id", input.clientId)
        .single();
      service = serviceRow;
      if (serviceRow) {
        const { data: briefs } = await admin
          .from("competitor_briefs")
          .select("*")
          .eq("client_id", input.clientId)
          .eq("client_service_id", input.serviceId)
          .order("generated_at", { ascending: false })
          .limit(1);
        brief = briefs?.[0] ?? null;
      }
    }
  }

  return { client, service, brief };
}

export async function generateCreativeDrafts(
  input: GenerateCreativesInput,
): Promise<GenerateCreativesResult> {
  const config = getConfig();
  const { client, service, brief } = await loadScope(input);
  const landing =
    input.landingPageUrl || service?.landing_page_url || undefined;

  // Brand look: explicit brand URL, else landing, else client website.
  const brandSourceUrl =
    input.brandUrl || landing || client.website_url || undefined;

  let brandAnalysis = null as Awaited<
    ReturnType<typeof analyzeBrandFromUrl>
  > | null;
  if (input.analyzeBrand !== false && brandSourceUrl) {
    try {
      brandAnalysis = await analyzeBrandFromUrl(brandSourceUrl);
    } catch (error) {
      logger.warn("Brand analysis failed; creatives will be unbranded", {
        url: brandSourceUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      brandAnalysis = null;
    }
  } else if (!brandSourceUrl) {
    logger.warn("No landing page or client website to pull brand cues from", {
      clientId: input.clientId,
    });
  }

  const colors =
    brandAnalysis?.colors?.length ? brandAnalysis.colors : client.brand_colors;
  const brandVoice = brandAnalysis?.brand_voice || client.brand_voice;
  const brandName = brandAnalysis?.brand_name || client.name;
  const serviceName = service?.name ?? "Brand offer";
  const conceptCount = Math.min(Math.max(input.count ?? 3, 1), 5);

  const guidelinesNote = client.brand_guidelines?.trim()
    ? `Brand guidelines: ${client.brand_guidelines.trim().slice(0, 600)}`
    : null;
  const referenceNote = input.referenceBrief?.trim()
    ? `Reference / competitor recreate brief: ${input.referenceBrief
        .trim()
        .slice(0, 800)}`
    : null;
  const directionParts = [
    brandAnalysis?.imagery_notes ?? null,
    guidelinesNote,
    referenceNote,
  ].filter(Boolean);
  const baseDirection = directionParts.length
    ? directionParts.join(" | ")
    : null;

  // Supplied copy means the operator wants the SAME ad rendered several ways,
  // so vary the art direction instead of rewriting their headline.
  const hasSuppliedCopy = Boolean(input.headline || input.primaryText);

  const concepts =
    hasSuppliedCopy || !service
      ? buildVisualVariantConcepts({
          clientId: input.clientId,
          serviceId: service?.id ?? null,
          brandName,
          serviceName,
          headline: input.headline || client.value_proposition || brandName,
          primaryText:
            input.primaryText ||
            client.value_proposition ||
            `${brandName} — ${serviceName}`,
          description: service?.description ?? serviceName,
          baseDirection,
          audience: client.target_audience,
          count: conceptCount,
        })
      : generateCreativeConcepts({
          client: {
            ...client,
            brand_colors: colors,
            brand_voice: brandVoice,
          } as never,
          service: service as never,
          brief: brief as never,
          count: conceptCount,
        });

  // Images are produced after this call returns, so the rows are born
  // "generating" and every surface can render a live placeholder immediately.
  const willGenerateImages = input.generateImages !== false && config.hasOpenAI;

  const drafts: CreativeDraft[] = [];
  for (const concept of concepts) {
    const draft = await upsertCreativeDraftAsync({
      client_id: input.clientId,
      service_id: service?.id ?? null,
      conversation_id: input.conversationId ?? null,
      task_id: input.taskId ?? null,
      brief_id: brief?.id ?? null,
      concept: concept.concept,
      headline: concept.headline,
      primary_text: concept.primary_text,
      description: concept.description,
      cta: concept.cta,
      creative_direction: concept.creative_direction,
      image_url: null,
      image_b64: null,
      image_mime: "image/png",
      image_model: null,
      image_prompt: null,
      image_status: willGenerateImages ? "generating" : "skipped",
      image_error: null,
      landing_page_url: landing ?? null,
      brand_colors: colors,
      logo_url: brandAnalysis?.logo_url ?? null,
      revision_notes: null,
      status: "draft",
    });
    drafts.push(draft);
  }

  if (input.taskId) {
    await patchTaskAgentState(input.taskId, {
      creatives: {
        request: {
          landing_page_url: landing ?? null,
          headline: input.headline ?? null,
          primary_text: input.primaryText ?? null,
          service_id: service?.id ?? null,
          brief_id: brief?.id ?? null,
        },
        draft_ids: drafts.map((d) => d.id),
        last_event_at: new Date().toISOString(),
      },
    });
  }

  if (input.conversationId) {
    await appendWorkflowMessage({
      conversationId: input.conversationId,
      taskId: input.taskId,
      eventType: "creative_generating",
      content: `Generating ${drafts.length} creative concept${drafts.length === 1 ? "" : "s"}${landing ? ` from ${landing}` : ""}. Images will appear here as they finish.`,
      metadata: {
        ui: {
          creativePicker: {
            drafts: drafts.map(toPublicDraft),
            status: willGenerateImages ? "generating" : "concepts_ready",
          },
        },
        draftIds: drafts.map((d) => d.id),
      },
    });
  }

  return {
    drafts,
    concepts: drafts.map(toPublicDraft),
    brandAnalysis,
    briefId: brief?.id ?? null,
    openaiConfigured: config.hasOpenAI,
    imageModel: config.OPENAI_IMAGE_MODEL,
  };
}

export async function generateImagesForDrafts(input: {
  draftIds: string[];
  brandName?: string;
  conversationId?: string;
  taskId?: string;
}): Promise<CreativeDraft[]> {
  // Generated in parallel so one slow or failing still cannot truncate the
  // batch, and so N variants cost roughly one image's wall time instead of N.
  const results = await Promise.allSettled(
    input.draftIds.map((draftId) =>
      generateImageForDraft(draftId, input.brandName),
    ),
  );

  const updated: CreativeDraft[] = [];
  for (const [index, settled] of results.entries()) {
    const draftId = input.draftIds[index]!;

    if (settled.status === "rejected") {
      const message =
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
      logger.warn("Creative image generation threw", { draftId, error: message });
      if (input.conversationId) {
        await appendWorkflowMessage({
          conversationId: input.conversationId,
          taskId: input.taskId,
          eventType: "creative_failed",
          content: `Creative image failed: ${message}`,
          metadata: { draftId },
        });
      }
      continue;
    }

    const result = settled.value;
    const draft = result.draft;
    updated.push(draft);

    if (input.conversationId) {
      await appendWorkflowMessage({
        conversationId: input.conversationId,
        taskId: input.taskId,
        eventType:
          result.imageStatus === "succeeded"
            ? "creative_ready"
            : "creative_failed",
        content:
          result.imageStatus === "succeeded"
            ? `Creative ready: **${draft.headline}**`
            : `Creative image failed for **${draft.headline}**: ${result.imageError ?? "Unknown error"}`,
        metadata: {
          ui: {
            creativePicker: {
              drafts: [toPublicDraft(draft)],
              status:
                result.imageStatus === "succeeded" ? "ready" : "failed",
            },
          },
          draftId: draft.id,
        },
      });
    }
  }

  if (input.taskId && updated.length) {
    await patchTaskAgentState(input.taskId, {
      creatives: {
        draft_ids: input.draftIds,
        last_event_at: new Date().toISOString(),
      },
    });
  }

  return updated;
}

/**
 * Persist the concepts now, hand back the slow image work for the caller to
 * schedule after the response.
 *
 * Callers get draft rows in "generating" state within a couple of seconds, so
 * the chat and the Creatives page can both render live placeholders and poll
 * `/api/creatives/status` while the stills render server-side.
 */
export async function startCreativeGeneration(
  input: GenerateCreativesInput,
): Promise<{
  result: GenerateCreativesResult;
  runImages: (() => Promise<CreativeDraft[]>) | null;
}> {
  const result = await generateCreativeDrafts(input);
  if (input.generateImages === false || !result.openaiConfigured) {
    return { result, runImages: null };
  }

  const brandName =
    result.brandAnalysis?.brand_name ??
    result.drafts[0]?.concept.split("—")[0]?.trim();
  const draftIds = result.drafts.map((d) => d.id);

  return {
    result,
    runImages: () =>
      generateImagesForDrafts({
        draftIds,
        brandName,
        conversationId: input.conversationId,
        taskId: input.taskId,
      }),
  };
}

export async function runFullCreativeGeneration(
  input: GenerateCreativesInput,
): Promise<GenerateCreativesResult & { updatedDrafts: CreativeDraft[] }> {
  const base = await generateCreativeDrafts(input);
  if (input.generateImages === false || !base.openaiConfigured) {
    return { ...base, updatedDrafts: base.drafts };
  }
  const brandName =
    base.brandAnalysis?.brand_name ??
    base.drafts[0]?.concept.split("—")[0]?.trim();
  const updatedDrafts = await generateImagesForDrafts({
    draftIds: base.drafts.map((d) => d.id),
    brandName,
    conversationId: input.conversationId,
    taskId: input.taskId,
  });

  // Keep every requested variant in the result, even ones whose image failed,
  // so the reported count always matches what the operator was promised.
  const byId = new Map(updatedDrafts.map((d) => [d.id, d]));
  const merged = base.drafts.map((d) => byId.get(d.id) ?? d);

  return {
    ...base,
    drafts: merged,
    concepts: merged.map(toPublicDraft),
    updatedDrafts,
  };
}
