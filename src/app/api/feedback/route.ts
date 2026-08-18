import { z } from "zod";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { recordFeedback } from "@/lib/agent/learning";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapMessageRow } from "@/lib/db/live-maps";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const schema = z.object({
  messageId: z.string().min(1),
  rating: z.enum(["up", "down"]),
  comment: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const body = await parseBody(request, schema);
    const config = getConfig();

    let conversationId: string | null = null;
    let clientId: string | null = null;
    let taskId: string | null = null;

    if (config.isDemoMode || !config.hasSupabase) {
      const message = getDemoStore().messages.find((m) => m.id === body.messageId);
      if (!message) throw new Error("Message not found");
      conversationId = message.conversation_id;
      taskId =
        typeof message.metadata?.taskId === "string"
          ? message.metadata.taskId
          : null;
      const conversation = getDemoStore().conversations.find(
        (c) => c.id === conversationId,
      );
      clientId = conversation?.client_id ?? null;
    } else {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const { data: messageRow, error } = await supabase
        .from("messages")
        .select("*")
        .eq("id", body.messageId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!messageRow) throw new Error("Message not found");
      const message = mapMessageRow(messageRow as Record<string, unknown>);
      conversationId = message.conversation_id;
      taskId =
        typeof message.metadata?.taskId === "string"
          ? message.metadata.taskId
          : ((messageRow.task_id as string | null) ?? null);

      const { data: conversation } = await supabase
        .from("conversations")
        .select("client_id")
        .eq("id", conversationId)
        .maybeSingle();
      clientId = (conversation?.client_id as string | undefined) ?? null;
    }

    if (!clientId) throw new Error("Could not resolve client for feedback");
    await assertClientAccess(user.id, clientId);

    const feedback = await recordFeedback({
      clientId,
      userId: user.id,
      rating: body.rating,
      conversationId,
      messageId: body.messageId,
      taskId,
      comment: body.comment ?? null,
    });

    return jsonOk({ feedback }, 201);
  });
}
