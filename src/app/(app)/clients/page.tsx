"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import type { AccessStatus, Client, ConnectedMetaAccount } from "@/types";
import { apiFetch, formatCents } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { ClientStatusBadge } from "@/components/clients/client-status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Filter = "all" | "connected" | "not_connected" | "needs_attention";

type ClientRow = Client & {
  accessStatus: AccessStatus | "not_connected";
  accountName: string | null;
};

export default function ClientsPage() {
  const { user, clients: appClients, loading: appLoading } = useApp();
  const [clients, setClients] = useState<Client[]>([]);
  const [accounts, setAccounts] = useState<ConnectedMetaAccount[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Prefer shell roster when present to avoid a duplicate round trip.
      if (appClients.length > 0) {
        setClients(appClients);
      } else {
        const clientsRes = await apiFetch<{ clients: Client[] }>("/api/clients");
        setClients(clientsRes.clients);
      }

      if (user?.profile.role === "admin") {
        try {
          const accountsRes = await apiFetch<{
            accounts: ConnectedMetaAccount[];
          }>("/api/admin/adspirer/accounts");
          setAccounts(accountsRes.accounts);
        } catch {
          setAccounts([]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Wait until shell auth resolves so we don't flash "Authentication required".
    if (appLoading) return;
    if (!user) {
      setLoading(false);
      setError("Authentication required");
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appLoading, user?.id, user?.profile.role, appClients.length]);

  const rows: ClientRow[] = useMemo(() => {
    return clients.map((client) => {
      const account = accounts.find((a) => a.client_id === client.id);
      // Operators cannot list Meta accounts; treat assigned roster as connected for filters.
      const fallbackStatus: AccessStatus | "not_connected" =
        user?.profile.role === "admin" ? "not_connected" : "granted";
      return {
        ...client,
        accessStatus: account?.access_status ?? fallbackStatus,
        accountName: account?.meta_account_name ?? null,
      };
    });
  }, [clients, accounts, user?.profile.role]);

  const filtered = rows.filter((row) => {
    const matchesQuery =
      !query ||
      row.name.toLowerCase().includes(query.toLowerCase()) ||
      (row.industry ?? "").toLowerCase().includes(query.toLowerCase());

    if (!matchesQuery) return false;
    if (filter === "all") return true;
    if (filter === "connected") return row.accessStatus === "granted";
    if (filter === "not_connected")
      return row.accessStatus === "not_connected" || row.accessStatus === "not_requested";
    if (filter === "needs_attention")
      return (
        row.accessStatus === "stale" ||
        row.accessStatus === "requested" ||
        row.accessStatus === "revoked"
      );
    return true;
  });

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "connected", label: "Connected" },
    { id: "not_connected", label: "Not connected" },
    { id: "needs_attention", label: "Needs attention" },
  ];

  if (appLoading || loading) return <LoadingState skeleton />;
  if (error) return <ErrorState description={error} onRetry={() => void load()} />;

  return (
    <div>
      <PageHeader
        title="Clients"
        description="Roster of agency accounts and Meta connection health."
        actions={
          user?.profile.role === "admin" ? (
            <Button asChild>
              <Link href="/clients/new">
                <Plus className="h-4 w-4" />
                New client
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                filter === f.id
                  ? "bg-accent-muted text-accent"
                  : "bg-secondary text-muted hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
          <Input
            className="pl-8"
            placeholder="Search clients…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No clients match"
          description="Adjust filters or create a new client."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Budget ceiling</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell>
                      <div>
                        <Link
                          href={`/clients/${client.id}`}
                          className="font-medium hover:text-accent"
                        >
                          {client.name}
                        </Link>
                        <p className="font-mono text-[11px] text-muted">
                          {client.slug}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted">
                      {client.industry ?? "—"}
                    </TableCell>
                    <TableCell>
                      <ClientStatusBadge
                        status={
                          client.accessStatus === "stale" ||
                          client.accessStatus === "requested"
                            ? "needs_attention"
                            : client.accessStatus
                        }
                      />
                      {client.accountName ? (
                        <p className="mt-1 text-[11px] text-muted">
                          {client.accountName}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {formatCents(client.budget_ceiling_cents, client.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {client.accessStatus === "not_connected" ||
                        client.accessStatus === "not_requested" ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link href="/admin/connections">Connect Meta</Link>
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/workspace?clientId=${client.id}`}>
                            Workspace
                          </Link>
                        </Button>
                      </div>
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
