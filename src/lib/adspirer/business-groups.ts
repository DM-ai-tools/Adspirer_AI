import type { ConnectedMetaAccount } from "@/types";
import type { MetaBusinessRelation } from "@/lib/adspirer/provider";

export type MappingFilter = "all" | "mapped" | "unmapped";

export interface BusinessGroup {
  /** Stable key: the business id, or "direct" for accounts reached without one. */
  key: string;
  businessId: string | null;
  name: string;
  /** True when the business name hasn't been synced yet (older rows): a re-sync fills it. */
  nameMissing: boolean;
  accounts: ConnectedMetaAccount[];
  mappedCount: number;
  ownedCount: number;
  clientCount: number;
}

const DIRECT_KEY = "direct";

export function businessRelation(account: ConnectedMetaAccount): MetaBusinessRelation | null {
  const value = account.raw?.business_relation;
  return value === "owned" || value === "client" || value === "personal" ? value : null;
}

/** Accounts under the Business Manager they are reached through; direct-access accounts last. */
export function groupAccountsByBusiness(accounts: ConnectedMetaAccount[]): BusinessGroup[] {
  const groups = new Map<string, BusinessGroup>();
  for (const account of accounts) {
    const businessId = account.business_id?.trim() || null;
    const key = businessId ?? DIRECT_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        businessId,
        name: "",
        nameMissing: false,
        accounts: [],
        mappedCount: 0,
        ownedCount: 0,
        clientCount: 0,
      };
      groups.set(key, group);
    }
    group.accounts.push(account);
    if (account.client_id) group.mappedCount += 1;
    const relation = businessRelation(account);
    if (relation === "owned") group.ownedCount += 1;
    if (relation === "client") group.clientCount += 1;
    if (!group.name && account.business_name?.trim()) group.name = account.business_name.trim();
  }
  for (const group of groups.values()) {
    if (!group.name) {
      group.nameMissing = group.businessId != null;
      group.name = group.businessId ? `Business ${group.businessId}` : "Direct access (no Business Manager)";
    }
    group.accounts.sort((a, b) => a.meta_account_name.localeCompare(b.meta_account_name));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === DIRECT_KEY) return 1;
    if (b.key === DIRECT_KEY) return -1;
    return a.name.localeCompare(b.name);
  });
}

/** Search by account name, account id, business name or mapped client name. */
export function filterMetaAccounts(
  accounts: ConnectedMetaAccount[],
  opts: { query: string; mapping: MappingFilter; clientName: (clientId: string) => string | undefined },
): ConnectedMetaAccount[] {
  const q = opts.query.trim().toLowerCase();
  return accounts.filter((a) => {
    if (opts.mapping === "mapped" && !a.client_id) return false;
    if (opts.mapping === "unmapped" && a.client_id) return false;
    if (!q) return true;
    const haystack = [
      a.meta_account_name,
      a.meta_account_id,
      a.meta_account_id.replace(/^act_/, ""),
      a.business_name ?? "",
      a.business_id ?? "",
      a.client_id ? (opts.clientName(a.client_id) ?? "") : "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}
