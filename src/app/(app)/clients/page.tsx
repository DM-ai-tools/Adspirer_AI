"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, Plus, Search } from "lucide-react";
import { toast } from "sonner";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const { user, clients: appClients, loading: appLoading, refresh } = useApp();
  const [clients, setClients] = useState<Client[]>([]);
  const [archived, setArchived] = useState<Client[]>([]);
  const [confirming, setConfirming] = useState<Client | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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
        try {
          const archivedRes = await apiFetch<{ clients: Client[] }>("/api/clients?archived=only");
          setArchived(archivedRes.clients);
        } catch {
          setArchived([]);
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

  async function setArchivedState(client: Client, archive: boolean) {
    setBusyId(client.id);
    try {
      await apiFetch(`/api/clients/${client.id}/archive`, {
        method: "POST",
        body: JSON.stringify({ archived: archive }),
      });
      if (archive) {
        setClients((current) => current.filter((c) => c.id !== client.id));
        setArchived((current) => [{ ...client, archived_at: new Date().toISOString() }, ...current]);
        toast.success(`${client.name} archived. Nothing was deleted; restore it any time from Archived clients.`);
      } else {
        setArchived((current) => current.filter((c) => c.id !== client.id));
        setClients((current) => [{ ...client, archived_at: null }, ...current]);
        toast.success(`${client.name} restored.`);
      }
      setConfirming(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the client");
    } finally {
      setBusyId(null);
    }
  }

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
                        {user?.profile.role === "admin" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted hover:text-danger"
                            onClick={() => setConfirming(client)}
                            aria-label={`Archive ${client.name}`}
                          >
                            <Archive className="h-4 w-4" />
                            Archive
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {user?.profile.role === "admin" && archived.length > 0 ? (
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-semibold">Archived clients ({archived.length})</h2>
          <p className="mb-3 text-xs text-muted">
            Hidden from the client list, workspace and monitoring. Their approvals, creatives,
            documents and chats are kept.
          </p>
          <Card>
            <CardContent className="divide-y divide-border p-0">
              {archived.map((client) => (
                <div key={client.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{client.name}</p>
                    <p className="font-mono text-[11px] text-muted">{client.slug}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === client.id}
                    onClick={() => void setArchivedState(client, false)}
                  >
                    <ArchiveRestore className="h-4 w-4" />
                    Restore
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Dialog open={confirming !== null} onOpenChange={(open) => (open ? null : setConfirming(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {confirming?.name}?</DialogTitle>
            <DialogDescription>
              {confirming?.name} will disappear from the client list, the workspace picker and
              monitoring. Nothing is deleted: approvals, creatives, documents and chats are kept,
              and you can restore the client from Archived clients on this page.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)} disabled={busyId !== null}>
              Cancel
            </Button>
            <Button
              onClick={() => confirming && void setArchivedState(confirming, true)}
              disabled={busyId !== null}
            >
              {busyId ? "Archiving…" : "Archive client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
