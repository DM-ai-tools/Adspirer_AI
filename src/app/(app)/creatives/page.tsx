"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Check, Loader2, Palette, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingState } from "@/components/shared/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api-client";
import { useCreativeStatus } from "@/hooks/use-creative-status";
import type { ClientService } from "@/types";

type ImageStatus = "pending" | "generating" | "succeeded" | "failed" | "skipped";

type CreativeCard = {
  id: string;
  concept: string;
  hook?: string;
  headline: string;
  primary_text: string;
  cta?: string | null;
  creative_direction?: string | null;
  image_url?: string | null;
  image_model?: string | null;
  image_status?: ImageStatus;
  image_error?: string | null;
  status?: string;
  competitor_gap_addressed?: string;
  reasoning?: string;
};

/**
 * Only the request that creates the concepts is client-owned. Once it returns,
 * the stills render on the server and progress is read back from the drafts,
 * so this page can be closed and reopened mid-run.
 */
type GenerationPhase =
  | { step: "idle" }
  | { step: "starting"; detail: string }
  | { step: "error"; message: string };

type DetectedBrand = {
  summary?: string;
  colors?: string[];
  logo_url?: string | null;
  brand_name?: string;
  source?: string;
};

const GENERATION_STEPS = [
  { key: "concepts", label: "Analyze brand & build concepts" },
  { key: "images", label: "Render image stills" },
] as const;

function CreativesInner() {
  const searchParams = useSearchParams();
  const { clients, selectedClientId, setSelectedClientId } = useApp();
  const client = clients.find((c) => c.id === selectedClientId);
  const [services, setServices] = useState<ClientService[]>([]);
  const [serviceId, setServiceId] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const [genPhase, setGenPhase] = useState<GenerationPhase>({ step: "idle" });
  const [elapsedSec, setElapsedSec] = useState(0);
  const [detectedBrand, setDetectedBrand] = useState<DetectedBrand | null>(null);
  const [revisingId, setRevisingId] = useState<string | null>(null);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [landingUrl, setLandingUrl] = useState(
    searchParams.get("landingUrl") ?? "",
  );
  const [headline, setHeadline] = useState(searchParams.get("headline") ?? "");
  const [primaryText, setPrimaryText] = useState(
    searchParams.get("primaryText") ?? "",
  );

  const {
    drafts: liveDrafts,
    progress,
    active: rendering,
    refresh: refreshDrafts,
  } = useCreativeStatus({
    clientId: selectedClientId,
    enabled: Boolean(selectedClientId),
  });

  const concepts: CreativeCard[] = useMemo(
    () =>
      liveDrafts.map((d) => ({
        ...d,
        concept: d.concept || d.headline,
        image_status: (d.image_status as ImageStatus | null) ?? undefined,
        status: d.status ?? undefined,
      })),
    [liveDrafts],
  );

  const busy = starting || rendering;

  useEffect(() => {
    if (!selectedClientId) {
      setServices([]);
      setServiceId(undefined);
      setDetectedBrand(null);
      return;
    }
    void (async () => {
      try {
        const data = await apiFetch<{ services: ClientService[] }>(
          `/api/clients/${selectedClientId}/services`,
        );
        setServices(data.services);
        setServiceId(data.services[0]?.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load services");
      }
    })();
  }, [selectedClientId]);

  useEffect(() => {
    if (!busy) {
      setElapsedSec(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function generate() {
    if (!selectedClientId) return;
    setStarting(true);
    setGenPhase({
      step: "starting",
      detail: landingUrl
        ? `Reading brand from ${landingUrl}`
        : "Using saved client brand colors",
    });

    try {
      const data = await apiFetch<{
        concepts: CreativeCard[];
        openaiConfigured: boolean;
        imageModel?: string;
        brandAnalysis?: DetectedBrand;
        generatingImages: boolean;
      }>("/api/creatives/generate", {
        method: "POST",
        body: JSON.stringify({
          clientId: selectedClientId,
          serviceId,
          count: 3,
          generateImages: true,
          landingPageUrl: landingUrl || undefined,
          headline: headline || undefined,
          primaryText: primaryText || undefined,
          analyzeBrand: Boolean(landingUrl),
        }),
      });

      setDetectedBrand(data.brandAnalysis ?? null);
      setGenPhase({ step: "idle" });
      // Pick the new "generating" rows up now instead of waiting for the poll.
      refreshDrafts();

      if (data.brandAnalysis?.summary) {
        toast.message(data.brandAnalysis.summary.slice(0, 120));
      }

      if (!data.generatingImages) {
        toast.message(
          data.openaiConfigured
            ? "Concepts ready — images were not requested"
            : "Concepts ready — image generation isn’t configured yet. Ask your administrator to enable it.",
        );
        return;
      }

      toast.success(
        `Rendering ${data.concepts.length} stills — you can leave this page`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generation failed";
      setGenPhase({ step: "error", message });
      toast.error(message);
    } finally {
      setStarting(false);
    }
  }

  async function revise(draftId: string) {
    const suggestion = suggestions[draftId]?.trim();
    if (!suggestion) {
      toast.error("Describe the change you want");
      return;
    }
    setRevisingId(draftId);
    try {
      await apiFetch<{ imageStatus: string }>("/api/creatives/revise", {
        method: "POST",
        body: JSON.stringify({ draftId, suggestion }),
      });
      toast.success("Reworking — the new still replaces this card when ready");
      refreshDrafts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revision failed");
    } finally {
      setRevisingId(null);
    }
  }

  async function selectForCampaign(draftId: string) {
    try {
      const data = await apiFetch<{
        image_url: string | null;
        workspaceHint: string;
      }>("/api/creatives/select", {
        method: "POST",
        body: JSON.stringify({ draftId }),
      });
      if (!data.image_url) {
        toast.error("No image_url on this draft");
        return;
      }
      toast.success(
        "Approved — attached to pending ad approvals and posted to Workspace.",
      );
      refreshDrafts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Select failed");
    }
  }

  async function discard(draftId: string) {
    setDiscardingId(draftId);
    try {
      await apiFetch("/api/creatives/reject", {
        method: "POST",
        body: JSON.stringify({
          draftId,
          reason: suggestions[draftId]?.trim() || undefined,
        }),
      });
      toast.success("Discarded — Workspace notified.");
      refreshDrafts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discard failed");
    } finally {
      setDiscardingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Creatives"
        description="Generate stills from ad copy + landing URL brand analysis. Rework or approve — approvals attach the image to your campaign and post back to Workspace."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={selectedClientId ?? undefined}
              onValueChange={setSelectedClientId}
            >
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
            <Select
              value={serviceId}
              onValueChange={setServiceId}
              disabled={!services.length}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select service" />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => void generate()}
              disabled={!selectedClientId || busy}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              {starting
                ? "Starting…"
                : rendering
                  ? "Rendering…"
                  : "Generate"}
            </Button>
          </div>
        }
      />

      {client ? (
        <div className="space-y-6">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <p className="mb-1 text-xs text-muted">Landing URL (brand analysis)</p>
              <Input
                value={landingUrl}
                onChange={(e) => setLandingUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-muted">Headline</p>
              <Input
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="Ad headline"
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-muted">Primary text</p>
              <Input
                value={primaryText}
                onChange={(e) => setPrimaryText(e.target.value)}
                placeholder="Primary text excerpt"
              />
            </div>
          </div>

          {genPhase.step !== "idle" || busy ? (
            <Card className="border-accent/30 bg-accent/5">
              <CardContent className="space-y-4 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {genPhase.step === "error"
                      ? "Generation failed"
                      : "Generating creatives…"}
                  </p>
                  {busy ? (
                    <span className="font-mono text-xs text-muted">
                      {elapsedSec}s elapsed
                    </span>
                  ) : null}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  {GENERATION_STEPS.map((step, index) => {
                    const activeIndex = starting ? 0 : rendering ? 1 : -1;
                    const done =
                      index < activeIndex || (!busy && genPhase.step !== "error");
                    const active =
                      !done &&
                      index === activeIndex &&
                      genPhase.step !== "error";

                    return (
                      <div
                        key={step.key}
                        className={`rounded-lg border px-3 py-2 text-xs ${
                          done
                            ? "border-accent/40 bg-accent/10 text-foreground"
                            : active
                              ? "border-accent bg-accent/15 text-foreground"
                              : "border-border bg-secondary/20 text-muted"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {done ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                          ) : active ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                          ) : (
                            <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                          )}
                          <span>{step.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {genPhase.step === "starting" ? (
                  <p className="text-xs text-muted">{genPhase.detail}</p>
                ) : null}
                {rendering && progress ? (
                  <p className="text-xs text-muted">
                    {progress.succeeded + progress.failed + progress.stalled} of{" "}
                    {progress.total} stills finished
                    {progress.failed + progress.stalled > 0
                      ? ` · ${progress.failed + progress.stalled} failed`
                      : ""}
                    {" · "}Each still takes 30–90s. This runs in the background —
                    you can switch pages or close the tab.
                  </p>
                ) : null}
                {genPhase.step === "error" ? (
                  <p className="text-xs text-destructive">{genPhase.message}</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {detectedBrand?.source === "firecrawl_branding" ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
              {detectedBrand.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={detectedBrand.logo_url}
                  alt={`${detectedBrand.brand_name ?? client.name} official logo`}
                  className="h-12 max-w-44 rounded-md bg-white object-contain p-2"
                />
              ) : null}
              <div>
                <p className="text-sm font-medium">
                  {detectedBrand.brand_name ?? client.name}
                </p>
                <p className="text-xs text-muted">
                  Official branding extracted from your website
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-3">
            {(detectedBrand?.colors?.length
              ? detectedBrand.colors
              : client.brand_colors ?? []
            ).map(
              (color) => (
                <Card key={color}>
                  <CardContent className="p-4">
                    <div
                      className="mb-3 h-24 rounded-lg border border-border"
                      style={{ background: color }}
                    />
                    <p className="font-mono text-sm">{color}</p>
                    <p className="mt-1 text-xs text-muted">
                      {detectedBrand?.source === "firecrawl_branding"
                        ? "Website brand color"
                        : "Saved brand color"}{" "}
                      · {detectedBrand?.brand_name ?? client.name}
                    </p>
                  </CardContent>
                </Card>
              ),
            )}
          </div>

          {!detectedBrand?.colors?.length && !client.brand_colors?.length ? (
            <p className="text-xs text-muted">
              No brand colours detected yet. Add a landing page URL above (or a
              website on the client) so stills can be built from the real
              palette and logo.
            </p>
          ) : null}

          {concepts.length === 0 ? (
            <EmptyState
              icon={Palette}
              title="No concepts yet"
              description="Paste landing URL + ad copy, then Generate. Review stills, suggest changes, Use for campaign."
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-3">
              {concepts.map((concept) => (
                <Card key={concept.id}>
                  <CardHeader className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">{concept.concept}</CardTitle>
                      <Badge
                        variant={
                          concept.status === "selected"
                            ? "default"
                            : concept.status === "rejected"
                              ? "danger"
                              : "secondary"
                        }
                      >
                        {concept.status === "selected"
                          ? "Approved"
                          : concept.status === "rejected"
                            ? "Discarded"
                            : concept.status === "revised"
                              ? "Reworked"
                              : "Draft"}
                      </Badge>
                    </div>
                    {concept.hook ? (
                      <p className="text-sm text-accent">{concept.hook}</p>
                    ) : null}
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {concept.image_status === "generating" ||
                    concept.image_status === "pending" ? (
                      // A rework keeps the previous still visible underneath so
                      // the card does not go blank while the new one renders.
                      <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-dashed border-accent/40 bg-accent/5">
                        {concept.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={concept.image_url}
                            alt={concept.headline}
                            className="absolute inset-0 h-full w-full object-cover opacity-25"
                          />
                        ) : null}
                        <div className="relative flex flex-col items-center gap-2 text-xs text-muted">
                          <Loader2 className="h-6 w-6 animate-spin text-accent" />
                          <span>
                            {concept.image_url
                              ? "Reworking image…"
                              : "Generating image…"}
                          </span>
                        </div>
                      </div>
                    ) : concept.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={concept.image_url}
                        alt={concept.headline}
                        className="aspect-square w-full rounded-lg border border-border object-cover"
                      />
                    ) : concept.image_status === "failed" ? (
                      <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 p-4 text-center text-xs text-destructive">
                        <span>Image failed</span>
                        {concept.image_error ? (
                          <span className="text-[10px] opacity-80">
                            {concept.image_error}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted">
                        Headline
                      </p>
                      <p className="font-medium">{concept.headline}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted">
                        Primary text
                      </p>
                      <p className="whitespace-pre-wrap text-muted-foreground">
                        {concept.primary_text}
                      </p>
                    </div>
                    <Textarea
                      placeholder="Suggest changes (e.g. warmer light, show product closer…)"
                      value={suggestions[concept.id] ?? ""}
                      onChange={(e) =>
                        setSuggestions((prev) => ({
                          ...prev,
                          [concept.id]: e.target.value,
                        }))
                      }
                      className="min-h-[72px] text-xs"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={revisingId === concept.id}
                        onClick={() => void revise(concept.id)}
                      >
                        {revisingId === concept.id ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        Rework
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={concept.image_status !== "succeeded"}
                        onClick={() => void selectForCampaign(concept.id)}
                      >
                        <Check className="mr-1 h-3.5 w-3.5" />
                        Approve for campaign
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={
                          discardingId === concept.id ||
                          concept.status === "rejected"
                        }
                        onClick={() => void discard(concept.id)}
                      >
                        {discardingId === concept.id ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <X className="mr-1 h-3.5 w-3.5" />
                        )}
                        Discard
                      </Button>
                    </div>
                    {concept.image_model ? (
                      <Badge variant="outline">{concept.image_model}</Badge>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          icon={Palette}
          title="Select a client"
          description="Choose a client to generate brand-aligned creative concepts."
        />
      )}
    </div>
  );
}

export default function CreativesPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <CreativesInner />
    </Suspense>
  );
}
