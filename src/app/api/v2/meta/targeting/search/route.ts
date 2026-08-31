import { GET as baseGET } from "@/app/api/meta/targeting/search/route";
import { runWithWorkspaceContext } from "@/lib/runtime/workspace-context";

export async function GET(request: Request) {
  return runWithWorkspaceContext(
    { version: "v2", backend: "meta_direct" },
    () => baseGET(request),
  );
}

