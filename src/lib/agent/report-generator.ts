/**
 * Conversation / session reports — structured AuditReport is the source of truth.
 * Markdown for chat display is derived from the same object.
 */
export {
  generateStructuredAuditReport as generateConversationReport,
  type GeneratedStructuredReport as GeneratedReport,
} from "@/lib/report/generate";
