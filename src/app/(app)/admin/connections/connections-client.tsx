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
import { Plug, Trash2, UserPlus } from "lucide-react";

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
          {source === "facebook_oauth" ? "Facebook" : "Legacy API"}
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
  const [accounts, setAccounts] = useState<ConnectedMetaAccount[]>([]);
  const [metaStatus, setMetaStatus] = useState<MetaStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
          accounts: ConnectedMetaAccount[];
        }>("/api/admin/adspirer/accounts");
        setAccounts(data.accounts);
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

  const facebookAccounts = useMemo(
    () =>
      accounts.filter((a) =>
        getConnectionSources(a).includes("facebook_oauth"),
      ),
    [accounts],
  );

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
          description="Connect Facebook so the Workspace can read and manage your Meta ad accounts."
        />
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Facebook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted">
              Sign in with Facebook so the Workspace can access your Meta ad
              accounts. Ask an admin to map synced accounts to a client for chat
              context.
            </p>
            <MetaConnectButton
              variant="card"
              returnTo="/admin/connections"
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
        description="Connect Facebook, sync your Meta ad accounts, then map each one to a client."
      />

      <div className="mb-6">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Facebook</CardTitle>
              <p className="mt-1 text-sm text-muted">
                Meta Business login used by the Workspace
              </p>
            </div>
            <Badge variant={metaStatus.connected ? "default" : "secondary"}>
              {metaStatus.connected ? "Connected" : "Not connected"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted">
              Sign in with your Facebook Business account. Synced ad accounts
              can be mapped to clients so the Workspace has the right context.
            </p>
            <MetaConnectButton
              variant="card"
              returnTo="/admin/connections"
              onChanged={handleMetaChanged}
              onSynced={handleMetaSynced}
            />
            <p className="text-xs text-muted">
              {facebookAccounts.length} account
              {facebookAccounts.length === 1 ? "" : "s"} via Facebook
            </p>
          </CardContent>
        </Card>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No Meta accounts yet"
          description="Connect Facebook above, then sync to pull your ad accounts."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Connected Meta accounts ({accounts.length})
            </CardTitle>
            <p className="text-sm text-muted">
              Map an account to a client (or Add as client) so the Workspace
              can use it. Source badges show how each account was synced.
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
