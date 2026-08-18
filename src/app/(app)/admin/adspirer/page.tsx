"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { Client, ConnectedMetaAccount } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { ClientStatusBadge } from "@/components/clients/client-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Plug, RefreshCw, UserPlus } from "lucide-react";

type ServiceAccountSummary = {
  id: string;
  label: string;
  is_active: boolean;
  token_expires_at: string | null;
  scopes: string[] | null;
  last_refreshed_at: string | null;
};

export default function AdminAdspirerPage() {
  const { user, clients, refresh } = useApp();
  const [serviceAccount, setServiceAccount] =
    useState<ServiceAccountSummary | null>(null);
  const [accounts, setAccounts] = useState<ConnectedMetaAccount[]>([]);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mapTarget, setMapTarget] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{
        serviceAccount: ServiceAccountSummary | null;
        accounts: ConnectedMetaAccount[];
        apiKeyConfigured?: boolean;
      }>("/api/admin/adspirer/accounts");
      setServiceAccount(data.serviceAccount);
      setAccounts(data.accounts);
      setApiKeyConfigured(Boolean(data.apiKeyConfigured));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function connect() {
    if (apiKeyConfigured) {
      window.open(
        "https://adspirer.ai/connections",
        "_blank",
        "noopener,noreferrer",
      );
      toast.message("Manage Meta connections on Adspirer", {
        description: "Then come back here and click Sync accounts.",
      });
      return;
    }
    try {
      const data = await apiFetch<{ url: string }>(
        "/api/admin/adspirer/connect",
        { method: "POST" },
      );
      window.location.href = data.url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Connect failed");
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const data = await apiFetch<{ count: number }>(
        "/api/admin/adspirer/sync",
        { method: "POST", body: JSON.stringify({}) },
      );
      toast.success(`Synced ${data.count} accounts`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function mapAccount(metaAccountId: string, clientId: string) {
    setBusyId(metaAccountId);
    try {
      await apiFetch("/api/admin/adspirer/map", {
        method: "POST",
        body: JSON.stringify({ metaAccountId, clientId }),
      });
      toast.success("Account mapped");
      await Promise.all([load(), refresh()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Map failed");
    } finally {
      setBusyId(null);
    }
  }

  async function addAsClient(account: ConnectedMetaAccount) {
    // Prefer DB row UUID; Meta act_* ids are looked up via external_account_id.
    const key = account.id || account.meta_account_id;
    setBusyId(key);
    try {
      const data = await apiFetch<{
        client: Client | null;
        account: ConnectedMetaAccount;
      }>("/api/admin/adspirer/map", {
        method: "POST",
        body: JSON.stringify({
          metaAccountId: key,
          createClient: true,
        }),
      });
      toast.success(
        data.client
          ? `Created client “${data.client.name}” — select it under Working on`
          : "Client created and mapped",
      );
      await Promise.all([load(), refresh()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add client");
    } finally {
      setBusyId(null);
    }
  }

  if (user?.profile.role !== "admin") {
    return (
      <EmptyState
        icon={Plug}
        title="Admin only"
        description="Adspirer connection settings require an admin role."
      />
    );
  }

  if (loading) return <LoadingState skeleton />;
  if (error) return <ErrorState description={error} onRetry={() => void load()} />;

  return (
    <div>
      <PageHeader
        title="Adspirer Connection"
        description="Sync Meta ad accounts from Adspirer, then add them as clients to use in Workspace."
        actions={
          <>
            <Button variant="outline" onClick={() => void sync()} disabled={syncing}>
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
              Sync accounts
            </Button>
            <Button onClick={() => void connect()}>
              <Plug className="h-4 w-4" />
              {apiKeyConfigured
                ? "Open Adspirer connections"
                : serviceAccount
                  ? "Reconnect"
                  : "Connect Adspirer"}
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Service account</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted">
          {apiKeyConfigured
            ? "API key configured. Sync pulls Meta accounts you linked at adspirer.ai/connections. Click Add as client so they appear in the Working on dropdown."
            : "Connect OAuth or set ADSPIRER_API_KEY, then sync Meta ad accounts."}
        </CardContent>
      </Card>

      {accounts.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No Meta accounts synced"
          description="Connect Meta on Adspirer, then click Sync accounts."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Meta account</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mapped client</TableHead>
                  <TableHead>Synced</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => {
                  const mapped = clients.find(
                    (c: Client) => c.id === account.client_id,
                  );
                  const busyKey = account.meta_account_id || account.id;
                  const isBusy = busyId === busyKey || busyId === account.id;
                  return (
                    <TableRow key={account.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">
                            {account.meta_account_name}
                          </p>
                          <p className="font-mono text-[11px] text-muted">
                            {account.meta_account_id}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <ClientStatusBadge status={account.access_status} />
                      </TableCell>
                      <TableCell>
                        {mapped ? (
                          <Link
                            href={`/clients/${mapped.id}`}
                            className="text-accent hover:underline"
                          >
                            {mapped.name}
                          </Link>
                        ) : (
                          <span className="text-muted">Not a client yet</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted">
                        {formatRelative(account.last_synced_at)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          {!mapped ? (
                            <Button
                              size="sm"
                              disabled={isBusy}
                              onClick={() => void addAsClient(account)}
                            >
                              <UserPlus className="h-4 w-4" />
                              Add as client
                            </Button>
                          ) : null}
                          {clients.length > 0 ? (
                            <>
                              <Select
                                value={
                                  mapTarget[account.id] ??
                                  account.client_id ??
                                  undefined
                                }
                                onValueChange={(value) =>
                                  setMapTarget((prev) => ({
                                    ...prev,
                                    [account.id]: value,
                                  }))
                                }
                              >
                                <SelectTrigger className="w-[180px]">
                                  <SelectValue placeholder="Map to client" />
                                </SelectTrigger>
                                <SelectContent>
                                  {clients.map((c) => (
                                    <SelectItem key={c.id} value={c.id}>
                                      {c.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isBusy}
                                onClick={() => {
                                  const clientId =
                                    mapTarget[account.id] ?? account.client_id;
                                  if (!clientId) {
                                    toast.error(
                                      "Select a client, then click Map.",
                                    );
                                    return;
                                  }
                                  void mapAccount(busyKey, clientId);
                                }}
                              >
                                Map
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
