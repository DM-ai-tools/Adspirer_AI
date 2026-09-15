"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { Client, ConnectedMetaAccount } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { getConnectionSources } from "@/lib/adspirer/connection-source";
import { handleMetaOAuthReturn } from "@/lib/meta/oauth-return";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { ClientStatusBadge } from "@/components/clients/client-status-badge";
import { MetaConnectButton } from "@/components/meta-connect-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Plug, RefreshCw, Trash2, UserPlus } from "lucide-react";

type ServiceAccountSummary = {
  id: string;
  label: string;
  is_active: boolean;
  token_expires_at: string | null;
  scopes: string[] | null;
  last_refreshed_at: string | null;
};

type MetaStatus = {
  connected: boolean;
  metaUserName?: string;
};

function SourceBadges({ account }: { account: ConnectedMetaAccount }) {
  const sources = getConnectionSources(account);
  return (
    <div className="flex flex-wrap gap-1">
      {sources.map((source) => (
        <Badge
          key={source}
          variant={source === "facebook_oauth" ? "default" : "secondary"}
          className="text-[10px]"
        >
          {source === "facebook_oauth" ? "Facebook OAuth" : "Adspirer"}
        </Badge>
      ))}
    </div>
  );
}

export default function ConnectionsPortalPage() {
  const { user, clients, refresh, setSelectedClientId } = useApp();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [serviceAccount, setServiceAccount] =
    useState<ServiceAccountSummary | null>(null);
  const [accounts, setAccounts] = useState<ConnectedMetaAccount[]>([]);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [metaStatus, setMetaStatus] = useState<MetaStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncingAdspirer, setSyncingAdspirer] = useState(false);
  const [disconnectingAdspirer, setDisconnectingAdspirer] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mapTarget, setMapTarget] = useState<Record<string, string>>({});

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const meta = await fetch("/api/auth/meta/status")
        .then((r) => r.json() as Promise<MetaStatus>)
        .catch(() => ({ connected: false }));
      setMetaStatus(meta);

      if (user?.profile.role === "admin") {
        const data = await apiFetch<{
          serviceAccount: ServiceAccountSummary | null;
          accounts: ConnectedMetaAccount[];
          apiKeyConfigured?: boolean;
        }>("/api/admin/adspirer/accounts");
        setServiceAccount(data.serviceAccount);
        setAccounts(data.accounts);
        setApiKeyConfigured(Boolean(data.apiKeyConfigured));
      }
    } catch (err) {
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : "Failed to load");
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [user?.profile.role]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    handleMetaOAuthReturn({
      searchParams,
      pathname,
      replace: (url) => router.replace(url, { scroll: false }),
      toastSuccess: (msg) => toast.success(msg),
      toastError: (msg) => toast.error(msg),
      onConnected: () => {
        void load({ silent: true });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for OAuth return
  }, []);

  const handleMetaChanged = useCallback((s: MetaStatus) => {
    setMetaStatus((prev) =>
      prev.connected === s.connected && prev.metaUserName === s.metaUserName
        ? prev
        : s,
    );
  }, []);

  const handleMetaSynced = useCallback(() => {
    void load({ silent: true });
  }, [load]);

  const adspirerAccounts = useMemo(
    () => accounts.filter((a) => getConnectionSources(a).includes("adspirer")),
    [accounts],
  );
  const facebookAccounts = useMemo(
    () =>
      accounts.filter((a) =>
        getConnectionSources(a).includes("facebook_oauth"),
      ),
    [accounts],
  );

  async function connectAdspirer() {
    if (apiKeyConfigured) {
      window.open(
        "https://adspirer.ai/connections",
        "_blank",
        "noopener,noreferrer",
      );
      toast.message("Manage Meta connections on Adspirer", {
        description: "Then come back here and click Sync Adspirer accounts.",
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

  async function syncAdspirer() {
    setSyncingAdspirer(true);
    try {
      const data = await apiFetch<{ count: number }>(
        "/api/admin/adspirer/sync",
        { method: "POST", body: JSON.stringify({}) },
      );
      toast.success(`Synced ${data.count} Adspirer accounts`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncingAdspirer(false);
    }
  }

  async function disconnectAdspirer() {
    if (
      !window.confirm(
        "Disconnect Adspirer OAuth? Synced Adspirer accounts stay listed until you remove them.",
      )
    ) {
      return;
    }
    setDisconnectingAdspirer(true);
    try {
      await apiFetch("/api/admin/adspirer/disconnect", { method: "POST" });
      toast.success("Adspirer disconnected");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setDisconnectingAdspirer(false);
    }
  }

  async function removeAccount(account: ConnectedMetaAccount) {
    const mapped = clients.find((c: Client) => c.id === account.client_id);
    const label = account.meta_account_name || account.meta_account_id;
    const message = mapped
      ? `Remove "${label}" from connections? Client "${mapped.name}" will stay, but this ad account will no longer be linked.`
      : `Remove "${label}" from connections? You can sync it again later.`;

    if (!window.confirm(message)) return;

    setBusyId(account.id);
    try {
      await apiFetch<{ deleted: boolean }>(
        `/api/admin/adspirer/accounts/${encodeURIComponent(account.id)}`,
        { method: "DELETE" },
      );
      toast.success("Account removed");
      await Promise.all([load(), refresh()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusyId(null);
    }
  }

  async function mapAccount(metaAccountId: string, clientId: string) {
    setBusyId(metaAccountId);
    try {
      await apiFetch("/api/admin/adspirer/map", {
        method: "POST",
        body: JSON.stringify({ metaAccountId, clientId }),
      });
      toast.success("Account mapped — available in Workspace");
      setSelectedClientId(clientId);
      await Promise.all([load(), refresh()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Map failed");
    } finally {
      setBusyId(null);
    }
  }

  async function addAsClient(account: ConnectedMetaAccount) {
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
      if (data.client) {
        setSelectedClientId(data.client.id);
        toast.success(
          `Created client “${data.client.name}” — selected for Workspace`,
        );
      } else {
        toast.success("Client created and mapped");
      }
      await Promise.all([load(), refresh()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add client");
    } finally {
      setBusyId(null);
    }
  }

  const isAdmin = user?.profile.role === "admin";

  if (!isAdmin) {
    return (
      <div>
        <PageHeader
          title="Connections"
          description="Connect Facebook for Workspace V2. Adspirer sync is admin-only."
        />
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Facebook (Workspace V2)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted">
              Sign in with Facebook so Workspace V2 can access your Meta ad
              accounts. Ask an admin to map synced accounts to a client for chat
              context.
            </p>
            <MetaConnectButton
              variant="card"
              returnTo="/admin/adspirer"
              onChanged={handleMetaChanged}
              onSynced={handleMetaSynced}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) return <LoadingState skeleton />;
  if (error) {
    return <ErrorState description={error} onRetry={() => void load()} />;
  }

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Connect Adspirer and/or Facebook OAuth, sync Meta ad accounts, then map them to clients for Workspace chat."
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Adspirer</CardTitle>
              <p className="mt-1 text-sm text-muted">
                Workspace V1 · Adspirer connection
              </p>
            </div>
            <Badge
              variant={apiKeyConfigured || serviceAccount ? "default" : "secondary"}
            >
              {apiKeyConfigured || serviceAccount ? "Ready" : "Not connected"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted">
              {apiKeyConfigured
                ? "API key configured. Link Meta at adspirer.ai, then sync."
                : "Connect OAuth or configure your Adspirer API key, then sync Meta accounts."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void syncAdspirer()}
                disabled={syncingAdspirer}
              >
                <RefreshCw
                  className={`h-4 w-4 ${syncingAdspirer ? "animate-spin" : ""}`}
                />
                Sync Adspirer accounts
              </Button>
              <Button size="sm" onClick={() => void connectAdspirer()}>
                <Plug className="h-4 w-4" />
                {apiKeyConfigured
                  ? "Open Adspirer"
                  : serviceAccount
                    ? "Reconnect"
                    : "Connect Adspirer"}
              </Button>
              {serviceAccount?.is_active ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disconnectingAdspirer}
                  onClick={() => void disconnectAdspirer()}
                >
                  Disconnect
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted">
              {adspirerAccounts.length} account
              {adspirerAccounts.length === 1 ? "" : "s"} via Adspirer
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Facebook OAuth</CardTitle>
              <p className="mt-1 text-sm text-muted">
                Workspace V2 · Facebook Business connection
              </p>
            </div>
            <Badge variant={metaStatus.connected ? "default" : "secondary"}>
              {metaStatus.connected ? "Connected" : "Not connected"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted">
              Sign in with your Facebook Business account. Synced ad accounts
              can be mapped to clients so V2 chat has the right context.
            </p>
            <MetaConnectButton
              variant="card"
              returnTo="/admin/adspirer"
              onChanged={handleMetaChanged}
              onSynced={handleMetaSynced}
            />
            <p className="text-xs text-muted">
              {facebookAccounts.length} account
              {facebookAccounts.length === 1 ? "" : "s"} via Facebook OAuth
            </p>
          </CardContent>
        </Card>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No Meta accounts yet"
          description="Connect Adspirer or Facebook above, then sync to pull ad accounts."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Connected Meta accounts ({accounts.length})
            </CardTitle>
            <p className="text-sm text-muted">
              Map an account to a client (or Add as client) so Workspace /
              Workspace V2 chat can use it. Source badges show how it was
              synced.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Meta account</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Currency</TableHead>
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
                        <SourceBadges account={account} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {account.currency ?? "—"}
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
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setSelectedClientId(mapped.id);
                                toast.message(`Working on ${mapped.name}`);
                              }}
                            >
                              Use in Workspace
                            </Button>
                          )}
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
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-danger hover:text-danger"
                            disabled={isBusy}
                            onClick={() => void removeAccount(account)}
                          >
                            <Trash2 className="h-4 w-4" />
                            Remove
                          </Button>
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
