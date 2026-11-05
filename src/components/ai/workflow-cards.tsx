"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, Download, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { creativeDownloadUrl } from "@/lib/creatives/download";

export type CreativeDraftCard = {
  id: string;
  concept: string;
  headline: string;
  primary_text: string;
  image_url?: string | null;
  image_status?: string | null;
  image_error?: string | null;
  status?: string | null;
};

export function InlineCreativeCards({
  drafts,
  disabled,
  onUpdated,
}: {
  drafts: CreativeDraftCard[];
  disabled?: boolean;
  onUpdated?: () => void | Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // Cards whose full ad copy is open; applies to every draft, old or new, since it only reads stored copy.
  const [copyOpen, setCopyOpen] = useState<Set<string>>(new Set());
  const toggleCopy = (id: string) =>
    setCopyOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function selectDraft(draftId: string) {
    setBusyId(draftId);
    try {
      const result = await apiFetch<{
        approvalIds: string[];
        queued: boolean;
        needsDetails?: boolean;
        blockedReason: string | null;
      }>("/api/creatives/select", {
        method: "POST",
        body: JSON.stringify({ draftId }),
      });

      if (result.queued) {
        toast.success(
          `Creative selected — attached to ${result.approvalIds.length} pending approval${result.approvalIds.length === 1 ? "" : "s"}`,
        );
      } else if (result.needsDetails) {
        toast.success("Creative selected — answer the ad copy question in the chat");
      } else {
        toast.error(
          result.blockedReason ??
            "Creative selected, but nothing could be queued for approval",
        );
      }

      await onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Select failed");
    } finally {
      setBusyId(null);
    }
  }

  async function moreLikeThis(draftId: string) {
    setBusyId(draftId);
    try {
      await apiFetch("/api/creatives/variations", {
        method: "POST",
        body: JSON.stringify({ draftId, count: 3 }),
      });
      toast.success("Making 3 close variations — they appear below");
      await onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not make variations");
    } finally {
      setBusyId(null);
    }
  }

  async function rejectDraft(draftId: string) {
    setBusyId(draftId);
    try {
      await apiFetch("/api/creatives/reject", {
        method: "POST",
        body: JSON.stringify({ draftId }),
      });
      toast.message("Creative rejected");
      await onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  if (!drafts.length) return null;

  const downloadable = drafts.filter(
    (d) => d.image_url && d.image_status === "succeeded" && d.status !== "rejected",
  );

  // Browsers allow several saves in a row only if they are spaced out a little.
  function downloadAll() {
    downloadable.forEach((d, i) => {
      window.setTimeout(() => {
        const a = document.createElement("a");
        a.href = creativeDownloadUrl(d.id);
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 450);
    });
  }

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8"
          onClick={() =>
            setCopyOpen(copyOpen.size === drafts.length ? new Set() : new Set(drafts.map((d) => d.id)))
          }
        >
          {copyOpen.size === drafts.length ? (
            <ChevronUp className="mr-1 h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="mr-1 h-3.5 w-3.5" />
          )}
          {copyOpen.size === drafts.length ? "Hide all ad copy" : "Show all ad copy"}
        </Button>
        {downloadable.length > 1 ? (
          <Button type="button" size="sm" variant="secondary" className="h-8" onClick={downloadAll}>
            <Download className="mr-1 h-3.5 w-3.5" />
            Download all ({downloadable.length})
          </Button>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
      {drafts.map((draft) => (
        <div
          key={draft.id}
          className={cn(
            "overflow-hidden rounded-lg border border-border bg-secondary/20",
            draft.status === "selected" && "border-accent ring-1 ring-accent/30",
          )}
        >
          {draft.image_status === "generating" ||
          draft.image_status === "pending" ? (
            // A rework keeps the previous still underneath so the card does not
            // go blank while the replacement renders.
            <div className="relative flex aspect-[4/5] items-center justify-center border-b border-border bg-secondary/30 text-xs text-muted">
              {draft.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={draft.image_url}
                  alt={draft.headline}
                  className="absolute inset-0 h-full w-full object-contain opacity-25"
                />
              ) : null}
              <span className="relative inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {draft.image_url ? "Reworking…" : "Generating…"}
              </span>
            </div>
          ) : draft.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.image_url}
              alt={draft.headline}
              className="block h-auto w-full border-b border-border bg-secondary/30 object-contain"
            />
          ) : (
            <div className="flex aspect-[4/5] items-center justify-center border-b border-border bg-secondary/30 text-xs text-muted">
              {draft.image_status === "failed"
                ? "Image failed"
                : "Waiting for image…"}
            </div>
          )}
          <div className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  draft.status === "selected"
                    ? "default"
                    : draft.status === "rejected"
                      ? "danger"
                      : "secondary"
                }
              >
                {draft.status === "selected"
                  ? "In campaign"
                  : draft.status === "rejected"
                    ? "Rejected"
                    : "Draft"}
              </Badge>
              {draft.image_status ? (
                <Badge variant="outline">{draft.image_status}</Badge>
              ) : null}
            </div>
            <p className="text-sm font-medium">{draft.headline}</p>
            <p
              className={cn(
                "whitespace-pre-wrap text-xs text-muted",
                !copyOpen.has(draft.id) && "line-clamp-3",
              )}
            >
              {draft.primary_text}
            </p>
            <button
              type="button"
              aria-expanded={copyOpen.has(draft.id)}
              onClick={() => toggleCopy(draft.id)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
            >
              {copyOpen.has(draft.id) ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {copyOpen.has(draft.id) ? "Hide ad copy" : "Show full ad copy"}
            </button>
            {draft.image_error ? (
              <p className="text-[11px] text-destructive">{draft.image_error}</p>
            ) : null}
            {draft.status === "selected" ? (
              <div className="space-y-2">
                <p className="rounded-md bg-accent/10 px-2.5 py-1.5 text-[11px] text-foreground">
                  Chosen for your campaign. Nothing is queued yet: I&apos;ll ask for the remaining
                  details in the chat first, then queue it for your approval.
                </p>
                {draft.image_url && draft.image_status === "succeeded" ? (
                  <Button type="button" size="sm" variant="secondary" className="h-8" asChild>
                    <a href={creativeDownloadUrl(draft.id)} download>
                      <Download className="mr-1 h-3.5 w-3.5" />
                      Download
                    </a>
                  </Button>
                ) : null}
              </div>
            ) : draft.status === "rejected" ? (
              <p className="text-[11px] text-muted">Rejected.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  disabled={disabled || busyId === draft.id || !draft.image_url}
                  onClick={() => void selectDraft(draft.id)}
                >
                  {busyId === draft.id ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="mr-1 h-3.5 w-3.5" />
                  )}
                  Use for campaign
                </Button>
                {draft.image_url && draft.image_status === "succeeded" ? (
                  <Button type="button" size="sm" variant="secondary" className="h-8" asChild>
                    <a href={creativeDownloadUrl(draft.id)} download>
                      <Download className="mr-1 h-3.5 w-3.5" />
                      Download
                    </a>
                  </Button>
                ) : null}
                {draft.image_url && draft.image_status === "succeeded" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8"
                    title="Make 3 close variations of this image: same idea and style, similar wording"
                    disabled={disabled || busyId === draft.id}
                    onClick={() => void moreLikeThis(draft.id)}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    More like this
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-8"
                  disabled={disabled || busyId === draft.id}
                  onClick={() => void rejectDraft(draft.id)}
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Reject
                </Button>
              </div>
            )}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}
