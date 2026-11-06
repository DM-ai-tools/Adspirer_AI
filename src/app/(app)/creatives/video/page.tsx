"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, Check, FileUp, ChevronDown, ChevronUp, CircleDashed, Download, Film, ImagePlus, Loader2, MessageSquarePlus, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2, Wand2, X } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/api-client";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import { describeEvent, mmss, overlayEvents, withTimes } from "@/lib/video/overlays";
import { retime, sceneSeconds } from "@/lib/video/timing";
import { SCRIPT_STAGES, UPLOAD_STAGES, viewProgress, type ScriptProgress } from "@/lib/video/progress";
import { cn } from "@/lib/utils";
import type { ClientService } from "@/types";

type Scene = {
  number: number;
  start: number;
  end: number;
  seconds: number;
  visual: string;
  camera: string;
  speaker: "on_camera" | "voiceover" | "none";
  line: string;
  keywords: string[];
  stat: string | null;
  assetId: string | null;
  sound: string;
  originalLine?: string | null;
};

type Issue = { scene: number | null; severity: "low" | "medium" | "high"; area: string; problem: string; fix: string };

type Verification = {
  score: number | null;
  verdict: "passed" | "fixed" | "needs_review";
  summary: string;
  fixes: Array<{ target: string; reason: string }>;
  issues: Issue[];
  checkedAt: string;
};

type Script = {
  id: string;
  verification?: Verification | null;
  source?: "written" | "uploaded";
  handling?: { restoredScenes: number[]; removedScenes: number[]; unusedText: string[]; changes: Array<{ target: string; was: string; now: string }> } | null;
  title: string;
  angle: { key: string; name: string; stage: string; kind: string };
  pain: string;
  framework: { key: string; name: string };
  style: string;
  durationSeconds: number;
  hookAlternatives: string[];
  character: string | null;
  setting: string;
  scenes: Scene[];
  adCopy: { primaryText: string; headline: string; description: string; cta: string };
  warnings: string[];
};

type Plan = {
  modelLabel: string;
  reasons: string[];
  resolution: string;
  clips: Array<{ number: number; seconds: number; sceneNumbers: number[] }>;
  totalSeconds: number;
  estimatedUsd: number;
  estimatedUsd1080: number | null;
};

type GenClip = {
  number: number;
  seconds: number;
  sceneNumbers: number[];
  status: "waiting" | "running" | "succeeded" | "failed";
  attempts: number;
  error: string | null;
  usd: number | null;
  hasVideo: boolean;
  videoUrl: string | null;
};

type FinalView = {
  state: "running" | "done" | "failed";
  stage: string | null;
  error: string | null;
  seconds: number | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  videoUrl: string | null;
  qa: Array<{ name: string; ok: boolean; detail: string }>;
  includes: { captions: boolean; logo: boolean; endCard: boolean; stats: number; images: number; captionTiming: "transcript" | "estimated" | "none" } | null;
};

type GenerationView = {
  status: "generating" | "paused" | "stopped" | "clips_ready" | "assembling" | "done" | "failed" | "idle";
  reviewClip: number | null;
  remainingUsd: number;
  final: FinalView | null;
  clips: GenClip[];
  spentUsd: number;
  blocked: string | null;
  error: string | null;
};

type Asset = { id: string; name: string; summary: string; kind: string | null; stats: Array<{ value: string; label: string }>; analysed: boolean; url: string };

type ProjectView = {
  id: string;
  name: string;
  status: "writing" | "scripts_ready" | "confirmed" | "generating" | "paused" | "stopped" | "clips_ready" | "assembling" | "done" | "failed";
  error: string | null;
  inputs: { landingPageUrl: string | null; targetSeconds: number; format: string; mode?: "write" | "upload"; scriptFileName?: string | null; changeRequest?: string | null };
  assets: Asset[];
  progress: ScriptProgress | null;
  brand: { name: string; colors: string[] | null; hasLogo: boolean } | null;
  scripts: Script[] | null;
  chosenScript: Script | null;
  plan: Plan | null;
  generation: GenerationView | null;
};

type HistoryItem = { id: string; name: string; status: ProjectView["status"]; created_at: string; landing_page_url: string | null; target_seconds: number; title: string | null };

const STATUS_LABEL: Record<ProjectView["status"], string> = { writing: "Writing scripts", scripts_ready: "Scripts ready", confirmed: "Script confirmed", generating: "Making the video", paused: "Waiting for your check", stopped: "Stopped", clips_ready: "Clips ready", assembling: "Finishing the video", done: "Finished", failed: "Failed" };
const STYLES = ["auto", "UGC creator walkthrough", "Cinematic", "Motion graphics over footage", "Documentary", "3D animated"];
const FORMATS = [
  { value: "9:16", label: "9:16 Reels & Stories" },
  { value: "4:5", label: "4:5 Feed" },
  { value: "1:1", label: "1:1 Square" },
];
const SPEAKER_LABEL: Record<Scene["speaker"], string> = { on_camera: "Presenter speaks to camera", voiceover: "Voiceover (unseen voice)", none: "No speech" };

type NewImage = { file: File; preview: string };

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-[10px] text-muted">{hint}</span> : null}
    </label>
  );
}

/** The bar, the stage list and the time left, driven by the stage the server reports. */
function ProgressCard({ progress, hasImages, upload }: { progress: ScriptProgress | null; hasImages: boolean; upload: boolean }) {
  const stages = upload ? UPLOAD_STAGES : SCRIPT_STAGES;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  const view = viewProgress(progress, now, stages);
  const activeIndex = progress ? stages.findIndex((s) => s.key === progress.stage) : 0;
  const elapsed = progress ? Math.max(0, Math.round((now - Date.parse(progress.startedAt)) / 1000)) : 0;
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">{view.label}…</span>
            <span className="tabular-nums text-muted">{view.percent}%</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={view.percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${view.percent}%` }} />
          </div>
          <p className="text-[11px] text-muted">
            {view.slow ? "Taking a little longer than usual, still working." : view.secondsLeft !== null ? `About ${view.secondsLeft} seconds left.` : "Starting…"}
            {progress ? ` ${elapsed}s so far.` : ""}
          </p>
        </div>
        <ol className="space-y-1.5 text-xs">
          {stages.map((s, i) => {
            const done = i < activeIndex;
            const active = i === activeIndex;
            return (
              <li key={s.key} className={cn("flex items-center gap-2", done ? "text-foreground" : active ? "text-foreground" : "text-muted")}>
                {done ? <Check className="h-3.5 w-3.5 text-accent" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDashed className="h-3.5 w-3.5" />}
                {s.key === "reading" && !hasImages ? "Reading your website" : s.label}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

const SEVERITY_STYLE: Record<Issue["severity"], string> = {
  high: "text-red-400",
  medium: "text-amber-500",
  low: "text-muted",
};

function VerdictBadge({ v }: { v: Verification }) {
  const label = v.verdict === "passed" ? "Verified" : v.verdict === "fixed" ? "Verified, fixed" : "Needs a look";
  return (
    <Badge variant={v.verdict === "needs_review" ? "warning" : "secondary"}>
      {v.verdict === "needs_review" ? <AlertTriangle className="mr-1 h-3 w-3" /> : <ShieldCheck className="mr-1 h-3 w-3" />}
      {label}
      {v.score !== null ? ` · ${v.score}/10` : ""}
    </Badge>
  );
}

/** What the verifier found about a scene or the ad copy, with ways to fix it: automatically, or from the operator's own note. */
function FixBar({
  id,
  issues,
  busy,
  feedback,
  noun,
  onFeedback,
  onRun,
}: {
  id: string;
  issues: Issue[];
  busy: string | null;
  feedback: string | undefined;
  noun: string;
  onFeedback: (value: string | undefined) => void;
  onRun: (issues: string[], feedback: string | undefined) => void;
}) {
  const working = busy === id;
  const open = feedback !== undefined;
  return (
    <div className="space-y-2">
      {issues.length ? (
        <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
          {issues.map((i, k) => (
            <li key={k} className={cn("flex gap-1.5", SEVERITY_STYLE[i.severity])}>
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                {i.problem.replace(/^Scene \d+ /, "")} <span className="text-muted">Suggested fix: {i.fix}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {issues.length ? (
          <Button type="button" size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => onRun(issues.map((i) => `${i.problem} Fix: ${i.fix}`), open ? feedback : undefined)}>
            {working ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
            Fix the {issues.length === 1 ? "problem" : `${issues.length} problems`} automatically
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => onFeedback(open ? undefined : "")}>
          <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
          {open ? "Cancel" : `Rewrite this ${noun} with my feedback`}
        </Button>
      </div>
      {open ? (
        <div className="space-y-2">
          <Textarea
            className="min-h-[64px] text-xs"
            value={feedback}
            onChange={(e) => onFeedback(e.target.value)}
            placeholder={`What should change? e.g. "make it less salesy", "mention the free audit earlier", "shorter and punchier"`}
          />
          <Button type="button" size="sm" disabled={Boolean(busy) || !feedback?.trim()} onClick={() => onRun(issues.map((i) => `${i.problem} Fix: ${i.fix}`), feedback)}>
            {working ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            Rewrite this {noun}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FinishingOptions({ value, onChange }: { value: { captions: boolean; logo: boolean; endCard: boolean }; onChange: (v: { captions: boolean; logo: boolean; endCard: boolean }) => void }) {
  const item = (key: "captions" | "logo" | "endCard", label: string) => (
    <label className="flex items-center gap-2 text-xs">
      <Checkbox checked={value[key]} onCheckedChange={(c) => onChange({ ...value, [key]: c === true })} />
      {label}
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span className="text-[11px] font-medium">Add to the finished video:</span>
      {item("captions", "Captions and highlighted words")}
      {item("logo", "Your logo")}
      {item("endCard", "End card with the call to action")}
    </div>
  );
}

/** Starts the video, follows each clip and keeps the work moving while the page is open. */
function GenerationPanel({ projectId, status, initial, onStatus }: { projectId: string; status: ProjectView["status"]; initial: GenerationView | null; onStatus: (s: ProjectView["status"]) => void }) {
  const [gen, setGen] = useState<GenerationView | null>(initial);
  const [starting, setStarting] = useState(false);
  const [busyClip, setBusyClip] = useState<number | null>(null);
  const advancing = useRef(false);
  const [finishing, setFinishing] = useState({ captions: true, logo: true, endCard: true });
  // Where to wait for a look at a clip before paying for the next one.
  const [checkpoint, setCheckpoint] = useState<"after_first" | "each" | "none">("after_first");
  const [confirmStop, setConfirmStop] = useState(false);

  useEffect(() => {
    if (status !== "generating" && status !== "assembling") return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        // While clips are being made, ask the server to take the next step (it also carries on in the background).
        if (status === "generating" && !advancing.current) {
          advancing.current = true;
          await apiFetch<GenerationView>(`/api/creatives/video/${projectId}/generation`, { method: "POST", body: JSON.stringify({ action: "advance" }) })
            .then((g) => !stopped && setGen(g))
            .finally(() => {
              advancing.current = false;
            });
        }
        const g = await apiFetch<GenerationView>(`/api/creatives/video/${projectId}/generation`);
        if (stopped) return;
        setGen(g);
        const moving = g.status === "generating" || g.status === "assembling";
        if (g.status !== status) onStatus(g.status === "idle" ? "confirmed" : g.status);
        if (moving) timer = window.setTimeout(() => void tick(), 4_000);
      } catch {
        if (!stopped) timer = window.setTimeout(() => void tick(), 6_000);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [projectId, status, onStatus]);

  async function post(body: Record<string, unknown>, loading: () => void, done: () => void, next: ProjectView["status"] = "generating") {
    loading();
    try {
      const g = await apiFetch<GenerationView>(`/api/creatives/video/${projectId}/generation`, { method: "POST", body: JSON.stringify(body) });
      setGen(g);
      onStatus(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start");
    } finally {
      done();
    }
  }

  const clips = gen?.clips ?? [];
  const finished = clips.filter((c) => c.status === "succeeded").length;
  const blocked = status === "confirmed" || status === "clips_ready" ? gen?.blocked ?? null : null;

  if (!clips.length || (status === "confirmed" && !clips.some((c) => c.status !== "waiting"))) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={starting || Boolean(blocked)} onClick={() => void post({ action: "start", finishing, checkpoint }, () => setStarting(true), () => setStarting(false))}>
            {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Film className="mr-2 h-4 w-4" />}
            Generate video
          </Button>
          <p className="text-[11px] text-muted">Makes the clips one after another so the person and voice carry through, then joins them. It takes several minutes and keeps going if you leave.</p>
        </div>
        <FinishingOptions value={finishing} onChange={setFinishing} />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[11px] font-medium">Check before spending more:</span>
          <Select value={checkpoint} onValueChange={(v) => setCheckpoint(v as typeof checkpoint)}>
            <SelectTrigger className="h-8 w-[300px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="after_first">Pause after clip 1 so I can check it (recommended)</SelectItem>
              <SelectItem value="each">Pause after every clip</SelectItem>
              <SelectItem value="none">Don&apos;t pause, make it all</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[11px] text-muted">You can also stop at any time.</span>
        </div>
        {blocked ? <p className="text-xs text-amber-500">{blocked}</p> : null}
      </div>
    );
  }

  const final = gen?.final ?? null;
  const allClips = clips.length > 0 && finished === clips.length;

  return (
    <div className="space-y-3">
      {status === "paused" ? (
        <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">Clip {gen?.reviewClip ?? 1} is ready. Check it before the rest are made.</p>
          <p className="text-xs text-muted">
            Look for a presenter who looks and sounds right, speech that matches the mouth, and no garbled words anywhere. Making the rest will cost about ${(gen?.remainingUsd ?? 0).toFixed(2)} more.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={starting} onClick={() => void post({ action: "continue" }, () => setStarting(true), () => setStarting(false))}>
              {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
              Looks good, make the rest
            </Button>
            <Button size="sm" variant="secondary" disabled={starting} onClick={() => void post({ action: "regenerate", fromClip: gen?.reviewClip ?? 1 }, () => setStarting(true), () => setStarting(false))}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              Not right, make clip {gen?.reviewClip ?? 1} again
            </Button>
            <Button size="sm" variant="ghost" disabled={starting} onClick={() => void post({ action: "stop" }, () => setStarting(true), () => setStarting(false), "stopped")}>
              Stop here
            </Button>
          </div>
        </div>
      ) : null}

      {status === "stopped" ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p className="font-medium">Stopped. The clips already made are kept.</p>
          <p className="text-xs text-muted">Nothing more is being made. Carrying on would cost about ${(gen?.remainingUsd ?? 0).toFixed(2)} more.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={starting} onClick={() => void post({ action: "continue" }, () => setStarting(true), () => setStarting(false))}>
              Carry on making the video
            </Button>
            <Button size="sm" variant="secondary" disabled={starting} onClick={() => void post({ action: "regenerate", fromClip: 1 }, () => setStarting(true), () => setStarting(false))}>
              Start again from clip 1
            </Button>
          </div>
        </div>
      ) : null}

      {status === "assembling" || final?.state === "running" ? (
        <div className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            Finishing the video{final?.stage ? `: ${final.stage}` : ""}…
            <span className="block text-[11px] text-muted">Joining the clips, timing the captions to the voice, adding your graphics, then checking the result. About a minute.</span>
          </span>
        </div>
      ) : null}

      {final?.state === "done" && final.videoUrl ? (
        <div className="space-y-3 rounded-md border border-accent/40 p-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Check className="h-4 w-4 text-accent" /> Finished video · {final.seconds}s · {final.width}x{final.height}
          </p>
          <div className="grid gap-4 md:grid-cols-[minmax(0,320px)_1fr]">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={final.videoUrl} controls playsInline preload="metadata" className="aspect-[9/16] max-h-[560px] w-full rounded-md bg-black object-contain" />
            <div className="space-y-3 text-xs">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" asChild>
                  <a href={`${final.videoUrl.split("?")[0]}?download=1`} download>
                    <Download className="mr-1 h-3.5 w-3.5" />
                    Download MP4
                  </a>
                </Button>
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-medium">Checked before showing you</p>
                <ul className="space-y-1">
                  {final.qa.map((c) => (
                    <li key={c.name} className={cn("flex gap-1.5", c.ok ? "text-muted" : "text-amber-500")}>
                      {c.ok ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-accent" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
                      <span>
                        {c.name}: {c.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {final.includes ? (
                <p className="text-muted">
                  Includes: {[final.includes.captions ? (final.includes.captionTiming === "transcript" ? "captions timed to the voice" : "captions (timing estimated)") : null, final.includes.logo ? "logo" : null, final.includes.stats ? `${final.includes.stats} stat${final.includes.stats === 1 ? "" : "s"}` : null, final.includes.images ? `${final.includes.images} of your image${final.includes.images === 1 ? "" : "s"}` : null, final.includes.endCard ? "end card" : null].filter(Boolean).join(", ")}.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {final?.state === "failed" ? <p className="text-xs text-destructive">Could not finish the video: {final.error}</p> : null}

      {allClips && status !== "assembling" && status !== "generating" ? (
        <div className="space-y-2">
          <FinishingOptions value={finishing} onChange={setFinishing} />
          <Button size="sm" variant={final?.state === "done" ? "secondary" : "default"} disabled={starting} onClick={() => void post({ action: "assemble", finishing }, () => setStarting(true), () => setStarting(false), "assembling")}>
            {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Film className="mr-1 h-3.5 w-3.5" />}
            {final?.state === "done" ? "Finish the video again with these options" : "Join the clips and finish the video"}
          </Button>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">
            {status === "clips_ready" || status === "done" || status === "assembling" ? "Clips ready" : status === "paused" ? "Paused for your check" : status === "stopped" ? "Stopped" : status === "failed" ? "Stopped with an error" : "Making the video"}: {finished} of {clips.length} clips done
          </span>
          {gen ? <span className="text-xs text-muted">${gen.spentUsd.toFixed(2)} spent so far</span> : null}
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={Math.round((finished / clips.length) * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${Math.max(3, (finished / clips.length) * 100)}%` }} />
        </div>
        {status === "generating" ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted">Each clip usually takes 2 to 4 minutes. You can leave this page and come back.</p>
            {confirmStop ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted">Stop now? Clips already made are kept. A clip being made may still be charged if it cannot be cancelled.</span>
                <Button size="sm" variant="danger" disabled={starting} onClick={() => void post({ action: "stop" }, () => setStarting(true), () => { setStarting(false); setConfirmStop(false); }, "stopped")}>
                  Stop
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirmStop(false)}>
                  Keep going
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setConfirmStop(true)}>
                Stop making the video
              </Button>
            )}
          </div>
        ) : null}
        {gen?.error && status === "failed" ? <p className="text-xs text-destructive">{gen.error}</p> : null}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {clips.map((c) => (
          <div key={c.number} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                Clip {c.number} · {c.seconds}s
              </span>
              <Badge variant={c.status === "failed" ? "danger" : "secondary"}>{c.status === "waiting" ? "Waiting" : c.status === "running" ? "Making" : c.status === "succeeded" ? "Done" : "Failed"}</Badge>
            </div>
            <p className="text-[11px] text-muted">
              Scenes {c.sceneNumbers[0]}
              {c.sceneNumbers.length > 1 ? ` to ${c.sceneNumbers[c.sceneNumbers.length - 1]}` : ""}
            </p>
            {c.videoUrl ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={c.videoUrl} controls playsInline preload="metadata" className="aspect-[9/16] max-h-[420px] w-full rounded-md bg-black object-contain" />
            ) : (
              <div className="flex aspect-[9/16] max-h-[200px] w-full items-center justify-center rounded-md border border-dashed border-border text-[11px] text-muted">
                {c.status === "running" ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Making this clip…
                  </span>
                ) : c.status === "failed" ? (
                  "No video"
                ) : (
                  "Waiting for the clip before it"
                )}
              </div>
            )}
            {c.error && c.status !== "succeeded" ? <p className="text-[11px] text-destructive">{c.error}</p> : null}
            <div className="flex flex-wrap gap-2">
              {c.hasVideo ? (
                <Button size="sm" variant="secondary" className="h-8" asChild>
                  <a href={`${c.videoUrl!.split("?")[0]}?download=1`} download>
                    Download
                  </a>
                </Button>
              ) : null}
              {c.status === "succeeded" || c.status === "failed" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8"
                  disabled={busyClip !== null || status === "generating"}
                  title={clips.length > c.number ? "This clip and every clip after it are made again, because each opens from where the one before ended" : undefined}
                  onClick={() => void post({ action: "regenerate", fromClip: c.number }, () => setBusyClip(c.number), () => setBusyClip(null))}
                >
                  {busyClip === c.number ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  {c.number < clips.length ? "Make again from here" : "Make again"}
                </Button>
              ) : null}
            </div>
            {c.usd !== null ? <p className="text-[10px] text-muted">${c.usd.toFixed(2)}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function VideoInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("id");
  const { clients, selectedClientId, setSelectedClientId } = useApp();
  const client = clients.find((c) => c.id === selectedClientId);

  const [tab, setTab] = useState<"new" | "history">(searchParams.get("tab") === "history" ? "history" : "new");
  const [services, setServices] = useState<ClientService[]>([]);
  const [serviceId, setServiceId] = useState<string | undefined>();
  const [landingUrl, setLandingUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  // "upload": the operator brings their own script, which is kept word for word.
  const [mode, setMode] = useState<"write" | "upload">("write");
  const [scriptText, setScriptText] = useState("");
  const [scriptFile, setScriptFile] = useState<File | null>(null);
  const [adCopyText, setAdCopyText] = useState("");
  const [changeRequest, setChangeRequest] = useState("");
  const [offerDetails, setOfferDetails] = useState("");
  const [stats, setStats] = useState<string[]>([""]);
  const [images, setImages] = useState<NewImage[]>([]);
  const [seconds, setSeconds] = useState(35);
  const [style, setStyle] = useState("auto");
  const [format, setFormat] = useState("9:16");
  const [priority, setPriority] = useState<"balanced" | "quality" | "cost">("balanced");
  const [starting, setStarting] = useState(false);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [view, setView] = useState<ProjectView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Script | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The verifier's review of the script on screen, the feedback boxes that are open, and which rewrite is running.
  const [review, setReview] = useState<Verification | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<Record<string, string | undefined>>({});
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  // Bumped to start following the project again after "write 3 new scripts".
  const [pollKey, setPollKey] = useState(0);
  const setProjectStatus = useCallback((status: ProjectView["status"]) => setView((v) => (v && v.status !== status ? { ...v, status } : v)), []);

  useEffect(() => {
    setTab(searchParams.get("tab") === "history" ? "history" : "new");
  }, [searchParams]);

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

  const loadHistory = useCallback(async () => {
    if (!selectedClientId) return;
    try {
      setHistory((await apiFetch<{ projects: HistoryItem[] }>(`/api/creatives/video?clientId=${selectedClientId}`)).projects);
    } catch {
      setHistory([]);
    }
  }, [selectedClientId]);

  useEffect(() => {
    if (!projectId && tab === "history") void loadHistory();
  }, [projectId, tab, loadHistory]);

  // Follow the project: scripts are written on the server, so the screen only reads progress.
  useEffect(() => {
    if (!projectId) {
      setView(null);
      setSelectedId(null);
      setDraft(null);
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await apiFetch<ProjectView>(`/api/creatives/video/${projectId}`);
        if (stopped) return;
        setView(next);
        if (next.status === "writing") timer = window.setTimeout(() => void tick(), 2_000);
      } catch (err) {
        if (!stopped) toast.error(err instanceof Error ? err.message : "Could not load the project");
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [projectId, pollKey]);

  const scriptWords = scriptText.trim().split(/\s+/).filter(Boolean).length;
  const canStart =
    Boolean(selectedClientId) &&
    (mode === "upload" ? scriptWords >= 15 || Boolean(scriptFile) : Boolean(landingUrl.trim() || instructions.trim() || offerDetails.trim() || serviceId));

  async function start() {
    if (!selectedClientId) return;
    setStarting(true);
    try {
      const payload = {
        clientId: selectedClientId,
        serviceId,
        landingPageUrl: landingUrl.trim() || undefined,
        instructions: instructions.trim() || undefined,
        offerDetails: offerDetails.trim() || undefined,
        stats: stats.map((s) => s.trim()).filter(Boolean),
        targetSeconds: seconds,
        style,
        format,
        priority,
        mode,
        scriptText: mode === "upload" ? scriptText.trim() || undefined : undefined,
        adCopyText: mode === "upload" ? adCopyText.trim() || undefined : undefined,
        changeRequest: mode === "upload" ? changeRequest.trim() || undefined : undefined,
      };
      const form = new FormData();
      form.set("payload", JSON.stringify(payload));
      images.forEach((i) => form.append("images", i.file));
      if (mode === "upload" && scriptFile) form.set("scriptFile", scriptFile);
      const res = await fetch("/api/creatives/video", { method: "POST", body: form });
      const json = (await res.json()) as { ok: boolean; data?: { projectId: string }; error?: { message: string } };
      if (!json.ok || !json.data) throw new Error(json.error?.message ?? "Could not start");
      router.replace(`/creatives/video?id=${json.data.projectId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start");
    } finally {
      setStarting(false);
    }
  }

  async function rewrite() {
    if (!projectId) return;
    try {
      await apiFetch(`/api/creatives/video/${projectId}`, { method: "POST" });
      setSelectedId(null);
      setDraft(null);
      setView((v) => (v ? { ...v, status: "writing", scripts: null, error: null, progress: null } : v));
      setPollKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rewrite");
    }
  }

  async function removeProject(id: string) {
    setDeleting(id);
    try {
      await apiFetch(`/api/creatives/video/${id}`, { method: "DELETE" });
      setHistory((h) => (h ? h.filter((x) => x.id !== id) : h));
      toast.success("Deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  }

  function pick(script: Script) {
    setSelectedId(script.id);
    const copy = structuredClone(script);
    copy.scenes = retime(copy.scenes);
    setDraft(copy);
    setReview(script.verification ?? null);
    setShowDetails(false);
    setFeedbackFor({});
  }

  async function runRewrite(id: string, action: "scene" | "copy" | "check", opts: { sceneNumber?: number; issues?: string[]; feedback?: string } = {}) {
    if (!draft || !projectId) return;
    setRewriting(id);
    try {
      const res = await apiFetch<{ scene: Scene | null; adCopy: Script["adCopy"] | null; verification: Verification }>(`/api/creatives/video/${projectId}/rewrite`, {
        method: "POST",
        body: JSON.stringify({
          scriptId: draft.id,
          action,
          sceneNumber: opts.sceneNumber,
          issues: opts.issues,
          feedback: opts.feedback?.trim() || undefined,
          draft: { title: draft.title, scenes: draft.scenes.map((s) => ({ ...s, seconds: Number(s.seconds) || 2 })), adCopy: draft.adCopy },
        }),
      });
      if (res.scene) {
        const n = res.scene.number;
        setDraft((d) => (d ? { ...d, scenes: d.scenes.map((s) => (s.number === n ? { ...res.scene!, start: s.start, end: s.end } : s)) } : d));
      }
      if (res.adCopy) setDraft((d) => (d ? { ...d, adCopy: res.adCopy! } : d));
      setReview(res.verification);
      setFeedbackFor((f) => ({ ...f, [id]: undefined }));
      if (action !== "check") toast.success(action === "scene" ? "Scene rewritten and the script re-checked" : "Ad copy rewritten and the script re-checked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rewrite");
    } finally {
      setRewriting(null);
    }
  }

  // A scene's length follows what is said in it (and whether a stat or image needs time on screen). Only a
  // scene with no speech has a length of its own to set.
  function editScene(i: number, patch: Partial<Scene>) {
    setDraft((d) =>
      d
        ? {
            ...d,
            scenes: d.scenes.map((s, k) => {
              if (k !== i) return s;
              const next = { ...s, ...patch };
              return { ...next, seconds: sceneSeconds(next) };
            }),
          }
        : d,
    );
  }

  // An uploaded script is the only one there is: open it straight away.
  useEffect(() => {
    if (view?.status === "scripts_ready" && view.scripts?.length === 1 && !draft) pick(view.scripts[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.status, view?.scripts]);

  const timed = useMemo(() => (draft ? withTimes(draft.scenes) : []), [draft]);
  const draftTotal = timed.length ? timed[timed.length - 1]!.end : 0;
  const assetName = useCallback((id: string) => view?.assets.find((a) => a.id === id)?.name, [view]);
  const events = useMemo(() => overlayEvents(timed), [timed]);

  async function confirm() {
    if (!draft || !projectId) return;
    setConfirming(true);
    try {
      const next = await apiFetch<ProjectView>(`/api/creatives/video/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          scriptId: draft.id,
          edits: {
            title: draft.title,
            scenes: draft.scenes.map((s) => ({ ...s, seconds: Number(s.seconds) || 2 })),
            adCopy: draft.adCopy,
          },
        }),
      });
      setView(next);
      toast.success("Script confirmed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not confirm");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Video ad"
        description="A brief in, three different scripts out. Pick one, edit it, confirm it."
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
        <EmptyState icon={Film} title="Select a client" description="Choose a client to plan a video ad." />
      ) : !projectId ? (
        <div className="space-y-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "new" | "history")}>
            <TabsList>
              <TabsTrigger value="new">New video</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
          </Tabs>

          {tab === "history" ? (
            history === null ? (
              <LoadingState />
            ) : history.length === 0 ? (
              <EmptyState icon={Film} title="No video projects yet" description="Projects you start appear here." />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {history.map((h) => (
                  <Card key={h.id}>
                    <CardContent className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate text-sm font-medium">{h.name}</p>
                        <p className="text-[11px] text-muted">
                          {new Date(h.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {h.target_seconds}s
                        </p>
                        {h.title ? <p className="max-w-[300px] truncate text-[11px] text-muted">Script: {h.title}</p> : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant={h.status === "failed" ? "danger" : "secondary"}>{STATUS_LABEL[h.status]}</Badge>
                        {confirmDelete === h.id ? (
                          <>
                            <Button size="sm" variant="danger" disabled={deleting === h.id} onClick={() => void removeProject(h.id)}>
                              {deleting === h.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                              Delete
                            </Button>
                            <Button size="sm" variant="secondary" disabled={deleting === h.id} onClick={() => setConfirmDelete(null)}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => router.replace(`/creatives/video?id=${h.id}`)}>
                              Open
                            </Button>
                            <Button size="icon" variant="ghost" aria-label={`Delete ${h.name}`} title="Delete this run" onClick={() => setConfirmDelete(h.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )
          ) : (
            <Card>
              <CardContent className="space-y-4 p-4">
                <div className="inline-flex rounded-lg border border-border bg-secondary/50 p-1 text-sm" role="tablist" aria-label="How to get the script">
                  <button type="button" role="tab" aria-selected={mode === "write"} onClick={() => setMode("write")} className={cn("rounded-md px-3 py-1.5", mode === "write" ? "bg-card font-medium text-foreground shadow-sm" : "text-muted")}>
                    Write the script for me
                  </button>
                  <button type="button" role="tab" aria-selected={mode === "upload"} onClick={() => setMode("upload")} className={cn("rounded-md px-3 py-1.5", mode === "upload" ? "bg-card font-medium text-foreground shadow-sm" : "text-muted")}>
                    I already have a script
                  </button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label={mode === "upload" ? "Landing page URL (for the brand, colours and logo)" : "Landing page URL"}>
                    <Input value={landingUrl} onChange={(e) => setLandingUrl(e.target.value)} placeholder="https://…" />
                  </Field>
                  <Field label="Service">
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
                  </Field>
                </div>
                {mode === "write" ? (
                  <>
                    <Field label="Instructions (optional)">
                      <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Tone, who it is for, what to show, what to avoid, a hook you like…" className="min-h-[72px]" />
                    </Field>
                    <Field label="Offer details (optional)">
                      <Textarea value={offerDetails} onChange={(e) => setOfferDetails(e.target.value)} placeholder="The offer, price or terms you can state, deadline, guarantee, who qualifies…" className="min-h-[72px]" />
                    </Field>
                  </>
                ) : (
                  <div className="space-y-4 rounded-md border border-border p-3">
                    <Field label="Your script" hint="Paste it here, or upload a file below. Your words are kept exactly as you wrote them: we only split it into scenes and add visuals, sound and ad copy around it.">
                      <Textarea value={scriptText} onChange={(e) => setScriptText(e.target.value)} placeholder="Paste your script. Scene notes, speaker labels (like VO: or Presenter:) and directions are fine: they are used for the visuals and not spoken." className="min-h-[220px]" />
                    </Field>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary">
                        <FileUp className="h-3.5 w-3.5" />
                        {scriptFile ? "Replace file" : "Upload a file (.txt, .docx, .pdf, .md)"}
                        <input type="file" accept=".txt,.md,.markdown,.docx,.doc,.pdf" className="hidden" onChange={(e) => { setScriptFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                      </label>
                      {scriptFile ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted">
                          {scriptFile.name}
                          <button type="button" aria-label="Remove the file" onClick={() => setScriptFile(null)} className="rounded p-0.5 hover:bg-secondary">
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ) : null}
                      <span className="text-[11px] text-muted">{scriptWords ? `${scriptWords} words pasted` : ""}</span>
                    </div>
                    <Field label="Your ad copy (optional)" hint="If you have it, it is used exactly as written. If not, it is written for you from your script.">
                      <Textarea value={adCopyText} onChange={(e) => setAdCopyText(e.target.value)} placeholder="The text that goes above the video" className="min-h-[96px]" />
                    </Field>
                    <Field label="Changes you want (optional)" hint="Leave this empty and your script is kept word for word. Say what to change and only that is touched, e.g. “make scene 3 shorter” or “change the call to action to Book Now”.">
                      <Textarea value={changeRequest} onChange={(e) => setChangeRequest(e.target.value)} placeholder="Nothing: keep it exactly as I wrote it" className="min-h-[64px]" />
                    </Field>
                  </div>
                )}

                <div className="space-y-2">
                  <p className="text-[11px] font-medium">Images to use in the video (screenshots of results, stats, product)</p>
                  <p className="text-[11px] text-muted">We read each image automatically, pull out the stats printed in it, and show it on screen where that stat is said. PNG, JPG or WebP, up to 8.</p>
                  <div className="flex flex-wrap gap-2">
                    {images.map((img, i) => (
                      <div key={i} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.preview} alt={img.file.name} className="h-20 w-20 rounded-md border border-border object-cover" />
                        <button
                          type="button"
                          aria-label={`Remove ${img.file.name}`}
                          onClick={() => setImages((p) => p.filter((_, k) => k !== i))}
                          className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-card p-0.5 hover:bg-secondary"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    {images.length < 8 ? (
                      <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-[11px] text-muted hover:bg-secondary">
                        <ImagePlus className="h-4 w-4" />
                        Add
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files ?? []);
                            setImages((p) => [...p, ...files.map((file) => ({ file, preview: URL.createObjectURL(file) }))].slice(0, 8));
                            e.target.value = "";
                          }}
                        />
                      </label>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-medium">Other stats to show (only ones that are not in your images)</p>
                  {stats.map((s, i) => (
                    <div key={i} className="flex gap-2">
                      <Input value={s} onChange={(e) => setStats((p) => p.map((x, k) => (k === i ? e.target.value : x)))} placeholder="e.g. 255% average client ROI" />
                      {stats.length > 1 ? (
                        <Button type="button" size="icon" variant="ghost" aria-label="Remove stat" onClick={() => setStats((p) => p.filter((_, k) => k !== i))}>
                          <X className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="secondary" onClick={() => setStats((p) => [...p, ""])}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add stat
                  </Button>
                </div>

                <div className="grid gap-4 md:grid-cols-4">
                  {mode === "write" ? (
                  <div className="md:col-span-2">
                    <p className="mb-1 text-[11px] font-medium">
                      Target length: <span className="text-foreground">{seconds}s</span> <span className="font-normal text-muted">(a guide: each scene runs as long as its words take, up to 60s)</span>
                    </p>
                    <input type="range" min={15} max={60} step={1} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="w-full" />
                  </div>
                  ) : null}
                  {mode === "write" ? (
                  <Field label="Style">
                    <Select value={style} onValueChange={setStyle}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STYLES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s === "auto" ? "Let the writer choose" : s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  ) : null}
                  <Field label="Size">
                    <Select value={format} onValueChange={setFormat}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FORMATS.map((f) => (
                          <SelectItem key={f.value} value={f.value}>
                            {f.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="max-w-[260px]">
                  <Field label="Priority">
                    <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="balanced">Balanced (the system chooses)</SelectItem>
                        <SelectItem value="quality">Best quality</SelectItem>
                        <SelectItem value="cost">Lowest cost</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => void start()} disabled={!canStart || starting}>
                    {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Film className="mr-2 h-4 w-4" />}
                    {mode === "upload" ? "Analyse my script" : "Write 3 scripts"}
                  </Button>
                  <p className="text-[11px] text-muted">{mode === "upload" ? "Takes under a minute. Your wording is not changed unless you ask. No video is generated until you confirm." : "Takes about a minute. No video is generated yet: you choose and confirm a script first."}</p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      ) : !view ? (
        <LoadingState />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={view.status === "failed" ? "danger" : "secondary"}>{STATUS_LABEL[view.status]}</Badge>
              <span className="text-sm font-medium">{view.name}</span>
            </div>
            <div className="flex gap-2">
              {view.status !== "writing" ? (
                <Button size="sm" variant="secondary" onClick={() => void rewrite()}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  {view.inputs.mode === "upload" ? "Read my script again" : "Write 3 new scripts"}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => router.replace("/creatives/video?tab=history")}>
                History
              </Button>
              <Button size="sm" variant="secondary" onClick={() => router.replace("/creatives/video")}>
                New video
              </Button>
            </div>
          </div>

          {view.status === "writing" ? (
            <ProgressCard progress={view.progress} hasImages={view.assets.length > 0} upload={view.inputs.mode === "upload"} />
          ) : view.chosenScript && (["confirmed", "generating", "paused", "stopped", "clips_ready", "assembling", "done"].includes(view.status) || (view.status === "failed" && (view.generation?.clips.length ?? 0) > 0)) ? (
            <div className="space-y-4">
              <Card className="border-accent/40">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Check className="h-4 w-4 text-accent" /> Confirmed: {view.chosenScript.title} · {view.chosenScript.durationSeconds}s
                  </div>
                  {view.plan ? (
                    <div className="space-y-2 text-sm">
                      <p>
                        <span className="font-medium">{view.plan.modelLabel}</span> at {view.plan.resolution}, {view.plan.clips.length} clip{view.plan.clips.length === 1 ? "" : "s"}:{" "}
                        {view.plan.clips.map((c) => `${c.seconds}s (scenes ${c.sceneNumbers[0]}-${c.sceneNumbers[c.sceneNumbers.length - 1]})`).join(" + ")}
                      </p>
                      <p className="text-xs text-muted">Why: {view.plan.reasons.join("; ")}.</p>
                      <p className="text-xs text-muted">
                        Estimated generation cost about ${view.plan.estimatedUsd.toFixed(2)}
                        {view.plan.estimatedUsd1080 ? ` (about $${view.plan.estimatedUsd1080.toFixed(2)} at 1080p)` : ""}, from BytePlus&apos;s published rates. The bill follows actual usage.
                      </p>
                    </div>
                  ) : null}
                  <GenerationPanel projectId={view.id} status={view.status} initial={view.generation} onStatus={setProjectStatus} />
                </CardContent>
              </Card>
              <ScriptBody script={view.chosenScript} assets={view.assets} />
            </div>
          ) : view.status === "failed" ? (
            <Card>
              <CardContent className="p-4 text-sm text-destructive">Could not write the scripts: {view.error ?? "unknown error"}</CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {view.assets.length ? (
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <Sparkles className="h-4 w-4 text-accent" /> Read from your images
                    </p>
                    <div className="grid gap-3 md:grid-cols-2">
                      {view.assets.map((a) => (
                        <div key={a.id} className="flex gap-3 rounded-md border border-border p-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={a.url} alt={a.name} className="h-16 w-16 shrink-0 rounded object-cover" />
                          <div className="min-w-0 space-y-1 text-xs">
                            <p className="truncate font-medium">{a.name}</p>
                            <p className="text-muted">{a.summary || (a.analysed ? "No description" : "Could not be read, so it is shown but no stats were taken from it.")}</p>
                            <div className="flex flex-wrap gap-1">
                              {a.stats.length ? (
                                a.stats.map((s, i) => (
                                  <Badge key={i} variant="secondary">
                                    {s.value} {s.label}
                                  </Badge>
                                ))
                              ) : (
                                <span className="text-[11px] text-muted">No numbers found in it</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              <div className="grid gap-3 lg:grid-cols-3">
                {(view.scripts ?? []).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => pick(s)}
                    className={cn("rounded-lg border p-4 text-left transition-colors hover:bg-secondary/40", selectedId === s.id ? "border-accent ring-1 ring-accent/30" : "border-border")}
                  >
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      <Badge>{s.angle.name}</Badge>
                      <Badge variant="outline">{s.angle.stage}</Badge>
                      <Badge variant="outline">{s.durationSeconds}s</Badge>
                    </div>
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="mt-1 text-[11px] text-muted">
                      {s.framework.name} · {s.style}
                    </p>
                    <p className="mt-2 text-xs text-muted">Targets: {s.pain}</p>
                    <p className="mt-2 text-xs">&ldquo;{s.hookAlternatives[0]}&rdquo;</p>
                    {s.verification ? (
                      <div className="mt-2">
                        <VerdictBadge v={s.verification} />
                        {s.verification.fixes.length ? <p className="mt-1 text-[11px] text-muted">{s.verification.fixes.length} fixed automatically</p> : null}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>

              {draft ? (
                <Card>
                  <CardContent className="space-y-5 p-4">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="min-w-[260px] flex-1 max-w-[460px]">
                        <Field label="Script title (for your reference only)">
                          <Input className="font-medium" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                        </Field>
                      </div>
                      <p className={cn("text-sm font-medium tabular-nums", draftTotal > 60 || draftTotal < 15 ? "text-destructive" : "text-foreground")}>
                        {draftTotal}s total{" "}
                        <span className="text-xs font-normal text-muted">{draftTotal >= 30 && draftTotal <= 40 ? "(ideal range)" : draftTotal > 60 ? "(over the 60s limit)" : draftTotal < 30 ? "(a little short)" : ""}</span>
                      </p>
                    </div>

                    {draft.source === "uploaded" ? (
                      <div className="space-y-1.5 rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
                        <p className="flex items-center gap-1.5 text-sm font-medium">
                          <Check className="h-4 w-4 text-accent" /> Your script, kept word for word
                        </p>
                        <p className="text-muted">
                          Split into {draft.scenes.length} scenes. Your wording is untouched
                          {draft.handling?.changes.length ? " except where you asked for a change" : ""}. Visuals, camera, sound and the ad copy were added around it.
                        </p>
                        {draft.handling?.restoredScenes.length ? <p className="text-muted">Scene{draft.handling.restoredScenes.length === 1 ? "" : "s"} {draft.handling.restoredScenes.join(", ")}: the reader had reworded your text, so your exact words were put back.</p> : null}
                        {draft.handling?.removedScenes?.length ? <p className="text-muted">Scene{draft.handling.removedScenes.length === 1 ? "" : "s"} {draft.handling.removedScenes.join(", ")}: words that were not in your script were removed.</p> : null}
                        {draft.handling?.unusedText.length ? (
                          <div className="text-muted">
                            Treated as directions, not spoken:
                            <ul className="mt-0.5 list-disc pl-4">
                              {draft.handling.unusedText.slice(0, 6).map((t, k) => (
                                <li key={k} className="italic">{t.length > 140 ? `${t.slice(0, 140)}…` : t}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {draft.handling?.changes.length ? (
                          <div className="text-muted">
                            Changed as you asked:
                            <ul className="mt-0.5 list-disc pl-4">
                              {draft.handling.changes.map((c, k) => (
                                <li key={k}>
                                  <span className="text-foreground">{c.target}</span>: “{c.was.slice(0, 90)}” became “{c.now.slice(0, 90)}”
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <ShieldCheck className="h-4 w-4 text-accent" />
                          <span className="font-medium">Verification</span>
                          {review ? <VerdictBadge v={review} /> : <span className="text-xs text-muted">Not reviewed yet</span>}
                          {review ? (
                            <span className="text-xs text-muted">
                              {(() => {
                                const open = review.issues.filter((i) => i.severity !== "low").length;
                                const parts = [open ? `${open} to look at` : "nothing open", review.fixes.length ? `${review.fixes.length} fixed` : null].filter(Boolean);
                                return parts.join(" · ");
                              })()}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1">
                          {review && (review.summary || review.fixes.length) ? (
                            <Button type="button" size="sm" variant="ghost" onClick={() => setShowDetails((v) => !v)}>
                              {showDetails ? <ChevronUp className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
                              Details
                            </Button>
                          ) : null}
                          <Button type="button" size="sm" variant="secondary" disabled={Boolean(rewriting)} onClick={() => void runRewrite("check", "check")}>
                            {rewriting === "check" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                            Check again
                          </Button>
                        </div>
                      </div>
                      {review && showDetails ? (
                        <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted">
                          {review.summary ? <p>{review.summary.split(/(?<=[.!?])\s/)[0]}</p> : null}
                          {review.fixes.map((f, k) => (
                            <p key={k}>
                              <span className="text-foreground">{f.target}</span> was rewritten.
                            </p>
                          ))}
                          {review.issues
                            .filter((i) => i.scene === null && !["copy", "cta"].includes(i.area) && i.severity !== "low")
                            .map((i, k) => (
                              <p key={k} className={SEVERITY_STYLE[i.severity]}>
                                {i.problem}
                              </p>
                            ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-1 rounded-md bg-secondary/30 p-3 text-xs">
                      {draft.character ? (
                        <p>
                          <span className="font-medium">Presenter</span> (kept identical in every clip): <span className="text-muted">{draft.character}</span>
                        </p>
                      ) : null}
                      <p>
                        <span className="font-medium">Setting:</span> <span className="text-muted">{draft.setting}</span>
                      </p>
                      <p>
                        <span className="font-medium">Other openings you could use:</span>{" "}
                        <span className="text-muted">{draft.hookAlternatives.map((h) => `“${h}”`).join("  ·  ")}</span>
                      </p>
                    </div>

                    <div className="space-y-3">
                      <p className="text-sm font-medium">Scenes</p>
                      {timed.map((s, i) => (
                        <div key={i} className="space-y-3 rounded-md border border-border p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium">
                              Scene {s.number} <span className="font-normal text-muted">· {mmss(s.start)} to {mmss(s.end)}</span>
                            </p>
                            {draft.scenes[i]!.speaker === "none" || !draft.scenes[i]!.line.trim() ? (
                              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                                Hold the picture for
                                <Input className="h-8 w-16" type="number" min={2} max={6} value={draft.scenes[i]!.seconds} onChange={(e) => editScene(i, { seconds: Number(e.target.value) })} />
                                sec
                              </label>
                            ) : (
                              <p className="text-[11px] text-muted">{draft.scenes[i]!.seconds}s, set by the words</p>
                            )}
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-3">
                              <Field label="What viewers see" hint="Subject, place and action">
                                <Textarea className="min-h-[72px] text-xs" value={draft.scenes[i]!.visual} onChange={(e) => editScene(i, { visual: e.target.value })} />
                              </Field>
                              <Field label="Camera">
                                <Input className="text-xs" value={draft.scenes[i]!.camera} onChange={(e) => editScene(i, { camera: e.target.value })} />
                              </Field>
                              <Field label="Sound and music">
                                <Input className="text-xs" value={draft.scenes[i]!.sound} onChange={(e) => editScene(i, { sound: e.target.value })} />
                              </Field>
                            </div>
                            <div className="space-y-3">
                              <Field label="Who speaks">
                                <Select value={draft.scenes[i]!.speaker} onValueChange={(v) => editScene(i, { speaker: v as Scene["speaker"] })}>
                                  <SelectTrigger className="h-9 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {(Object.keys(SPEAKER_LABEL) as Scene["speaker"][]).map((k) => (
                                      <SelectItem key={k} value={k}>
                                        {SPEAKER_LABEL[k]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </Field>
                              <Field label="What is said (exact words)" hint={draft.source === "uploaded" ? "Your words. Change them only if you want to." : "Spoken aloud and used for the captions"}>
                                <Textarea className="min-h-[72px] text-xs" value={draft.scenes[i]!.line} onChange={(e) => editScene(i, { line: e.target.value })} />
                              </Field>
                              {draft.scenes[i]!.originalLine && draft.scenes[i]!.originalLine !== draft.scenes[i]!.line ? (
                                <div className="rounded-md bg-secondary/40 p-2 text-[11px] text-muted">
                                  Your original: “{draft.scenes[i]!.originalLine}”{" "}
                                  <button type="button" className="font-medium text-accent hover:underline" onClick={() => editScene(i, { line: draft.scenes[i]!.originalLine ?? "", originalLine: null })}>
                                    Put it back
                                  </button>
                                </div>
                              ) : null}
                              <div className="grid grid-cols-2 gap-2">
                                <Field label="Words to highlight" hint="Up to 3, comma separated">
                                  <Input className="text-xs" value={draft.scenes[i]!.keywords.join(", ")} onChange={(e) => editScene(i, { keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 3) })} placeholder="e.g. free audit" />
                                </Field>
                                <Field label="Big stat on screen" hint="Only a real number">
                                  <Input className="text-xs" value={draft.scenes[i]!.stat ?? ""} onChange={(e) => editScene(i, { stat: e.target.value.trim() ? e.target.value : null })} placeholder="e.g. 255%" />
                                </Field>
                              </div>
                              <Field label="Your image shown in this scene">
                                <Select value={draft.scenes[i]!.assetId ?? "none"} onValueChange={(v) => editScene(i, { assetId: v === "none" ? null : v })}>
                                  <SelectTrigger className="h-9 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none">None</SelectItem>
                                    {(view.assets ?? []).map((a) => (
                                      <SelectItem key={a.id} value={a.id}>
                                        {a.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </Field>
                            </div>
                          </div>
                          <FixBar
                            id={`scene-${s.number}`}
                            noun="scene"
                            issues={(review?.issues ?? []).filter((i) => i.scene === s.number)}
                            busy={rewriting}
                            feedback={feedbackFor[`scene-${s.number}`]}
                            onFeedback={(v) => setFeedbackFor((f) => ({ ...f, [`scene-${s.number}`]: v }))}
                            onRun={(issues, feedback) => void runRewrite(`scene-${s.number}`, "scene", { sceneNumber: s.number, issues, feedback })}
                          />
                        </div>
                      ))}
                    </div>

                    <div className="space-y-2 rounded-md border border-border p-3">
                      <p className="text-sm font-medium">What appears on screen, and when</p>
                      {events.length ? (
                        <ul className="space-y-1 text-xs text-muted">
                          {events.map((e, i) => (
                            <li key={i}>{describeEvent(e, assetName)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted">No highlights, stats or images yet. Add them in the scenes above.</p>
                      )}
                    </div>

                    <div className="space-y-3">
                      <p className="text-sm font-medium">Ad copy (posted with the video)</p>
                      <Field label="Primary text" hint="The text above the video. The first line is what people read before “See more”, so it carries the hook.">
                        <Textarea className="min-h-[220px] text-sm leading-relaxed" value={draft.adCopy.primaryText} onChange={(e) => setDraft({ ...draft, adCopy: { ...draft.adCopy, primaryText: e.target.value } })} />
                      </Field>
                      <div className="grid gap-3 md:grid-cols-3">
                        <Field label="Headline" hint={`Bold text under the video. ${draft.adCopy.headline.length}/40 characters`}>
                          <Input value={draft.adCopy.headline} onChange={(e) => setDraft({ ...draft, adCopy: { ...draft.adCopy, headline: e.target.value } })} />
                        </Field>
                        <Field label="Description" hint="Small text under the headline (optional)">
                          <Input value={draft.adCopy.description} onChange={(e) => setDraft({ ...draft, adCopy: { ...draft.adCopy, description: e.target.value } })} />
                        </Field>
                        <Field label="Call-to-action button" hint="The button on the ad">
                          <Select value={draft.adCopy.cta} onValueChange={(v) => setDraft({ ...draft, adCopy: { ...draft.adCopy, cta: v } })}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ADSPIRER_META_CTAS.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {c}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                    </div>

                    <FixBar
                      id="copy"
                      noun="ad copy"
                      issues={(review?.issues ?? []).filter((i) => i.scene === null && ["copy", "cta"].includes(i.area))}
                      busy={rewriting}
                      feedback={feedbackFor["copy"]}
                      onFeedback={(v) => setFeedbackFor((f) => ({ ...f, copy: v }))}
                      onRun={(issues, feedback) => void runRewrite("copy", "copy", { issues, feedback })}
                    />

                    <Button onClick={() => void confirm()} disabled={confirming || draftTotal > 60 || draftTotal < 15}>
                      {confirming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                      Confirm this script
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <p className="text-sm text-muted">Pick a script to read it in full, edit it and confirm it.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScriptBody({ script, assets }: { script: Script; assets: Asset[] }) {
  const events = overlayEvents(script.scenes);
  const name = (id: string) => assets.find((a) => a.id === id)?.name;
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap gap-1.5">
          <Badge>{script.angle.name}</Badge>
          <Badge variant="outline">{script.angle.stage}</Badge>
          <Badge variant="outline">{script.framework.name}</Badge>
          <Badge variant="outline">{script.style}</Badge>
        </div>
        <p className="text-xs text-muted">Targets: {script.pain}</p>
        {script.character ? (
          <p className="text-xs">
            <span className="font-medium">Presenter:</span> <span className="text-muted">{script.character}</span>
          </p>
        ) : null}
        <div className="space-y-2">
          {script.scenes.map((s) => (
            <div key={s.number} className="grid gap-2 rounded-md border border-border p-3 text-xs md:grid-cols-[110px_1fr_1fr]">
              <p className="font-medium">
                Scene {s.number}
                <span className="block font-normal text-muted">
                  {mmss(s.start)} to {mmss(s.end)}
                </span>
              </p>
              <div>
                <p className="text-[11px] font-medium">What viewers see</p>
                <p className="text-muted">{s.visual}</p>
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-medium">{SPEAKER_LABEL[s.speaker]}</p>
                <p>{s.line ? `“${s.line}”` : <span className="text-muted">No speech</span>}</p>
              </div>
            </div>
          ))}
        </div>
        {events.length ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">What appears on screen, and when</p>
            <ul className="space-y-1 text-xs text-muted">
              {events.map((e, i) => (
                <li key={i}>{describeEvent(e, name)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="space-y-2 text-sm">
          <p className="font-medium">Ad copy</p>
          <div>
            <p className="text-[11px] font-medium">Primary text</p>
            <p className="whitespace-pre-wrap text-muted">{script.adCopy.primaryText}</p>
          </div>
          <div className="grid gap-2 text-xs md:grid-cols-3">
            <div>
              <p className="text-[11px] font-medium">Headline</p>
              <p className="text-muted">{script.adCopy.headline}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium">Description</p>
              <p className="text-muted">{script.adCopy.description || "None"}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium">Call-to-action button</p>
              <p className="text-muted">{script.adCopy.cta}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function VideoPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <VideoInner />
    </Suspense>
  );
}
