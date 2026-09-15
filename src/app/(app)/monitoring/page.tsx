"use client";

import { useEffect, useState } from "react";
import type { MonitoringFinding, Recommendation } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Activity } from "lucide-react";
import { humanRecommendationStatus } from "@/lib/tools/display-labels";

type AccountUpdate = {
  id: string;
  at: string;
  kind: "optimization" | "recommendation" | "task";
  title: string;
  detail: string;
  status: string;
};

export default function MonitoringPage() {
  const { clients, selectedClientId, setSelectedClientId } = useApp();
  const clientId = selectedClientId;
  const [findings, setFindings] = useState<MonitoringFinding[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [accountUpdates, setAccountUpdates] = useState<AccountUpdate[]>([]);
  const [optimizations, setOptimizations] = useState<AccountUpdate[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(cid: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{
        findings: MonitoringFinding[];
        recommendations: Recommendation[];
        accountUpdates?: AccountUpdate[];
        optimizations?: AccountUpdate[];
        summary: string;
      }>(`/api/monitoring/${cid}`);
      setFindings(data.findings);
      setRecommendations(data.recommendations);
      setAccountUpdates(data.accountUpdates ?? []);
      setOptimizations(data.optimizations ?? []);
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load monitoring");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (clientId) void load(clientId);
  }, [clientId]);

  return (
    <div>
      <PageHeader
        title="Monitoring"
        description="Track what changed on each account — findings, recommendations, and optimizations applied."
        actions={
          <Select
            value={clientId ?? undefined}
            onValueChange={setSelectedClientId}
          >
            <SelectTrigger className="w-[240px]">
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
        }
      />

      {!clientId ? (
        <EmptyState
          icon={Activity}
          title="Select a client"
          description="Choose a client to view account updates and monitoring health."
        />
      ) : loading ? (
        <LoadingState skeleton />
      ) : error ? (
        <ErrorState
          description={error}
          onRetry={() => clientId && void load(clientId)}
        />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted">{summary}</CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account updates</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {accountUpdates.length === 0 ? (
                <p className="text-sm text-muted">
                  No account changes yet. Audits, recommendations, and applied
                  optimizations for this client will show up here.
                </p>
              ) : (
                accountUpdates.slice(0, 25).map((u) => (
                  <div
                    key={u.id}
                    className="rounded-lg border border-border-subtle px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{u.title}</p>
                        <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">
                          {u.kind === "optimization"
                            ? "Optimization"
                            : u.kind === "recommendation"
                              ? "Recommendation"
                              : "Task"}
                        </p>
                      </div>
                      <Badge variant="secondary">{u.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted">{u.detail}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      {formatRelative(u.at)}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Findings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {findings.length === 0 ? (
                  <p className="text-sm text-muted">
                    No metric findings yet. Snapshot comparisons appear here once
                    monitoring runs for this account.
                  </p>
                ) : (
                  findings.map((f, i) => (
                    <div
                      key={`${f.code}-${i}`}
                      className="rounded-lg border border-border-subtle px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{f.title}</p>
                        <Badge
                          variant={
                            f.severity === "critical"
                              ? "danger"
                              : f.severity === "warning"
                                ? "warning"
                                : "secondary"
                          }
                        >
                          {f.severity}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted">{f.detail}</p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Recommendations & optimizations
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {recommendations.length === 0 && optimizations.length === 0 ? (
                  <p className="text-sm text-muted">
                    No recommendations or applied optimizations yet.
                  </p>
                ) : (
                  <>
                    {recommendations.map((r) => (
                      <div
                        key={r.id}
                        className="rounded-lg border border-border-subtle px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium">{r.title}</p>
                          <Badge variant="secondary">
                            {humanRecommendationStatus(r.status)}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted">{r.description}</p>
                        <p className="mt-1 font-mono text-[10px] text-muted">
                          {formatRelative(r.created_at)}
                        </p>
                      </div>
                    ))}
                    {optimizations.map((o) => (
                      <div
                        key={o.id}
                        className="rounded-lg border border-border-subtle px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium">{o.title}</p>
                          <Badge variant="secondary">{o.status}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted">{o.detail}</p>
                        <p className="mt-1 font-mono text-[10px] text-muted">
                          {formatRelative(o.at)}
                        </p>
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
