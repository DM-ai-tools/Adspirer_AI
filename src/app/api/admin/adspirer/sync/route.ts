import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { syncConnectedMetaAccounts } from "@/lib/adspirer/account-sync";
import { jsonOk, withApiHandler } from "@/lib/api/response";

const bodySchema = z.object({
  clientId: z.string().min(1).nullable().optional(),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    let clientId: string | null = null;
    const text = await request.text();
    if (text.trim()) {
      const parsed = bodySchema.parse(JSON.parse(text));
      clientId = parsed.clientId ?? null;
    }

    const result = await syncConnectedMetaAccounts({ clientId });

    return jsonOk({
      count: result.count,
      accounts: result.upserted,
    });
  });
}
