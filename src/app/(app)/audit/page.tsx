"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { apiFetch, formatDateTime } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollText } from "lucide-react";

type AuditEvent = {
  id: string;
  at: string;
  type: string;
  client_id: string | null;
  actor_id: string | null;
  summary: string;
  payload: Record<string, unknown>;
};

function AuditInner() {
  const searchParams = useSearchParams();
  const { clients, user } = useApp();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [clientId, setClientId] = useState(
    searchParams.get("clientId") ?? "all",
  );
  const [type, setType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (clientId !== "all") params.set("clientId", clientId);
      if (type.trim()) params.set("type", type.trim());
      params.set("limit", "100");
      const data = await apiFetch<{ events: AuditEvent[] }>(
        `/api/audit?${params.toString()}`,
      );
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function exportCsv() {
    try {
      const params = new URLSearchParams();
      if (clientId !== "all") params.set("clientId", clientId);
      if (type.trim()) params.set("type", type.trim());
      const response = await fetch(`/api/audit/export?${params.toString()}`, {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `adspirer-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  }

  const clientName = (id: string | null) =>
    clients.find((c) => c.id === id)?.name ?? id ?? "—";

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="Immutable trail of tasks, tool calls, and approval decisions."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Client" />
              </SelectTrigger>
              <SelectContent>
                {user?.profile.role === "admin" ? (
                  <SelectItem value="all">All clients</SelectItem>
                ) : null}
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="w-[160px]"
              placeholder="Filter type…"
              value={type}
              onChange={(e) => setType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load();
              }}
            />
            <Button variant="secondary" onClick={() => void load()}>
              Apply
            </Button>
            {user?.profile.role === "admin" ? (
              <Button variant="outline" onClick={() => void exportCsv()}>
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
            ) : null}
          </div>
        }
      />

      {loading ? (
        <LoadingState skeleton />
      ) : error ? (
        <ErrorState description={error} onRetry={() => void load()} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No audit events"
          description="Adjust filters or run workspace actions to generate trail entries."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted">
                      {formatDateTime(event.at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{event.type}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {clientName(event.client_id)}
                    </TableCell>
                    <TableCell className="text-sm text-muted">
                      {event.summary}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AuditInner />
    </Suspense>
  );
}
