import { getCurrentUser } from "@/lib/security/auth";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    if (!user) {
      const err = new Error("Unauthenticated");
      err.name = "AuthenticationError";
      throw err;
    }
    return jsonOk({
      user: {
        id: user.id,
        email: user.email,
        profile: user.profile,
      },
    });
  });
}
