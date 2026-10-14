"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BellOff, Check } from "lucide-react";
import { toast } from "sonner";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AlertRow } from "@/lib/monitoring/alert-store";

/**
 * Alerts from scheduled monitoring (daily and hourly). Acknowledge keeps one
 * quiet until it resolves; snooze keeps it quiet for three days. Alerts with
 * a fix link to the draft waiting in Approvals.
 */
export function AlertsPanel({ clientId }: { clientId: string }) {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<{ alerts: AlertRow[] }>(`/api/monitoring/${clientId}/alerts`)
      .then((d) => live && setAlerts(d.alerts))
      .catch(() => live && setAlerts([]));
    return () => {
      live = false;
    };
  }, [clientId]);

  async function act(key: string, action: "acknowledge" | "snooze") {
    setBusy(key);
    try {
      const d = await apiFetch<{ alerts: AlertRow[] }>(`/api/monitoring/${clientId}/alerts`, {
        method: "POST",
        body: JSON.stringify(action === "snooze" ? { key, action, days: 3 } : { key, action }),
      });
      setAlerts(d.alerts);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the alert");
    }
    setBusy(null);
  }

  if (!alerts?.length) return null;
  const now = new Date().toISOString();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Scheduled alerts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {alerts.map((a) => {
          const quiet = Boolean(a.acknowledged_at) || (a.snoozed_until != null && a.snoozed_until > now);
          return (
            <div key={a.key} className="flex flex-wrap items-start gap-3 rounded-lg border border-border-subtle px-3 py-2">
              <Badge variant={a.severity === "critical" ? "danger" : "warning"}>{a.severity === "critical" ? "Critical" : "Warning"}</Badge>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{a.title ?? a.key}</p>
                {a.detail ? <p className="text-xs text-muted">{a.detail}</p> : null}
                <p className="mt-0.5 text-[11px] text-muted">
                  Since {formatRelative(a.first_seen_at)}
                  {a.acknowledged_at ? " · acknowledged" : a.snoozed_until && a.snoozed_until > now ? ` · snoozed until ${a.snoozed_until.slice(0, 10)}` : ""}
                  {a.approval_id ? (
                    <>
                      {" · "}
                      <Link href="/approvals" className="text-accent hover:underline">
                        fix waiting in Approvals
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
              {!quiet ? (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={busy === a.key} onClick={() => act(a.key, "acknowledge")}>
                    <Check className="mr-1 h-3.5 w-3.5" /> Acknowledge
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === a.key} onClick={() => act(a.key, "snooze")}>
                    <BellOff className="mr-1 h-3.5 w-3.5" /> Snooze 3 days
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
