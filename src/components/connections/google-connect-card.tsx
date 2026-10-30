"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Client } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { groupGoogleAssets } from "@/lib/google/assets-view";
import type { GoogleAsset, GoogleAssetKind } from "@/lib/google/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MappingFilter } from "@/lib/adspirer/business-groups";
import { Search } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  needsReconnect: boolean;
  connectedAt: string | null;
};

type SyncResult = { ga4: number; ads: number; gsc: number; warnings: string[] };

type PublicAsset = Omit<GoogleAsset, "raw_metadata">;

// Radix Select doesn't allow an empty-string value, so "Not mapped" gets a sentinel.
const NOT_MAPPED = "__not_mapped__";

const SECTIONS: Array<{ kind: GoogleAssetKind; title: string; empty: string }> = [
  { kind: "ga4_property", title: "GA4", empty: "No GA4 properties found yet." },
  { kind: "ads_customer", title: "Google Ads", empty: "No Google Ads accounts found yet." },
  { kind: "gsc_site", title: "Search Console", empty: "No Search Console sites found yet." },
];

const ENV_VARS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
];

type Props = {
  clients: Client[];
  onChanged?: () => void;
};

/** Rows under their parent (GA4 account, Ads manager), keeping the incoming order inside each. */
function groupByParent(rows: PublicAsset[]): Array<{ parent: string | null; assets: PublicAsset[] }> {
  const groups = new Map<string | null, PublicAsset[]>();
  for (const row of rows) {
    const parent = row.parent_name?.trim() || null;
    groups.set(parent, [...(groups.get(parent) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a == null ? 1 : b == null ? -1 : a.localeCompare(b)))
    .map(([parent, assets]) => ({ parent, assets }));
}

/** Admin card: the agency's read-only Google connection and the mapping of its assets to clients. */
export function GoogleConnectCard({ clients, onChanged }: Props) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [assets, setAssets] = useState<PublicAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [mappingId, setMappingId] = useState<string | null>(null);
  const [mapErrors, setMapErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const s = await apiFetch<GoogleStatus>("/api/auth/google/status");
      setStatus(s);
      if (s.connected) {
        const data = await apiFetch<{ assets: PublicAsset[] }>("/api/admin/google/assets");
        setAssets(data.assets);
      } else {
        setAssets([]);
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load Google status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => groupGoogleAssets(assets as GoogleAsset[]), [assets]);
  const [kind, setKind] = useState<GoogleAssetKind>("ga4_property");
  const [query, setQuery] = useState("");
  const [mapping, setMapping] = useState<MappingFilter>("all");
  const clientNames = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);

  const visibleRows = (rows: PublicAsset[]) => {
    const q = query.trim().toLowerCase();
    return rows.filter((a) => {
      if (mapping === "mapped" && !a.mapped_client_id) return false;
      if (mapping === "unmapped" && a.mapped_client_id) return false;
      if (!q) return true;
      return [a.name, a.external_id, a.parent_name ?? "", a.mapped_client_id ? clientNames.get(a.mapped_client_id) ?? "" : ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  };

  async function sync() {
    setSyncing(true);
    try {
      const result = await apiFetch<SyncResult>("/api/admin/google/sync", { method: "POST" });
      const counts = `${result.ga4} GA4, ${result.ads} Google Ads, ${result.gsc} Search Console`;
      if (result.warnings.length > 0) {
        toast.warning(`Synced ${counts}. ${result.warnings.join(" · ")}`);
      } else {
        toast.success(`Synced ${counts}`);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect Google? The Workspace will stop using Google data until you connect again. Asset mappings are kept.",
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      await apiFetch<{ ok: true }>("/api/auth/google/disconnect", { method: "POST" });
      toast.success("Google disconnected");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setDisconnecting(false);
    }
  }

  async function map(asset: PublicAsset, value: string) {
    const clientId = value === NOT_MAPPED ? null : value;
    setMappingId(asset.id);
    setMapErrors((prev) => {
      const next = { ...prev };
      delete next[asset.id];
      return next;
    });
    try {
      await apiFetch<{ asset: PublicAsset }>("/api/admin/google/map", {
        method: "POST",
        body: JSON.stringify({ assetId: asset.id, clientId }),
      });
      // Re-read: mapping an asset replaces the client's previous one of that kind.
      await load();
      onChanged?.();
    } catch (err) {
      setMapErrors((prev) => ({
        ...prev,
        [asset.id]: err instanceof Error ? err.message : "Couldn't map this asset",
      }));
    } finally {
      setMappingId(null);
    }
  }

  const badge = !status
    ? "Checking"
    : !status.configured
      ? "Not configured"
      : status.needsReconnect
        ? "Needs reconnecting"
        : status.connected
          ? "Connected"
          : "Not connected";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Google</CardTitle>
          <p className="mt-1 text-sm text-muted">
            Read-only access to GA4, Google Ads and Search Console. This tool
            never changes anything on Google.
          </p>
        </div>
        <Badge variant={status?.connected && !status.needsReconnect ? "default" : "secondary"}>
          {badge}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted">Loading Google status…</p>
        ) : loadError ? (
          <div className="space-y-2">
            <p className="text-sm text-danger">{loadError}</p>
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : status && !status.configured ? (
          <div className="space-y-2 text-sm">
            <p className="text-muted">
              Google isn&apos;t set up yet. Set these environment variables, then
              add the redirect URI below to your Google OAuth client:
            </p>
            <ul className="list-inside list-disc font-mono text-xs">
              {ENV_VARS.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              Redirect URI path: <span className="font-mono">/api/auth/google/callback</span>
            </p>
          </div>
        ) : status ? (
          <>
            {status.connected ? (
              <p className="text-sm">
                Connected as <span className="font-medium">{status.email ?? "a Google account"}</span>
                {status.connectedAt ? (
                  <span className="text-muted"> · {formatRelative(status.connectedAt)}</span>
                ) : null}
              </p>
            ) : (
              <p className="text-sm text-muted">
                Sign in with the Google account that can see your clients&apos; GA4,
                Google Ads and Search Console.
              </p>
            )}
            {status.needsReconnect ? (
              <p className="text-sm text-danger">
                Google revoked access. Reconnect so the Workspace can read Google data again.
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {!status.connected || status.needsReconnect ? (
                <Button size="sm" asChild>
                  {/* A plain link: the route redirects to Google, so no client-side navigation. */}
                  <a href="/api/auth/google">
                    {status.needsReconnect ? "Reconnect Google" : "Connect Google"}
                  </a>
                </Button>
              ) : null}
              {status.connected ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={syncing || status.needsReconnect}
                    onClick={() => void sync()}
                  >
                    {syncing ? "Syncing…" : "Sync Google assets"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger hover:text-danger"
                    disabled={disconnecting}
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </Button>
                </>
              ) : null}
            </div>

            {status.connected ? (
              <Tabs value={kind} onValueChange={(v) => setKind(v as GoogleAssetKind)}>
                <TabsList>
                  {SECTIONS.map((section) => (
                    <TabsTrigger key={section.kind} value={section.kind}>
                      {section.title}
                      <Badge variant="muted" className="ml-2 text-[10px]">
                        {grouped[section.kind].length}
                      </Badge>
                    </TabsTrigger>
                  ))}
                </TabsList>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[220px] flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search name, ID, account or client"
                      className="pl-8"
                    />
                  </div>
                  <Select value={mapping} onValueChange={(v) => setMapping(v as MappingFilter)}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="unmapped">Not mapped</SelectItem>
                      <SelectItem value="mapped">Mapped</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {SECTIONS.map((section) => {
                  const all = grouped[section.kind];
                  const rows = visibleRows(all);
                  const mappedCount = all.filter((a) => a.mapped_client_id).length;
                  return (
                    <TabsContent key={section.kind} value={section.kind} className="mt-3">
                      <p className="mb-2 text-xs text-muted">
                        {all.length} total · {mappedCount} mapped
                        {rows.length !== all.length ? ` · showing ${rows.length}` : ""}
                      </p>
                      {all.length === 0 ? (
                        <p className="text-xs text-muted">{section.empty}</p>
                      ) : rows.length === 0 ? (
                        <p className="py-4 text-center text-sm text-muted">Nothing matches these filters.</p>
                      ) : (
                        <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-border-subtle">
                          {groupByParent(rows).map(({ parent, assets: groupRows }) => (
                            <div key={parent ?? "__none__"}>
                              {parent ? (
                                <p className="sticky top-0 z-10 border-b border-border-subtle bg-card px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                                  {parent} · {groupRows.length}
                                </p>
                              ) : null}
                              {groupRows.map((asset) => (
                                <div
                                  key={asset.id}
                                  className="border-b border-border-subtle px-3 py-2 last:border-b-0"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-medium">{asset.name}</p>
                                      <p className="font-mono text-[11px] text-muted">{asset.external_id}</p>
                                    </div>
                                    <Select
                                      value={asset.mapped_client_id ?? NOT_MAPPED}
                                      disabled={mappingId === asset.id}
                                      onValueChange={(value) => void map(asset, value)}
                                    >
                                      <SelectTrigger className="w-[200px]">
                                        <SelectValue placeholder="Map to client" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value={NOT_MAPPED}>Not mapped</SelectItem>
                                        {clients.map((c) => (
                                          <SelectItem key={c.id} value={c.id}>
                                            {c.name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  {mapErrors[asset.id] ? (
                                    <p className="mt-1 text-xs text-danger">{mapErrors[asset.id]}</p>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>
                  );
                })}
              </Tabs>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
