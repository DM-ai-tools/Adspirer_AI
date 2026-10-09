import type { AccessMethod } from "@/types";
import { getConfig } from "@/lib/config";

export type AccessInstructions = {
  method: AccessMethod;
  subject: string;
  body: string;
  checklist: string[];
};

/**
 * Generate operator/client instructions for granting Meta access.
 */
export function generateAccessInstructions(input: {
  clientName: string;
  method: AccessMethod;
  metaAccountName?: string | null;
  recipientEmail?: string | null;
}): AccessInstructions {
  const config = getConfig();
  const partnerBmId =
    process.env.PARTNER_BM_ID ?? process.env.ADSPIRER_BM_ID ?? "PARTNER_BM_PENDING";

  if (input.method === "business_manager_partner") {
    return {
      method: input.method,
      subject: `Please partner Spendsmith Business Manager for ${input.clientName}`,
      body: [
        `Hi${input.recipientEmail ? "" : " there"},`,
        "",
        `Please grant Spendsmith partner access to the Meta Business Manager for ${input.clientName}${
          input.metaAccountName ? ` (${input.metaAccountName})` : ""
        }.`,
        "",
        "Steps:",
        "1. Open Meta Business Settings → Partners.",
        `2. Add partner Business ID: ${partnerBmId}`,
        "3. Share the ad account(s) with permission: Manage campaigns (Ads).",
        "4. Reply to this email once complete so we can verify access.",
        "",
        `App: ${config.APP_URL}`,
        "",
        "Thank you,",
        "Spendsmith",
      ].join("\n"),
      checklist: [
        "Open Business Settings → Partners",
        `Add partner BM ID ${partnerBmId}`,
        "Share ad account with Manage campaigns",
        "Confirm back to Spendsmith operator",
      ],
    };
  }

  return {
    method: input.method,
    subject: `Please grant Spendsmith direct access for ${input.clientName}`,
    body: [
      `Hi${input.recipientEmail ? "" : " there"},`,
      "",
      `Please grant the Spendsmith service user direct access to the Meta ad account for ${input.clientName}${
        input.metaAccountName ? ` (${input.metaAccountName})` : ""
      }.`,
      "",
      "Steps:",
      "1. Open Meta Business Settings → Ad accounts → Assign people.",
      "2. Invite the Spendsmith operator email provided by your account manager.",
      "3. Permission: Manage campaigns.",
      "4. Reply once access is granted.",
      "",
      `App: ${config.APP_URL}`,
      "",
      "Thank you,",
      "Spendsmith",
    ].join("\n"),
    checklist: [
      "Open Ad accounts → Assign people",
      "Invite Spendsmith service user",
      "Grant Manage campaigns",
      "Confirm back to Spendsmith operator",
    ],
  };
}
