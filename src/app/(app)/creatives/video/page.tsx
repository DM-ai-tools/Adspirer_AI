"use client";

import { VIDEO_TYPES, type VideoTypeId } from "@/lib/video/video-types";
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
import { buildScriptSpeech } from "@/lib/video/duration";
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
  edited?: boolean;
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
  handling?: { restoredScenes: number[]; removedScenes: number[]; addedScenes?: number[]; unusedText: string[]; changes: Array<{ target: string; was: string; now: string }> } | null;
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
  angleDetail?: { situation: string; tension: string; centralMessage: string };
  differentiator?: string;
  hook?: { line: string; payoff: string };
  visualDirection?: string;
  onScreen?: string[];
  cta?: { spoken: string; label: string; target: string | null; benefit: string | null };
  speech?: { words: number; estimatedSeconds: number; wordsPerSecond: number; requestedSeconds: number; budgetWords: { min: number; target: number; max: number }; fit: "fits" | "long" | "short"; measuredSeconds?: number | null };
  sources?: SourceView[];
  dramatisation?: boolean;
  imageStats?: Array<{ assetId: string; assetName: string; value: string; label: string; said: boolean; shown: boolean; scene: number | null }>;
  editorial?: { hardFailures: Array<{ problem: string }>; open: Array<{ problem: string; severity: "hard" | "major" | "minor" }>; limitation: string | null };
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
  status: "waiting" | "running" | "reviewing" | "succeeded" | "failed";
  attempts: number;
  attemptCount?: number;
  qaAttempts?: number;
  unresolved?: boolean;
  acceptedWithIssues?: boolean;
  checkStatus?: CheckStatus;
  override?: OverrideView | null;
  corrections?: string[];
  qa?: { verdict: string; framesInspected: number; limitations: string[]; findings: Array<{ code: string; severity: "critical" | "major" | "minor"; message: string; atSeconds?: number }> } | null;
  error: string | null;
  usd: number | null;
  hasVideo: boolean;
  videoUrl: string | null;
};

/** How a clip or an export stands. One approved by a person despite findings is never shown as having passed. */
type CheckStatus = "passed" | "issues" | "approved_despite_warnings" | "unchecked";
type OverrideView = { at: string; by: string | null; findings: Array<{ code: string; severity: "critical" | "major" | "minor"; message: string; atSeconds?: number }> };

const CHECK_LABEL: Record<CheckStatus, string> = { passed: "Passed its checks", issues: "Issues detected", approved_despite_warnings: "Approved by you despite warnings", unchecked: "Not inspected" };

function CheckBadge({ status }: { status: CheckStatus }) {
  return <Badge variant={status === "passed" ? "secondary" : status === "issues" ? "danger" : "warning"}>{CHECK_LABEL[status]}</Badge>;
}

type FinalView = {
  state: "running" | "done" | "failed" | "blocked";
  /** "clean": footage and sound only. Absent on exports made before clean video existed. */
  mode?: "clean" | "branded";
  transcriptUrl?: string | null;
  planUrl?: string | null;
  planJsonUrl?: string | null;
  suggestedOverlays?: number;
  checkStatus?: CheckStatus;
  override?: OverrideView | null;
  acceptedAnyway?: boolean;
  reviewUrl?: string | null;
  srtUrl?: string | null;
  vttUrl?: string | null;
  subtitleCues?: number;
  /** The extra export with the logo and/or subtitles drawn in. */
  withGraphics?: { state: "running" | "done" | "failed"; stage: string | null; error: string | null; captions: boolean; logo: boolean; createdAt: string | null; url: string | null; logoPlacement?: { spot: string; widthShare: number; reason: string; by: "vision" | "pixels" | "default" } | null } | null;
  brand?: { name: string | null; logo: boolean; textOnly: boolean } | null;
  speech?: { measuredSeconds: number | null; estimatedSeconds: number | null } | null;
  report?: { findings: Array<{ code: string; severity: "critical" | "major" | "minor"; message: string; atSeconds?: number }>; limitations: string[]; framesInspected: number } | null;
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

type ClipDecisionView = {
  clip: number;
  verdict: "retry" | "redesign" | "unresolved";
  summary: string;
  estimateUsd: number;
  inspectionFailed: boolean;
  spentUsd: number;
  budgetUsd: number | null;
  overBudget: boolean;
  canUse: boolean;
  remainingUsd: number;
};

type JobFile = { id: string; name: string; purpose: "approved_proof_screenshot" | "supporting_image"; version: number; sha256: string | null; bytes: number | null; url: string; downloadUrl: string; available: boolean; cautions: string[] };

type GenerationView = {
  status: "generating" | "paused" | "stopped" | "clips_ready" | "assembling" | "done" | "failed" | "idle";
  assets?: JobFile[];
  cautions?: string[];
  storageDurable?: boolean;
  plan?: { narrationChanges?: Array<{ scene: number; was: string; now: string; reason: string }>; figureAdjustments?: Array<{ scene: number; figure: string; change: string }> } | null;
  reviewClip: number | null;
  decision?: ClipDecisionView | null;
  remainingUsd: number;
  final: FinalView | null;
  clips: GenClip[];
  spentUsd: number;
  blocked: string | null;
  notice?: string | null;
  statInserts?: StatInsertView[];
  error: string | null;
};

type Asset = { id: string; name: string; summary: string; kind: string | null; stats: Array<{ value: string; label: string }>; mainStat?: { value: string; label: string } | null; analysed: boolean; url: string; downloadUrl?: string; dateRange?: string | null; cautions?: string[] };

type ProjectView = {
  id: string;
  name: string;
  status: "writing" | "needs_context" | "scripts_ready" | "confirmed" | "generating" | "paused" | "stopped" | "clips_ready" | "assembling" | "done" | "failed";
  error: string | null;
  contextBrief?: BriefView | null;
  angleLimitation?: string | null;
  wordsPerSecond?: number | null;
  inputs: { landingPageUrl: string | null; targetSeconds: number; format: string; mode?: "write" | "upload"; scriptFileName?: string | null; changeRequest?: string | null };
  assets: Asset[];
  progress: ScriptProgress | null;
  brand: { name: string; colors: string[] | null; hasLogo: boolean } | null;
  brandCheck?: BrandCheck | null;
  creative?: CreativeView | null;
  scripts: Script[] | null;
  chosenScript: Script | null;
  plan: Plan | null;
  generation: GenerationView | null;
};

type HistoryItem = { id: string; name: string; status: ProjectView["status"]; created_at: string; landing_page_url: string | null; target_seconds: number; title: string | null };

const STATUS_LABEL: Record<ProjectView["status"], string> = { writing: "Writing scripts", needs_context: "Needs more information", scripts_ready: "Scripts ready", confirmed: "Script confirmed", generating: "Making the video", paused: "Waiting for your check", stopped: "Stopped", clips_ready: "Clips ready", assembling: "Finishing the video", done: "Finished", failed: "Failed" };
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

/** What a clean video is, where the old "add to the video" switches used to be. Nothing here can turn a graphic on. */
/** The kind of video and the operator's own idea, asked before the script is read or written. */
function VideoTypePicker({ value, onChange, idea, onIdea }: { value: VideoTypeId; onChange: (v: VideoTypeId) => void; idea: string; onIdea: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium">What kind of video do you want?</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {VIDEO_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={value === t.id}
            onClick={() => onChange(t.id)}
            className={cn("rounded-md border p-2.5 text-left transition-colors", value === t.id ? "border-accent bg-accent/10" : "border-border hover:border-accent/50")}
          >
            <p className="text-xs font-medium">{t.label}</p>
            <p className="text-[11px] text-muted">{t.blurb}</p>
          </button>
        ))}
      </div>
      <Field label="Your idea for the video (optional)">
        <Textarea
          value={idea}
          onChange={(e) => onIdea(e.target.value)}
          placeholder="e.g. Open on a tradie stuck in traffic while his phone keeps ringing, then cut to him calm at a job site. Moody evening light, feels like a movie trailer."
          className="min-h-[70px]"
        />
      </Field>
    </div>
  );
}

type StatInsertView = { scene: number; figure: string; spoken: boolean; sourced: boolean; line: string };

/** The figures in the script, to put on screen by hand: the footage itself never draws a number. */
function StatInserts({ items, exported }: { items: StatInsertView[]; exported: boolean }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1 rounded-md border border-border p-3 text-xs">
      <p className="font-medium">Stats to insert in editing</p>
      <p className="text-[11px] text-muted">
        The video says these figures; the footage shows no numbers (the video model cannot draw them cleanly). Add each one on screen while it is said.
        {exported ? " The placement plan in the download gives the exact time for each." : " After export, the placement plan gives the exact time for each."}
      </p>
      {items.map((s) => (
        <p key={`${s.scene}-${s.figure}`} className="text-[11px]">
          <span className="font-medium">Scene {s.scene}: {s.figure}</span>
          {s.spoken ? <> — said in &ldquo;{s.line}&rdquo;</> : <> — on screen only in the script; the line does not say it, so add it to the line if it should be heard</>}
          {s.sourced ? null : <span className="text-amber-500"> · no recorded source, confirm before showing it</span>}
        </p>
      ))}
    </div>
  );
}

function CleanVideoNote() {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-2 text-[11px]">
      <p className="font-medium">Clean video</p>
      <p className="text-muted">
        The MP4 is finished footage and sound only. No subtitles, highlighted words, logo, on-screen text, proof image or end card is added to it. Subtitle files, a transcript, a placement plan and your original logo and images are
        supplied separately, for you to add by hand.
      </p>
    </div>
  );
}

/** The files this video works from: the actual thumbnail, file name and checksum of each, exactly as selected when it was started. */
function JobFiles({ files, cautions, started }: { files: JobFile[]; cautions: string[]; started: boolean }) {
  if (!files.length && !cautions.length) return null;
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs">
      {files.length ? (
        <>
          <p className="font-medium">{started ? "Files this video was started with" : "Files this video will use"}</p>
          <p className="text-[11px] text-muted">{started ? "Fixed when the video was started: a later upload or change does not alter it." : "They are fixed when you start the video."} They are never drawn into the video or recreated by the video model.</p>
          <div className="grid gap-2 md:grid-cols-2">
            {files.map((f) => (
              <div key={`${f.id}-${f.version}`} className="flex gap-3 rounded-md border border-border p-2">
                {f.available ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.url} alt={f.name} className="h-16 w-16 shrink-0 rounded bg-white object-contain" />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-dashed border-destructive/60 text-center text-[10px] text-destructive">File missing</div>
                )}
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-medium" title={f.name}>{f.name}</p>
                  <p className="text-[11px] text-muted">
                    {f.purpose === "approved_proof_screenshot" ? "Approved proof screenshot" : "Supporting image"} · version {f.version}
                    {f.sha256 ? ` · checksum ${f.sha256.slice(0, 10)}` : ""}
                  </p>
                  {f.available ? (
                    <a href={f.downloadUrl} download className="text-[11px] text-accent underline">
                      Download the original
                    </a>
                  ) : (
                    <p className="text-[11px] text-destructive">The file is not in storage. Upload it again; nothing else is used in its place.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {cautions.length ? (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> To settle before these figures are used
          </p>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
            {cautions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

type SourceView = { claim: string; factId: string; source: { label: string; quote: string; url?: string } };

type BriefView = {
  company: { name: string | null };
  offer: { name: string; description: string };
  conversion: { action: string; target: string | null; benefit: string | null } | null;
  audience: { primary: string; situation: string; inferred: boolean };
  mechanism: { plain: string; distinctive: boolean } | null;
  facts: Array<{ id: string; text: string; category: string; source: { label: string; quote: string }; scope?: string }>;
  inferences: Array<{ id: string; text: string; kind: string }>;
  rejectedFacts: Array<{ text: string; reason: string }>;
  voice: { tone: string };
  defaults: Array<{ field: "audience" | "platform" | "tone" | "goal" | "speechRate"; value: string; why: string }>;
  gaps: Array<{ field: string; why: string; essential: boolean; ask: string }>;
  sourceQuality: "rich" | "thin" | "insufficient";
  limitation: string | null;
  injectionFlags: string[];
};

/** What the scripts are written from: the facts the page states (with where each came from), what is only inferred, what is missing, and the defaults in force. */
function BriefCard({ brief, angleLimitation, onSave, busy }: { brief: BriefView; angleLimitation: string | null; onSave: (values: { audience?: string; tone?: string; goal?: string; platform?: string; offerDetails?: string; instructions?: string; speechRate?: number; rewrite: boolean }) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState({ audience: "", tone: "", goal: "", platform: "", offerDetails: "", speechRate: "" });
  const gapsOpen = brief.gaps.filter((g) => g.essential);
  const set = (k: keyof typeof vals) => (e: { target: { value: string } }) => setVals((v) => ({ ...v, [k]: e.target.value }));
  const payload = (rewrite: boolean) => ({
    audience: vals.audience.trim() || undefined,
    tone: vals.tone.trim() || undefined,
    goal: vals.goal.trim() || undefined,
    platform: vals.platform.trim() || undefined,
    offerDetails: vals.offerDetails.trim() || undefined,
    speechRate: vals.speechRate.trim() ? Number(vals.speechRate) : undefined,
    rewrite,
  });
  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4 text-accent" /> What these scripts are written from
            <Badge variant={brief.sourceQuality === "rich" ? "secondary" : "danger"}>{brief.sourceQuality === "rich" ? "Plenty to work with" : brief.sourceQuality === "thin" ? "Thin source material" : "Not enough to go on"}</Badge>
          </p>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
            {open ? "Hide" : "Show the brief"}
          </Button>
        </div>
        {brief.limitation ? <p className="text-xs text-amber-500">{brief.limitation}</p> : null}
        {angleLimitation ? <p className="text-xs text-amber-500">{angleLimitation}</p> : null}
        {brief.injectionFlags.length ? <p className="text-[11px] text-muted">The page contained text addressed to an AI. It was treated as page content and ignored as an instruction.</p> : null}
        {brief.defaults.length ? (
          <div className="space-y-1 rounded-md bg-secondary/30 p-3 text-xs">
            <p className="font-medium">Assumed, because you did not say (change any of these and write again)</p>
            <ul className="space-y-0.5 text-muted">
              {brief.defaults.map((d) => (
                <li key={d.field}>
                  <span className="text-foreground">{d.field === "speechRate" ? "Speaking pace" : d.field}</span>: {d.value} <span className="italic">({d.why})</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {gapsOpen.length || brief.gaps.length ? (
          <div className="space-y-1 text-xs">
            <p className="font-medium">Missing from the page</p>
            <ul className="space-y-0.5 text-muted">
              {brief.gaps.map((g, i) => (
                <li key={i} className={g.essential ? "text-amber-500" : undefined}>
                  {g.why} {g.essential ? `Needed: ${g.ask}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {open ? (
          <div className="space-y-3 border-t border-border pt-3 text-xs">
            <p>
              <span className="font-medium">Company:</span> {brief.company.name ?? "not verified"} · <span className="font-medium">Offer:</span> {brief.offer.name}
              {brief.offer.description ? ` · ${brief.offer.description}` : ""}
            </p>
            {brief.conversion ? (
              <p>
                <span className="font-medium">The real next step:</span> {brief.conversion.action}
                {brief.conversion.target ? ` (${brief.conversion.target})` : ""}
                {brief.conversion.benefit ? ` · you get: ${brief.conversion.benefit}` : ""}
              </p>
            ) : (
              <p className="text-muted">No clear next step was found on the page.</p>
            )}
            <p>
              <span className="font-medium">Audience{brief.audience.inferred ? " (inferred)" : ""}:</span> {brief.audience.primary}. <span className="text-muted">{brief.audience.situation}</span>
            </p>
            {brief.mechanism ? (
              <p>
                <span className="font-medium">How it works:</span> {brief.mechanism.plain}
              </p>
            ) : null}
            <div>
              <p className="font-medium">Stated by the sources ({brief.facts.length})</p>
              <ul className="mt-1 space-y-1">
                {brief.facts.slice(0, 24).map((f) => (
                  <li key={f.id} className="rounded border border-border p-2">
                    <span className="text-foreground">{f.text}</span>
                    {f.scope ? <span className="text-muted"> · {f.scope}</span> : null}
                    <span className="block text-[10px] text-muted">
                      {f.source.label}: “{f.source.quote.slice(0, 160)}”
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {brief.inferences.length ? (
              <div>
                <p className="font-medium">Inferred by the writer (not stated as fact)</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
                  {brief.inferences.slice(0, 12).map((f) => (
                    <li key={f.id}>
                      {f.kind}: {f.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {brief.rejectedFacts.length ? <p className="text-muted">{brief.rejectedFacts.length} statement{brief.rejectedFacts.length === 1 ? "" : "s"} could not be traced to the sources and were left out.</p> : null}
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="font-medium">Change what it is written from</p>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Audience">
                  <Input className="text-xs" value={vals.audience} onChange={set("audience")} placeholder={brief.audience.primary} />
                </Field>
                <Field label="Tone">
                  <Input className="text-xs" value={vals.tone} onChange={set("tone")} placeholder={brief.voice.tone} />
                </Field>
                <Field label="Campaign goal">
                  <Input className="text-xs" value={vals.goal} onChange={set("goal")} placeholder="e.g. book a consultation" />
                </Field>
                <Field label="Platform">
                  <Input className="text-xs" value={vals.platform} onChange={set("platform")} placeholder="e.g. Instagram Reels" />
                </Field>
                <Field label="Words spoken per second" hint="Used for the length estimate (about 2.5 is a relaxed pace). Replaced by the measured length once a video exists.">
                  <Input className="text-xs" type="number" step={0.1} min={1.8} max={3.2} value={vals.speechRate} onChange={set("speechRate")} placeholder="2.5" />
                </Field>
              </div>
              <Field label="Details you can add (prices, terms, proof, who qualifies)">
                <Textarea className="min-h-[64px] text-xs" value={vals.offerDetails} onChange={set("offerDetails")} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => onSave(payload(true))}>
                  {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  Save and write the three scripts again
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onSave(payload(false))}>
                  Save without rewriting
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The page cannot support scripts without inventing things: say what is missing and ask only for what is essential. */
function NeedsContext({ brief, error, onSave, busy }: { brief: BriefView | null; error: string | null; onSave: (values: { offerDetails?: string; instructions?: string; audience?: string; rewrite: boolean }) => void; busy: boolean }) {
  const [details, setDetails] = useState("");
  const [audience, setAudience] = useState("");
  const asks = brief?.gaps.filter((g) => g.essential) ?? [];
  return (
    <Card className="border-amber-500/60">
      <CardContent className="space-y-3 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> More information is needed before scripts can be written
        </p>
        <p className="text-xs text-muted">
          {brief?.limitation ?? error ?? "The page does not say enough about the offer, and writing from it would mean inventing details."} Nothing has been made up to fill the gap.
        </p>
        {asks.length ? (
          <ul className="list-disc space-y-0.5 pl-4 text-xs">
            {asks.map((g, i) => (
              <li key={i}>{g.ask}</li>
            ))}
          </ul>
        ) : null}
        <Field label="What the offer is and what you can say about it" hint="Plain facts: what you do, how, for whom, any price or result you can stand behind.">
          <Textarea className="min-h-[96px] text-xs" value={details} onChange={(e) => setDetails(e.target.value)} />
        </Field>
        <Field label="Who it is for (optional)">
          <Input className="text-xs" value={audience} onChange={(e) => setAudience(e.target.value)} />
        </Field>
        <Button size="sm" disabled={busy || !details.trim()} onClick={() => onSave({ offerDetails: details.trim(), audience: audience.trim() || undefined, rewrite: true })}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
          Write the scripts with this
        </Button>
      </CardContent>
    </Card>
  );
}

/** The clean spoken script, how long it should take to say, and what to show and ask: the part of a version people actually read. */
function VersionSummary({
  script,
  spoken,
  words,
  speech,
  requestedSeconds,
  onAction,
  busy,
}: {
  script: Script;
  spoken: string;
  words: number;
  speech: { estimatedSeconds: number; wordsPerSecond: number; fit: "fits" | "long" | "short"; budgetWords: { min: number; max: number }; measuredSeconds?: number | null } | null;
  requestedSeconds: number;
  onAction: (action: "regenerate" | "rewrite_delivery" | "change_angle" | "retime", opts?: { instruction?: string; seconds?: number }) => void;
  busy: string | null;
}) {
  const [instruction, setInstruction] = useState("");
  const [newLength, setNewLength] = useState(String(requestedSeconds));
  const [showSources, setShowSources] = useState(false);
  const sources = (script.sources ?? []) as SourceView[];
  const editorial = script.editorial;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(spoken);
      toast.success("Script copied");
    } catch {
      toast.error("Could not copy");
    }
  };
  const fitText = !speech ? null : speech.fit === "fits" ? "fits the length asked for" : speech.fit === "long" ? "runs long: edit it down rather than speed it up" : "runs short";
  return (
    <div className="space-y-4 rounded-md border border-accent/30 p-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{script.angle.name}</Badge>
          {script.dramatisation ? <Badge variant="outline">Dramatisation, not a customer testimonial</Badge> : null}
        </div>
        {script.angleDetail ? <p className="text-xs text-muted">For: {script.angleDetail.situation}</p> : null}
        {script.differentiator ? <p className="text-xs">{script.differentiator}</p> : null}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">The script, as it will be spoken</p>
          <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
            Copy
          </Button>
        </div>
        <div className="whitespace-pre-line rounded-md bg-secondary/30 p-3 text-sm leading-relaxed">{spoken || "Nothing is spoken yet."}</div>
        <p className="text-xs text-muted">
          {words} words
          {speech ? (
            <>
              {" "}
              · estimated {Math.round(speech.estimatedSeconds)}s spoken at {speech.wordsPerSecond} words a second (asked for {requestedSeconds}s, {fitText}; about {speech.budgetWords.min} to {speech.budgetWords.max} words fits)
            </>
          ) : null}
          {speech?.measuredSeconds ? <> · measured from the audio: {speech.measuredSeconds}s</> : <> · the measured length appears once the video has been made</>}
        </p>
      </div>

      {script.imageStats?.length ? (
        <div className="space-y-1 rounded-md border border-border p-2 text-xs">
          <p className="font-medium">Main stat from each of your images (it must be said, with its image shown)</p>
          <ul className="space-y-0.5">
            {script.imageStats.map((c, i) => (
              <li key={i} className={c.said && c.shown ? "text-muted" : c.said ? "text-amber-500" : "text-destructive"}>
                {c.said && c.shown ? "Said and shown" : c.said ? "Said, image not shown" : "Not said yet"} in {c.scene ? `scene ${c.scene}` : "no scene"}: <span className="text-foreground">{c.value}</span> {c.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {script.hook ? (
        <p className="text-xs">
          <span className="font-medium">Opening chosen:</span> “{script.hook.line}” <span className="text-muted">· pays off: {script.hook.payoff}</span>
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 text-xs">
        <div className="space-y-1">
          <p className="font-medium">What is shown</p>
          <p className="text-muted">{script.visualDirection ?? "See the scenes below."}</p>
        </div>
        <div className="space-y-1">
          <p className="font-medium">Optional on-screen text, and the ask</p>
          {script.onScreen?.length ? <p className="text-muted">Could be added by hand (not in the video): {script.onScreen.join(" · ")}</p> : null}
          {script.cta ? (
            <p className="text-muted">
              Ends with: “{script.cta.spoken}” → button <span className="text-foreground">{script.cta.label}</span>
              {script.cta.target ? ` (${script.cta.target})` : ""}
              {script.cta.benefit ? ` · you get: ${script.cta.benefit}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1 text-xs">
        <button type="button" className="text-accent underline" onClick={() => setShowSources((v) => !v)}>
          {showSources ? "Hide" : "Show"} where each claim comes from ({sources.length})
        </button>
        {showSources ? (
          sources.length ? (
            <ul className="space-y-1">
              {sources.map((s, i) => (
                <li key={i} className="rounded border border-border p-2">
                  <span className="text-foreground">{s.claim}</span>
                  <span className="block text-[10px] text-muted">
                    {s.source.label}: “{s.source.quote.slice(0, 200)}”
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">This version states no factual claim that needs a source.</p>
          )
        ) : null}
      </div>

      {editorial && (editorial.hardFailures.length || editorial.open.length || editorial.limitation) ? (
        <div className="space-y-1 rounded-md border border-border p-2 text-xs">
          {editorial.hardFailures.map((i, k) => (
            <p key={`h${k}`} className="text-destructive">
              Must fix: {i.problem}
            </p>
          ))}
          {editorial.open.filter((i) => i.severity !== "minor" && i.severity !== "hard").slice(0, 4).map((i, k) => (
            <p key={`o${k}`} className="text-amber-500">
              {i.problem}
            </p>
          ))}
          {editorial.limitation ? <p className="text-muted">{editorial.limitation}</p> : null}
          <p className="text-[10px] text-muted">The editor&apos;s ratings are editorial signals, not predictions of how the ad will perform.</p>
        </div>
      ) : null}

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs font-medium">Change this version (the other two stay as they are; scenes you edited are kept)</p>
        <Input className="text-xs" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Optional: what you want, in your words" />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => onAction("regenerate", { instruction: instruction.trim() || undefined })}>
            {busy === "regenerate" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            Write this version again
          </Button>
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => onAction("rewrite_delivery", { instruction: instruction.trim() || undefined })}>
            {busy === "rewrite_delivery" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />}
            Same angle, new delivery
          </Button>
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => onAction("change_angle", { instruction: instruction.trim() || undefined })}>
            {busy === "change_angle" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
            Different angle, same facts
          </Button>
          <span className="flex items-center gap-1 text-xs">
            <Input className="h-8 w-16 text-xs" type="number" min={15} max={60} value={newLength} onChange={(e) => setNewLength(e.target.value)} />
            <Button size="sm" variant="secondary" disabled={Boolean(busy) || !Number(newLength)} onClick={() => onAction("retime", { seconds: Number(newLength) })}>
              {busy === "retime" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Make it {Number(newLength) || "?"}s
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

type BrandCheck =
  | { checked: false }
  | {
      checked: true;
      ready: boolean;
      name: string | null;
      nameSources: string[];
      nameCandidates: Array<{ value: string; source: string; rejectedReason: string | null }>;
      internalLabels: string[];
      conflicts: Array<{ field: string; chosen: string | null; reason: string; values: Array<{ value: string; source: string }> }>;
      hasLogo: boolean;
      /** The logo is on record but its file cannot be read from storage. */
      logoMissing?: boolean;
      readyForClean?: boolean;
      logoState?: { nameVerified: boolean; found: boolean; saved: boolean; accessible: boolean; approved: boolean };
      logo: { width: number; height: number; hasAlpha: boolean; origin: string; source: string | null; url: string; downloadUrl?: string } | null;
      logoCandidates: Array<{ url: string | null; role: string; score: number; rejectedReason: string | null; source: string }>;
      allowTextOnly: boolean;
      colors: string[];
      offer: string | null;
      cta: { label: string; url?: string } | null;
      claims: Array<{ id: string; text: string; source: string }>;
      issues: Array<{ code: string; severity: "blocking" | "warning"; field: string; message: string; resolution: string }>;
      checkedAt: string;
    };

type CreativeView = {
  narrative: { approach: string; whyItFits: string; arc: string[] };
  characters: Array<{ id: string; description: string; role: string }>;
  environments: Array<{ id: string; description: string; sceneNumbers: number[] }>;
  scenes: Array<{ number: number; purpose: string; informationAdded: string; subject: string; setting: string; action: string; framing: string; camera: string; seconds: number; durationBasis: string; screenTreatment: string; transition: { kind: string; rationale: string }; risks: string[]; acceptance: string[] }>;
  validation: { ok: boolean; issues: Array<{ scene: number | null; severity: string; message: string }> };
};

/** The verified brand the video is made from: public name, original logo, where each came from, and what still needs a decision. */

/**
 * A clip did not pass its inspection. Making it again costs real money, so nothing happens until the
 * operator chooses: make it again (the cost is stated), use the clip as it is, or stop.
 */
function DecisionCard({ decision, clipCount, busy, onChoose, onStop }: { decision: ClipDecisionView; clipCount: number; busy: boolean; onChoose: (choice: "remake" | "use" | "inspect") => void; onStop: () => void }) {
  const last = decision.clip >= clipCount;
  return (
    <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4 text-amber-500" /> Clip {decision.clip} did not pass the inspection
      </p>
      <p className="text-xs">{decision.summary}</p>
      <p className="text-xs text-muted">
        Nothing is being spent now. {decision.inspectionFailed ? "The inspection itself could not finish, so making the clip again would not help; inspecting it again costs no video." : `Making it again would cost about $${decision.estimateUsd.toFixed(2)} (you have spent $${decision.spentUsd.toFixed(2)} so far).`}
        {decision.overBudget && !decision.inspectionFailed ? ` That is past the cost cap of $${(decision.budgetUsd ?? 0).toFixed(2)}; choosing it raises the cap to cover this attempt and the clips still to be made.` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {decision.canUse ? (
          <Button size="sm" disabled={busy} onClick={() => onChoose("use")} title="Keep this clip exactly as it is. The problems stay on record.">
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
            {last ? "Use this clip as it is" : `Use this clip as it is, make the rest (about $${decision.remainingUsd.toFixed(2)})`}
          </Button>
        ) : null}
        {decision.inspectionFailed ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onChoose("inspect")}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            Inspect it again
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onChoose("remake")}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {decision.verdict === "redesign" ? "Redesign the shot and make it again" : "Make it again with corrections"} (about ${decision.estimateUsd.toFixed(2)})
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onStop}>
          Stop here
        </Button>
      </div>
      {decision.canUse ? <p className="text-[11px] text-muted">Watch the clip below first. If it looks right to you, use it.</p> : null}
    </div>
  );
}

function BrandCheckCard({ projectId, brand, onChanged }: { projectId: string; brand: BrandCheck | null | undefined; onChanged: (b: BrandCheck) => void }) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [page, setPage] = useState("");
  const [open, setOpen] = useState(false);
  // The preview is the proof that the file loads: if the picture fails, the logo is not shown as present.
  const [logoBroken, setLogoBroken] = useState(false);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      setLogoBroken(false);
      onChanged(await apiFetch<BrandCheck>(`/api/creatives/video/${projectId}/brand`, { method: "POST", body: JSON.stringify(body) }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not check the brand");
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("logo", file);
      const res = await fetch(`/api/creatives/video/${projectId}/brand`, { method: "POST", body: form, credentials: "same-origin" });
      const json = (await res.json()) as { ok: boolean; data?: BrandCheck; error?: { message?: string } };
      if (!json.ok || !json.data) throw new Error(json.error?.message ?? "Could not use that logo");
      onChanged(json.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not use that logo");
    } finally {
      setBusy(false);
    }
  }

  if (!brand || !brand.checked) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <ShieldCheck className="h-4 w-4 text-muted" />
          <span>The brand has not been checked. The video says only a verified company name.</span>
          <Button size="sm" disabled={busy} onClick={() => void post({ action: "refresh" })}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}Check the brand
          </Button>
        </CardContent>
      </Card>
    );
  }

  // A clean video shows no logo, so a logo problem never holds the video up: it is shown, but as something for the manual finish.
  const blocking = brand.issues.filter((i) => i.severity === "blocking" && i.field !== "logo");
  const logoIssues = brand.issues.filter((i) => i.severity === "blocking" && i.field === "logo");
  const warnings = brand.issues.filter((i) => i.severity === "warning");
  const state = brand.logoState;
  const pickable = brand.logoCandidates.filter((c) => c.url && c.role !== "icon" && c.role !== "decorative");
  return (
    <Card className={blocking.length ? "border-amber-500/60" : "border-accent/40"}>
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-medium">
            {blocking.length ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <ShieldCheck className="h-4 w-4 text-accent" />}
            Brand check {blocking.length ? "· needs a decision before video is made" : "· company name verified"}
          </p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void post({ action: "refresh" })}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}Check again
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-[160px_1fr]">
          <div className="space-y-1">
            {brand.logo && !logoBroken ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.logo.url} alt="Saved logo" onError={() => setLogoBroken(true)} className="max-h-24 w-full rounded border border-border bg-white object-contain p-2" />
            ) : brand.logoMissing || logoBroken ? (
              <div className="flex h-24 items-center justify-center rounded border border-dashed border-destructive/60 p-2 text-center text-[11px] text-destructive">The saved logo file cannot be loaded</div>
            ) : (
              <div className="flex h-24 items-center justify-center rounded border border-dashed border-border text-[11px] text-muted">No logo saved</div>
            )}
            {brand.logo && !logoBroken ? (
              <p className="text-[10px] text-muted">
                {brand.logo.width}x{brand.logo.height}{brand.logo.hasAlpha ? ", transparent" : ""}, {brand.logo.origin === "page" ? "from the page" : brand.logo.origin === "client" ? "saved for this client" : "uploaded"}
              </p>
            ) : null}
            {state ? (
              <ul className="space-y-0.5 text-[10px]">
                {(
                  [
                    ["Logo found", state.found],
                    ["Logo saved", state.saved],
                    ["Logo file loads", state.accessible && !logoBroken],
                    ["Approved by you", state.approved && !logoBroken],
                  ] as Array<[string, boolean]>
                ).map(([label, ok]) => (
                  <li key={label} className={cn("flex items-center gap-1", ok ? "text-muted" : "text-amber-500")}>
                    {ok ? <Check className="h-3 w-3 text-accent" /> : <X className="h-3 w-3" />} {label}
                  </li>
                ))}
              </ul>
            ) : null}
            {brand.logo && !logoBroken ? (
              <div className="flex flex-wrap gap-2 text-[11px]">
                {brand.logo.downloadUrl ? (
                  <a href={brand.logo.downloadUrl} download className="text-accent underline">
                    Download the original
                  </a>
                ) : null}
                <button type="button" disabled={busy} className="text-accent underline" onClick={() => void post({ action: "approve_logo", approved: !state?.approved })}>
                  {state?.approved ? "Withdraw approval" : "This is the right logo"}
                </button>
              </div>
            ) : null}
            {brand.logoMissing || logoBroken ? <p className="text-[10px] text-muted">Choose &quot;Check again&quot; to fetch it again, or upload the logo below. A clean video does not need it.</p> : null}
          </div>
          <div className="space-y-1 text-xs">
            <p>
              <span className="text-muted">Company name as it is said:</span> <span className="font-medium">{brand.name ?? "not verified"}</span>
            </p>
            {brand.nameSources.length ? <p className="text-[11px] text-muted">Source: {brand.nameSources.join("; ")}</p> : null}
            {brand.internalLabels.length ? <p className="text-[11px] text-muted">Kept out of the video (internal labels): {brand.internalLabels.slice(0, 4).join("; ")}</p> : null}
            {brand.cta ? <p><span className="text-muted">Call to action:</span> {brand.cta.label}</p> : null}
            <p className="text-[11px] text-muted">{brand.claims.length} claim{brand.claims.length === 1 ? "" : "s"} with a recorded source may be stated in the video.</p>
          </div>
        </div>

        {blocking.map((i) => (
          <p key={i.code + i.message} className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            <span className="font-medium">{i.message}</span> <span className="text-muted">{i.resolution}</span>
          </p>
        ))}
        {logoIssues.map((i) => (
          <p key={i.code + i.message} className="text-[11px] text-muted">
            {i.message} This does not hold up a clean video, which shows no logo.
          </p>
        ))}
        {warnings.map((i) => (
          <p key={i.code + i.message} className="text-[11px] text-muted">
            {i.message}
          </p>
        ))}

        <button type="button" className="text-[11px] text-accent underline" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Fix or change"} the name and logo
        </button>
        {open ? (
          <div className="space-y-3 rounded border border-border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Public company name" hint="Exactly as customers know it.">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={brand.name ?? "Company name"} className="h-8 w-64 text-xs" />
              </Field>
              <Button size="sm" disabled={busy || !name.trim()} onClick={() => void post({ action: "choose", name })}>
                Use this name
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Landing page to read the brand from" hint="Its header and footer show the real company name and logo.">
                <Input value={page} onChange={(e) => setPage(e.target.value)} placeholder="https://" className="h-8 w-64 text-xs" />
              </Field>
              <Button size="sm" disabled={busy || !/^https?:\/\//.test(page.trim())} onClick={() => void post({ action: "choose", landingPageUrl: page.trim() })}>
                Read this page
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary">
                <FileUp className="h-3.5 w-3.5" /> Upload the logo
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
              </label>
              <label className="inline-flex items-center gap-2 text-xs">
                <Checkbox checked={brand.allowTextOnly} onCheckedChange={(v) => void post({ action: "choose", allowTextOnly: v === true })} />
                No logo on record (only matters if you add an end card by hand)
              </label>
            </div>
            {pickable.length ? (
              <div className="space-y-1">
                <p className="text-[11px] font-medium">Images found on the page (choose the company logo)</p>
                <div className="flex flex-wrap gap-2">
                  {pickable.slice(0, 6).map((c) => (
                    <button key={c.url} type="button" disabled={busy} onClick={() => void post({ action: "choose", logoUrl: c.url })} className="w-24 space-y-1 rounded border border-border p-1 text-left hover:border-accent" title={c.rejectedReason ?? c.source}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c.url!} alt="" className="h-12 w-full bg-white object-contain" />
                      <span className="block truncate text-[10px] text-muted">{c.role}{c.rejectedReason ? " (rejected)" : ""}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The creative plan made for this video: what each scene is for and what it adds, so it can be judged before more is paid for. */
function PlanCard({ creative }: { creative: CreativeView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">Creative plan: {creative.narrative.approach}</p>
          <p className="text-muted">{creative.narrative.whyItFits}</p>
        </div>
        <Badge variant={creative.validation.ok ? "secondary" : "danger"}>{creative.validation.ok ? "Checked" : "Failed checks"}</Badge>
      </div>
      <button type="button" className="text-accent underline" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide scenes" : `Show ${creative.scenes.length} scenes`}
      </button>
      {open ? (
        <ol className="space-y-2">
          {creative.scenes.map((s) => (
            <li key={s.number} className="rounded border border-border p-2">
              <p className="font-medium">
                Scene {s.number} · {s.seconds}s · {s.purpose}
              </p>
              <p className="text-muted">Adds: {s.informationAdded}</p>
              <p>
                {s.framing} of {s.subject} in {s.setting}. {s.action}. Camera: {s.camera}.
              </p>
              <p className="text-[11px] text-muted">
                Length: {s.durationBasis}. Transition: {s.transition.kind} ({s.transition.rationale}).{s.screenTreatment !== "none" ? ` Screen: ${s.screenTreatment.replace(/_/g, " ")}.` : ""}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
      {creative.validation.issues.filter((i) => i.severity === "warning").length ? (
        <p className="text-[11px] text-muted">Notes: {creative.validation.issues.filter((i) => i.severity === "warning").slice(0, 3).map((i) => i.message).join(" ")}</p>
      ) : null}
    </div>
  );
}

/**
 * Make a copy of the finished clean video with the subtitles and/or the verified logo drawn in. The clean
 * MP4 stays as it is; this is an extra download beside it.
 */
function AddGraphics({ projectId, hasSubtitles, hasLogo, current, onView }: { projectId: string; hasSubtitles: boolean; hasLogo: boolean; current: NonNullable<FinalView["withGraphics"]> | null; onView: (g: GenerationView) => void }) {
  const [captions, setCaptions] = useState(hasSubtitles);
  const [logo, setLogo] = useState(hasLogo);
  const [busy, setBusy] = useState(false);
  const running = current?.state === "running";

  // While it is being made, follow it until it is done or has failed.
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void apiFetch<GenerationView>(`/api/creatives/video/${projectId}/generation`)
        .then((g) => {
          if (!stopped) onView(g);
        })
        .catch(() => undefined);
    }, 4_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [running, projectId, onView]);

  async function make() {
    setBusy(true);
    try {
      onView(await apiFetch<GenerationView>(`/api/creatives/video/${projectId}/generation`, { method: "POST", body: JSON.stringify({ action: "add_graphics", captions, logo }) }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add them");
    } finally {
      setBusy(false);
    }
  }

  if (!hasSubtitles && !hasLogo) return null;
  const what = (c: boolean, l: boolean) => (c && l ? "logo and subtitles" : c ? "subtitles" : "logo");
  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <p className="text-[11px] font-medium">Add the logo and subtitles to the video</p>
      <p className="text-[11px] text-muted">Makes a second MP4 with them drawn in (subtitles kept clear of faces, timed to the same words as the SRT). The clean MP4 stays as it is.</p>
      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        <label className={cn("flex items-center gap-1.5", !hasSubtitles && "text-muted")}>
          <input type="checkbox" checked={captions} disabled={!hasSubtitles || running} onChange={(e) => setCaptions(e.target.checked)} />
          Subtitles{hasSubtitles ? "" : " (no subtitle file for this export)"}
        </label>
        <label className={cn("flex items-center gap-1.5", !hasLogo && "text-muted")}>
          <input type="checkbox" checked={logo} disabled={!hasLogo || running} onChange={(e) => setLogo(e.target.checked)} />
          Logo{hasLogo ? "" : " (no verified logo: check the brand first)"}
        </label>
        <Button size="sm" variant="secondary" disabled={busy || running || (!captions && !logo)} onClick={() => void make()}>
          {busy || running ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Film className="mr-1 h-3.5 w-3.5" />}
          {current?.state === "done" ? "Make it again" : "Make the video with these"}
        </Button>
      </div>
      {running ? <p className="text-[11px] text-muted">{current?.stage ?? "Working"}… about a minute.</p> : null}
      {current?.state === "failed" ? <p className="text-[11px] text-destructive">Could not add them: {current.error}</p> : null}
      {current?.state === "done" && current.logoPlacement ? (
        <p className="text-[11px] text-muted">
          Logo: {current.logoPlacement.spot}, {Math.round(current.logoPlacement.widthShare * 100)}% of the width
          {current.logoPlacement.by === "vision" ? ` (chosen by looking at the video: ${current.logoPlacement.reason})` : current.logoPlacement.by === "pixels" ? " (the calmest place in the frames)" : ""}.
        </p>
      ) : null}
      {current?.state === "done" && current.url ? (
        <Button size="sm" asChild>
          <a href={`${current.url}&download=1`} download>
            <Download className="mr-1 h-3.5 w-3.5" />
            Download MP4 with {what(current.captions, current.logo)}
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/** Starts the video, follows each clip and keeps the work moving while the page is open. */
function GenerationPanel({ projectId, status, initial, onStatus, logoDownloadUrl }: { projectId: string; status: ProjectView["status"]; initial: GenerationView | null; onStatus: (s: ProjectView["status"]) => void; logoDownloadUrl?: string | null }) {
  const [gen, setGen] = useState<GenerationView | null>(initial);
  const [starting, setStarting] = useState(false);
  const [busyClip, setBusyClip] = useState<number | null>(null);
  const advancing = useRef(false);
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
  const notice = status === "confirmed" || status === "clips_ready" ? gen?.notice ?? null : null;

  if (!clips.length || (status === "confirmed" && !clips.some((c) => c.status !== "waiting"))) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={starting || Boolean(blocked)} onClick={() => void post({ action: "start", checkpoint }, () => setStarting(true), () => setStarting(false))}>
            {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Film className="mr-2 h-4 w-4" />}
            Generate video
          </Button>
          <p className="text-[11px] text-muted">Makes the clips one after another so the person and voice carry through, then joins them. It takes several minutes and keeps going if you leave.</p>
        </div>
        <CleanVideoNote />
        <StatInserts items={gen?.statInserts ?? []} exported={false} />
        {gen?.storageDurable === false ? <p className="text-xs text-amber-500">Files are being kept on this server&apos;s own disk and would be lost on a restart or redeploy. Set up the storage bucket before relying on a video made now.</p> : null}
        <JobFiles files={gen?.assets ?? []} cautions={gen?.cautions ?? []} started={false} />
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
        {notice ? <p className="text-xs text-amber-500">{notice}</p> : null}
      </div>
    );
  }

  const final = gen?.final ?? null;
  const allClips = clips.length > 0 && finished === clips.length;
  const isClean = final?.mode === "clean";
  const reworded = gen?.plan?.narrationChanges ?? [];
  const figureChanges = gen?.plan?.figureAdjustments ?? [];
  const overridden = final?.override?.findings ?? (final?.acceptedAnyway ? (final.report?.findings.filter((f) => f.severity !== "minor") ?? []) : []);

  return (
    <div className="space-y-3">
      <JobFiles files={gen?.assets ?? []} cautions={gen?.cautions ?? []} started />
      <StatInserts items={gen?.statInserts ?? []} exported={gen?.final?.state === "done"} />
      {figureChanges.length ? (
        <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium">Scenes changed because a figure had no recorded source</p>
          <p className="text-[11px] text-muted">The video was still made. Add the source (a stat, an image, the offer details) and make it again to show the figure.</p>
          {figureChanges.map((c) => (
            <p key={c.scene} className="text-[11px]">
              Scene {c.scene} ({c.figure}): {c.change}
            </p>
          ))}
        </div>
      ) : null}
      {reworded.length ? (
        <div className="space-y-1 rounded-md border border-border p-3 text-xs">
          <p className="font-medium">Spoken lines that were reworded</p>
          <p className="text-[11px] text-muted">They pointed at an image, and a clean video shows none, so each was reworded to make sense on its own.</p>
          {reworded.map((c) => (
            <p key={c.scene} className="text-[11px]">
              Scene {c.scene}: <span className="text-muted line-through">{c.was}</span> {c.now}
            </p>
          ))}
        </div>
      ) : null}
      {status === "paused" && gen?.decision ? (
        <DecisionCard
          decision={gen.decision}
          clipCount={clips.length}
          busy={starting}
          onChoose={(choice) => void post({ action: "decide", clip: gen.decision!.clip, choice }, () => setStarting(true), () => setStarting(false))}
          onStop={() => void post({ action: "stop" }, () => setStarting(true), () => setStarting(false), "stopped")}
        />
      ) : null}

      {status === "paused" && !gen?.decision ? (
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
            <span className="block text-[11px] text-muted">Joining the clips, levelling the sound, timing the subtitle files to the voice, writing the placement plan, then checking the result. Nothing is drawn onto the video. About a minute.</span>
          </span>
        </div>
      ) : null}

      {final?.state === "done" && final.videoUrl ? (
        <div className="space-y-3 rounded-md border border-accent/40 p-3">
          {final.acceptedAnyway ? (
            <div className="space-y-1 rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-500">
              <p className="font-medium">Approved by you despite warnings{final.override?.at ? ` on ${new Date(final.override.at).toLocaleString()}` : ""}. It did not pass every check.</p>
              {overridden.length ? (
                <ul className="list-disc space-y-0.5 pl-4">
                  {overridden.slice(0, 8).map((f, i) => (
                    <li key={f.code + i}>
                      {f.severity}: {f.message}
                      {f.atSeconds !== undefined ? ` (${f.atSeconds.toFixed(1)}s)` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              {overridden.length > 8 ? <p>And {overridden.length - 8} more, kept with the video.</p> : null}
            </div>
          ) : null}
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {final.acceptedAnyway ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <Check className="h-4 w-4 text-accent" />} {isClean ? "Clean video" : "Earlier export, with graphics burned in"} · {final.seconds}s · {final.width}x{final.height}
            <CheckBadge status={final.checkStatus ?? (final.acceptedAnyway ? "approved_despite_warnings" : "passed")} />
          </p>
          {!isClean ? <p className="text-[11px] text-muted">This export was made before clean video. Finish the video again below to get a clean MP4 with the subtitles, transcript and placement plan supplied separately.</p> : null}
          <div className="grid gap-4 md:grid-cols-[minmax(0,320px)_1fr]">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={final.videoUrl} controls playsInline preload="metadata" className="aspect-[9/16] max-h-[560px] w-full rounded-md bg-black object-contain" />
            <div className="space-y-3 text-xs">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" asChild>
                  <a href={`${final.videoUrl.split("?")[0]}?download=1`} download>
                    <Download className="mr-1 h-3.5 w-3.5" />
                    {isClean ? "Download clean MP4" : "Download MP4"}
                  </a>
                </Button>
                {final.srtUrl ? (
                  <Button size="sm" variant="secondary" asChild>
                    <a href={final.srtUrl} download>Subtitles (SRT)</a>
                  </Button>
                ) : null}
                {final.vttUrl ? (
                  <Button size="sm" variant="secondary" asChild>
                    <a href={final.vttUrl} download>Subtitles (VTT)</a>
                  </Button>
                ) : null}
                {final.transcriptUrl ? (
                  <Button size="sm" variant="secondary" asChild>
                    <a href={final.transcriptUrl} download>Transcript</a>
                  </Button>
                ) : null}
                {final.planUrl ? (
                  <Button size="sm" variant="secondary" asChild>
                    <a href={final.planUrl} download>Text and asset placement plan</a>
                  </Button>
                ) : null}
                {final.planJsonUrl ? (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={final.planJsonUrl} download>Plan as JSON</a>
                  </Button>
                ) : null}
              </div>
              {isClean ? (
                <AddGraphics
                  projectId={projectId}
                  hasSubtitles={Boolean(final.srtUrl)}
                  hasLogo={Boolean(logoDownloadUrl)}
                  current={final.withGraphics ?? null}
                  onView={setGen}
                />
              ) : null}
              {isClean ? (
                <div className="space-y-1 rounded-md border border-border p-2">
                  <p className="text-[11px] font-medium">Original files, to add by hand</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                    {logoDownloadUrl ? (
                      <a href={logoDownloadUrl} download className="text-accent underline">
                        Logo (original file)
                      </a>
                    ) : (
                      <span className="text-muted">No logo file is available.</span>
                    )}
                    {(gen?.assets ?? []).map((f) =>
                      f.available ? (
                        <a key={f.id} href={f.downloadUrl} download className="text-accent underline" title={f.sha256 ? `SHA-256 ${f.sha256}` : undefined}>
                          {f.name}
                        </a>
                      ) : (
                        <span key={f.id} className="text-destructive">
                          {f.name} (missing from storage)
                        </span>
                      ),
                    )}
                  </div>
                </div>
              ) : null}
              {isClean ? (
                <p className="text-muted">
                  In the MP4: the footage and its sound. Not in the MP4: subtitles, logo, on-screen text, proof images and an end card. The subtitle files{final.subtitleCues ? ` (${final.subtitleCues} cues)` : ""} follow the final audio
                  {final.includes?.captionTiming === "estimated" ? " (the speech could not be located, so their timing is estimated)" : ""}, and the placement plan suggests {final.suggestedOverlays ?? 0} piece{final.suggestedOverlays === 1 ? "" : "s"} of on-screen text with times from this export.
                </p>
              ) : null}
              {final.speech?.measuredSeconds ? (
                <p className="text-muted">
                  Narration measured from the audio: {final.speech.measuredSeconds}s{final.speech.estimatedSeconds ? ` (the script estimated ${Math.round(final.speech.estimatedSeconds)}s)` : ""}.
                </p>
              ) : null}
              {final.brand && !isClean ? <p className="text-muted">Brand on screen: {final.brand.name ?? "none"}{final.brand.logo ? ", with the verified logo" : final.brand.textOnly ? ", as text (no logo)" : ", with no logo"}.</p> : null}
              <div className="space-y-1">
                <p className="text-[11px] font-medium">{final.acceptedAnyway ? "What the inspection found (you approved it anyway)" : "Checked before showing you"}</p>
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
              {final.includes && !isClean ? (
                <p className="text-muted">
                  Burned into this file: {[final.includes.captions ? (final.includes.captionTiming === "transcript" ? "captions timed to the voice" : "captions (timing estimated)") : null, final.includes.logo ? "logo" : null, final.includes.stats ? `${final.includes.stats} stat${final.includes.stats === 1 ? "" : "s"}` : null, final.includes.images ? `${final.includes.images} of your image${final.includes.images === 1 ? "" : "s"}` : null, final.includes.endCard ? "end card" : null].filter(Boolean).join(", ")}.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {final?.state === "failed" ? <p className="text-xs text-destructive">Could not finish the video: {final.error}</p> : null}

      {final?.state === "blocked" ? (
        <div className="space-y-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" /> Not approved for delivery
          </p>
          <p className="text-xs">{final.error}</p>
          {final.report?.findings.length ? (
            <ul className="space-y-0.5 text-[11px]">
              {final.report.findings.slice(0, 8).map((f, i) => (
                <li key={f.code + i} className={f.severity === "minor" ? "text-muted" : "text-destructive"}>
                  {f.severity}: {f.message}
                  {f.atSeconds !== undefined ? ` (${f.atSeconds.toFixed(1)}s)` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {final.report?.limitations.length ? <p className="text-[11px] text-muted">Could not check: {final.report.limitations.join(" ")}</p> : null}
          {final.reviewUrl ? (
            <div className="space-y-1.5 rounded-md border border-border p-2 text-xs">
              <p>Watch it. If it is good enough for you, you can use it as it is. The problems above stay on record with the video.</p>
              <Button size="sm" variant="secondary" disabled={starting} onClick={() => void post({ action: "accept_final" }, () => setStarting(true), () => setStarting(false), "done")}>
                <Check className="mr-1 h-3.5 w-3.5" />
                Use this video anyway
              </Button>
            </div>
          ) : null}
          {final.reviewUrl ? (
            <details className="text-xs" open>
              <summary className="cursor-pointer text-accent">The export the inspection did not approve</summary>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={final.reviewUrl} controls playsInline preload="metadata" className="mt-2 aspect-[9/16] max-h-[420px] rounded-md bg-black object-contain" />
            </details>
          ) : null}
        </div>
      ) : null}

      {allClips && status !== "assembling" && status !== "generating" ? (
        <div className="space-y-2">
          <CleanVideoNote />
          <Button size="sm" variant={final?.state === "done" ? "secondary" : "default"} disabled={starting} onClick={() => void post({ action: "assemble" }, () => setStarting(true), () => setStarting(false), "assembling")}>
            {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Film className="mr-1 h-3.5 w-3.5" />}
            {final?.state === "done" ? (isClean ? "Finish the clean video again" : "Finish it again as a clean video") : "Join the clips into the clean video"}
          </Button>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">
            {status === "clips_ready" || status === "done" || status === "assembling" ? "Clips ready" : status === "paused" ? (gen?.decision ? "Waiting for your decision" : "Paused for your check") : status === "stopped" ? "Stopped" : status === "failed" ? "Stopped with an error" : "Making the video"}: {finished} of {clips.length} clips done
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
        {status === "failed" && !clips.some((c) => c.status !== "waiting" || c.attempts > 0) ? (
          // Stopped before any clip was made (nothing was spent): start again with a fresh plan.
          <Button size="sm" disabled={starting} onClick={() => void post({ action: "start", checkpoint: "after_first" }, () => setStarting(true), () => setStarting(false))}>
            {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            Try again (nothing was spent)
          </Button>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {clips.map((c) => (
          <div key={c.number} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                Clip {c.number} · {c.seconds}s
              </span>
              <Badge variant={c.status === "failed" ? "danger" : c.acceptedWithIssues ? "warning" : "secondary"}>{c.status === "waiting" ? ((c.qaAttempts ?? 0) > 0 ? "Making again" : "Waiting") : c.status === "running" ? "Making" : c.status === "reviewing" ? "Inspecting" : c.status === "succeeded" ? (c.acceptedWithIssues ? "Approved by you despite warnings" : c.checkStatus === "passed" ? "Passed its checks" : "Done") : c.unresolved ? "Issues detected" : "Failed"}</Badge>
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
                {c.status === "running" || c.status === "reviewing" ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> {c.status === "reviewing" ? "Inspecting the clip frame by frame…" : "Making this clip…"}
                  </span>
                ) : c.status === "failed" ? (
                  "No video"
                ) : (
                  "Waiting for the clip before it"
                )}
              </div>
            )}
            {c.error && c.status !== "succeeded" ? <p className="text-[11px] text-destructive">{c.error}</p> : null}
            {c.qa && c.qa.findings.length ? (
              <ul className="space-y-0.5 text-[11px]">
                {c.qa.findings.slice(0, 5).map((f, i) => (
                  <li key={f.code + i} className={f.severity === "minor" ? "text-muted" : "text-amber-500"}>
                    {f.severity}: {f.message}
                    {f.atSeconds !== undefined ? ` (${f.atSeconds.toFixed(1)}s)` : ""}
                  </li>
                ))}
                {c.acceptedWithIssues ? <li className="text-amber-500">You used this clip with {c.override?.findings.length ?? c.qa.findings.filter((f) => f.severity !== "minor").length} open finding(s){c.override?.at ? ` on ${new Date(c.override.at).toLocaleString()}` : ""}. It is not counted as passed.</li> : null}
              </ul>
            ) : c.qa ? (
              <p className="text-[11px] text-muted">Inspected {c.qa.framesInspected} frames: no problems found.</p>
            ) : null}
            {c.qa?.limitations?.length ? <p className="text-[10px] text-muted">Not checked: {c.qa.limitations.join(" ")}</p> : null}
            {(c.attemptCount ?? 0) > 1 ? <p className="text-[10px] text-muted">Made {c.attemptCount} times; earlier takes were rejected by the inspection.</p> : null}
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
              {c.number === 1 && (c.status === "succeeded" || c.status === "failed") ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8"
                  disabled={busyClip !== null || status === "generating"}
                  title="Throw away the creative plan too and make a new one from the same script"
                  onClick={() => void post({ action: "regenerate", fromClip: 1, replan: true }, () => setBusyClip(c.number), () => setBusyClip(null))}
                >
                  New plan, start again
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
  const [audienceIn, setAudienceIn] = useState("");
  const [toneIn, setToneIn] = useState("");
  const [goalIn, setGoalIn] = useState("");
  const [platformIn, setPlatformIn] = useState("");
  const [style, setStyle] = useState("auto");
  // Asked before the script is read or written: the kind of video, and the operator's own idea.
  const [videoType, setVideoType] = useState<VideoTypeId>("auto");
  const [videoIdea, setVideoIdea] = useState("");
  const [format, setFormat] = useState("9:16");
  const [priority, setPriority] = useState<"balanced" | "quality" | "cost">("quality");
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
        videoType,
        videoIdea: videoIdea.trim() || undefined,
        format,
        priority,
        mode,
        audience: audienceIn.trim() || undefined,
        tone: toneIn.trim() || undefined,
        goal: goalIn.trim() || undefined,
        platform: platformIn.trim() || undefined,
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

  // One version changed on its own: the other two and any scene the operator edited are left as they are.
  const [revising, setRevising] = useState<string | null>(null);
  async function revise(action: "regenerate" | "rewrite_delivery" | "change_angle" | "retime", opts: { instruction?: string; seconds?: number } = {}) {
    if (!draft || !projectId) return;
    setRevising(action);
    try {
      const res = await apiFetch<{ scripts: Script[]; scriptId: string }>(`/api/creatives/video/${projectId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          scriptId: draft.id,
          action,
          instruction: opts.instruction,
          seconds: opts.seconds,
          draft: { title: draft.title, scenes: draft.scenes.map((s) => ({ ...s, seconds: Number(s.seconds) || 2 })), adCopy: draft.adCopy },
        }),
      });
      setView((v) => (v ? { ...v, scripts: res.scripts } : v));
      const next = res.scripts.find((x) => x.id === res.scriptId);
      if (next) pick(next);
      toast.success(action === "retime" ? "Rewritten to the new length" : "This version was rewritten");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change this version");
    } finally {
      setRevising(null);
    }
  }

  async function chooseMainStat(assetId: string, value: string) {
    if (!projectId) return;
    try {
      await apiFetch(`/api/creatives/video/${projectId}/assets/${assetId}`, { method: "PATCH", body: JSON.stringify({ value }) });
      setView((v) => (v ? { ...v, assets: v.assets.map((a) => (a.id === assetId ? { ...a, mainStat: a.stats.find((s) => s.value === value) ?? a.mainStat } : a)) } : v));
      toast.success("Main stat changed. Write the scripts again to use it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the main stat");
    }
  }

  async function saveContext(values: { audience?: string; tone?: string; goal?: string; platform?: string; offerDetails?: string; instructions?: string; speechRate?: number; rewrite: boolean }) {
    if (!projectId) return;
    setRevising("context");
    try {
      const res = await apiFetch<{ rewriting: boolean }>(`/api/creatives/video/${projectId}/context`, { method: "POST", body: JSON.stringify(values) });
      if (res.rewriting) {
        setSelectedId(null);
        setDraft(null);
        setView((v) => (v ? { ...v, status: "writing", scripts: null, error: null, progress: null } : v));
        setPollKey((k) => k + 1);
      } else {
        toast.success("Saved");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setRevising(null);
    }
  }

  async function runRewrite(id: string, action: "scene" | "copy" | "check", opts: { sceneNumber?: number; issues?: string[]; feedback?: string } = {}) {
    if (!draft || !projectId) return;
    setRewriting(id);
    try {
      const res = await apiFetch<{ scene: Scene | null; adCopy: Script["adCopy"] | null; verification: Verification; speech?: Script["speech"] | null; imageStats?: Script["imageStats"] }>(`/api/creatives/video/${projectId}/rewrite`, {
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
      if (res.speech) setDraft((d) => (d ? { ...d, speech: res.speech! } : d));
      if (res.imageStats) setDraft((d) => (d ? { ...d, imageStats: res.imageStats! } : d));
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
  // The clean spoken script and its length estimate follow the words as they are being edited.
  const spokenText = useMemo(() => (draft ? draft.scenes.map((s) => s.line.trim()).filter(Boolean).join("\n\n") : ""), [draft]);
  const draftSpeech = useMemo(() => {
    if (!draft) return null;
    const requested = draft.speech?.requestedSeconds ?? view?.inputs.targetSeconds ?? 35;
    const built = buildScriptSpeech(draft.scenes.map((s) => s.line).filter((l) => l.trim()), requested, view?.wordsPerSecond ?? draft.speech?.wordsPerSecond ?? null);
    return { ...built, measuredSeconds: draft.speech?.measuredSeconds ?? null };
  }, [draft, view?.inputs.targetSeconds, view?.wordsPerSecond]);
  const assetName = useCallback((id: string) => view?.assets.find((a) => a.id === id)?.name, [view]);
  const events = useMemo(() => overlayEvents(timed), [timed]);

  // A confirmed script can be reopened for last-minute changes until a clip has been made from it.
  const [reopening, setReopening] = useState(false);
  const canReopen = Boolean(view?.chosenScript) && (view?.status === "confirmed" || view?.status === "failed") && !(view?.generation?.clips ?? []).some((c) => c.status !== "waiting" || c.attempts > 0);
  async function reopen() {
    if (!projectId) return;
    setReopening(true);
    try {
      const res = await apiFetch<{ scriptId: string }>(`/api/creatives/video/${projectId}/reopen`, { method: "POST" });
      const next = await apiFetch<ProjectView>(`/api/creatives/video/${projectId}`);
      setView(next);
      const script = next.scripts?.find((s) => s.id === res.scriptId);
      if (script) pick(script);
      toast.success("The script is open for editing. Confirm it again when you are done.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reopen the script");
    } finally {
      setReopening(false);
    }
  }

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
                    <details className="rounded-md border border-border p-3 text-xs">
                      <summary className="cursor-pointer text-[11px] font-medium">Optional: audience, tone, goal, platform</summary>
                      <p className="mt-2 text-[11px] text-muted">The landing page and the length are enough. Anything left empty is worked out from the page, and what was assumed is shown with the scripts so you can change it.</p>
                      <div className="mt-2 grid gap-3 md:grid-cols-2">
                        <Field label="Who it is for">
                          <Input className="text-xs" value={audienceIn} onChange={(e) => setAudienceIn(e.target.value)} />
                        </Field>
                        <Field label="Tone">
                          <Input className="text-xs" value={toneIn} onChange={(e) => setToneIn(e.target.value)} placeholder="e.g. dry and practical" />
                        </Field>
                        <Field label="Campaign goal">
                          <Input className="text-xs" value={goalIn} onChange={(e) => setGoalIn(e.target.value)} placeholder="e.g. quote requests" />
                        </Field>
                        <Field label="Platform">
                          <Input className="text-xs" value={platformIn} onChange={(e) => setPlatformIn(e.target.value)} placeholder="e.g. Instagram Reels" />
                        </Field>
                      </div>
                    </details>
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
                  <p className="text-[11px] text-muted">We read each image automatically and pick its main stat (you can change it). The script says that stat. The image itself is not put into the video: it is kept exactly as uploaded and handed back with a note on where it could go. PNG, JPG or WebP, up to 8.</p>
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
                  {mode === "write" && videoType === "auto" ? (
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
                        <SelectItem value="quality">Best quality (1080p, recommended)</SelectItem>
                        <SelectItem value="cost">Lowest cost</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                <VideoTypePicker value={videoType} onChange={setVideoType} idea={videoIdea} onIdea={setVideoIdea} />

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
          ) : view.chosenScript && (["confirmed", "generating", "paused", "stopped", "clips_ready", "assembling", "done"].includes(view.status) || (view.status === "failed" && Boolean(view.chosenScript))) ? (
            <div className="space-y-4">
              <Card className="border-accent/40">
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Check className="h-4 w-4 text-accent" /> Confirmed: {view.chosenScript.title} · {view.chosenScript.durationSeconds}s
                    </div>
                    {canReopen ? (
                      <Button type="button" size="sm" variant="secondary" disabled={reopening} onClick={() => void reopen()} title="Make last-minute changes, then confirm again. Nothing has been generated yet, so nothing is lost.">
                        {reopening ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />}
                        Edit the script
                      </Button>
                    ) : null}
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
                  <BrandCheckCard projectId={view.id} brand={view.brandCheck} onChanged={(b) => setView((v) => (v ? { ...v, brandCheck: b } : v))} />
                  {view.creative ? <PlanCard creative={view.creative} /> : null}
                  <GenerationPanel projectId={view.id} status={view.status} initial={view.generation} onStatus={setProjectStatus} logoDownloadUrl={view.brandCheck?.checked ? (view.brandCheck.logo?.downloadUrl ?? null) : null} />
                </CardContent>
              </Card>
              <ScriptBody script={view.chosenScript} assets={view.assets} />
            </div>
          ) : view.status === "needs_context" ? (
            <NeedsContext brief={view.contextBrief ?? null} error={view.error} busy={revising === "context"} onSave={(v) => void saveContext(v)} />
          ) : view.status === "failed" ? (
            <Card>
              <CardContent className="p-4 text-sm text-destructive">Could not write the scripts: {view.error || "the script step stopped without a reason. Choose \"Read my script again\" (or write again) to retry."}</CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <BrandCheckCard projectId={view.id} brand={view.brandCheck} onChanged={(b) => setView((v) => (v ? { ...v, brandCheck: b } : v))} />
              {view.contextBrief ? <BriefCard brief={view.contextBrief} angleLimitation={view.angleLimitation ?? null} busy={revising === "context"} onSave={(v) => void saveContext(v)} /> : null}
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
                            <p className="text-muted">{a.summary || (a.analysed ? "No description" : "Could not be read, so no stats were taken from it.")}</p>
                            {a.dateRange ? <p className="text-[11px] text-muted">Period shown in the image: {a.dateRange}</p> : null}
                            {a.cautions?.map((c) => (
                              <p key={c} className="flex gap-1 text-[11px] text-amber-500">
                                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {c}
                              </p>
                            ))}
                            <div className="flex flex-wrap gap-1">
                              {a.stats.length ? (
                                a.stats.map((s, i) => {
                                  const isMain = a.mainStat?.value === s.value;
                                  return (
                                    <button
                                      key={i}
                                      type="button"
                                      title={isMain ? "The main stat: the script says this one" : "Make this the main stat"}
                                      onClick={() => void chooseMainStat(a.id, s.value)}
                                      className={cn("rounded-md border px-2 py-0.5 text-[11px] transition-colors", isMain ? "border-accent bg-accent/10 font-medium text-foreground" : "border-border text-muted hover:border-accent")}
                                    >
                                      {isMain ? "Main · " : ""}
                                      {s.value} {s.label}
                                    </button>
                                  );
                                })
                              ) : (
                                <span className="text-[11px] text-muted">No numbers found in it</span>
                              )}
                            </div>
                            {a.stats.length ? <p className="text-[10px] text-muted">The main stat is the one the script says, with this image shown while it is said. Click another to change it, then write the scripts again.</p> : null}
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
                      {s.angle.stage ? <Badge variant="outline">{s.angle.stage}</Badge> : null}
                      <Badge variant="outline">{s.speech ? `${s.speech.words} words · about ${Math.round(s.speech.estimatedSeconds)}s` : `${s.durationSeconds}s`}</Badge>
                    </div>
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="mt-1 text-[11px] text-muted">{s.style}</p>
                    <p className="mt-2 text-xs text-muted">{s.angleDetail ? s.angleDetail.situation : `Targets: ${s.pain}`}</p>
                    {s.differentiator ? <p className="mt-1 text-xs">{s.differentiator}</p> : null}
                    <p className="mt-2 text-xs">&ldquo;{s.hook?.line ?? s.hookAlternatives[0]}&rdquo;</p>
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

                    {draft.source !== "uploaded" ? (
                      <VersionSummary script={draft} spoken={spokenText} words={spokenText.split(/\s+/).filter(Boolean).length} speech={draftSpeech} requestedSeconds={draft.speech?.requestedSeconds ?? view.inputs.targetSeconds} onAction={(a, o) => void revise(a, o)} busy={revising} />
                    ) : null}

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
                        {draft.handling?.addedScenes?.length ? <p className="text-muted">Scene{draft.handling.addedScenes.length === 1 ? "" : "s"} {draft.handling.addedScenes.join(", ")}: a spoken part of your script had been left out, so it was put back with your exact words.</p> : null}
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
                              <Field label="What is said (exact words)" hint={draft.source === "uploaded" ? "Your words. Change them only if you want to." : "Spoken aloud. It is heard, not shown: the subtitle files are made from it."}>
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
                                <Field label="Words that could be emphasised (optional, added by hand)" hint="Up to 3, comma separated. Not shown in the video.">
                                  <Input className="text-xs" value={draft.scenes[i]!.keywords.join(", ")} onChange={(e) => editScene(i, { keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 3) })} placeholder="e.g. free audit" />
                                </Field>
                                <Field label="Figure that could be shown (optional, added by hand)" hint="Only a real number. Not shown in the video.">
                                  <Input className="text-xs" value={draft.scenes[i]!.stat ?? ""} onChange={(e) => editScene(i, { stat: e.target.value.trim() ? e.target.value : null })} placeholder="e.g. 255%" />
                                </Field>
                              </div>
                              <Field label="Your image that belongs with this scene (not put in the video)">
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
                      <p className="text-sm font-medium">Optional on-screen text and images, to add by hand</p>
            <p className="text-[11px] text-muted">None of this is in the video. It is kept apart from what is spoken and goes into the placement plan, with times from the finished video.</p>
                      {events.length ? (
                        <ul className="space-y-1 text-xs text-muted">
                          {events.map((e, i) => (
                            <li key={i}>{describeEvent(e, assetName)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted">Nothing suggested. The video does not need any.</p>
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
                      {view?.chosenScript?.id === draft.id ? "Confirm the changes" : "Confirm this script"}
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
          {script.angle.stage ? <Badge variant="outline">{script.angle.stage}</Badge> : null}
          {script.framework.name ? <Badge variant="outline">{script.framework.name}</Badge> : null}
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
            <p className="text-sm font-medium">Optional on-screen text and images, to add by hand</p>
            <p className="text-[11px] text-muted">None of this is in the video. It is kept apart from what is spoken and goes into the placement plan, with times from the finished video.</p>
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
