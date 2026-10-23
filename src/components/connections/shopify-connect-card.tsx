"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Client } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ShopifyCounts = {
  collections: number;
  products: number;
  variants: number;
  orders?: number;
  skipped_line_items?: number;
};

type ShopifyStatus = {
  connected: boolean;
  shop_domain: string | null;
  shop_name: string | null;
  currency: string | null;
  last_sync_at: string | null;
  last_sync_status: "never" | "running" | "ok" | "error";
  last_sync_error: string | null;
  counts: ShopifyCounts | null;
};

function describeCounts(c: ShopifyCounts): string {
  return `${c.collections} collections, ${c.products} products, ${c.variants} variants`;
}

function ClientRow({ client }: { client: Client }) {
  const [status, setStatus] = useState<ShopifyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apiFetch<ShopifyStatus>(
        `/api/admin/shopify/status?clientId=${encodeURIComponent(client.id)}`,
      );
      setStatus(s);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load Shopify status");
    } finally {
      setLoading(false);
    }
  }, [client.id]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  function closeForm() {
    setFormOpen(false);
    setAccessToken("");
    setFormError(null);
  }

  async function runSync(): Promise<boolean> {
    setSyncing(true);
    try {
      const counts = await apiFetch<ShopifyCounts>("/api/admin/shopify/sync", {
        method: "POST",
        body: JSON.stringify({ clientId: client.id }),
      });
      toast.success(`Synced ${client.name}: ${describeCounts(counts)}`);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
      return false;
    } finally {
      setSyncing(false);
      await load();
    }
  }

  async function connect() {
    setFormError(null);
    setConnecting(true);
    try {
      await apiFetch<{ shopName: string | null; currency: string | null }>(
        "/api/admin/shopify/connect",
        {
          method: "POST",
          body: JSON.stringify({
            clientId: client.id,
            shopDomain: shopDomain.trim(),
            accessToken: accessToken.trim(),
          }),
        },
      );
    } catch (err) {
      setAccessToken("");
      setFormError(err instanceof Error ? err.message : "Connect failed");
      setConnecting(false);
      return;
    }
    // The token has been sent; drop it from state before anything else runs.
    setAccessToken("");
    setConnecting(false);
    setFormOpen(false);
    setShopDomain("");
    toast.success(`Connected ${client.name}'s Shopify store`);
    await load();
    await runSync();
  }

  async function disconnect() {
    if (
      !window.confirm(
        `Disconnect Shopify for ${client.name}? The stored access token and synced store data will be removed.`,
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      await apiFetch<{ disconnected: boolean }>("/api/admin/shopify/disconnect", {
        method: "POST",
        body: JSON.stringify({ clientId: client.id }),
      });
      toast.success(`Shopify disconnected for ${client.name}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setDisconnecting(false);
    }
  }

  const running = syncing || status?.last_sync_status === "running";

  let badge: { label: string; variant: "default" | "secondary" | "danger" } = {
    label: "Checking",
    variant: "secondary",
  };
  if (status) {
    if (!status.connected) badge = { label: "Not connected", variant: "secondary" };
    else if (running) badge = { label: "Syncing", variant: "secondary" };
    else if (status.last_sync_status === "error") badge = { label: "Error", variant: "danger" };
    else if (status.last_sync_status === "ok" && status.last_sync_at)
      badge = { label: `Synced ${formatRelative(status.last_sync_at)}`, variant: "default" };
    else badge = { label: "Connected, not synced yet", variant: "secondary" };
  }

  const busy = connecting || syncing || disconnecting;

  return (
    <div className="rounded-lg border border-border-subtle px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{client.name}</p>
          {status?.connected ? (
            <p className="font-mono text-[11px] text-muted">
              {status.shop_name ? `${status.shop_name} · ` : ""}
              {status.shop_domain}
            </p>
          ) : null}
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      {loading ? (
        <p className="mt-2 text-xs text-muted">Loading Shopify status…</p>
      ) : loadError ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-xs text-danger">{loadError}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : status ? (
        <div className="mt-2 space-y-2">
          {status.connected && status.last_sync_status === "error" && status.last_sync_error ? (
            <p className="text-xs text-danger">{status.last_sync_error}</p>
          ) : null}
          {status.connected && status.counts ? (
            <p className="text-xs text-muted">{describeCounts(status.counts)}</p>
          ) : null}

          {formOpen ? (
            <form
              className="space-y-2"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              <p className="text-xs text-muted">
                Paste the Admin API access token (starts with{" "}
                <span className="font-mono">shpat_</span>) of an app installed on this store
                with read-only <span className="font-mono">read_products</span>,{" "}
                <span className="font-mono">read_inventory</span> and{" "}
                <span className="font-mono">read_orders</span> access. Apps made in the Dev
                Dashboard may also need protected customer data access approved before
                order data can be read. The token is stored encrypted and never shown again.
              </p>
              <Input
                type="text"
                name="shopify-store-address"
                placeholder="yourstore.myshopify.com"
                aria-label="Store address"
                autoComplete="off"
                spellCheck={false}
                value={shopDomain}
                disabled={connecting}
                onChange={(e) => setShopDomain(e.target.value)}
              />
              <Input
                type="password"
                name="shopify-access-token"
                placeholder="Admin API access token (shpat_…)"
                aria-label="Admin API access token"
                autoComplete="off"
                spellCheck={false}
                value={accessToken}
                disabled={connecting}
                onChange={(e) => setAccessToken(e.target.value)}
              />
              {formError ? <p className="text-xs text-danger">{formError}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  type="submit"
                  disabled={connecting || !shopDomain.trim() || !accessToken.trim()}
                >
                  {connecting ? "Connecting…" : "Connect"}
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  disabled={connecting}
                  onClick={closeForm}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!status.connected ? (
                <Button size="sm" disabled={busy} onClick={() => setFormOpen(true)}>
                  Connect
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void runSync()}
                  >
                    {syncing ? "Syncing…" : "Sync now"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void load()}
                  >
                    Refresh
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setFormOpen(true)}
                  >
                    Reconnect
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger hover:text-danger"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Admin card: each client's read-only Shopify store connection (token paste) and its sync state. */
export function ShopifyConnectCard({ clients }: { clients: Client[] }) {
  return (
    <Card>
      <CardHeader className="space-y-0">
        <CardTitle className="text-base">Shopify</CardTitle>
        <p className="mt-1 text-sm text-muted">
          Read-only access to a client&apos;s products, stock and recent sales so the
          Workspace can use them next to GA4 and Meta. This tool never changes anything
          in Shopify.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {clients.length === 0 ? (
          <p className="text-sm text-muted">Add a client first, then connect their store.</p>
        ) : (
          clients.map((c) => <ClientRow key={c.id} client={c} />)
        )}
      </CardContent>
    </Card>
  );
}
