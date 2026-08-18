"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import type {
  Approval,
  Client,
  CompetitorBrief,
  MonitoringFinding,
  Recommendation,
  Task,
} from "@/types";
import { apiFetch, formatCents, formatRelative } from "@/lib/api-client";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { StatCard } from "@/components/shared/stat-card";
import { ClientStatusBadge } from "@/components/clients/client-status-badge";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const clientId = params.id;
  const initialTab = searchParams.get("tab") ?? "overview";

  const [client, setClient] = useState<Client | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [findings, setFindings] = useState<MonitoringFinding[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [briefs, setBriefs] = useState<CompetitorBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [clientRes, approvalsRes, tasksRes, monitoringRes] =
        await Promise.all([
          apiFetch<{ client: Client }>(`/api/clients/${clientId}`),
          apiFetch<{ approvals: Approval[] }>(
            `/api/approvals?clientId=${clientId}`,
          ),
          apiFetch<{ tasks: Task[] }>(`/api/tasks?clientId=${clientId}`),
          apiFetch<{
            findings: MonitoringFinding[];
            recommendations: Recommendation[];
          }>(`/api/monitoring/${clientId}`),
        ]);

      setClient(clientRes.client);
      setApprovals(approvalsRes.approvals);
      setTasks(tasksRes.tasks);
      setFindings(monitoringRes.findings);
      setRecommendations(monitoringRes.recommendations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load client");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function saveSettings(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!client) return;
    setSaving(true);
    const form = new FormData(e.currentTarget);
    try {
      const data = await apiFetch<{ client: Client }>(
        `/api/clients/${client.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: String(form.get("name") || client.name),
            industry: String(form.get("industry") || "") || null,
            website_url: String(form.get("website_url") || "") || null,
            brand_voice: String(form.get("brand_voice") || "") || null,
            notes: String(form.get("notes") || "") || null,
            budget_ceiling_cents: Math.round(
              Number(form.get("budget") || 0) * 100,
            ),
          }),
        },
      );
      setClient(data.client);
      toast.success("Client updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState skeleton />;
  if (error || !client)
    return <ErrorState description={error ?? undefined} onRetry={() => void load()} />;

  const pending = approvals.filter((a) => a.status === "pending");
  const connected = tasks.length > 0 || pending.length >= 0;

  return (
    <div>
      <PageHeader
        title={client.name}
        description={client.industry ?? client.website_url ?? client.slug}
        actions={
          <>
            <ClientStatusBadge
              status={connected ? "granted" : "not_connected"}
            />
            <Button asChild>
              <Link href={`/workspace?clientId=${client.id}`}>
                Open workspace
              </Link>
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Budget ceiling"
          value={formatCents(client.budget_ceiling_cents, client.currency)}
        />
        <StatCard
          label="Pending approvals"
          value={pending.length}
          tone={pending.length > 0 ? "warning" : "default"}
        />
        <StatCard label="Tasks" value={tasks.length} />
      </div>

      <Tabs defaultValue={initialTab}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
          <TabsTrigger value="competitors">Competitors</TabsTrigger>
          <TabsTrigger value="creatives">Creatives</TabsTrigger>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Brand profile</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 text-sm">
              <div>
                <p className="text-xs text-muted">Voice</p>
                <p>{client.brand_voice ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Audience</p>
                <p>{client.target_audience ?? "—"}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-muted">Value proposition</p>
                <p>{client.value_proposition ?? "—"}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent tasks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {tasks.slice(0, 5).map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between rounded-lg border border-border-subtle px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium">{task.title}</p>
                    <p className="font-mono text-[11px] text-muted">
                      {formatRelative(task.updated_at)}
                    </p>
                  </div>
                  <Badge variant="secondary">{task.status}</Badge>
                </div>
              ))}
              {tasks.length === 0 ? (
                <p className="text-sm text-muted">No tasks yet.</p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="workspace">
          <Card>
            <CardContent className="flex items-center justify-between gap-4 p-6">
              <div>
                <p className="font-medium">AI workspace</p>
                <p className="text-sm text-muted">
                  Chat with the agent scoped to {client.name}.
                </p>
              </div>
              <Button asChild>
                <Link href={`/workspace?clientId=${client.id}`}>Launch</Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="campaigns">
          <Card>
            <CardContent className="p-6 text-sm text-muted">
              Campaign inventory is loaded via diagnose tools in Workspace.
              Run an account audit to surface live (demo) Meta structure.
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="monitoring" className="space-y-3">
          {findings.length === 0 ? (
            <p className="text-sm text-muted">No monitoring findings.</p>
          ) : (
            findings.map((f, idx) => (
              <Card key={`${f.code}-${idx}`}>
                <CardContent className="flex items-start justify-between gap-3 p-4">
                  <div>
                    <p className="text-sm font-medium">{f.title}</p>
                    <p className="mt-1 text-sm text-muted">{f.detail}</p>
                  </div>
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
                </CardContent>
              </Card>
            ))
          )}
          {recommendations.length > 0 ? (
            <div className="space-y-2 pt-2">
              <p className="text-sm font-medium">Recommendations</p>
              {recommendations.map((r) => (
                <Card key={r.id}>
                  <CardContent className="p-4">
                    <p className="text-sm font-medium">{r.title}</p>
                    <p className="mt-1 text-sm text-muted">{r.description}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="competitors">
          <Card>
            <CardContent className="flex items-center justify-between gap-4 p-6">
              <div>
                <p className="font-medium">Competitor intelligence</p>
                <p className="text-sm text-muted">
                  Research briefs for client services.
                </p>
              </div>
              <Button asChild variant="outline">
                <Link href={`/competitors?clientId=${client.id}`}>
                  Open competitors
                </Link>
              </Button>
            </CardContent>
          </Card>
          {briefs.length > 0 ? (
            <pre className="mt-3 text-xs">{JSON.stringify(briefs, null, 2)}</pre>
          ) : null}
        </TabsContent>

        <TabsContent value="creatives">
          <Card>
            <CardContent className="p-6 text-sm text-muted">
              Creative library and fatigue signals will appear here. Use Workspace
              to request creative diagnostics for this client.
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="approvals" className="space-y-3">
          {approvals.length === 0 ? (
            <p className="text-sm text-muted">No approvals for this client.</p>
          ) : (
            approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                clientName={client.name}
                onUpdated={(updated) =>
                  setApprovals((prev) =>
                    prev.map((a) => (a.id === updated.id ? updated : a)),
                  )
                }
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardContent className="flex items-center justify-between gap-4 p-6">
              <div>
                <p className="font-medium">Audit events</p>
                <p className="text-sm text-muted">
                  Filtered audit trail for {client.name}.
                </p>
              </div>
              <Button asChild variant="outline">
                <Link href={`/audit?clientId=${client.id}`}>Open audit log</Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings">
          <Card>
            <CardContent className="p-6">
              <form className="space-y-4" onSubmit={saveSettings}>
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" defaultValue={client.name} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="industry">Industry</Label>
                  <Input
                    id="industry"
                    name="industry"
                    defaultValue={client.industry ?? ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="website_url">Website</Label>
                  <Input
                    id="website_url"
                    name="website_url"
                    defaultValue={client.website_url ?? ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="budget">Budget ceiling (USD)</Label>
                  <Input
                    id="budget"
                    name="budget"
                    type="number"
                    defaultValue={
                      client.budget_ceiling_cents != null
                        ? client.budget_ceiling_cents / 100
                        : ""
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="brand_voice">Brand voice</Label>
                  <Textarea
                    id="brand_voice"
                    name="brand_voice"
                    defaultValue={client.brand_voice ?? ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    name="notes"
                    defaultValue={client.notes ?? ""}
                  />
                </div>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save settings"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
