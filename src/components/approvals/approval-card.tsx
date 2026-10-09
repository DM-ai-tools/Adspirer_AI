"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Pencil,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Approval } from "@/types";
import { apiFetch, formatCents, formatRelative, ApiClientError } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { humanToolLabel } from "@/lib/tools/display-labels";

function isBudgetChange(approval: Approval): boolean {
  return (
    approval.tool_name.toLowerCase().includes("budget") ||
    (approval.budget_impact_cents != null &&
      Math.abs(approval.budget_impact_cents) > 0)
  );
}

function proofLines(result: Record<string, unknown> | null): string[] {
  if (!result) return [];
  const lines: string[] = [];
  const proof =
    result.proof && typeof result.proof === "object"
      ? (result.proof as Record<string, unknown>)
      : null;
  const pick = (key: string, label: string) => {
    const fromProof = proof?.[key];
    const fromRoot = result[key];
    const value = fromProof ?? fromRoot;
    if (typeof value === "string" || typeof value === "number") {
      lines.push(`${label}: ${value}`);
    }
  };
  pick("id", "ID");
  pick("ad_set_id", "Ad set ID");
  pick("adset_id", "Ad set ID");
  pick("campaign_id", "Campaign ID");
  pick("ad_id", "Ad ID");
  pick("status", "Status");
  pick("name", "Name");
  pick("ad_type", "Ad type");
  pick("landing_page_url", "Landing page");
  if (!lines.length && result.raw_text && typeof result.raw_text === "string") {
    lines.push(result.raw_text.slice(0, 240));
  }
  return lines;
}

/** Old → new daily budget when the proposal carries both (cents). */
function budgetDelta(
  args: Record<string, unknown>,
): { before: number; after: number; pct: number | null } | null {
  const after = Number(args.daily_budget_cents);
  const before = Number(args.previous_daily_budget_cents);
  if (!Number.isFinite(after) || !Number.isFinite(before)) return null;
  if (args.daily_budget_cents == null || args.previous_daily_budget_cents == null) {
    return null;
  }
  return {
    before,
    after,
    pct: before > 0 ? Math.round(((after - before) / before) * 100) : null,
  };
}

function formatArgValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  }
  return String(value);
}

/** Hide internal routing fields (`__provider_backend`, `__account_currency`). */
function sanitizeApprovalArgsForDisplay(
  args: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !key.startsWith("__")),
  );
}

/** Ad account currency stamped on the approval at validation time. */
function approvalCurrency(approval: Approval): string {
  const args = approval.edited_args ?? approval.proposed_args ?? {};
  const fromArgs = args.__account_currency;
  if (typeof fromArgs === "string" && /^[A-Z]{3}$/.test(fromArgs)) return fromArgs;
  const fromResult = approval.execution_result?.currency;
  if (typeof fromResult === "string" && /^[A-Z]{3}$/.test(fromResult)) {
    return fromResult;
  }
  return "USD";
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function formatDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeLocations(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  const names = value.map((loc) => {
    if (typeof loc === "string") return loc;
    if (loc && typeof loc === "object") {
      const row = loc as Record<string, unknown>;
      const name = row.name ?? row.key ?? row.id ?? "location";
      const radius =
        typeof row.radius === "number"
          ? ` +${row.radius}${row.distance_unit === "mile" ? "mi" : "km"}`
          : "";
      return `${String(name)}${radius}`;
    }
    return String(loc);
  });
  return names.length > 4
    ? `${names.slice(0, 4).join(", ")} +${names.length - 4} more`
    : names.join(", ");
}

function countList(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Human-readable summary rows for the compact card (no raw JSON keys). */
function summarizeArgs(
  toolName: string,
  args: Record<string, unknown>,
  currency: string,
): Array<[string, string]> {
  const rows: Array<[string, string | null | undefined]> = [];
  const money = (cents: number | null) =>
    cents == null ? null : formatCents(cents, currency, { exact: true });
  const major = (value: unknown) => {
    const n = asNumber(value);
    return n == null ? null : money(Math.round(n * 100));
  };

  switch (toolName) {
    case "update_adset_budget":
      rows.push(["Ad set", formatArgValue(args.adset_id)]);
      rows.push(["New daily budget", money(asNumber(args.daily_budget_cents))]);
      rows.push(["Current", money(asNumber(args.previous_daily_budget_cents))]);
      break;
    case "pause_campaign":
    case "resume_campaign":
      rows.push(["Campaign", formatArgValue(args.campaign_name ?? args.campaign_id)]);
      rows.push(["Action", toolName === "pause_campaign" ? "Pause" : "Resume (starts spending)"]);
      break;
    case "pause_ad":
      rows.push(["Ad", formatArgValue(args.ad_name ?? args.ad_id)]);
      rows.push(["Action", "Pause"]);
      break;
    default: {
      const name =
        args.campaign_name ?? args.name ?? args.ad_set_name ?? args.ad_name;
      if (name != null) rows.push(["Name", formatArgValue(name)]);
      if (args.campaign_id) rows.push(["Campaign", formatArgValue(args.campaign_id)]);
      if (args.ad_set_id ?? args.adset_id) {
        rows.push(["Ad set", formatArgValue(args.ad_set_id ?? args.adset_id)]);
      }
      if (args.objective) rows.push(["Objective", String(args.objective)]);
      const budget =
        args.budget_lifetime != null
          ? `${major(args.budget_lifetime)} lifetime`
          : args.budget_daily != null || args.daily_budget != null
            ? `${major(args.budget_daily ?? args.daily_budget)} / day`
            : args.daily_budget_cents != null
              ? `${money(asNumber(args.daily_budget_cents))} / day`
              : null;
      if (budget) {
        rows.push([
          "Budget",
          args.campaign_budget_optimization === true
            ? `${budget} (campaign budget)`
            : budget,
        ]);
      }
      const start = formatDate(args.start_time);
      const end = formatDate(args.end_time);
      if (start || end) {
        rows.push(["Schedule", `${start ?? "on publish"} → ${end ?? "ongoing"}`]);
      }
      const targeting: string[] = [];
      const where = describeLocations(args.locations);
      if (where) targeting.push(where);
      const ageMin = asNumber(args.age_min);
      const ageMax = asNumber(args.age_max);
      if (ageMin != null || ageMax != null) {
        targeting.push(`age ${ageMin ?? 18}–${ageMax ?? "65+"}`);
      }
      if (Array.isArray(args.genders) && args.genders.length) {
        targeting.push(args.genders.join("/"));
      }
      const interests = countList(args.interests) + countList(args.behaviors);
      if (interests) targeting.push(`${interests} interest/behaviour`);
      const audiences = countList(args.custom_audiences);
      if (audiences) targeting.push(`${audiences} custom audience${audiences > 1 ? "s" : ""}`);
      if (args.advantage_audience === true || args.advantage_audience === 1) {
        targeting.push("Advantage+ audience");
      }
      if (targeting.length) rows.push(["Targeting", targeting.join(" · ")]);
      else if (
        toolName === "create_meta_image_campaign" ||
        toolName === "create_meta_video_campaign" ||
        toolName === "create_adset"
      ) {
        rows.push(["Targeting", "No location set — add one before approving"]);
      }
      if (args.headline) rows.push(["Headline", formatArgValue(args.headline)]);
      if (args.call_to_action) rows.push(["Button", String(args.call_to_action)]);
      if (args.landing_page_url) rows.push(["Landing page", formatArgValue(args.landing_page_url)]);
      if (args.lead_form_id) rows.push(["Lead form", formatArgValue(args.lead_form_id)]);
    }
  }
  if (args.account_id) rows.push(["Ad account", formatArgValue(args.account_id)]);
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

function successHint(toolName: string): string {
  switch (toolName) {
    case "resume_campaign":
      return "Campaign is now ACTIVE in Meta.";
    case "pause_campaign":
      return "Campaign is now paused in Meta.";
    case "pause_ad":
      return "Ad is now paused in Meta.";
    case "update_adset_budget":
      return "Daily budget updated in Meta.";
    default:
      return "Created in Meta as PAUSED (not published/live).";
  }
}

export function ApprovalCard({
  approval,
  clientName,
  onUpdated,
  className,
  compact,
}: {
  approval: Approval;
  clientName?: string;
  onUpdated?: (approval: Approval) => void;
  className?: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | "edit" | null>(null);
  const [editing, setEditing] = useState(false);
  const displayArgs = sanitizeApprovalArgsForDisplay(
    approval.edited_args ?? approval.proposed_args,
  );
  const [editJson, setEditJson] = useState(
    JSON.stringify(displayArgs, null, 2),
  );
  const [rejectReason, setRejectReason] = useState("");

  // Re-sync the edit buffer when the approval changes underneath us (polling,
  // another reviewer, a failed run returning normalized args) — unless the
  // operator is mid-edit. Adjusting state during render avoids a stale frame.
  const syncKey = `${approval.id}:${approval.updated_at}`;
  const [syncedKey, setSyncedKey] = useState(syncKey);
  if (syncKey !== syncedKey) {
    setSyncedKey(syncKey);
    if (!editing) setEditJson(JSON.stringify(displayArgs, null, 2));
  }

  const currency = approvalCurrency(approval);
  const budgetHeavy = isBudgetChange(approval);
  const args = displayArgs;
  const delta = budgetDelta(args);
  const summary = summarizeArgs(approval.tool_name, args, currency);
  // A failed run can be fixed and approved again.
  const pending =
    approval.status === "pending" ||
    approval.status === "edited" ||
    approval.status === "failed";
  const executed = approval.status === "executed";
  const failed = Boolean(approval.execution_error) && !executed;
  const isCreate = approval.tool_name.startsWith("create_");
  const proof = proofLines(approval.execution_result);

  async function handleApprove() {
    setBusy("approve");
    try {
      const data = await apiFetch<{ approval: Approval; result?: unknown }>(
        `/api/approvals/${approval.id}/approve`,
        { method: "POST" },
      );
      toast.success(
        `Approved and executed — ${successHint(data.approval.tool_name)}`,
      );
      onUpdated?.(data.approval);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Approve failed");
      if (error instanceof ApiClientError) {
        const details = error.details as { approval?: Approval } | undefined;
        if (details?.approval) {
          onUpdated?.(details.approval);
          setEditJson(
            JSON.stringify(
              sanitizeApprovalArgsForDisplay(
                details.approval.edited_args ??
                  details.approval.proposed_args,
              ),
              null,
              2,
            ),
          );
        }
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleReject() {
    setBusy("reject");
    try {
      const data = await apiFetch<{ approval: Approval }>(
        `/api/approvals/${approval.id}/reject`,
        {
          method: "POST",
          body: JSON.stringify({ reason: rejectReason || undefined }),
        },
      );
      toast.success("Rejected");
      onUpdated?.(data.approval);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reject failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleEdit() {
    let editableInput: Record<string, unknown>;
    try {
      editableInput = JSON.parse(editJson) as Record<string, unknown>;
    } catch {
      toast.error("The edited values aren't valid JSON — check commas and quotes.");
      return;
    }
    setBusy("edit");
    try {
      // Internal routing keys are hidden from the editor; carry them over.
      const original = approval.edited_args ?? approval.proposed_args ?? {};
      for (const [key, value] of Object.entries(original)) {
        if (key.startsWith("__") && editableInput[key] === undefined) {
          editableInput[key] = value;
        }
      }
      const data = await apiFetch<{ approval: Approval }>(
        `/api/approvals/${approval.id}/edit`,
        {
          method: "POST",
          body: JSON.stringify({ editableInput }),
        },
      );
      toast.success("Edits saved — still pending approval");
      setEditing(false);
      onUpdated?.(data.approval);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Edit failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      className={cn(
        "overflow-hidden",
        budgetHeavy && pending
          ? "border-warning/50 bg-warning-muted/20 shadow-[0_0_24px_rgba(251,191,36,0.08)]"
          : "border-border bg-card",
        className,
      )}
    >
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-semibold">
              {humanToolLabel(approval.tool_name)}
            </CardTitle>
            <p className="mt-1 text-xs text-muted">
              {clientName ? `${clientName} · ` : ""}
              {formatRelative(approval.created_at)}
            </p>
          </div>
          <Badge
            variant={
              pending
                ? approval.execution_error
                  ? "danger"
                  : "warning"
                : approval.status === "executed" ||
                    approval.status === "approved"
                  ? "success"
                  : approval.status === "rejected" ||
                      approval.status === "failed"
                    ? "danger"
                    : "secondary"
            }
          >
            {approval.execution_error && pending
              ? "needs fix"
              : approval.status}
          </Badge>
        </div>

        {budgetHeavy && pending ? (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <p className="font-semibold">Budget change requires review</p>
              {delta ? (
                <p className="mt-0.5 text-warning/90">
                  Daily budget{" "}
                  <span className="font-mono">
                    {formatCents(delta.before, currency, { exact: true })}
                  </span>
                  {" → "}
                  <span className="font-mono font-semibold">
                    {formatCents(delta.after, currency, { exact: true })}
                  </span>
                  {delta.pct != null ? (
                    <span className="font-mono">
                      {" "}
                      ({delta.pct > 0 ? "+" : ""}
                      {delta.pct}%)
                    </span>
                  ) : null}
                </p>
              ) : (
                <p className="mt-0.5 text-warning/80">
                  Impact:{" "}
                  <span className="font-mono">
                    {formatCents(approval.budget_impact_cents, currency, {
                      exact: true,
                    })}
                  </span>
                  /day. Confirm the budget before executing.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-3">
        {approval.rationale ? (
          <p className="text-sm text-foreground/90">{approval.rationale}</p>
        ) : null}

        {editing ? (
          <Textarea
            value={editJson}
            onChange={(e) => setEditJson(e.target.value)}
            aria-label="Edit proposed values (JSON)"
            className="min-h-[140px] font-mono text-xs"
          />
        ) : !compact ? (
          <pre className="max-h-48 overflow-auto rounded-lg border border-border-subtle bg-secondary/50 p-3 font-mono text-[11px] leading-relaxed text-muted">
            {JSON.stringify(args, null, 2)}
          </pre>
        ) : (
          <div className="space-y-0.5 rounded-lg border border-border-subtle bg-secondary/40 px-3 py-2 text-xs text-muted">
            {summary.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <span className="shrink-0">{label}</span>
                <span className="truncate text-right text-foreground" title={value}>
                  {value}
                </span>
              </div>
            ))}
            <p className="mt-1 text-[11px] text-muted">
              Open Edit to see every field.
            </p>
          </div>
        )}

        {executed ? (
          <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
            <p className="font-semibold text-foreground">
              Execution proof
            </p>
            <p className="mt-1 text-muted">
              {isCreate ? (
                <>
                  Applied in Meta. New campaigns / ad sets / ads are created{" "}
                  <span className="font-medium text-foreground">PAUSED</span> —
                  not published or live until you activate them.
                </>
              ) : (
                successHint(approval.tool_name)
              )}
              {approval.execution_result?.verified === false
                ? " Meta accepted it but the read-back failed — confirm in Ads Manager."
                : ""}
            </p>
            {proof.length ? (
              <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-foreground/85">
                {proof.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 font-mono text-[11px] text-muted">
                executed_at: {approval.executed_at ?? "—"}
              </p>
            )}
          </div>
        ) : null}

        {failed && approval.execution_error ? (
          <div className="rounded-lg border border-danger/40 bg-danger-muted/40 px-3 py-2 text-xs text-danger">
            <p className="font-semibold">
              {approval.execution_error.startsWith("Needs edits")
                ? "Needs edits before it can be approved"
                : "Execution failed — fix and re-approve"}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-danger/90">
              {approval.execution_error}
            </p>
            <p className="mt-2 text-muted">
              {isCreate
                ? "Check Ads Manager first, then Edit any wrong fields, Save, and Approve again. Entities already created are reused (not duplicated) and stay PAUSED."
                : "Edit the values if needed, Save, then Approve again."}
            </p>
          </div>
        ) : null}

        {pending ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {editing ? (
              <>
                <Button
                  size="sm"
                  onClick={handleEdit}
                  disabled={busy !== null}
                >
                  Save edits
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={handleApprove}
                  disabled={busy !== null}
                >
                  <Check className="h-3.5 w-3.5" />
                  {busy === "approve" ? "Approving…" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(true)}
                  disabled={busy !== null}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={handleReject}
                  disabled={busy !== null}
                >
                  <X className="h-3.5 w-3.5" />
                  {busy === "reject" ? "Rejecting…" : "Reject"}
                </Button>
              </>
            )}
          </div>
        ) : null}

        {pending && !editing ? (
          <Textarea
            placeholder="Optional reject reason…"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="min-h-[60px] text-xs"
          />
        ) : null}

        {pending &&
        approval.tool_name === "create_adset" &&
        !(typeof args.landing_page_url === "string" && args.landing_page_url) ? (
          <p className="text-[11px] text-warning">
            Missing landing_page_url — Edit and add a https:// URL before
            approving (Meta requires it). Entities are created PAUSED, not
            published.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
