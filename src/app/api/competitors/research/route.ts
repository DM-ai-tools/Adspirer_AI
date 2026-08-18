import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import {
  fetchClientMetaCompetitorAds,
  researchClientService,
} from "@/lib/competitors/service";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const researchSchema = z.object({
  clientId: z.string().min(1),
  serviceId: z.string().min(1),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const body = await parseBody(request, researchSchema);
    await assertClientAccess(user.id, body.clientId);

    const brief = await researchClientService({
      clientId: body.clientId,
      serviceId: body.serviceId,
    });

    return jsonOk(
      {
        brief,
        meta_intel: brief.meta_intel ?? [],
      },
      201,
    );
  });
}

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    const serviceId = url.searchParams.get("serviceId") ?? undefined;
    if (!clientId) throw new Error("clientId is required");
    await assertClientAccess(user.id, clientId);

    const meta_intel = await fetchClientMetaCompetitorAds({
      clientId,
      serviceId,
    });

    return jsonOk({ meta_intel });
  });
}
