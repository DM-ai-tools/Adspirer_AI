/**
 * Workspace document persistence — upload, list, delete, context load.
 */

import { nanoid } from "nanoid";
import type { WorkspaceDocument } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getObjectStorage } from "@/lib/storage/r2";
import { nowIso } from "@/lib/utils";
import {
  MAX_CONTEXT_CHARS,
  extractDocumentText,
  makeExcerpt,
} from "@/lib/documents/extract-text";

function publicMeta(doc: WorkspaceDocument) {
  return {
    id: doc.id,
    client_id: doc.client_id,
    conversation_id: doc.conversation_id,
    filename: doc.filename,
    mime_type: doc.mime_type,
    size_bytes: doc.size_bytes,
    excerpt: doc.excerpt,
    doc_kind: doc.doc_kind,
    status: doc.status,
    error: doc.error,
    created_at: doc.created_at,
  };
}

export async function uploadWorkspaceDocument(input: {
  clientId: string;
  conversationId?: string | null;
  uploadedBy?: string | null;
  filename: string;
  mimeType?: string;
  buffer: Buffer;
}): Promise<WorkspaceDocument> {
  const extracted = await extractDocumentText({
    filename: input.filename,
    buffer: input.buffer,
    mimeType: input.mimeType,
  });

  const storage = getObjectStorage();
  const storageKey = `workspace-docs/${input.clientId}/${Date.now()}-${nanoid(8)}-${input.filename.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  await storage.put(storageKey, input.buffer, extracted.mimeType);

  const row: WorkspaceDocument = {
    id: crypto.randomUUID(),
    client_id: input.clientId,
    conversation_id: input.conversationId ?? null,
    uploaded_by: input.uploadedBy ?? null,
    filename: input.filename,
    mime_type: extracted.mimeType,
    size_bytes: input.buffer.byteLength,
    storage_key: storageKey,
    extracted_text: extracted.text,
    excerpt: makeExcerpt(extracted.text),
    doc_kind: extracted.kind,
    status: "ready",
    error: null,
    created_at: nowIso(),
  };

  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    getDemoStore().workspaceDocuments.unshift(row);
    return row;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("workspace_documents")
    .insert({
      client_id: row.client_id,
      conversation_id: row.conversation_id,
      uploaded_by: row.uploaded_by,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      storage_key: row.storage_key,
      extracted_text: row.extracted_text,
      excerpt: row.excerpt,
      doc_kind: row.doc_kind,
      status: row.status,
      error: row.error,
    })
    .select("*")
    .single();

  if (error || !data) {
    await storage.delete(storageKey).catch(() => undefined);
    throw new Error(error?.message || "Failed to save document");
  }
  return data as WorkspaceDocument;
}

export async function listWorkspaceDocuments(input: {
  clientId: string;
  conversationId?: string | null;
}): Promise<ReturnType<typeof publicMeta>[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    let rows = getDemoStore().workspaceDocuments.filter(
      (d) => d.client_id === input.clientId,
    );
    if (input.conversationId) {
      // Client library + docs attached to this conversation
      rows = rows.filter(
        (d) =>
          !d.conversation_id || d.conversation_id === input.conversationId,
      );
    }
    return rows
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(publicMeta);
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  let query = supabase
    .from("workspace_documents")
    .select(
      "id, client_id, conversation_id, filename, mime_type, size_bytes, excerpt, doc_kind, status, error, created_at",
    )
    .eq("client_id", input.clientId)
    .order("created_at", { ascending: false });

  if (input.conversationId) {
    query = query.or(
      `conversation_id.is.null,conversation_id.eq.${input.conversationId}`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as ReturnType<typeof publicMeta>[]) ?? [];
}

export async function deleteWorkspaceDocument(input: {
  id: string;
  clientId: string;
}): Promise<void> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.workspaceDocuments.findIndex(
      (d) => d.id === input.id && d.client_id === input.clientId,
    );
    if (idx < 0) throw new Error("Document not found");
    const [removed] = store.workspaceDocuments.splice(idx, 1);
    if (removed?.storage_key) {
      await getObjectStorage().delete(removed.storage_key).catch(() => undefined);
    }
    return;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("workspace_documents")
    .select("id, storage_key")
    .eq("id", input.id)
    .eq("client_id", input.clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Document not found");

  const { error: delErr } = await supabase
    .from("workspace_documents")
    .delete()
    .eq("id", input.id)
    .eq("client_id", input.clientId);
  if (delErr) throw new Error(delErr.message);

  if (data.storage_key) {
    await getObjectStorage().delete(String(data.storage_key)).catch(() => undefined);
  }
}

/**
 * Load documents for LLM context: conversation-pinned first, then newest client docs.
 */
export async function loadDocumentsForContext(input: {
  clientId: string;
  conversationId?: string | null;
}): Promise<WorkspaceDocument[]> {
  const config = getConfig();
  let rows: WorkspaceDocument[] = [];

  if (config.isDemoMode || !config.hasSupabase) {
    rows = getDemoStore().workspaceDocuments.filter(
      (d) => d.client_id === input.clientId && d.status === "ready",
    );
  } else {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("workspace_documents")
      .select("*")
      .eq("client_id", input.clientId)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    rows = (data as WorkspaceDocument[]) ?? [];
  }

  const convId = input.conversationId ?? null;
  const pinned = convId
    ? rows.filter((d) => d.conversation_id === convId)
    : [];
  const rest = rows.filter((d) => !convId || d.conversation_id !== convId);
  return [...pinned, ...rest];
}

export function formatDocumentsForContext(
  docs: WorkspaceDocument[],
  maxChars = MAX_CONTEXT_CHARS,
): string {
  if (!docs.length) return "- (none uploaded)";

  const blocks: string[] = [];
  let used = 0;
  for (const doc of docs) {
    const header = `- ${doc.filename} · kind=${doc.doc_kind}${
      doc.conversation_id ? " · attached to this chat" : " · client library"
    }`;
    const body = (doc.extracted_text || doc.excerpt || "").trim();
    if (!body) {
      blocks.push(`${header}\n  (no text)`);
      continue;
    }
    const room = maxChars - used - header.length - 8;
    if (room < 200) {
      blocks.push(
        `${header}\n  …[additional documents omitted to fit context budget]`,
      );
      break;
    }
    const slice =
      body.length > room ? `${body.slice(0, room)}\n  …[truncated]` : body;
    blocks.push(`${header}\n${slice}`);
    used += header.length + slice.length;
  }
  return blocks.join("\n\n");
}

export { publicMeta as toDocumentListItem };
