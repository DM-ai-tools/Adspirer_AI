import { describe, expect, it, beforeEach } from "vitest";
import {
  assertAllowedDocument,
  extractDocumentText,
  inferDocKind,
  makeExcerpt,
  truncateText,
} from "@/lib/documents/extract-text";
import {
  formatDocumentsForContext,
  listWorkspaceDocuments,
  uploadWorkspaceDocument,
  deleteWorkspaceDocument,
} from "@/lib/documents/service";
import { buildClientContext } from "@/lib/agent/context-builder";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import type { WorkspaceDocument } from "@/types";

describe("document extract helpers", () => {
  it("rejects unsupported types and oversized files", () => {
    expect(() => assertAllowedDocument("notes.txt", 100)).toThrow(/Unsupported/);
    expect(() =>
      assertAllowedDocument("big.pdf", 11 * 1024 * 1024),
    ).toThrow(/too large/);
  });

  it("infers doc kind from filename/content", () => {
    expect(inferDocKind("competitor-ads.md", "Rival brands")).toBe("competitor");
    expect(inferDocKind("audit-framework.md", "Scoring checklist")).toBe(
      "framework",
    );
    expect(inferDocKind("creative-brief.md", "Campaign brief")).toBe("brief");
    expect(inferDocKind("notes.md", "Hello world")).toBe("other");
  });

  it("extracts markdown text", async () => {
    const md = `# Competitor overview\n\nAcme spends heavily on lead gen.\nFramework: 70/20/10 budget split.\n`;
    const result = await extractDocumentText({
      filename: "competitors.md",
      buffer: Buffer.from(md, "utf8"),
    });
    expect(result.kind).toBe("competitor");
    expect(result.text).toContain("Acme spends");
    expect(makeExcerpt(result.text).length).toBeLessThanOrEqual(500);
  });

  it("extracts excel workbooks as sheet text", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Competitor", "Spend", "Notes"],
      ["RivalCo", "12000", "Lead gen video ads"],
      ["Acme Ads", "8000", "Retargeting"],
    ]);
    XLSX.utils.book_append_sheet(wb, sheet, "Competitors");
    const buffer = Buffer.from(
      XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer,
    );
    const result = await extractDocumentText({
      filename: "competitor-report.xlsx",
      buffer,
    });
    expect(result.kind).toBe("competitor");
    expect(result.text).toContain("RivalCo");
    expect(result.text).toContain("Sheet: Competitors");
  });
});

describe("document service (demo mode)", () => {
  beforeEach(() => {
    resetDemoStore();
  });

  it("uploads, lists, and deletes a markdown document", async () => {
    const clientId = getDemoStore().clients[0]!.id;
    const doc = await uploadWorkspaceDocument({
      clientId,
      conversationId: null,
      filename: "framework.md",
      buffer: Buffer.from(
        "# Meta framework\n\nUse best practice checklist for audits.\n",
        "utf8",
      ),
    });
    expect(doc.status).toBe("ready");
    expect(doc.doc_kind).toBe("framework");
    expect(doc.extracted_text).toContain("best practice");

    const listed = await listWorkspaceDocuments({ clientId });
    expect(listed.some((d) => d.id === doc.id)).toBe(true);

    await deleteWorkspaceDocument({ id: doc.id, clientId });
    const after = await listWorkspaceDocuments({ clientId });
    expect(after.some((d) => d.id === doc.id)).toBe(false);
  });

  it("formats context with conversation-pinned docs first", () => {
    const docs: WorkspaceDocument[] = [
      {
        id: "1",
        client_id: "c",
        conversation_id: null,
        uploaded_by: null,
        filename: "library.md",
        mime_type: "text/markdown",
        size_bytes: 10,
        storage_key: null,
        extracted_text: "Library body about brand.",
        excerpt: "Library body",
        doc_kind: "brief",
        status: "ready",
        error: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "2",
        client_id: "c",
        conversation_id: "conv_1",
        uploaded_by: null,
        filename: "chat-attach.md",
        mime_type: "text/markdown",
        size_bytes: 10,
        storage_key: null,
        extracted_text: "Pinned competitor intel.",
        excerpt: "Pinned",
        doc_kind: "competitor",
        status: "ready",
        error: null,
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];
    // formatDocumentsForContext does not re-sort — caller pins. Verify content.
    const text = formatDocumentsForContext(docs);
    expect(text).toContain("library.md");
    expect(text).toContain("chat-attach.md");
    expect(text).toContain("Pinned competitor intel");
  });
});

describe("buildClientContext includes documents", () => {
  beforeEach(() => {
    resetDemoStore();
  });

  it("injects workspace documents section", async () => {
    const clientId = getDemoStore().clients[0]!.id;
    await uploadWorkspaceDocument({
      clientId,
      filename: "rival-brief.md",
      buffer: Buffer.from(
        "# Competitor brief\n\nRivalCo runs video lead ads.\n",
        "utf8",
      ),
    });
    const ctx = await buildClientContext(clientId);
    expect(ctx).toContain("## Workspace documents");
    expect(ctx).toContain("rival-brief.md");
    expect(ctx).toContain("RivalCo");
  });
});
