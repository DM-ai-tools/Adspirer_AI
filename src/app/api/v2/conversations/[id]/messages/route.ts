import type { NextRequest } from "next/server";
import {
  GET as getMessages,
  POST as postMessages,
} from "@/app/api/conversations/[id]/messages/route";

type RouteContext = { params: Promise<{ id: string }> };

/** V2 alias — keep pathname under /api/v2 so the agent uses Meta-direct mode. */
export async function GET(request: NextRequest, context: RouteContext) {
  return getMessages(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return postMessages(request, context);
}
