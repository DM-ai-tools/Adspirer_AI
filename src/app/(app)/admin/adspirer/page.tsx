import { redirect } from "next/navigation";

type Search = Record<string, string | string[] | undefined>;

/** Old Connections URL — keep bookmarks and OAuth return links working. */
export default async function LegacyConnectionsRedirect({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first != null) next.set(key, first);
  }
  const qs = next.toString();
  redirect(qs ? `/admin/connections?${qs}` : "/admin/connections");
}
