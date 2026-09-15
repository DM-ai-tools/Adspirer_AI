import type { AgentToolCallProposal } from "@/lib/agent/adspirer-agent";

/** Operator wants recommendations submitted to the Approvals panel. */
export function wantsQueueApprovals(request: string): boolean {
  const text = request.toLowerCase();
  return (
    /\b(send|queue|submit|put|push|add)\b[\s\S]{0,48}\bapprov/.test(text) ||
    /\bapprov(?:al|als)?\b[\s\S]{0,32}\b(queue|section|panel)\b/.test(text) ||
    /\b(apply|implement|execute|make)\b[\s\S]{0,40}\b(optim|recommend|change|these|those)\b/.test(
      text,
    ) ||
    /\b(don'?t|do not|can'?t|cannot|doesn'?t)\s+see\b[\s\S]{0,48}\bapprov/.test(
      text,
    ) ||
    /\bnothing\b[\s\S]{0,24}\bapprov/.test(text) ||
    /\bsend (?:the |these |those )?(?:optim|change|recommend)/.test(text) ||
    /\bqueue (?:the |these |those )?(?:optim|change|recommend|budget)/.test(text)
  );
}

type StructuredProposal = {
  tool?: string;
  args?: Record<string, unknown>;
  rationale?: string;
};

/** Pull execute tool proposals out of optimize_* structured payloads. */
export function proposalsFromOptimizeStructured(
  structured: Record<string, unknown> | null | undefined,
): AgentToolCallProposal[] {
  if (!structured || typeof structured !== "object") return [];
  const raw = structured.proposals;
  if (!Array.isArray(raw)) return [];

  const out: AgentToolCallProposal[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as StructuredProposal;
    if (!row.tool || !row.args || typeof row.args !== "object") continue;
    const key = `${row.tool}:${JSON.stringify(row.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: row.tool,
      args: row.args,
      rationale:
        typeof row.rationale === "string" ? row.rationale : undefined,
    });
  }
  return out;
}

export function mergeExecuteProposals(
  existing: AgentToolCallProposal[],
  next: AgentToolCallProposal[],
): AgentToolCallProposal[] {
  const seen = new Set(
    existing.map((c) => `${c.name}:${JSON.stringify(c.args)}`),
  );
  const merged = [...existing];
  for (const call of next) {
    const key = `${call.name}:${JSON.stringify(call.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(call);
  }
  return merged;
}
