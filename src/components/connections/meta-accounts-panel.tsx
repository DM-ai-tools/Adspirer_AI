"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { Client, ConnectedMetaAccount } from "@/types";
import { formatRelative } from "@/lib/api-client";
import { getConnectionSources } from "@/lib/adspirer/connection-source";
import {
  businessRelation,
  filterMetaAccounts,
  groupAccountsByBusiness,
  type MappingFilter,
} from "@/lib/adspirer/business-groups";
import { ClientStatusBadge } from "@/components/clients/client-status-badge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import { Building2, ChevronRight, Search, Trash2, UserPlus } from "lucide-react";

/** Above this many accounts, Business Managers start collapsed so the page shows the list of businesses first. */
const EXPAND_ALL_UP_TO = 12;
/** Rows shown per business before "Show all". */
const ROWS_PER_GROUP = 25;

type Props = {
  accounts: ConnectedMetaAccount[];
  clients: Client[];
  busyId: string | null;
  onAddAsClient: (account: ConnectedMetaAccount) => void;
  onMap: (metaAccountId: string, clientId: string) => void;
  onRemove: (account: ConnectedMetaAccount) => void;
  onUseInWorkspace: (client: Client) => void;
};

export function MetaAccountsPanel({
  accounts,
  clients,
  busyId,
  onAddAsClient,
  onMap,
  onRemove,
  onUseInWorkspace,
}: Props) {
  const [query, setQuery] = useState("");
  const [mapping, setMapping] = useState<MappingFilter>("all");
  const [open, setOpen] = useState<Set<string> | "all">(
    accounts.length <= EXPAND_ALL_UP_TO ? "all" : new Set(),
  );
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [mapTarget, setMapTarget] = useState<Record<string, string>>({});

  const clientsById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const allGroups = useMemo(() => groupAccountsByBusiness(accounts), [accounts]);
  const filtered = useMemo(
    () =>
      filterMetaAccounts(accounts, {
        query,
        mapping,
        clientName: (id) => clientsById.get(id)?.name,
      }),
    [accounts, query, mapping, clientsById],
  );
  const groups = useMemo(() => groupAccountsByBusiness(filtered), [filtered]);
  const filtering = query.trim() !== "" || mapping !== "all";
  const mappedTotal = accounts.filter((a) => a.client_id).length;
  const namesMissing = allGroups.some((g) => g.nameMissing);

  const isOpen = (key: string) => filtering || open === "all" || open.has(key);
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev === "all" ? allGroups.map((g) => g.key) : prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Meta ad accounts</CardTitle>
            <p className="mt-1 text-sm text-muted">
              {accounts.length} account{accounts.length === 1 ? "" : "s"} across{" "}
              {allGroups.length} Business Manager{allGroups.length === 1 ? "" : "s"} ·{" "}
              {mappedTotal} mapped to a client
            </p>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setOpen("all")}>
              Expand all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(new Set())}>
              Collapse all
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search account, ID, Business Manager or client"
              className="pl-8"
            />
          </div>
          <Select value={mapping} onValueChange={(v) => setMapping(v as MappingFilter)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              <SelectItem value="unmapped">Not a client yet</SelectItem>
              <SelectItem value="mapped">Mapped</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {namesMissing ? (
          <p className="text-xs text-muted">
            Some Business Manager names haven&apos;t been loaded yet. Sync Facebook again to fill them in.
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {groups.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No accounts match these filters.</p>
        ) : (
          groups.map((group) => {
            const expanded = isOpen(group.key);
            const rows = showAll.has(group.key) ? group.accounts : group.accounts.slice(0, ROWS_PER_GROUP);
            const hidden = group.accounts.length - rows.length;
            return (
              <div key={group.key} className="overflow-hidden rounded-lg border border-border-subtle">
                <button
                  type="button"
                  onClick={() => toggle(group.key)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/40"
                >
                  <ChevronRight
                    className={cn("h-4 w-4 shrink-0 text-muted transition-transform", expanded && "rotate-90")}
                  />
                  <Building2 className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{group.name}</p>
                    {group.businessId ? (
                      <p className="font-mono text-[11px] text-muted">{group.businessId}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {group.ownedCount > 0 ? (
                      <Badge variant="muted" className="text-[10px]">
                        {group.ownedCount} owned
                      </Badge>
                    ) : null}
                    {group.clientCount > 0 ? (
                      <Badge variant="muted" className="text-[10px]">
                        {group.clientCount} client access
                      </Badge>
                    ) : null}
                    <Badge variant="secondary" className="text-[10px]">
                      {group.accounts.length} account{group.accounts.length === 1 ? "" : "s"}
                    </Badge>
                    <Badge variant={group.mappedCount > 0 ? "default" : "muted"} className="text-[10px]">
                      {group.mappedCount} mapped
                    </Badge>
                  </div>
                </button>
                {expanded ? (
                  <div className="border-t border-border-subtle">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Ad account</TableHead>
                          <TableHead>Currency</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Client</TableHead>
                          <TableHead>Synced</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((account) => (
                          <AccountRow
                            key={account.id}
                            account={account}
                            mapped={account.client_id ? clientsById.get(account.client_id) : undefined}
                            clients={clients}
                            busy={busyId === (account.meta_account_id || account.id) || busyId === account.id}
                            target={mapTarget[account.id]}
                            onTarget={(value) => setMapTarget((prev) => ({ ...prev, [account.id]: value }))}
                            onAddAsClient={onAddAsClient}
                            onMap={onMap}
                            onRemove={onRemove}
                            onUseInWorkspace={onUseInWorkspace}
                          />
                        ))}
                      </TableBody>
                    </Table>
                    {hidden > 0 ? (
                      <div className="border-t border-border-subtle px-4 py-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setShowAll((prev) => new Set(prev).add(group.key))}
                        >
                          Show all {group.accounts.length} accounts
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function AccountRow({
  account,
  mapped,
  clients,
  busy,
  target,
  onTarget,
  onAddAsClient,
  onMap,
  onRemove,
  onUseInWorkspace,
}: {
  account: ConnectedMetaAccount;
  mapped: Client | undefined;
  clients: Client[];
  busy: boolean;
  target: string | undefined;
  onTarget: (clientId: string) => void;
  onAddAsClient: (account: ConnectedMetaAccount) => void;
  onMap: (metaAccountId: string, clientId: string) => void;
  onRemove: (account: ConnectedMetaAccount) => void;
  onUseInWorkspace: (client: Client) => void;
}) {
  const busyKey = account.meta_account_id || account.id;
  const relation = businessRelation(account);
  const legacy = getConnectionSources(account).some((s) => s !== "facebook_oauth");
  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">{account.meta_account_name}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted">{account.meta_account_id}</span>
          {relation === "client" ? (
            <Badge variant="muted" className="text-[10px]">Client access</Badge>
          ) : null}
          {legacy ? (
            <Badge variant="secondary" className="text-[10px]">Legacy API</Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs">{account.currency ?? "—"}</TableCell>
      <TableCell>
        <ClientStatusBadge status={account.access_status} />
      </TableCell>
      <TableCell>
        {mapped ? (
          <Link href={`/clients/${mapped.id}`} className="text-accent hover:underline">
            {mapped.name}
          </Link>
        ) : (
          <span className="text-muted">Not a client yet</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs text-muted">
        {formatRelative(account.last_synced_at)}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {mapped ? (
            <Button size="sm" variant="secondary" onClick={() => onUseInWorkspace(mapped)}>
              Use in Workspace
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => onAddAsClient(account)}>
              <UserPlus className="h-4 w-4" />
              Add as client
            </Button>
          )}
          {clients.length > 0 ? (
            <>
              <Select value={target ?? account.client_id ?? undefined} onValueChange={onTarget}>
                <SelectTrigger className="w-[170px]">
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
                disabled={busy}
                onClick={() => {
                  const clientId = target ?? account.client_id;
                  if (!clientId) {
                    toast.error("Select a client, then click Map.");
                    return;
                  }
                  onMap(busyKey, clientId);
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
            disabled={busy}
            title="Remove from connections"
            aria-label={`Remove ${account.meta_account_name}`}
            onClick={() => onRemove(account)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
