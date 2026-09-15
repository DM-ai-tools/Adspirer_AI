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

/** Hide internal routing fields from the Approvals JSON panel. */
function sanitizeApprovalArgsForDisplay(
  args: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const { __provider_backend: _backend, ...rest } = args;
  return rest;
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

  const budgetHeavy = isBudgetChange(approval);
  const args = displayArgs;
  const pending =
    approval.status === "pending" || approval.status === "edited";
  const executed = approval.status === "executed";
  const failed = Boolean(approval.execution_error) && !executed;
  const proof = proofLines(approval.execution_result);

  async function handleApprove() {
    setBusy("approve");
    try {
      const data = await apiFetch<{ approval: Approval; result?: unknown }>(
        `/api/approvals/${approval.id}/approve`,
        { method: "POST" },
      );
      const statusHint =
        data.approval.tool_name.includes("create")
          ? "Created in Meta as PAUSED (not published/live)."
          : "Executed in Meta.";
      toast.success(`Approved and executed — ${statusHint}`);
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
    setBusy("edit");
    try {
      const editableInput = JSON.parse(editJson) as Record<string, unknown>;
      const original = approval.edited_args ?? approval.proposed_args;
      if (
        original &&
        typeof original.__provider_backend === "string" &&
        editableInput.__provider_backend === undefined
      ) {
        editableInput.__provider_backend = original.__provider_backend;
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
              <p className="mt-0.5 text-warning/80">
                Impact:{" "}
                <span className="font-mono">
                  {formatCents(approval.budget_impact_cents)}
                </span>
                . Confirm the new daily budget before executing.
              </p>
            </div>
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-3">
        {approval.rationale ? (
          <p className="text-sm text-foreground/90">{approval.rationale}</p>
        ) : null}

        {!compact ? (
          editing ? (
            <Textarea
              value={editJson}
              onChange={(e) => setEditJson(e.target.value)}
              className="min-h-[140px] font-mono text-xs"
            />
          ) : (
            <pre className="max-h-48 overflow-auto rounded-lg border border-border-subtle bg-secondary/50 p-3 font-mono text-[11px] leading-relaxed text-muted">
              {JSON.stringify(args, null, 2)}
            </pre>
          )
        ) : (
          <div className="rounded-lg border border-border-subtle bg-secondary/40 px-3 py-2 font-mono text-xs text-muted">
            {Object.entries(args)
              .slice(0, 4)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <span>{k}</span>
                  <span className="text-foreground">{String(v)}</span>
                </div>
              ))}
          </div>
        )}

        {executed ? (
          <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
            <p className="font-semibold text-foreground">
              Execution proof
            </p>
            <p className="mt-1 text-muted">
              Applied in Meta. New campaigns / ad sets / ads are created{" "}
              <span className="font-medium text-foreground">PAUSED</span> — not
              published or live until you activate them.
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
            <p className="font-semibold">Execution failed — fix and re-approve</p>
            <p className="mt-1 whitespace-pre-wrap text-danger/90">
              {approval.execution_error}
            </p>
            <p className="mt-2 text-muted">
              Click Edit, add any missing fields (especially{" "}
              <code className="font-mono">landing_page_url</code>,{" "}
              <code className="font-mono">primary_text</code>,{" "}
              <code className="font-mono">ad_type</code>), Save, then Approve
              again. New entities are created PAUSED — not published.
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
            approving (Adspirer requires it). Entities are created PAUSED, not
            published.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
