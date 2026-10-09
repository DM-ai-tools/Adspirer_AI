"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/api-client";

export type WorkspaceDocumentListItem = {
  id: string;
  client_id: string;
  conversation_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  excerpt: string | null;
  doc_kind: string;
  status: string;
  error: string | null;
  created_at: string;
};

type DocumentsPanelProps = {
  clientId: string;
  conversationId?: string | null;
  apiBase?: string;
  className?: string;
  /** Called after a successful upload/delete so chat can refresh chips */
  onChanged?: () => void;
};

const ACCEPT =
  ".pdf,.doc,.docx,.xlsx,.xls,.csv,.md,.markdown,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/markdown";

export function DocumentsPanel({
  clientId,
  conversationId,
  apiBase = "/api",
  className,
  onChanged,
}: DocumentsPanelProps) {
  const [docs, setDocs] = useState<WorkspaceDocumentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const apiPath = (path: string) =>
    `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;

  const load = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ clientId });
      if (conversationId) qs.set("conversationId", conversationId);
      const res = await fetch(`${apiPath("/documents")}?${qs}`, {
        credentials: "same-origin",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error?.message ?? "Failed to load documents");
      }
      setDocs(payload?.data?.documents ?? payload?.documents ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, [clientId, conversationId, apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function uploadFile(file: File, attachToChat: boolean) {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("clientId", clientId);
      form.set("file", file);
      if (attachToChat && conversationId) {
        form.set("conversationId", conversationId);
      }
      const res = await fetch(apiPath("/documents/upload"), {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error?.message ?? "Upload failed");
      }
      toast.success(
        payload?.data?.message ??
          payload?.message ??
          `Uploaded ${file.name}`,
      );
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function removeDoc(id: string) {
    setDeletingId(id);
    try {
      const qs = new URLSearchParams({ clientId });
      const res = await fetch(`${apiPath(`/documents/${id}`)}?${qs}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error?.message ?? "Delete failed");
      }
      toast.success("Document removed");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card className={cn("min-h-0", className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
        <CardTitle className="text-sm">Documents</CardTitle>
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadFile(file, Boolean(conversationId));
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 gap-1 text-xs"
            disabled={uploading || !clientId}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-3 pb-3 pt-0">
        <p className="text-[11px] text-muted">
          PDF, Word, Excel, CSV, or Markdown — briefs, brand docs, competitor notes,
          reports. Ask the agent to summarize or generate ads from them.
        </p>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        ) : !docs.length ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
            No documents yet
          </p>
        ) : (
          <ul className="max-h-64 space-y-2 overflow-auto">
            {docs.map((doc) => (
              <li
                key={doc.id}
                className="rounded-md border border-border bg-card px-2.5 py-2"
              >
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{doc.filename}</p>
                    <p className="mt-0.5 text-[10px] text-muted">
                      {doc.doc_kind}
                      {doc.conversation_id ? " · this chat" : " · library"}
                      {" · "}
                      {formatRelative(doc.created_at)}
                    </p>
                    {doc.excerpt ? (
                      <p className="mt-1 line-clamp-2 text-[10px] text-muted">
                        {doc.excerpt}
                      </p>
                    ) : null}
                    {doc.status === "failed" && doc.error ? (
                      <p className="mt-1 text-[10px] text-danger">{doc.error}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    title="Remove"
                    className="rounded p-1 text-muted hover:bg-danger-muted hover:text-danger"
                    disabled={deletingId === doc.id}
                    onClick={() => void removeDoc(doc.id)}
                  >
                    {deletingId === doc.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Compact paperclip control for the chat composer. */
export function ChatDocumentAttachButton({
  clientId,
  conversationId,
  apiBase = "/api",
  disabled,
  onUploaded,
}: {
  clientId?: string;
  conversationId?: string | null;
  apiBase?: string;
  disabled?: boolean;
  onUploaded?: (filename: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  if (!clientId) return null;

  async function upload(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("clientId", clientId!);
      form.set("file", file);
      if (conversationId) form.set("conversationId", conversationId);
      const res = await fetch(`${apiBase}/documents/upload`, {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error?.message ?? "Upload failed");
      }
      toast.success(`Attached ${file.name}`);
      onUploaded?.(file.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-9 w-9 shrink-0 rounded-xl text-muted hover:text-foreground"
        title="Attach PDF, Word, Excel, CSV, or Markdown"
        aria-label="Attach a file"
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Paperclip className="h-4 w-4" />
        )}
      </Button>
    </>
  );
}
