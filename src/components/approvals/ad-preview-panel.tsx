"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalPreview } from "@/lib/approvals/preview";

/**
 * "Preview ad" on a create approval: Meta's own rendering per placement
 * (feed, Instagram, Reels) before anything is created. Without a Meta frame
 * (demo, or Meta refused) it draws a simple mock-up from the ad's copy.
 */
export function AdPreviewPanel({
  approvalId,
  fallback,
}: {
  approvalId: string;
  fallback: { headline?: string; primaryText?: string; imageUrl?: string };
}) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [data, setData] = useState<ApprovalPreview | null>(null);
  const [tab, setTab] = useState(0);

  async function load() {
    setState("loading");
    try {
      setData(await apiFetch<ApprovalPreview>(`/api/approvals/${approvalId}/preview`));
    } catch (error) {
      setData({ previews: [], note: error instanceof Error ? error.message : "Preview failed" });
    }
    setState("done");
  }

  if (state === "idle") {
    return (
      <Button size="sm" variant="ghost" onClick={load}>
        <Eye className="mr-1 h-3.5 w-3.5" /> Preview ad
      </Button>
    );
  }
  if (state === "loading") return <p className="text-xs text-muted">Loading Meta preview…</p>;

  const previews = data?.previews ?? [];
  const current = previews[tab];
  return (
    <div className="space-y-2 rounded-lg border border-border-subtle p-2">
      {previews.length ? (
        <div className="flex flex-wrap gap-1">
          {previews.map((p, i) => (
            <button
              key={p.format}
              type="button"
              onClick={() => setTab(i)}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs",
                i === tab ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
      {current?.iframeSrc ? (
        <iframe
          key={current.iframeSrc}
          src={current.iframeSrc}
          title={`${current.label} preview`}
          className="mx-auto block w-full max-w-[360px] rounded-md border-0 bg-white"
          style={{ height: current.format === "INSTAGRAM_REELS" ? 640 : 560 }}
          sandbox="allow-scripts allow-same-origin allow-popups"
          loading="lazy"
        />
      ) : previews.length || fallback.primaryText ? (
        <div className="mx-auto max-w-[320px] overflow-hidden rounded-md border border-border-subtle bg-background text-xs">
          <p className="whitespace-pre-wrap p-2 text-foreground/90">{fallback.primaryText}</p>
          {fallback.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fallback.imageUrl} alt="Ad image" className="aspect-[4/5] w-full object-cover" />
          ) : null}
          {fallback.headline ? <p className="p-2 font-semibold text-foreground">{fallback.headline}</p> : null}
          <p className="px-2 pb-2 text-[11px] text-muted">Mock-up — Meta&apos;s preview isn&apos;t available here.</p>
        </div>
      ) : null}
      {data?.note ? <p className="text-[11px] text-muted">{data.note}</p> : null}
    </div>
  );
}
