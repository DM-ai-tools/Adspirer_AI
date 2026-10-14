import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

/** Loopback, private, link-local, carrier-grade NAT, multicast and other non-public ranges. */
export function isNonPublicAddress(address: string): boolean {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/**
 * Refuse URLs that would make the server fetch an internal address (cloud
 * metadata, localhost, the private network). Landing-page URLs come from ad
 * creatives and operators, so every fetch and every redirect hop is checked.
 */
export async function assertPublicUrl(url: string, lookup: Lookup = defaultLookup): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https pages can be checked, not ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  for (const { address } of addresses) {
    if (isNonPublicAddress(address)) {
      throw new Error(`${host} resolves to ${address}, which is not a public address.`);
    }
  }
}
