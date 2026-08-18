import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";

export type EmailMessage = {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
};

export type EmailSendResult = {
  id: string;
  provider: string;
  status: "sent" | "queued" | "mock";
  sentAt: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class MockEmailProvider implements EmailProvider {
  readonly name = "MockEmailProvider";

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const result: EmailSendResult = {
      id: `mock_email_${Date.now()}`,
      provider: this.name,
      status: "mock",
      sentAt: nowIso(),
    };
    logger.info("Mock email sent", {
      to: message.to,
      subject: message.subject,
      emailId: result.id,
    });
    return result;
  }
}

let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (!provider) {
    // TODO: Add Gmail API provider when OAuth credentials are configured.
    provider = new MockEmailProvider();
  }
  return provider;
}

/**
 * Mark an access request as sent manually (operator sent outside the app).
 */
export async function markSentManually(input: {
  accessRequestId: string;
  markedBy?: string;
}): Promise<void> {
  const config = getConfig();
  const ts = nowIso();

  if (config.isDemoMode || !config.hasSupabase) {
    const req = getDemoStore().clientAccessRequests.find(
      (r) => r.id === input.accessRequestId,
    );
    if (!req) throw new Error(`Access request not found: ${input.accessRequestId}`);
    req.sent_at = ts;
    req.sent_manually = true;
    req.status = req.status === "not_requested" ? "requested" : req.status;
    req.updated_at = ts;
    logger.info("Access request marked sent manually (demo)", {
      accessRequestId: input.accessRequestId,
      markedBy: input.markedBy,
    });
    return;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("client_access_requests")
    .update({
      sent_at: ts,
      sent_manually: true,
      status: "requested",
      updated_at: ts,
    })
    .eq("id", input.accessRequestId);

  if (error) throw new Error(error.message);
}
