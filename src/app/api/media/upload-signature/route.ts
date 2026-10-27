import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import { signClientUpload } from "@/lib/media/cloudinary-signature";

const bodySchema = z.object({
  clientId: z.string().min(1),
  resourceType: z.enum(["image", "video"]),
});

/** POST /api/media/upload-signature — signed params for a direct Cloudinary upload. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const body = await parseBody(request, bodySchema);
    await assertClientAccess(user.id, body.clientId);
    return jsonOk({ upload: signClientUpload(body) });
  });
}
