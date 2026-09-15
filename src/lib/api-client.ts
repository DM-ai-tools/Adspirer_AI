import type { ApiErrorBody, ApiSuccessBody } from "@/lib/api/response";
import { sanitizeClientFacingText } from "@/lib/client-facing";

export class ApiClientError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(sanitizeClientFacingText(message));
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/csv")) {
    return (await response.text()) as T;
  }

  const raw = await response.text();
  let payload: ApiSuccessBody<T> | ApiErrorBody | null = null;
  try {
    payload = raw ? (JSON.parse(raw) as ApiSuccessBody<T> | ApiErrorBody) : null;
  } catch {
    const looksHtml = /^\s*<!DOCTYPE|^\s*<html/i.test(raw);
    throw new ApiClientError(
      looksHtml
        ? `API route not found or returned a page instead of JSON (${response.status}): ${path}`
        : `Invalid JSON from ${path} (${response.status})`,
      response.status === 404 ? "NOT_FOUND" : "INVALID_RESPONSE",
      response.status,
      { preview: raw.slice(0, 120) },
    );
  }

  if (!payload || typeof payload !== "object" || !("ok" in payload)) {
    throw new ApiClientError(
      `Unexpected response from ${path}`,
      "INVALID_RESPONSE",
      response.status,
    );
  }

  if (!payload.ok) {
    throw new ApiClientError(
      payload.error.message,
      payload.error.code,
      response.status,
      payload.error.details,
    );
  }

  return payload.data;
}

export function formatCents(
  cents: number | null | undefined,
  currency = "USD",
): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 14) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
