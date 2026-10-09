"use client";

import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Settings } from "lucide-react";

export default function AdminSettingsPage() {
  const { user } = useApp();

  if (user?.profile.role !== "admin") {
    return (
      <EmptyState
        icon={Settings}
        title="Admin only"
        description="Workspace settings require an admin role."
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Settings"
        description="Environment and policy defaults for this Spendsmith workspace."
      />

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
              </div>
              <Badge variant="warning">ON</Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Ads execution mode</p>
                <p className="text-xs text-muted">
                  mock · sandbox · production
                </p>
              </div>
              <Badge variant="secondary" className="font-mono">
                mock
              </Badge>
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
              <p className="mt-1 font-mono text-lg">72h</p>
            </div>
            <div className="rounded-lg border border-border-subtle bg-secondary/30 p-3">
              <p className="text-xs text-muted">Access stale after</p>
              <p className="mt-1 font-mono text-lg">7d</p>
            </div>
            <div className="rounded-lg border border-border-subtle bg-secondary/30 p-3 sm:col-span-2">
              <p className="text-xs text-muted">Default budget ceiling</p>
              <p className="mt-1 font-mono text-lg">$5,000</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
