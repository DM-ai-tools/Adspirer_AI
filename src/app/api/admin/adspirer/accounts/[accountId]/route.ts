import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { removeConnectedMetaAccount } from "@/lib/adspirer/remove-connected-account";
import { jsonOk, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  source: z.enum(["adspirer", "facebook_oauth"]).optional(),
});

export async function DELETE(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const { accountId } = await context.params;

    let source: "adspirer" | "facebook_oauth" | undefined;
    const rawBody = await request.text();
    if (rawBody.trim()) {
      const body = bodySchema.parse(JSON.parse(rawBody));
      source = body.source;
    }

    const result = await removeConnectedMetaAccount(accountId, { source });

    return jsonOk(result);
  });
}
