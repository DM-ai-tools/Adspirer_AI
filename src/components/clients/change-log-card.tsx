"use client";

import { useEffect, useState } from "react";
import type { ChangeLogEntry, ChangeState } from "@/lib/changes/change-log";
import { apiFetch, formatCents, formatRelative } from "@/lib/api-client";
import { humanToolLabel } from "@/lib/tools/display-labels";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function stateText(state: ChangeState | null, currency: string): string {
  if (!state) return "—";
  if (state.daily_budget_cents !== undefined) {
    return state.daily_budget_cents == null
      ? "no daily budget"
      : `${formatCents(state.daily_budget_cents, currency, { exact: true })}/day`;
  }
  return state.status ? state.status.toLowerCase() : "—";
}

/** Every change applied to Meta for this client, newest first. */
export function ChangeLogCard({ clientId, currency }: { clientId: string; currency: string }) {
  const [changes, setChanges] = useState<ChangeLogEntry[] | null>(null);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Bumped to reload after a rollback.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ changes: ChangeLogEntry[]; people: Record<string, string> }>(`/api/clients/${clientId}/changes`)
      .then((data) => {
        if (cancelled) return;
        setChanges(data.changes);
        setPeople(data.people);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the change log");
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, version]);

  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const rolledBack = new Set((changes ?? []).map((c) => c.rollback_of).filter(Boolean));
  const canRollBack = (c: ChangeLogEntry) =>
    !rolledBack.has(c.id) &&
    ((/^update_(adset|campaign)_budget$/.test(c.tool_name) && c.before?.daily_budget_cents != null) ||
      (/^(pause|resume)_/.test(c.tool_name) && Boolean(c.before?.status)));

  async function rollBack(c: ChangeLogEntry) {
    if (!window.confirm(`Roll back this change? ${stateText(c.after, currency)} goes back to ${stateText(c.before, currency)} in Meta.`)) {
      return;
    }
    setRollingBack(c.id);
    try {
      await apiFetch(`/api/changes/${c.id}/rollback`, { method: "POST" });
      toast.success("Rolled back in Meta");
      setVersion((v) => v + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rollback failed");
    } finally {
      setRollingBack(null);
    }
  }

  const who = (id: string | null) => (id ? (people[id] ?? "someone") : "—");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Change log</CardTitle>
        <p className="text-sm text-muted">Every change applied to Meta, with its before and after. Entries can&apos;t be edited or deleted.</p>
      </CardHeader>
      <CardContent>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {changes === null && !error ? <p className="text-sm text-muted">Loading…</p> : null}
        {changes?.length === 0 ? <p className="text-sm text-muted">No changes have been applied yet.</p> : null}
        <ul className="divide-y divide-border">
          {changes?.map((c) => (
            <li key={c.id} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{humanToolLabel(c.tool_name)}</span>
                {c.rollback_of ? <Badge variant="secondary">Rollback</Badge> : null}
                {rolledBack.has(c.id) ? <Badge variant="secondary">Rolled back</Badge> : null}
                <span className="text-xs text-muted">{formatRelative(c.created_at)}</span>
                {canRollBack(c) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    disabled={rollingBack !== null}
                    onClick={() => void rollBack(c)}
                  >
                    {rollingBack === c.id ? "Rolling back…" : "Roll back"}
                  </Button>
                ) : null}
              </div>
              <p className="text-sm text-foreground/90">
                <span className="font-mono">{stateText(c.before, currency)}</span>
                {" → "}
                <span className="font-mono font-semibold">{stateText(c.after, currency)}</span>
                {c.entity_id ? (
                  <span className="text-xs text-muted">
                    {" "}
                    · {c.entity_type === "adset" ? "ad set" : c.entity_type} {c.entity_id}
                  </span>
                ) : null}
              </p>
              <p className="text-xs text-muted">
                Approved by {who(c.approved_by)} · run by {who(c.executed_by)}
                {c.rationale ? ` · ${c.rationale}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
