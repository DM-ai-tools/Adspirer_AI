"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, ClipboardCheck, XCircle } from "lucide-react";
import type { Approval } from "@/types";
import { formatRelative } from "@/lib/api-client";
import { humanToolLabel } from "@/lib/tools/display-labels";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "@/components/approvals/approval-card";

const OPEN_STATUSES = new Set(["pending", "edited", "approved", "executing"]);

/**
 * The single place to act on changes the agent queued in this chat: pending
 * items as full cards, then a short history of what was applied or rejected.
 */
export function ApprovalsPanel({
  approvals,
  clientName,
  onUpdated,
}: {
  approvals: Approval[];
  clientName?: string;
  onUpdated: (approval: Approval) => void | Promise<void>;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const open = approvals.filter((a) => OPEN_STATUSES.has(a.status));
  const decided = approvals
    .filter((a) => !OPEN_STATUSES.has(a.status))
    .sort(
      (a, b) =>
        new Date(b.executed_at ?? b.reviewed_at ?? b.updated_at ?? b.created_at).getTime() -
        new Date(a.executed_at ?? a.reviewed_at ?? a.updated_at ?? a.created_at).getTime(),
    );

  return (
    <div className="space-y-3">
      {open.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-4 py-6 text-center">
          <ClipboardCheck className="h-5 w-5 text-muted" />
          <p className="mt-2 text-sm font-medium text-foreground">Nothing waiting for approval</p>
          <p className="mt-1 text-xs text-muted">
            When the agent proposes a change in this chat — a budget, a pause, a new ad — it
            appears here for you to review before anything changes on Meta.
          </p>
        </div>
      ) : (
        open.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            clientName={clientName}
            compact
            onUpdated={onUpdated}
          />
        ))
      )}

      {decided.length ? (
        <div className="rounded-xl border border-border-subtle">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted hover:text-foreground"
            aria-expanded={showHistory}
          >
            Decided in this chat ({decided.length})
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showHistory && "rotate-180")} />
          </button>
          {showHistory ? (
            <ul className="space-y-2 border-t border-border-subtle px-3 py-2.5">
              {decided.map((a) => {
                const ok = a.status === "executed";
                return (
                  <li key={a.id} className="flex gap-2 text-xs">
                    {ok ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    ) : (
                      <XCircle
                        className={cn(
                          "mt-0.5 h-3.5 w-3.5 shrink-0",
                          a.status === "failed" ? "text-danger" : "text-muted",
                        )}
                      />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-foreground">{humanToolLabel(a.tool_name)}</p>
                      <p className="text-muted">
                        {ok ? "Applied on Meta" : a.status === "failed" ? "Failed" : "Rejected"} ·{" "}
                        {formatRelative(a.executed_at ?? a.reviewed_at ?? a.updated_at ?? a.created_at)}
                      </p>
                      {a.status === "failed" && a.execution_error ? (
                        <p className="mt-0.5 line-clamp-3 text-danger/90">{a.execution_error}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
