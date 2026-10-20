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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type GoogleStatus = {
  configured: boolean;
  adsConfigured: boolean;
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
  { kind: "ga4_property", title: "GA4 properties", empty: "No GA4 properties found yet." },
  { kind: "ads_customer", title: "Google Ads accounts", empty: "No Google Ads accounts found yet." },
  { kind: "gsc_site", title: "Search Console sites", empty: "No Search Console sites found yet." },
];

const ENV_VARS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
];

type Props = {
  clients: Client[];
  onChanged?: () => void;
};

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
            {!status.adsConfigured ? (
              <p className="text-xs text-muted">
                Google Ads accounts won&apos;t sync until GOOGLE_ADS_DEVELOPER_TOKEN is set.
              </p>
            ) : null}

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
              <div className="space-y-4">
                {SECTIONS.map((section) => {
                  const rows = grouped[section.kind];
                  return (
                    <div key={section.kind}>
                      <p className="mb-2 text-sm font-medium">
                        {section.title} ({rows.length})
                      </p>
                      {rows.length === 0 ? (
                        <p className="text-xs text-muted">{section.empty}</p>
                      ) : (
                        <div className="space-y-2">
                          {rows.map((asset) => (
                            <div
                              key={asset.id}
                              className="rounded-lg border border-border-subtle px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium">{asset.name}</p>
                                  <p className="font-mono text-[11px] text-muted">
                                    {asset.external_id}
                                    {asset.parent_name ? ` · ${asset.parent_name}` : ""}
                                  </p>
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
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
