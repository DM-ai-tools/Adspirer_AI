/**
 * Strip vendor / infra names from strings that may reach operators or clients.
 * Raw backend errors sometimes mention Supabase, OpenAI, etc. — never show those.
 */

const VENDOR_PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /\bSupabase Auth\b/gi, replace: "account auth" },
  { pattern: /\bSupabase\b/gi, replace: "the database" },
  { pattern: /\bFirecrawl\b/gi, replace: "website scan" },
  { pattern: /\bOpenAI\b/gi, replace: "image service" },
  { pattern: /\bAnthropic\b/gi, replace: "AI service" },
  { pattern: /\bClaude\b/gi, replace: "AI service" },
  { pattern: /\bGPT Image(?:-\d+)?\b/gi, replace: "image generation" },
  { pattern: /\bgpt-image-\d+\b/gi, replace: "image model" },
  { pattern: /\bTrigger\.dev\b/gi, replace: "background jobs" },
  { pattern: /\bMeta Graph API\b/gi, replace: "Meta Ads API" },
  { pattern: /\bGraph API\b/gi, replace: "Meta Ads API" },
  { pattern: /\bMCP\b/g, replace: "API" },
  { pattern: /\bDEMO_MODE\b/g, replace: "demo mode" },
  { pattern: /\bOPENAI_API_KEY\b/g, replace: "image generation settings" },
  { pattern: /\bADSPIRER_API_KEY\b/g, replace: "Adspirer API key" },
  {
    pattern: /supabase\/migrations\/[^\s,)]+/gi,
    replace: "database setup",
  },
  {
    pattern: /\bprofiles\b(?:\s+table|\s+is missing)?/gi,
    replace: "user profiles",
  },
];

export function sanitizeClientFacingText(input: string): string {
  let out = input;
  for (const { pattern, replace } of VENDOR_PATTERNS) {
    out = out.replace(pattern, replace);
  }
  return out.replace(/\s{2,}/g, " ").trim();
}
