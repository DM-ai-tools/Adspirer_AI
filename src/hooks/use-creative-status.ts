"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

export type LiveCreativeDraft = {
  id: string;
  concept: string;
  headline: string;
  primary_text: string;
  description?: string | null;
  cta?: string | null;
  creative_direction?: string | null;
  image_url?: string | null;
  image_status?: string | null;
  image_error?: string | null;
  image_model?: string | null;
  status?: string | null;
  brand_colors?: string[] | null;
  logo_url?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type CreativeProgress = {
  total: number;
  generating: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Left mid-render by a job that died; not coming back on its own. */
  stalled: number;
};

/** Tight enough to feel live while stills land, without hammering the API. */
const ACTIVE_POLL_MS = 2_500;
/** Slow background poll so a batch started on another screen still shows up. */
const IDLE_POLL_MS = 8_000;

/** Stable identity keeps consumers' memos from recomputing every render. */
const EMPTY_DRAFTS: LiveCreativeDraft[] = [];

/**
 * Follow creative generation from any surface.
 *
 * Generation runs server-side, so progress is read from the drafts rather than
 * held in the component that kicked it off. That is what lets the operator
 * start a batch in Workspace and watch it finish in Creatives, or reload
 * mid-run without losing the images.
 */
export function useCreativeStatus({
  clientId,
  conversationId,
  enabled = true,
}: {
  clientId?: string | null;
  conversationId?: string | null;
  enabled?: boolean;
}) {
  // Keyed by client so a client switch never shows the previous one's drafts
  // during the gap before the first poll lands.
  const [snapshot, setSnapshot] = useState<{
    clientId: string;
    drafts: LiveCreativeDraft[];
    progress: CreativeProgress | null;
    active: boolean;
  } | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !clientId) return;

    let cancelled = false;
    let timer: number | undefined;

    const url = new URL("/api/creatives/status", window.location.origin);
    url.searchParams.set("clientId", clientId);
    if (conversationId) url.searchParams.set("conversationId", conversationId);

    const schedule = (ms: number) => {
      timer = window.setTimeout(() => void tick(), ms);
    };

    const tick = async () => {
      try {
        const data = await apiFetch<{
          drafts: LiveCreativeDraft[];
          progress: CreativeProgress;
          active: boolean;
        }>(`${url.pathname}${url.search}`);
        if (cancelled) return;
        setSnapshot({
          clientId,
          drafts: data.drafts ?? [],
          progress: data.progress ?? null,
          active: Boolean(data.active),
        });
        schedule(data.active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      } catch {
        // A failed poll should slow us down, never stop the watch.
        if (!cancelled) schedule(IDLE_POLL_MS);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [clientId, conversationId, enabled, nonce]);

  const current =
    enabled && clientId && snapshot?.clientId === clientId ? snapshot : null;

  return {
    drafts: current?.drafts ?? EMPTY_DRAFTS,
    progress: current?.progress ?? null,
    active: current?.active ?? false,
    refresh,
  };
}
