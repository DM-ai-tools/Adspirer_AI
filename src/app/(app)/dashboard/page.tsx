"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Users,
  Plug,
  Bot,
  ShieldCheck,
  Wallet,
  AlertTriangle,
  KeyRound,
  Clock,
} from "lucide-react";
import type { Approval, Task } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApp } from "@/components/layout/app-provider";
import { humanToolLabel } from "@/lib/tools/display-labels";

type DashboardData = {
  stats: {
    clients: number;
    activeTasks: number;
    pendingApprovals: number;
    openRecommendations: number;
    unreadNotifications: number;
    accessRequestsOpen: number;
    connectedAccounts: number;
  };
  recentTasks: Task[];
  pendingApprovals: Approval[];
};

export default function DashboardPage() {
  const { refresh } = useApp();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<DashboardData>("/api/dashboard");
      setData(res);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <LoadingState skeleton />;
  if (error || !data)
    return <ErrorState description={error ?? undefined} onRetry={() => void load()} />;

  const budgetApprovals = data.pendingApprovals.filter(
    (a) =>
      a.tool_name.toLowerCase().includes("budget") ||
      (a.budget_impact_cents != null && a.budget_impact_cents !== 0),
  ).length;

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Agency-wide pulse across clients, agent tasks, and approvals."
        actions={
          <Button asChild>
            <Link href="/workspace">Open workspace</Link>
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active clients"
          value={data.stats.clients}
          icon={Users}
          tone="accent"
        />
        <StatCard
          label="Connected Meta accounts"
          value={data.stats.connectedAccounts}
          icon={Plug}
        />
        <StatCard
          label="Tasks running"
          value={data.stats.activeTasks}
          icon={Bot}
          tone="accent"
        />
        <StatCard
          label="Pending approvals"
          value={data.stats.pendingApprovals}
          icon={ShieldCheck}
          tone={data.stats.pendingApprovals > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Budget approvals"
          value={budgetApprovals}
          icon={Wallet}
          tone={budgetApprovals > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Needs attention"
          value={data.stats.openRecommendations}
          icon={AlertTriangle}
          tone={data.stats.openRecommendations > 0 ? "danger" : "default"}
        />
        <StatCard
          label="Access pending"
          value={data.stats.accessRequestsOpen}
          icon={KeyRound}
          tone="warning"
        />
        <StatCard
          label="Stale access"
          value={Math.max(0, data.stats.accessRequestsOpen > 0 ? 1 : 0)}
          icon={Clock}
          hint="From access request queue"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Recent activity</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/audit">Audit log</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.recentTasks.length === 0 ? (
              <p className="text-sm text-muted">No recent tasks.</p>
            ) : (
              data.recentTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-secondary/30 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{task.title}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-muted">
                      {formatRelative(task.updated_at)}
                    </p>
                  </div>
                  <Badge
                    variant={
                      task.status === "waiting_approval"
                        ? "warning"
                        : task.status === "done"
                          ? "success"
                          : task.status === "error"
                            ? "danger"
                            : "secondary"
                    }
                  >
                    {task.status}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Pending approvals</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/approvals">View queue</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.pendingApprovals.length === 0 ? (
              <p className="text-sm text-muted">No pending approvals.</p>
            ) : (
              data.pendingApprovals.map((approval) => (
                <Link
                  key={approval.id}
                  href="/approvals"
                  className="block rounded-lg border border-border-subtle bg-secondary/30 px-3 py-2.5 transition-colors hover:border-accent/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {humanToolLabel(approval.tool_name)}
                    </p>
                    <Badge variant="warning">pending</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted">
                    {approval.rationale ?? "Execute action awaiting review"}
                  </p>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
