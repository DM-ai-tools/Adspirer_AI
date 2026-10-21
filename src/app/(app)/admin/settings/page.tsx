"use client";

import { useEffect, useState } from "react";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api-client";
import type { RuntimeSettings } from "@/app/api/admin/runtime/route";
import { Settings } from "lucide-react";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

/** 72 hours reads as "72h"; whole days as "3d" only when asked for in days. */
const hours = (h: number) => `${h}h`;

export default function AdminSettingsPage() {
  const { user } = useApp();
  const isAdmin = user?.profile.role === "admin";
  const [runtime, setRuntime] = useState<RuntimeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    apiFetch<RuntimeSettings>("/api/admin/runtime")
      .then((data) => {
        if (!cancelled) setRuntime(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load settings");
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <EmptyState
        icon={Settings}
        title="Admin only"
        description="Workspace settings require an admin role."
      />
    );
  }

  const loading = runtime === null && error === null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Settings"
        description="Environment and policy defaults for this CampaignForge workspace."
      />

      {error ? <p className="mb-4 text-sm text-danger">{error}</p> : null}

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Runtime</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Demo mode</p>
                <p className="text-xs text-muted">
                  Seeded clients and mock Meta provider
                </p>
                {runtime?.demoReason === "no_supabase" ? (
                  <p className="mt-1 text-xs text-muted">
                    On because Supabase isn&apos;t configured on this deployment.
                  </p>
                ) : null}
              </div>
              {loading ? (
                <Badge variant="secondary">…</Badge>
              ) : runtime ? (
                <Badge variant={runtime.demoMode ? "warning" : "secondary"}>{runtime.demoMode ? "ON" : "OFF"}</Badge>
              ) : null}
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Ads execution mode</p>
                <p className="text-xs text-muted">
                  mock · sandbox · production
                </p>
              </div>
              {loading ? (
                <Badge variant="secondary">…</Badge>
              ) : runtime ? (
                <Badge variant="secondary" className="font-mono">
                  {runtime.adsExecutionMode}
                </Badge>
              ) : null}
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="approvals">Require approval for executes</Label>
                <p className="text-xs text-muted">
                  Always enforced by tool safety policy
                </p>
              </div>
              <Switch id="approvals" checked disabled />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Defaults</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-lg border border-border-subtle bg-secondary/30 p-3">
              <p className="text-xs text-muted">Approval expiry</p>
              <p className="mt-1 font-mono text-lg">{runtime ? hours(runtime.approvalExpiryHours) : "…"}</p>
            </div>
            <div className="rounded-lg border border-border-subtle bg-secondary/30 p-3">
              <p className="text-xs text-muted">Access stale after</p>
              <p className="mt-1 font-mono text-lg">{runtime ? `${runtime.accessStaleDays}d` : "…"}</p>
            </div>
            <div className="rounded-lg border border-border-subtle bg-secondary/30 p-3 sm:col-span-2">
              <p className="text-xs text-muted">Default budget ceiling</p>
              <p className="mt-1 font-mono text-lg">{runtime ? money(runtime.budgetCeilingCents) : "…"}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
