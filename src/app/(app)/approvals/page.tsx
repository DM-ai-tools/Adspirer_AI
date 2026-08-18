"use client";

import { useEffect, useMemo, useState } from "react";
import type { Approval, ApprovalStatus, Client } from "@/types";
import { APPROVAL_STATUSES } from "@/types";
import { apiFetch } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { ApprovalCard } from "@/components/approvals/approval-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck } from "lucide-react";

export default function ApprovalsPage() {
  const { clients, refresh } = useApp();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [status, setStatus] = useState<string>("pending");
  const [clientId, setClientId] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clientMap = useMemo(() => {
    const map = new Map<string, Client>();
    for (const c of clients) map.set(c.id, c);
    return map;
  }, [clients]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      // "pending" queue also includes edited items waiting for re-approve after a failed execute
      if (status === "pending") {
        params.set("status", "pending,edited");
      } else if (status !== "all") {
        params.set("status", status);
      }
      if (clientId !== "all") params.set("clientId", clientId);
      const data = await apiFetch<{ approvals: Approval[] }>(
        `/api/approvals?${params.toString()}`,
      );
      const next = data.approvals.slice();
      if (status === "pending") {
        next.sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        );
      }
      setApprovals(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, clientId]);

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="Global queue for execute actions requiring human review."
        actions={
          <div className="flex gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="edited">Needs fix / edited</SelectItem>
                <SelectItem value="executed">Executed</SelectItem>
                {(APPROVAL_STATUSES as readonly ApprovalStatus[])
                  .filter(
                    (s) =>
                      !["pending", "edited", "executed"].includes(s),
                  )
                  .map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Client" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All clients</SelectItem>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      {loading ? (
        <LoadingState skeleton />
      ) : error ? (
        <ErrorState description={error} onRetry={() => void load()} />
      ) : approvals.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No approvals in this view"
          description="When the agent proposes an execute action, it will appear here."
        />
      ) : (
        <div className="mx-auto grid max-w-3xl gap-4">
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              clientName={clientMap.get(approval.client_id)?.name}
              onUpdated={async (updated) => {
                setApprovals((prev) =>
                  prev.map((a) => (a.id === updated.id ? updated : a)),
                );
                await refresh();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
