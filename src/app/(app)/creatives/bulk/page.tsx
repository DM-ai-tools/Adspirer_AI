"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronDown, ChevronUp, Copy, Download, FileSpreadsheet, Layers, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingState } from "@/components/shared/loading-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ImageFormatPicker } from "@/components/creatives/image-format-picker";
import { apiFetch } from "@/lib/api-client";
import { creativeDownloadUrl } from "@/lib/creatives/download";
import type { ImageFormat } from "@/lib/creatives/formats";
import { STAGE_LABEL, type AwarenessStage } from "@/lib/creatives/bulk/angles";
import { cn } from "@/lib/utils";
import type { ClientService } from "@/types";

type Item = {
  draft_id: string;
  angle_name: string | null;
  stage: string | null;
  kind: string | null;
  targets: string | null;
  body_id: string | null;
  cta_label: string | null;
};

type Card = {
  id: string;
  headline: string;
  primary_text: string;
  image_url?: string | null;
  image_status?: string | null;
  image_error?: string | null;
  status?: string | null;
  item: Item;
};

type RunView = {
  run: {
    id: string;
    status: "planning" | "rendering" | "done" | "failed";
    error: string | null;
    bodies: Array<{ id: string; format: string; text: string }> | null;
  };
  cards: Card[];
  progress: { total: number; succeeded: number; failed: number; rendering: number; waiting: number };
  needsContinue: boolean;
};

type HistoryRun = {
  id: string;
  status: "planning" | "rendering" | "done" | "failed";
  created_at: string;
  landing_page_url: string | null;
  image_format: string;
  count: number;
  ready: number;
  failed: number;
  thumbs: Array<{ id: string; url: string | null }>;
};

type Summary = { monthly: { count: number; target: number }; runSize: number; runs: HistoryRun[] };

const STATUS_LABEL: Record<HistoryRun["status"], string> = {
  planning: "Writing",
  rendering: "Rendering",
  done: "Done",
  failed: "Failed",
};

const POLL_MS = 2_500;

/** Excel export of one run (`runId`) or all of a client's runs (`clientId`), dated in the viewer's time zone. */
function exportUrl(target: { runId?: string; clientId?: string }): string {
  const params = new URLSearchParams();
  if (target.runId) params.set("runId", target.runId);
  if (target.clientId) params.set("clientId", target.clientId);
  try {
    params.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    // dates fall back to UTC
  }
  return `/api/creatives/bulk/export?${params.toString()}`;
}

function BulkInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const runId = searchParams.get("runId");
  const { clients, selectedClientId, setSelectedClientId } = useApp();
  const client = clients.find((c) => c.id === selectedClientId);

  const [services, setServices] = useState<ClientService[]>([]);
  const [serviceId, setServiceId] = useState<string | undefined>();
  const [landingUrl, setLandingUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [pastedCopy, setPastedCopy] = useState("");
  const [format, setFormat] = useState<ImageFormat>("4:5");
  const [tab, setTab] = useState<"new" | "history">(searchParams.get("tab") === "history" ? "history" : "new");
  const [starting, setStarting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [view, setView] = useState<RunView | null>(null);
  const [copyOpen, setCopyOpen] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const continuing = useRef(false);

  useEffect(() => {
    setTab(searchParams.get("tab") === "history" ? "history" : "new");
  }, [searchParams]);

  const loadSummary = useCallback(async () => {
    if (!selectedClientId) return;
    try {
      setSummary(await apiFetch<Summary>(`/api/creatives/bulk?clientId=${selectedClientId}`));
    } catch {
      setSummary(null);
    }
  }, [selectedClientId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary, view?.run.status]);

  useEffect(() => {
    if (!selectedClientId) {
      setServices([]);
      setServiceId(undefined);
      return;
    }
    void (async () => {
      try {
        const data = await apiFetch<{ services: ClientService[] }>(`/api/clients/${selectedClientId}/services`);
        setServices(data.services);
        setServiceId(data.services[0]?.id);
      } catch {
        setServices([]);
      }
    })();
  }, [selectedClientId]);

  // Follow the run: the work happens on the server, so the screen only reads progress (and nudges a
  // run whose worker ran out of time to carry on).
  useEffect(() => {
    if (!runId) {
      setView(null);
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await apiFetch<RunView>(`/api/creatives/bulk/${runId}`);
        if (stopped) return;
        setView(next);
        if (next.needsContinue && !continuing.current) {
          continuing.current = true;
          void apiFetch(`/api/creatives/bulk/${runId}/continue`, { method: "POST" })
            .catch(() => undefined)
            .finally(() => {
              continuing.current = false;
            });
        }
        const active = next.run.status === "planning" || next.run.status === "rendering";
        if (active) timer = window.setTimeout(() => void tick(), POLL_MS);
      } catch (err) {
        if (!stopped) toast.error(err instanceof Error ? err.message : "Could not load the run");
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [runId]);

  const canStart = Boolean(selectedClientId) && Boolean(landingUrl.trim() || notes.trim() || pastedCopy.trim() || serviceId);

  async function start() {
    if (!selectedClientId) return;
    setStarting(true);
    try {
      const data = await apiFetch<{ runId: string }>("/api/creatives/bulk", {
        method: "POST",
        body: JSON.stringify({
          clientId: selectedClientId,
          serviceId,
          landingPageUrl: landingUrl.trim() || undefined,
          notes: notes.trim() || undefined,
          pastedCopy: pastedCopy.trim() || undefined,
          format,
        }),
      });
      router.replace(`/creatives/bulk?runId=${data.runId}`);
      toast.success("Run started. You can leave this page; it keeps going.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the run");
    } finally {
      setStarting(false);
    }
  }

  async function moreLikeThis(id: string) {
    setBusyId(id);
    try {
      await apiFetch("/api/creatives/variations", { method: "POST", body: JSON.stringify({ draftId: id, count: 3 }) });
      toast.success("Making 3 close variations. They appear in the Creatives list.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not make variations");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    setBusyId(id);
    try {
      await apiFetch("/api/creatives/reject", { method: "POST", body: JSON.stringify({ draftId: id }) });
      setView((v) => (v ? { ...v, cards: v.cards.map((c) => (c.id === id ? { ...c, status: "rejected" } : c)) } : v));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  const toggleCopy = (id: string) =>
    setCopyOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const downloadable = view?.cards.filter((c) => c.image_url && c.image_status === "succeeded" && c.status !== "rejected") ?? [];
  function downloadAll() {
    downloadable.forEach((c, i) => {
      window.setTimeout(() => {
        const a = document.createElement("a");
        a.href = creativeDownloadUrl(c.id);
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 450);
    });
  }

  const monthly = summary?.monthly;
  const pct = monthly ? Math.min(100, Math.round((monthly.count / monthly.target) * 100)) : 0;

  return (
    <div>
      <PageHeader
        title="Bulk run"
        description="15 ads from one brief: every hook a different angle, a few bodies reused behind them."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={selectedClientId ?? undefined} onValueChange={setSelectedClientId}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="secondary" asChild>
              <Link href="/creatives">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Creatives
              </Link>
            </Button>
          </div>
        }
      />

      {!client ? (
        <EmptyState icon={Layers} title="Select a client" description="Choose a client to plan a bulk run." />
      ) : (
        <div className="space-y-6">
          {monthly ? (
            <Card>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">This month&apos;s target</span>
                  <span className="text-muted">
                    {monthly.count} / {monthly.target} images
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-[11px] text-muted">
                  Counts finished, kept images from bulk runs for this client. {Math.max(0, monthly.target - monthly.count)} to go, about{" "}
                  {Math.ceil(Math.max(0, monthly.target - monthly.count) / (summary?.runSize ?? 15))} more run(s).
                </p>
              </CardContent>
            </Card>
          ) : null}

          {!runId ? (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "new" | "history")}>
              <TabsList>
                <TabsTrigger value="new">New run</TabsTrigger>
                <TabsTrigger value="history">History{summary?.runs.length ? ` (${summary.runs.length})` : ""}</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}

          {!runId && tab === "history" ? (
            !summary ? (
              <LoadingState />
            ) : summary.runs.length === 0 ? (
              <EmptyState icon={Layers} title="No bulk runs yet" description="Runs you create appear here, with their images and copy." />
            ) : (
              <div className="space-y-3">
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" asChild>
                  <a href={exportUrl({ clientId: selectedClientId ?? undefined })} download>
                    <FileSpreadsheet className="mr-1 h-3.5 w-3.5" />
                    Export all history to Excel
                  </a>
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {summary.runs.map((r) => (
                  <Card key={r.id}>
                    <CardContent className="space-y-3 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium">
                            {new Date(r.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                          </p>
                          <p className="max-w-[320px] truncate text-[11px] text-muted">{r.landing_page_url ?? "No landing page"}</p>
                        </div>
                        <div className="flex gap-1.5">
                          <Badge variant={r.status === "failed" ? "danger" : "secondary"}>{STATUS_LABEL[r.status]}</Badge>
                          <Badge variant="outline">{r.image_format}</Badge>
                        </div>
                      </div>
                      {r.thumbs.length ? (
                        <div className="grid grid-cols-4 gap-1.5">
                          {r.thumbs.map((t) =>
                            t.url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={t.id} src={t.url} alt="" className="aspect-[4/5] w-full rounded-md border border-border object-cover" />
                            ) : null,
                          )}
                        </div>
                      ) : null}
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted">
                          {r.ready} of {r.count} images ready{r.failed ? ` · ${r.failed} failed` : ""}
                        </p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" asChild>
                            <a href={exportUrl({ runId: r.id })} download>
                              <FileSpreadsheet className="mr-1 h-3.5 w-3.5" />
                              Excel
                            </a>
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => router.replace(`/creatives/bulk?runId=${r.id}`)}>
                            Open
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              </div>
            )
          ) : null}

          {!runId && tab === "new" ? (
            <Card>
              <CardContent className="space-y-4 p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs text-muted">Landing page URL</p>
                    <Input value={landingUrl} onChange={(e) => setLandingUrl(e.target.value)} placeholder="https://…" />
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted">Service</p>
                    <Select value={serviceId} onValueChange={setServiceId} disabled={!services.length}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select service (optional)" />
                      </SelectTrigger>
                      <SelectContent>
                        {services.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted">Notes on the offer, audience and proof (optional)</p>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Who it is for, what they struggle with, results you can back up, anything to avoid saying…"
                    className="min-h-[88px]"
                  />
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted">Existing ad copy to build the bodies from (optional)</p>
                  <Textarea
                    value={pastedCopy}
                    onChange={(e) => setPastedCopy(e.target.value)}
                    placeholder="Paste copy that already works and the bodies will be based on it."
                    className="min-h-[72px]"
                  />
                </div>
                <ImageFormatPicker value={format} onChange={setFormat} disabled={starting} />
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => void start()} disabled={!canStart || starting}>
                    {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Layers className="mr-2 h-4 w-4" />}
                    Create {summary?.runSize ?? 15} ads
                  </Button>
                  <p className="text-[11px] text-muted">
                    Makes {summary?.runSize ?? 15} images, so it uses {summary?.runSize ?? 15} image generations. Takes a few minutes and keeps
                    going if you leave.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : !view ? (
            <LoadingState />
          ) : (
            <div className="space-y-4">
              <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="space-y-1 text-sm">
                    {view.run.status === "planning" ? (
                      <p className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" /> Reading the brand and writing 15 hooks…
                      </p>
                    ) : view.run.status === "failed" ? (
                      <p className="text-destructive">Run failed: {view.run.error ?? "unknown error"}</p>
                    ) : (
                      <p>
                        {view.progress.succeeded} of {view.progress.total} images ready
                        {view.progress.rendering ? ` · ${view.progress.rendering} rendering` : ""}
                        {view.progress.waiting ? ` · ${view.progress.waiting} waiting` : ""}
                        {view.progress.failed ? ` · ${view.progress.failed} failed` : ""}
                      </p>
                    )}
                    {view.run.bodies?.length ? (
                      <p className="text-[11px] text-muted">
                        {view.run.bodies.length} bodies reused behind the hooks:{" "}
                        {view.run.bodies.map((b) => `${b.id} (${b.format})`).join(", ")}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" asChild>
                      <a href={exportUrl({ runId: runId ?? undefined })} download>
                        <FileSpreadsheet className="mr-1 h-3.5 w-3.5" />
                        Export to Excel
                      </a>
                    </Button>
                    {downloadable.length > 1 ? (
                      <Button size="sm" variant="secondary" onClick={downloadAll}>
                        <Download className="mr-1 h-3.5 w-3.5" />
                        Download all ({downloadable.length})
                      </Button>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={() => router.replace("/creatives/bulk?tab=history")}>
                      History
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => router.replace("/creatives/bulk")}>
                      New run
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {view.cards.map((card, index) => {
                  const open = copyOpen.has(card.id);
                  const rejected = card.status === "rejected";
                  return (
                    <div key={card.id} className={cn("overflow-hidden rounded-lg border border-border bg-secondary/20", rejected && "opacity-50")}>
                      {card.image_url && card.image_status === "succeeded" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={card.image_url} alt={card.headline} className="block h-auto w-full border-b border-border object-contain" />
                      ) : (
                        <div className="flex aspect-[4/5] items-center justify-center border-b border-border bg-secondary/30 px-4 text-center text-xs text-muted">
                          {card.image_status === "failed" ? (
                            card.image_error ?? "Image failed"
                          ) : card.image_status === "generating" ? (
                            <span className="inline-flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin" /> Rendering…
                            </span>
                          ) : (
                            "Waiting its turn…"
                          )}
                        </div>
                      )}
                      <div className="space-y-2 p-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="secondary">#{index + 1}</Badge>
                          {card.item.angle_name ? <Badge>{card.item.angle_name}</Badge> : null}
                          {card.item.stage ? <Badge variant="outline">{STAGE_LABEL[card.item.stage as AwarenessStage] ?? card.item.stage}</Badge> : null}
                          {card.item.kind ? <Badge variant="outline">{card.item.kind}</Badge> : null}
                        </div>
                        {card.item.targets ? <p className="text-[11px] text-muted">Targets: {card.item.targets}</p> : null}
                        <p className="text-sm font-medium">{card.headline}</p>
                        <p className={cn("whitespace-pre-wrap text-xs text-muted", !open && "line-clamp-3")}>{card.primary_text}</p>
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => toggleCopy(card.id)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
                        >
                          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          {open ? "Hide ad copy" : "Show full ad copy"}
                        </button>
                        <p className="text-[11px] text-muted">
                          {card.item.body_id ? `Body ${card.item.body_id}` : ""}
                          {card.item.cta_label ? ` · CTA: ${card.item.cta_label}` : ""}
                        </p>
                        {card.image_status === "succeeded" && !rejected ? (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="secondary" className="h-8" asChild>
                              <a href={creativeDownloadUrl(card.id)} download>
                                <Download className="mr-1 h-3.5 w-3.5" />
                                Download
                              </a>
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="h-8"
                              disabled={busyId === card.id}
                              title="3 close variations: same idea and style, similar wording"
                              onClick={() => void moreLikeThis(card.id)}
                            >
                              <Copy className="mr-1 h-3.5 w-3.5" />
                              More like this
                            </Button>
                            <Button size="sm" variant="secondary" className="h-8" disabled={busyId === card.id} onClick={() => void reject(card.id)}>
                              <X className="mr-1 h-3.5 w-3.5" />
                              Reject
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function BulkRunPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <BulkInner />
    </Suspense>
  );
}
