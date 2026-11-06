"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CampaignSettingsCard } from "@/components/ai/campaign-settings-card";
import { TargetingPickerCard } from "@/components/ai/targeting-picker";
import { apiFetch } from "@/lib/api-client";
import { targetingSelectionToCreateArgs, type CampaignTargetingSelection } from "@/lib/adspirer/targeting";
import type { CampaignSettings } from "@/lib/meta/campaign-rules";
import { PUBLISH_OBJECTIVES, settingsToArgs } from "@/lib/creatives/bulk/publish-settings";
import { cn } from "@/lib/utils";

type PublishContext = {
  accountId: string;
  landingPageUrl: string | null;
  suggestedCampaignName: string;
  callToAction: string;
  images: Array<{ id: string; headline: string; image_url: string }>;
  unreachableImages: number;
};

type MetaCampaignRow = { id: string; name: string; status: string; objective: string; budgetLevel: "campaign" | "ad_set" };
type PageRow = { id: string; name: string };

type Step = "where" | "campaign" | "targeting" | "ads" | "review" | "done";

const select = "h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground outline-none focus:border-accent/50 disabled:opacity-50";
const CTAS = ["LEARN_MORE", "SIGN_UP", "BOOK_NOW", "GET_QUOTE", "CONTACT_US", "APPLY_NOW", "GET_OFFER", "SHOP_NOW", "ORDER_NOW", "SUBSCRIBE", "DOWNLOAD"];
const label = (v: string) => v.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const SUPPORTED = new Set(PUBLISH_OBJECTIVES.map((o) => o.value));

function Field(props: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-foreground">{props.title}</p>
      {props.children}
      {props.hint ? <p className="text-[11px] text-muted">{props.hint}</p> : null}
    </div>
  );
}

/**
 * Sends the finished images of a bulk run to Meta as ONE approval. It asks, once: new campaign or an existing
 * one, the campaign settings the workspace asks, then the ad set and ad settings that apply to every image.
 * Nothing is created until the approval is approved, and then it is all created PAUSED.
 */
export function PublishToMeta({ runId, clientId, onClose }: { runId: string; clientId: string; onClose: () => void }) {
  const [ctx, setCtx] = useState<PublishContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("where");
  const [busy, setBusy] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);

  const [mode, setMode] = useState<"new" | "existing">("new");
  const [campaigns, setCampaigns] = useState<MetaCampaignRow[] | null>(null);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [objective, setObjective] = useState("OUTCOME_TRAFFIC");
  const [settings, setSettings] = useState<CampaignSettings | null>(null);
  const [targeting, setTargeting] = useState<CampaignTargetingSelection | null>(null);

  const [pages, setPages] = useState<PageRow[]>([]);
  const [pageId, setPageId] = useState("");
  const [instagramId, setInstagramId] = useState("");
  const [adSetName, setAdSetName] = useState("");
  const [budget, setBudget] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [cta, setCta] = useState("LEARN_MORE");
  const [landingUrl, setLandingUrl] = useState("");
  const [utm, setUtm] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetch<PublishContext>(`/api/creatives/bulk/${runId}/publish`)
      .then((c) => {
        if (cancelled) return;
        setCtx(c);
        setCampaignName(c.suggestedCampaignName);
        setCta(c.callToAction);
        setLandingUrl(c.landingPageUrl ?? "");
        setAdSetName(`${c.suggestedCampaignName} — Ad Set`);
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "Could not prepare the ads"));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    apiFetch<{ pages: PageRow[]; default_page_id: string | null }>(`/api/meta/pages?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(ctx.accountId)}`)
      .then((r) => {
        if (cancelled) return;
        setPages(r.pages ?? []);
        setPageId((p) => p || r.default_page_id || "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ctx, clientId]);

  function loadCampaigns() {
    if (!ctx || campaigns || campaignsError) return;
    apiFetch<{ campaigns: MetaCampaignRow[] }>(`/api/meta/campaigns?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(ctx.accountId)}`)
      .then((r) => setCampaigns(r.campaigns))
      .catch((e) => setCampaignsError(e instanceof Error ? e.message : "Could not load campaigns"));
  }

  const chosen = campaigns?.find((c) => c.id === campaignId) ?? null;
  const effectiveObjective = mode === "existing" ? (chosen?.objective ?? "") : objective;
  const budgetOnCampaign = mode === "existing" ? chosen?.budgetLevel === "campaign" : settings?.budget_level === "campaign";
  const needsBudget = mode === "existing" ? chosen?.budgetLevel === "ad_set" : true;
  const budgetNumber = Number(budget);
  const adsReady = Boolean(landingUrl.trim()) && (!needsBudget || (Number.isFinite(budgetNumber) && budgetNumber > 0)) && Boolean(pageId || pages.length === 0);

  async function send() {
    if (!ctx) return;
    setBusy(true);
    try {
      const targetingArgs = targeting ? targetingSelectionToCreateArgs(targeting) : {};
      const { campaign_budget_optimization, ...restSettings } = settingsToArgs(settings);
      const body = {
        destination:
          mode === "existing"
            ? { mode: "existing" as const, campaignId, campaignName: chosen?.name ?? "Existing campaign", objective: chosen?.objective, settings: restSettings }
            : { mode: "new" as const, campaignName: campaignName.trim(), objective, settings: { ...restSettings, ...(campaign_budget_optimization !== undefined ? { campaign_budget_optimization } : {}) } },
        adSet: {
          name: adSetName.trim() || undefined,
          ...(needsBudget && budgetNumber > 0 ? { budget_daily: budgetNumber } : {}),
          ...(startTime ? { start_time: startTime } : {}),
          ...(endTime ? { end_time: endTime } : {}),
          targeting: targetingArgs,
        },
        ad: {
          facebook_page_id: pageId || undefined,
          instagram_account_id: instagramId.trim() || undefined,
          call_to_action: cta,
          landing_page_url: landingUrl.trim(),
          url_tags: utm.trim() || undefined,
        },
      };
      const res = await apiFetch<{ approvalId: string; ads: number }>(`/api/creatives/bulk/${runId}/publish`, { method: "POST", body: JSON.stringify(body) });
      setApprovalId(res.approvalId);
      setStep("done");
      toast.success(`${res.ads} ads are ready for your approval`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not prepare the approval");
    } finally {
      setBusy(false);
    }
  }

  const count = ctx?.images.length ?? 0;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Send these ads to Meta</p>
          <p className="text-xs text-muted">One approval for all {count || "your"} ads. You answer the questions once, and every ad gets the same settings. Everything is created paused.</p>
        </div>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {loadError ? <p className="text-xs text-danger">{loadError}</p> : null}
      {!ctx && !loadError ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Getting your ads ready…
        </p>
      ) : null}

      {ctx && ctx.unreachableImages > 0 && step !== "done" ? (
        <p className="rounded-md bg-warning/10 p-2 text-[11px] text-warning">
          {ctx.unreachableImages} image{ctx.unreachableImages === 1 ? " is" : "s are"} only reachable on this computer, and Meta has to download them. Set the app&apos;s public address (APP_URL) or image hosting before sending.
        </p>
      ) : null}

      {ctx && step === "where" ? (
        <div className="space-y-3">
          <p className="text-xs font-semibold text-foreground">Where should the {count} ads go?</p>
          <label className="flex items-start gap-2 text-xs">
            <input type="radio" name="dest" checked={mode === "new"} onChange={() => setMode("new")} className="mt-0.5" />
            <span>
              <span className="font-medium">A new campaign for these ads</span>
              <span className="block text-muted">Named from your landing page, with one ad set holding all {count} ads.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="radio"
              name="dest"
              checked={mode === "existing"}
              onChange={() => {
                setMode("existing");
                loadCampaigns();
              }}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">An existing campaign</span>
              <span className="block text-muted">Adds a new ad set with all {count} ads to a campaign you already have. The campaign itself is not changed.</span>
            </span>
          </label>
          {mode === "existing" ? (
            <div className="space-y-1">
              {campaignsError ? <p className="text-[11px] text-danger">{campaignsError}</p> : null}
              {!campaigns && !campaignsError ? <p className="text-[11px] text-muted">Loading your campaigns…</p> : null}
              {campaigns ? (
                <select className={select} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                  <option value="">Choose a campaign…</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.status.toLowerCase()}, {label(c.objective.replace("OUTCOME_", ""))})
                    </option>
                  ))}
                </select>
              ) : null}
              {chosen && !SUPPORTED.has(chosen.objective) ? <p className="text-[11px] text-danger">That campaign&apos;s objective isn&apos;t supported here yet. Pick a Traffic, Leads, Sales, Engagement or Awareness campaign.</p> : null}
            </div>
          ) : null}
          <Button size="sm" disabled={mode === "existing" && (!chosen || !SUPPORTED.has(chosen.objective))} onClick={() => setStep("campaign")}>
            Continue
          </Button>
        </div>
      ) : null}

      {ctx && step === "campaign" ? (
        <div className="space-y-3">
          <p className="text-xs font-semibold text-foreground">{mode === "new" ? "Campaign" : `Settings for the new ad set in “${chosen?.name}”`}</p>
          {mode === "new" ? (
            <>
              <Field title="Campaign name">
                <Input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
              </Field>
              <Field title="Objective" hint={PUBLISH_OBJECTIVES.find((o) => o.value === objective)?.hint}>
                <select className={select} value={objective} onChange={(e) => (setObjective(e.target.value), setSettings(null))}>
                  {PUBLISH_OBJECTIVES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <p className="text-[11px] text-muted">Its objective ({label(effectiveObjective.replace("OUTCOME_", ""))}) and {budgetOnCampaign ? "campaign budget stay" : "budgets are on its ad sets, so you set this ad set's budget next"}.</p>
          )}
          {settings ? (
            <div className="flex items-center justify-between rounded-md bg-accent/10 p-2 text-xs">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-accent" /> Settings chosen
              </span>
              <span className="flex gap-2">
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setSettings(null)}>
                  Change
                </Button>
                <Button size="sm" className="h-7" disabled={mode === "new" && !campaignName.trim()} onClick={() => setStep("targeting")}>
                  Continue
                </Button>
              </span>
            </div>
          ) : (
            <CampaignSettingsCard
              key={`${effectiveObjective}`}
              clientId={clientId}
              accountId={ctx.accountId}
              objective={effectiveObjective}
              onConfirm={(s) => setSettings(s)}
              onSkip={() => setSettings({})}
            />
          )}
          <Button size="sm" variant="ghost" onClick={() => setStep("where")}>
            Back
          </Button>
        </div>
      ) : null}

      {ctx && step === "targeting" ? (
        <div className="space-y-3">
          <p className="text-xs font-semibold text-foreground">Who should see the ads? (applies to all {count})</p>
          {targeting ? (
            <div className="flex items-center justify-between rounded-md bg-accent/10 p-2 text-xs">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-accent" /> Audience chosen
              </span>
              <span className="flex gap-2">
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setTargeting(null)}>
                  Change
                </Button>
                <Button size="sm" className="h-7" onClick={() => setStep("ads")}>
                  Continue
                </Button>
              </span>
            </div>
          ) : (
            <TargetingPickerCard clientId={clientId} accountId={ctx.accountId} onConfirm={(t) => setTargeting(t)} onSkip={() => setTargeting({ custom_audiences: [], excluded_custom_audiences: [], interests: [], behaviors: [], locations: [], publisher_platforms: [] })} />
          )}
          <Button size="sm" variant="ghost" onClick={() => setStep("campaign")}>
            Back
          </Button>
        </div>
      ) : null}

      {ctx && step === "ads" ? (
        <div className="space-y-3">
          <p className="text-xs font-semibold text-foreground">Ad set and ad settings (the same for all {count} ads)</p>
          <Field title="Ad set name">
            <Input value={adSetName} onChange={(e) => setAdSetName(e.target.value)} />
          </Field>
          {needsBudget ? (
            <Field title={budgetOnCampaign ? "Daily campaign budget" : "Daily budget"} hint="In the ad account's currency. Shared across all the ads in the ad set.">
              <Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 50" />
            </Field>
          ) : (
            <p className="text-[11px] text-muted">The campaign already has its own budget, so none is set here.</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field title="Start (optional)" hint="Leave empty to start when you turn it on.">
              <Input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </Field>
            <Field title="End (optional)">
              <Input type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          </div>
          <Field title="Facebook Page" hint="The ads run as this Page.">
            {pages.length ? (
              <select className={select} value={pageId} onChange={(e) => setPageId(e.target.value)}>
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[11px] text-muted">No Page list available; Meta will use the account&apos;s default Page.</p>
            )}
          </Field>
          <Field title="Instagram account ID (optional)" hint="Leave empty to use the one linked to the Page.">
            <Input value={instagramId} onChange={(e) => setInstagramId(e.target.value)} />
          </Field>
          <Field title="Button" hint="One button for every ad.">
            <select className={select} value={cta} onChange={(e) => setCta(e.target.value)}>
              {[...new Set([cta, ...CTAS])].map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field title="Landing page">
            <Input value={landingUrl} onChange={(e) => setLandingUrl(e.target.value)} />
          </Field>
          <Field title="UTM tags (optional)" hint="Leave empty for the standard tags.">
            <Input value={utm} onChange={(e) => setUtm(e.target.value)} placeholder="utm_source=meta&utm_medium=paid" />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setStep("targeting")}>
              Back
            </Button>
            <Button size="sm" disabled={!adsReady} onClick={() => setStep("review")}>
              Review
            </Button>
          </div>
        </div>
      ) : null}

      {ctx && step === "review" ? (
        <div className="space-y-3">
          <p className="text-xs font-semibold text-foreground">Review</p>
          <ul className="space-y-1 text-xs text-foreground">
            <li>
              <span className="text-muted">Ads:</span> {count} images, each with its own headline and text
            </li>
            <li>
              <span className="text-muted">Where:</span> {mode === "existing" ? `a new ad set in “${chosen?.name}”` : `a new campaign “${campaignName}” (${label(objective.replace("OUTCOME_", ""))})`}
            </li>
            <li>
              <span className="text-muted">Ad set:</span> {adSetName || "—"}
              {needsBudget ? `, ${budget} per day` : ", uses the campaign budget"}
            </li>
            <li>
              <span className="text-muted">Button and page:</span> {label(cta)} → {landingUrl}
            </li>
          </ul>
          <p className="text-[11px] text-muted">This puts one request in Approvals. Nothing is created in Meta until you approve it there, and everything is created paused.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStep("ads")}>
              Back
            </Button>
            <Button size="sm" disabled={busy || ctx.unreachableImages > 0} onClick={() => void send()}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
              Send {count} ads for approval
            </Button>
          </div>
        </div>
      ) : null}

      {step === "done" ? (
        <div className={cn("space-y-2 rounded-md bg-accent/10 p-3 text-xs")}>
          <p className="flex items-center gap-1.5 font-semibold text-foreground">
            <CheckCircle2 className="h-4 w-4 text-accent" /> Waiting for your approval
          </p>
          <p className="text-muted">All {count} ads are in one request. Open it in Approvals to look it over and approve; approving sends it to Meta.</p>
          <Link href="/approvals" className="inline-block font-medium text-accent hover:underline" data-approval={approvalId ?? undefined}>
            Open Approvals
          </Link>
        </div>
      ) : null}
    </div>
  );
}
