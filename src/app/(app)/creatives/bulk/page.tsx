"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronDown, Pencil, ChevronUp, Copy, Download, FileSpreadsheet, ImagePlus, Layers, Loader2, Send, X } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ImageFormatPicker } from "@/components/creatives/image-format-picker";
import { PublishToMeta } from "@/components/creatives/publish-to-meta";
import { apiFetch } from "@/lib/api-client";
import { creativeDownloadUrl } from "@/lib/creatives/download";
import type { ImageFormat } from "@/lib/creatives/formats";
import { STAGE_LABEL, type AwarenessStage } from "@/lib/creatives/bulk/angles";
import { REFERENCE_CLOSE_COUNT, STYLE_IMAGE_LIMIT } from "@/lib/creatives/bulk/styles";
import { shrinkImageToDataUri } from "@/lib/creatives/shrink-image";
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
  edits: Array<{ id: string; at: string; instruction: string; mode: "edit" | "full" }>;
  editError: string | null;
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
  // The operator's own style: reference images (shrunk data URIs), words on the look, and whether all images follow it.
  const [styleImages, setStyleImages] = useState<string[]>([]);
  const [styleDirection, setStyleDirection] = useState("");
  const [styleMatchAll, setStyleMatchAll] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const styleFileInput = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<ImageFormat>("4:5");
  const [tab, setTab] = useState<"new" | "history">(searchParams.get("tab") === "history" ? "history" : "new");
  const [starting, setStarting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [view, setView] = useState<RunView | null>(null);
  const [copyOpen, setCopyOpen] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bumped to start following the run again after an edit is sent.
  const [pollKey, setPollKey] = useState(0);
  // The "send to Meta" steps, open from the run's header.
  const [publishOpen, setPublishOpen] = useState(false);
  // The edit box that is open on each image: what to change, and whether to change only that or start over.
  const [editing, setEditing] = useState<Record<string, { text: string; mode: "edit" | "full" } | undefined>>({});
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
        const active = next.run.status === "planning" || next.run.status === "rendering" || next.cards.some((c) => c.image_status === "generating");
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
  }, [runId, pollKey]);

  const canStart = Boolean(selectedClientId) && Boolean(landingUrl.trim() || notes.trim() || pastedCopy.trim() || serviceId);

  const hasStyle = styleImages.length > 0 || styleDirection.trim().length > 0;

  async function addStyleImages(files: FileList | null) {
    if (!files?.length) return;
    const room = STYLE_IMAGE_LIMIT - styleImages.length;
    if (room <= 0) {
      toast.error(`Up to ${STYLE_IMAGE_LIMIT} reference images.`);
      return;
    }
    setReadingImages(true);
    try {
      const added: string[] = [];
      for (const file of Array.from(files).slice(0, room)) added.push(await shrinkImageToDataUri(file));
      setStyleImages((current) => [...current, ...added]);
      if (files.length > room) toast.message(`Only ${STYLE_IMAGE_LIMIT} reference images are used.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read that image");
    } finally {
      setReadingImages(false);
      if (styleFileInput.current) styleFileInput.current.value = "";
    }
  }

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
          styleDirection: styleDirection.trim() || undefined,
          styleImages: styleImages.length ? styleImages : undefined,
          styleMatchAll: hasStyle && styleMatchAll ? true : undefined,
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

  async function sendEdit(id: string) {
    const e = editing[id];
    if (!e || e.text.trim().length < 3) return;
    setBusyId(id);
    try {
      await apiFetch(`/api/creatives/bulk/${runId}/edit`, { method: "POST", body: JSON.stringify({ action: "edit", draftId: id, instruction: e.text.trim(), mode: e.mode }) });
      setEditing((m) => ({ ...m, [id]: undefined }));
      setView((v) => (v ? { ...v, cards: v.cards.map((c) => (c.id === id ? { ...c, image_status: "generating", editError: null } : c)) } : v));
      setPollKey((k) => k + 1);
      toast.success(e.mode === "edit" ? "Changing only what you described. The original is kept." : "Regenerating the whole image with your feedback. The original is kept.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the edit");
    } finally {
      setBusyId(null);
    }
  }

  async function undoEdit(id: string) {
    setBusyId(id);
    try {
      await apiFetch(`/api/creatives/bulk/${runId}/edit`, { method: "POST", body: JSON.stringify({ action: "undo", draftId: id }) });
      setPollKey((k) => k + 1);
      toast.success("Back to the previous version");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not undo");
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
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div>
                    <p className="text-xs font-medium">Style reference (optional)</p>
                    <p className="text-[11px] text-muted">
                      Show or describe the look you want. Without one, every image gets a different style.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {styleImages.map((src, i) => (
                      <div key={i} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt={`Reference ${i + 1}`} className="h-16 w-16 rounded-md border border-border object-cover" />
                        <button
                          type="button"
                          aria-label={`Remove reference image ${i + 1}`}
                          onClick={() => setStyleImages((current) => current.filter((_, j) => j !== i))}
                          className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted hover:text-foreground"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    {styleImages.length < STYLE_IMAGE_LIMIT ? (
                      <>
                        <input
                          ref={styleFileInput}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          multiple
                          className="hidden"
                          onChange={(e) => void addStyleImages(e.target.files)}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={readingImages || starting}
                          onClick={() => styleFileInput.current?.click()}
                        >
                          {readingImages ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="mr-1 h-3.5 w-3.5" />}
                          {styleImages.length ? "Add another" : "Add reference image"}
                        </Button>
                      </>
                    ) : null}
                    <span className="text-[11px] text-muted">
                      {styleImages.length}/{STYLE_IMAGE_LIMIT} images
                    </span>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted">Describe the look, or add style rules</p>
                    <Textarea
                      value={styleDirection}
                      onChange={(e) => setStyleDirection(e.target.value)}
                      maxLength={1500}
                      placeholder="e.g. Dark, moody product photography with neon edge light. Real people only, no 3D renders or illustrations."
                      className="min-h-[72px]"
                    />
                  </div>
                  <div className="flex items-start gap-3">
                    <Switch id="style-match-all" checked={hasStyle && styleMatchAll} disabled={!hasStyle} onCheckedChange={setStyleMatchAll} />
                    <label htmlFor="style-match-all" className="text-xs">
                      <span className="font-medium">Make all {summary?.runSize ?? 15} in this style</span>
                      <span className="block text-[11px] text-muted">
                        {hasStyle && styleMatchAll
                          ? "Every image shares this look. Each still gets its own idea and words."
                          : `Off: the first ${REFERENCE_CLOSE_COUNT} follow it closely and the rest are variations on it. Your brand colours still set the hues.`}
                      </span>
                    </label>
                  </div>
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
                    {downloadable.length > 0 && view.progress.rendering === 0 ? (
                      <Button size="sm" onClick={() => setPublishOpen((o) => !o)} disabled={!selectedClientId}>
                        <Send className="mr-1 h-3.5 w-3.5" />
                        Send to Meta ({downloadable.length})
                      </Button>
                    ) : null}
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

              {publishOpen && runId && selectedClientId ? <PublishToMeta runId={runId} clientId={selectedClientId} onClose={() => setPublishOpen(false)} /> : null}

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
                            <Button size="sm" variant="secondary" className="h-8" disabled={busyId === card.id} onClick={() => setEditing((m) => ({ ...m, [card.id]: m[card.id] ? undefined : { text: "", mode: "edit" } }))}>
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              Edit this image
                            </Button>
                            <Button size="sm" variant="secondary" className="h-8" disabled={busyId === card.id} onClick={() => void reject(card.id)}>
                              <X className="mr-1 h-3.5 w-3.5" />
                              Reject
                            </Button>
                          </div>
                        ) : null}
                        {editing[card.id] ? (
                          <div className="space-y-2 rounded-md border border-border p-2">
                            <Textarea
                              className="min-h-[64px] text-xs"
                              value={editing[card.id]!.text}
                              onChange={(e) => setEditing((m) => ({ ...m, [card.id]: { ...m[card.id]!, text: e.target.value } }))}
                              placeholder={'What should change? e.g. "make the headline say Free Audit", "swap the background to dark blue", "show the client stats from the landing page" (or paste a link to any page and say which section to use)'}
                            />
                            <div className="space-y-1 text-[11px]">
                              <label className="flex items-start gap-1.5">
                                <input type="radio" name={`mode-${card.id}`} checked={editing[card.id]!.mode === "edit"} onChange={() => setEditing((m) => ({ ...m, [card.id]: { ...m[card.id]!, mode: "edit" } }))} />
                                <span>
                                  <span className="font-medium">Change only that</span>
                                  <span className="block text-muted">Everything else stays as it is, including your logo.</span>
                                </span>
                              </label>
                              <label className="flex items-start gap-1.5">
                                <input type="radio" name={`mode-${card.id}`} checked={editing[card.id]!.mode === "full"} onChange={() => setEditing((m) => ({ ...m, [card.id]: { ...m[card.id]!, mode: "full" } }))} />
                                <span>
                                  <span className="font-medium">Regenerate the whole image</span>
                                  <span className="block text-muted">Starts the picture again with your feedback.</span>
                                </span>
                              </label>
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" className="h-8" disabled={busyId === card.id || editing[card.id]!.text.trim().length < 3} onClick={() => void sendEdit(card.id)}>
                                {busyId === card.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Pencil className="mr-1 h-3.5 w-3.5" />}
                                Apply
                              </Button>
                              <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditing((m) => ({ ...m, [card.id]: undefined }))}>
                                Cancel
                              </Button>
                            </div>
                            <p className="text-[10px] text-muted">Your current image is kept, so you can go back to it.</p>
                          </div>
                        ) : null}
                        {card.editError ? <p className="text-[11px] text-destructive">The last edit could not be made, so the image is unchanged: {card.editError}</p> : null}
                        {card.edits.length ? (
                          <p className="text-[11px] text-muted">
                            Edited {card.edits.length} time{card.edits.length === 1 ? "" : "s"}. Last: “{card.edits[card.edits.length - 1]!.instruction.slice(0, 60)}”{" "}
                            <button type="button" className="font-medium text-accent hover:underline" disabled={busyId === card.id} onClick={() => void undoEdit(card.id)}>
                              Undo
                            </button>
                          </p>
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
