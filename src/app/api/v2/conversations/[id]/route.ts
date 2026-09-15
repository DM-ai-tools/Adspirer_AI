import {
  DELETE as deleteConversation,
} from "@/app/api/conversations/[id]/route";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  return deleteConversation(request, context);
}
