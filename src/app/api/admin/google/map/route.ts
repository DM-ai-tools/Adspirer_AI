import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAdmin, assertAuthenticated } from "@/lib/authz/assert";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import { mapGoogleAsset, withoutRawMetadata } from "@/lib/google/assets";

const bodySchema = z.object({
  assetId: z.string().min(1),
  /** The client to map onto; null unmaps. */
  clientId: z.string().min(1).nullable(),
});

/** Maps a Google asset to a client, replacing that client's asset of the same kind. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const body = await parseBody(request, bodySchema);
    const asset = await mapGoogleAsset(body.assetId, body.clientId);
    return jsonOk({ asset: withoutRawMetadata(asset) });
  });
}
