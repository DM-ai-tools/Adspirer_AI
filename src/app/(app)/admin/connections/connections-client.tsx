"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { Client, ConnectedMetaAccount } from "@/types";
import { apiFetch } from "@/lib/api-client";
import { getConnectionSources } from "@/lib/adspirer/connection-source";
import { handleMetaOAuthReturn } from "@/lib/meta/oauth-return";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { MetaConnectButton } from "@/components/meta-connect-button";
import { GoogleConnectCard } from "@/components/connections/google-connect-card";
import { MetaAccountsPanel } from "@/components/connections/meta-accounts-panel";
import { ShopifyConnectCard } from "@/components/connections/shopify-connect-card";
import { googleErrorMessage } from "@/lib/google/assets-view";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plug } from "lucide-react";

type MetaStatus = {
  connected: boolean;
  metaUserName?: string;
};

const TABS = ["meta", "google", "shopify"] as const;
type ConnectionsTab = (typeof TABS)[number];

function initialTab(params: URLSearchParams): ConnectionsTab {
  const asked = params.get("tab");
  if (TABS.includes(asked as ConnectionsTab)) return asked as ConnectionsTab;
  // Returning from Google sign-in lands on the Google tab.
  if (params.has("google_connected") || params.has("google_error")) return "google";
  return "meta";
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
  const [tab, setTab] = useState<ConnectionsTab>(() =>
    initialTab(new URLSearchParams(searchParams.toString())),
  );

  const changeTab = (value: string) => {
    const next = TABS.includes(value as ConnectionsTab) ? (value as ConnectionsTab) : "meta";
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    if (next === "meta") params.delete("tab");
    else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

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

  // ?google_connected= / ?google_error= from the Google OAuth callback: toast once, then strip.
  useEffect(() => {
    const connected = searchParams.get("google_connected") === "1";
    const googleError = searchParams.get("google_error");
    if (!connected && !googleError) return;
    if (connected) {
      const n = Number(searchParams.get("google_assets") ?? "0");
      toast.success(
        n > 0
          ? `Google connected · ${n} asset${n === 1 ? "" : "s"} found`
          : "Google connected",
      );
    } else if (googleError) {
      toast.error(googleErrorMessage(googleError));
    }
    const next = new URLSearchParams(searchParams.toString());
    next.delete("google_connected");
    next.delete("google_assets");
    next.delete("google_error");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
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
        description="Connect Facebook, Google and Shopify, then map each account to a client."
      />

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList>
          <TabsTrigger value="meta">
            Meta
            <Badge variant="muted" className="ml-2 text-[10px]">{accounts.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="google">Google</TabsTrigger>
          <TabsTrigger value="shopify">Shopify</TabsTrigger>
        </TabsList>

        {/* Kept mounted so each tab keeps its loaded data and filters when you switch. */}
        <TabsContent value="meta" forceMount className="space-y-4 data-[state=inactive]:hidden">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Facebook</p>
                  <Badge variant={metaStatus.connected ? "default" : "secondary"}>
                    {metaStatus.connected ? "Connected" : "Not connected"}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {metaStatus.connected && metaStatus.metaUserName
                    ? `Signed in as ${metaStatus.metaUserName} · `
                    : ""}
                  {facebookAccounts.length} ad account{facebookAccounts.length === 1 ? "" : "s"} synced from
                  your Business Managers
                </p>
              </div>
              <MetaConnectButton
                variant="card"
                returnTo="/admin/connections"
                onChanged={handleMetaChanged}
                onSynced={handleMetaSynced}
              />
            </CardContent>
          </Card>

          {accounts.length === 0 ? (
            <EmptyState
              icon={Plug}
              title="No Meta accounts yet"
              description="Connect Facebook above, then sync to pull your ad accounts."
            />
          ) : (
            <MetaAccountsPanel
              accounts={accounts}
              clients={clients}
              busyId={busyId}
              onAddAsClient={(account) => void addAsClient(account)}
              onMap={(metaAccountId, clientId) => void mapAccount(metaAccountId, clientId)}
              onRemove={(account) => void removeAccount(account)}
              onUseInWorkspace={(client) => {
                setSelectedClientId(client.id);
                toast.message(`Working on ${client.name}`);
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="google" forceMount className="data-[state=inactive]:hidden">
          <GoogleConnectCard clients={clients} />
        </TabsContent>

        <TabsContent value="shopify" forceMount className="data-[state=inactive]:hidden">
          <ShopifyConnectCard clients={clients} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
