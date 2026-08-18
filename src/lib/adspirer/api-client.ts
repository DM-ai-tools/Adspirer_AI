import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/config";
import {
  AdspirerConnectionError,
  ProviderUnavailableError,
} from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

export type AdspirerToolResult = {
  success: true;
  tool: string;
  data: {
    text: string;
    structured?: Record<string, unknown> | null;
    content?: unknown[];
    quota?: {
      used: number;
      limit: number;
      tier: string;
      period_end: string;
    };
  };
};

export type AdspirerToolError = {
  success: false;
  tool: string;
  error: string;
  is_error: true;
  quota?: Record<string, unknown>;
  structured_content?: Record<string, unknown>;
};

/**
 * Adspirer server-side tool client.
 * Uses the REST API (same tools as MCP) with Personal Access Token auth.
 * Docs: https://www.adspirer.com/docs/knowledge-base/security
 * Base: https://api.adspirer.ai/api/v1/tools/{tool}/execute
 */
export class AdspirerApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  static fromConfig(): AdspirerApiClient {
    const config = getConfig();
    const apiKey = config.ADSPIRER_API_KEY?.trim();
    if (!apiKey) {
      throw new ProviderUnavailableError(
        "ADSPIRER_API_KEY is not set. Generate a key at https://adspirer.ai/keys",
        { provider: "AdspirerApiClient" },
      );
    }
    const baseUrl = (
      config.ADSPIRER_API_BASE_URL ?? "https://api.adspirer.ai"
    ).replace(/\/$/, "");
    return new AdspirerApiClient(apiKey, baseUrl);
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown> = {},
    options?: { idempotencyKey?: string },
  ): Promise<AdspirerToolResult["data"]> {
    const url = `${this.baseUrl}/api/v1/tools/${encodeURIComponent(toolName)}/execute`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (options?.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ arguments: args }),
      });
    } catch (error) {
      logger.error("Adspirer API network failure", {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AdspirerConnectionError("Failed to reach Adspirer API", {
        toolName,
      });
    }

    const payload = (await response.json().catch(() => null)) as
      | AdspirerToolResult
      | AdspirerToolError
      | null;

    if (response.status === 401) {
      throw new AdspirerConnectionError(
        "Adspirer API key rejected. Check ADSPIRER_API_KEY or regenerate at https://adspirer.ai/keys",
        { status: 401, toolName },
      );
    }

    if (response.status === 402) {
      throw new ProviderUnavailableError(
        payload && "error" in payload
          ? payload.error
          : "Adspirer monthly tool-call quota exhausted",
        { status: 402, toolName, quota: payload && "quota" in payload ? payload.quota : undefined },
      );
    }

    if (!response.ok || !payload || payload.success === false) {
      const message =
        payload && "error" in payload && payload.error
          ? payload.error
          : `Adspirer tool ${toolName} failed (${response.status})`;
      logger.warn("Adspirer tool error", {
        toolName,
        status: response.status,
        message,
      });
      throw new AdspirerConnectionError(message, {
        status: response.status,
        toolName,
      });
    }

    logger.info("Adspirer tool executed", {
      toolName,
      quotaUsed: payload.data.quota?.used,
      quotaLimit: payload.data.quota?.limit,
    });

    return payload.data;
  }
}

export function newIdempotencyKey(): string {
  return randomUUID();
}
