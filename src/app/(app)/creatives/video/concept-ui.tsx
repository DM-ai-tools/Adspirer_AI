"use client";

import { useState } from "react";
import { Check, Loader2, Plus, RefreshCw, Sparkles, Undo2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export type VoiceView = { id: string; who: string; description: string };
export type SceneLineView = { voiceId: string; text: string; onCamera: boolean };
export type ConceptView = {
  id: string;
  title: string;
  format: string;
  logline: string;
  hook: string;
  beats: Array<{ text: string; seconds: number }>;
  whyItWorks: string;
  brandLink: string;
  look: string;
  cast: string[];
  settings: string[];
  voices: VoiceView[];
  seconds: number;
};

const total = (c: ConceptView) => Math.round(c.beats.reduce((t, b) => t + b.seconds, 0)) || c.seconds;

/** The concepts on show: the operator picks one and its full script is written, or asks for three new ones. */
export function ConceptCards({
  projectId,
  concepts,
  limitation,
  error,
  scripts,
  onStarted,
  onOpen,
}: {
  projectId: string;
  concepts: ConceptView[];
  limitation: string | null;
  error: string | null;
  /** Every script already written on this video: a concept that has one opens it instead of writing again, and each stays reachable after new concepts replace its concept. */
  scripts: Array<{ id: string; title: string; conceptId: string | null }>;
  onStarted: () => void;
  /** Open a script already written, by its id. */
  onOpen: (scriptId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      await apiFetch(`/api/creatives/video/${projectId}/concepts`, { method: "POST", body: JSON.stringify(body) });
      onStarted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not do that");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-accent" /> Pick a concept
        </p>
        <p className="text-xs text-muted">Three different ideas for this video. Pick one and its full voiceover and scenes are written. You can come back here and pick another at any time before you confirm.</p>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {scripts.length ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Scripts already written:</span>
          {scripts.map((s) => (
            <button key={s.id} type="button" onClick={() => onOpen(s.id)} className="rounded-md border border-border px-2 py-1 text-muted transition-colors hover:bg-secondary/40">
              {s.title}
            </button>
          ))}
        </div>
      ) : null}
      {limitation ? <p className="text-xs text-amber-500">{limitation}</p> : null}
      <div className="grid gap-3 lg:grid-cols-3">
        {concepts.map((c) => {
          const written = scripts.find((s) => s.conceptId === c.id);
          return (
            <Card key={c.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-2 p-4 text-xs">
                <div className="flex flex-wrap gap-1.5">
                  <Badge>{c.format}</Badge>
                  <Badge variant="outline">about {total(c)}s</Badge>
                  {written ? <Badge variant="secondary">Script written</Badge> : null}
                </div>
                <p className="text-sm font-semibold">{c.title}</p>
                <p className="text-sm">{c.logline}</p>
                <p>
                  <span className="font-medium">Opens on:</span> <span className="text-muted">{c.hook}</span>
                </p>
                <ol className="list-decimal space-y-0.5 pl-4 text-muted">
                  {c.beats.map((b, i) => (
                    <li key={i}>
                      {b.text} <span className="text-[10px]">({Math.round(b.seconds)}s)</span>
                    </li>
                  ))}
                </ol>
                <p>
                  <span className="font-medium">Look:</span> <span className="text-muted">{c.look}</span>
                </p>
                {c.cast.length ? (
                  <p>
                    <span className="font-medium">Cast:</span> <span className="text-muted">{c.cast.join("; ")}</span>
                  </p>
                ) : null}
                <p>
                  <span className="font-medium">Voices:</span> <span className="text-muted">{c.voices.map((v) => `${v.who} (${v.description})`).join("; ")}</span>
                </p>
                <p>
                  <span className="font-medium">How it lands:</span> <span className="text-muted">{c.brandLink}</span>
                </p>
                <p className="italic text-muted">{c.whyItWorks}</p>
                <div className="mt-auto pt-2">
                  {written ? (
                    <Button size="sm" variant="secondary" onClick={() => onOpen(written.id)}>
                      Open its script
                    </Button>
                  ) : (
                    <Button size="sm" disabled={Boolean(busy)} onClick={() => void post({ action: "pick", conceptId: c.id }, c.id)}>
                      {busy === c.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                      Use this concept
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-9 max-w-[420px] text-xs" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Optional: what should be different (funnier, a trailer, no people...)" />
        <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void post({ action: "more", feedback: feedback.trim() || undefined }, "more")}>
          {busy === "more" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
          Show 3 new concepts
        </Button>
      </div>
    </div>
  );
}

/** The chosen concept, shown above its script. */
export function ConceptSummary({ concept, onBack }: { concept: ConceptView; onBack?: () => void }) {
  return (
    <div className="space-y-1 rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {concept.title} <span className="font-normal text-muted">· {concept.format}</span>
        </p>
        {onBack ? (
          <Button type="button" size="sm" variant="ghost" onClick={onBack}>
            Back to the concepts
          </Button>
        ) : null}
      </div>
      <p>{concept.logline}</p>
      <p className="text-muted">Opens on: {concept.hook}</p>
    </div>
  );
}

/** "Tell us what to change": a plain-language change to the voiceover, some scenes, the ad copy or the idea, with undo. */
export function ChangeBox({
  projectId,
  scriptId,
  canUndo,
  changeNote,
  draft,
  onChanged,
  onBusy,
}: {
  projectId: string;
  scriptId: string;
  canUndo: boolean;
  changeNote: string | null;
  onChanged: (result: { started?: boolean }) => void;
  /** What is on screen now, unsaved edits included: the change is made on top of it so those edits are kept. */
  draft?: { title: string; scenes: unknown[]; adCopy: unknown };
  /** Told when a change starts and ends, so the page can hold back confirming meanwhile. */
  onBusy?: (busy: boolean) => void;
}) {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState<"change" | "undo" | null>(null);

  async function send(body: Record<string, unknown>, kind: "change" | "undo") {
    setBusy(kind);
    onBusy?.(true);
    try {
      const res = await apiFetch<{ changed?: boolean; started?: boolean; problem?: string; summary?: string; undone?: boolean }>(`/api/creatives/video/${projectId}/change`, { method: "POST", body: JSON.stringify(body) });
      if (res.problem) {
        toast.error(res.problem);
        return;
      }
      if (kind === "change") setRequest("");
      toast.success(res.undone ? "Went back to the script before the last change" : res.started ? "Rewriting the script around your change…" : (res.summary ?? "Changed"));
      onChanged({ started: res.started });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not make the change");
    } finally {
      setBusy(null);
      onBusy?.(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Wand2 className="h-4 w-4 text-accent" /> Tell us what to change
      </p>
      <p className="text-[11px] text-muted">Say it in your own words: the voiceover, a scene, who says a line, the ending, the ad copy, or the idea itself. Only what you mention changes, and edits you made in the fields below are kept.</p>
      {changeNote ? <p className="text-[11px] text-accent">Last change: {changeNote}</p> : null}
      <Textarea className="min-h-[64px] text-xs" value={request} onChange={(e) => setRequest(e.target.value)} placeholder={'e.g. "make the voiceover funnier", "scene 3 should end on the chase", "let the inspector say the last line"'} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(busy) || request.trim().length < 3} onClick={() => void send({ scriptId, request: request.trim(), ...(draft ? { draft } : {}) }, "change")}>
          {busy === "change" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
          Make the change
        </Button>
        {canUndo ? (
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void send({ scriptId, action: "undo" }, "undo")}>
            {busy === "undo" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Undo2 className="mr-1 h-3.5 w-3.5" />}
            Undo last change
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Who says what in one scene: up to two lines, each with its voice and whether the speaker is seen. */
export function SceneLinesEditor({ lines, voices, onChange }: { lines: SceneLineView[]; voices: VoiceView[]; onChange: (lines: SceneLineView[]) => void }) {
  const set = (i: number, patch: Partial<SceneLineView>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium">What is said (exact words, by who)</p>
      {lines.length ? null : <p className="text-[11px] text-muted">Nobody speaks in this scene.</p>}
      {lines.map((l, i) => (
        <div key={i} className="space-y-1 rounded-md border border-border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={l.voiceId} onValueChange={(v) => set(i, { voiceId: v })}>
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {voices.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.who}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1 text-[11px] text-muted">
              <Checkbox checked={l.onCamera} onCheckedChange={(v) => set(i, { onCamera: v === true })} /> seen saying it
            </label>
            <button type="button" aria-label="Remove this line" onClick={() => onChange(lines.filter((_, k) => k !== i))} className={cn("ml-auto rounded p-0.5 hover:bg-secondary")}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <Textarea className="min-h-[56px] text-xs" value={l.text} onChange={(e) => set(i, { text: e.target.value })} />
        </div>
      ))}
      {lines.length < 2 ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...lines, { voiceId: voices[0]?.id ?? "narrator", text: "", onCamera: false }])}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add a line
        </Button>
      ) : null}
    </div>
  );
}

/** What was changed so the operator's own script or concept fits the video model. */
export function Adaptations({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
      <p className="font-medium">Fitted to what the video model can make</p>
      <ul className="list-disc space-y-0.5 pl-4 text-muted">
        {items.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
    </div>
  );
}
