import { Suspense } from "react";
import { redirect } from "next/navigation";
import { LoadingState } from "@/components/shared/loading-state";
import { WorkspaceClient } from "./workspace-client";

type Search = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  if (first(params.workspace) === "v2") {
    const next = new URLSearchParams();
    const clientId = first(params.clientId);
    const conversationId = first(params.conversationId);
    if (clientId) next.set("clientId", clientId);
    if (conversationId) next.set("conversationId", conversationId);
    const qs = next.toString();
    redirect(qs ? `/workspace-v2?${qs}` : "/workspace-v2");
  }

  return (
    <Suspense fallback={<LoadingState label="Loading workspace…" />}>
      <WorkspaceClient workspaceVersion="v1" />
    </Suspense>
  );
}
