import type { ConnectedMetaAccount } from "@/types";

export type ConnectionSource = "adspirer" | "facebook_oauth";

/** Read connection source badges from account.raw (safe for client components). */
export function getConnectionSources(
  account: ConnectedMetaAccount,
): ConnectionSource[] {
  const raw = account.raw ?? {};
  const sources = Array.isArray(raw.sources)
    ? (raw.sources as string[]).filter(
        (s): s is ConnectionSource =>
          s === "adspirer" || s === "facebook_oauth",
      )
    : [];
  if (sources.length) return [...new Set(sources)];
  const via = raw.synced_via;
  if (via === "facebook_oauth" || via === "adspirer") return [via];
  if (typeof via === "string" && /meta.?graph|facebook/i.test(via)) {
    return ["facebook_oauth"];
  }
  return ["adspirer"];
}
