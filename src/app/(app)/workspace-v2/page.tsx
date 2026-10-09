import { redirect } from "next/navigation";

type Search = Record<string, string | string[] | undefined>;

/** Workspace V2 is now the only workspace — keep old links working. */
export default async function WorkspaceV2Redirect({
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
  redirect(qs ? `/workspace?${qs}` : "/workspace");
}
