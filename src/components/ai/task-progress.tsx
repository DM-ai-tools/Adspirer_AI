"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Loader2,
  MessageCircleQuestion,
  PauseCircle,
  XCircle,
} from "lucide-react";
import type { Task, TaskStatus } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ProgressStep = {
  id: string;
  label: string;
  state: "pending" | "active" | "done" | "waiting" | "error" | "skipped";
};

const STEP_STATES: ProgressStep["state"][] = [
  "pending",
  "active",
  "done",
  "waiting",
  "error",
  "skipped",
];

function stepsFromTask(task: Task): ProgressStep[] {
  const raw = task.agent_state?.steps;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .map((step) => {
        if (!step || typeof step !== "object") return null;
        const s = step as Record<string, unknown>;
        if (typeof s.id !== "string" || typeof s.label !== "string") return null;
        const state = String(s.state ?? "pending") as ProgressStep["state"];
        return {
          id: s.id,
          label: s.label,
          state: STEP_STATES.includes(state) ? state : "pending",
        } satisfies ProgressStep;
      })
      .filter((s): s is ProgressStep => Boolean(s));
  }

  // Legacy fallback for older tasks without dynamic steps.
  return [
    { id: "queued", label: "Queued", state: "done" },
    {
      id: "running",
      label: "Running",
      state:
        task.status === "running"
          ? "active"
          : task.status === "done" || task.status === "waiting_approval"
            ? "done"
            : "pending",
    },
    {
      id: "complete",
      label: "Complete",
      state: task.status === "done" ? "done" : "pending",
    },
  ];
}

const STATUS_BADGE: Record<
  TaskStatus,
  { label: string; variant: "default" | "success" | "warning" | "danger" | "muted" | "secondary" }
> = {
  queued: { label: "Queued", variant: "muted" },
  running: { label: "Running", variant: "default" },
  waiting_approval: { label: "Waiting approval", variant: "warning" },
  paused: { label: "Paused", variant: "secondary" },
  done: { label: "Done", variant: "success" },
  error: { label: "Error", variant: "danger" },
  cancelled: { label: "Cancelled", variant: "muted" },
};

function StepIcon({ state }: { state: ProgressStep["state"] }) {
  if (state === "done")
    return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (state === "active")
    return <Loader2 className="h-4 w-4 animate-spin text-accent" />;
  if (state === "waiting")
    return <MessageCircleQuestion className="h-4 w-4 text-warning" />;
  if (state === "error") return <XCircle className="h-4 w-4 text-danger" />;
  if (state === "skipped")
    return <PauseCircle className="h-4 w-4 text-muted" />;
  return <Circle className="h-4 w-4 text-muted/50" />;
}

export function TaskProgress({
  task,
  className,
}: {
  task: Task | null;
  className?: string;
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!task || !["queued", "running"].includes(task.status)) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 800);
    return () => window.clearInterval(id);
  }, [task]);

  const steps = useMemo(
    () => (task ? stepsFromTask(task) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task, tick],
  );

  if (!task) return null;

  // The run finished, but the plan stopped on a question — "Done" would read as
  // "your campaign is built" when nothing has been queued yet.
  const badge =
    task.status === "done" && steps.some((s) => s.state === "waiting")
      ? { label: "Waiting on you", variant: "warning" as const }
      : STATUS_BADGE[task.status];
  const summary =
    typeof task.agent_state?.summary === "string"
      ? task.agent_state.summary
      : null;
  const statusLabel =
    typeof task.agent_state?.statusLabel === "string"
      ? task.agent_state.statusLabel
      : null;

  return (
    <Card className={cn("border-border/80 bg-card/90", className)}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-sm font-medium">Task progress</CardTitle>
          <p className="mt-0.5 text-xs text-muted line-clamp-1">{task.title}</p>
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {statusLabel ? (
          <p className="flex items-center gap-2 text-xs text-accent">
            {["queued", "running"].includes(task.status) ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {statusLabel}
          </p>
        ) : null}
        <ul className="space-y-2">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2.5 text-sm">
              <StepIcon state={step.state} />
              <span
                className={cn(
                  step.state === "pending" || step.state === "skipped"
                    ? "text-muted"
                    : "text-foreground",
                  step.state === "active" && "font-medium text-accent",
                  step.state === "waiting" && "font-medium text-warning",
                )}
              >
                {step.label}
                {step.state === "waiting" ? (
                  <span className="ml-1.5 text-[11px] font-normal text-muted">
                    waiting on you
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {task.error_message ? (
          <p className="rounded-md bg-danger-muted px-3 py-2 text-xs text-danger">
            {task.error_message}
          </p>
        ) : null}
        {summary ? (
          <pre className="max-h-40 overflow-auto rounded-md border border-border-subtle bg-secondary/40 p-3 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
            {summary}
          </pre>
        ) : null}
      </CardContent>
    </Card>
  );
}
