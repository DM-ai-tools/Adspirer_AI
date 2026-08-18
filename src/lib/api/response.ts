import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { isAppError } from "@/lib/errors";

export type ApiSuccessBody<T> = {
  ok: true;
  data: T;
};

export type ApiErrorBody = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function jsonOk<T>(
  data: T,
  init?: number | ResponseInit,
): NextResponse<ApiSuccessBody<T>> {
  const responseInit: ResponseInit =
    typeof init === "number" ? { status: init } : (init ?? {});
  return NextResponse.json({ ok: true, data }, { status: 200, ...responseInit });
}

export function jsonError(
  error: unknown,
  fallbackStatus = 500,
): NextResponse<ApiErrorBody> {
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues,
        },
      },
      { status: 400 },
    );
  }

  if (isAppError(error)) {
    const hint = error.details?.statusHint;
    const status =
      typeof hint === "number" && Number.isFinite(hint)
        ? hint
        : error.statusCode;
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      { status },
    );
  }

  if (error instanceof Error) {
    const message = error.message;
    const lower = message.toLowerCase();
    let status = fallbackStatus;
    if (error.name === "BadRequestError" || lower.includes("invalid json"))
      status = 400;
    else if (lower.includes("not found")) status = 404;
    else if (
      lower.includes("unauthenticated") ||
      lower === "authentication required"
    )
      status = 401;
    else if (lower.includes("cannot ") || lower.includes("invalid")) status = 400;

    return NextResponse.json(
      {
        ok: false,
        error: {
          code: status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR",
          message,
        },
      },
      { status },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error",
      },
    },
    { status: fallbackStatus },
  );
}

/**
 * Parse and validate a JSON request body with a Zod schema.
 */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    const err = new Error("Invalid JSON body");
    err.name = "BadRequestError";
    throw err;
  }
  return schema.parse(raw);
}

/**
 * Wrap a route handler so thrown errors map to typed JSON responses.
 */
export function withApiHandler(
  handler: () => Promise<Response>,
): Promise<Response> {
  return handler().catch((error: unknown) => jsonError(error));
}
