"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Approval, Conversation, Message, Task } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ChatPanel } from "@/components/ai/chat-panel";
import { ChatHistorySidebar } from "@/components/ai/chat-history-sidebar";
import { TaskProgress } from "@/components/ai/task-progress";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

async function readSse(
  response: Response,
  handlers: {
    onEvent: (event: string, data: unknown) => void;
  },
) {
  if (!response.ok || !response.body) {
    throw new Error(`Stream failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n");
    buffer = chunks.pop() ?? "";

    for (const rawLine of chunks) {
      const line = rawLine.replace(/\r$/, "");
      if (!line) {
        eventName = "message";
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        try {
          handlers.onEvent(eventName, JSON.parse(payload));
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }
}

function WorkspaceInner() {
  const searchParams = useSearchParams();
  const {
    clients,
    selectedClientId,
    setSelectedClientId,
    refresh,
  } = useApp();

  const queryClientId = searchParams.get("clientId");
  const queryConversationId = searchParams.get("conversationId");
  const clientId = queryClientId || selectedClientId;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [sending, setSending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);

  const clientName = useMemo(
    () => clients.find((c) => c.id === clientId)?.name,
    [clients, clientId],
  );

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  const syncUrl = useCallback(
    (nextClientId: string, nextConversationId: string | null) => {
      const url = new URL(window.location.href);
      url.searchParams.set("clientId", nextClientId);
      if (nextConversationId) {
        url.searchParams.set("conversationId", nextConversationId);
      } else {
        url.searchParams.delete("conversationId");
      }
      window.history.replaceState({}, "", url.toString());
    },
    [],
  );

  const loadApprovals = useCallback(async (cid: string, taskId?: string | null) => {
    const { approvals: merged } = await apiFetch<{ approvals: Approval[] }>(
      `/api/approvals?clientId=${cid}&status=pending,edited`,
    );
    if (taskId) {
      const related = merged.filter((a) => a.task_id === taskId);
      setApprovals(related.length ? related : merged);
      return;
    }
    setApprovals(merged);
  }, []);

  const refreshWorkflow = useCallback(async () => {
    if (!clientId || !conversationId) return;
    const msgRes = await apiFetch<{
      conversation: Conversation;
      messages: Message[];
    }>(`/api/conversations/${conversationId}/messages`);
    setMessages(msgRes.messages);
    await loadApprovals(clientId, task?.id);
    if (task?.id) {
      try {
        const taskRes = await apiFetch<{ task: Task }>(`/api/tasks/${task.id}`);
        setTask(taskRes.task);
      } catch {
        // ignore
      }
    }
    await refresh();
  }, [clientId, conversationId, task?.id, loadApprovals, refresh]);

  useEffect(() => {
    if (!clientId || !conversationId) return;
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      void refreshWorkflow();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [clientId, conversationId, refreshWorkflow]);

  const openConversation = useCallback(
    async (cid: string, conversation: Conversation) => {
      setConversationId(conversation.id);
      syncUrl(cid, conversation.id);

      const msgRes = await apiFetch<{
        conversation: Conversation;
        messages: Message[];
      }>(`/api/conversations/${conversation.id}/messages`);
      setMessages(msgRes.messages);

      if (conversation.task_id) {
        try {
          const taskRes = await apiFetch<{ task: Task }>(
            `/api/tasks/${conversation.task_id}`,
          );
          setTask(taskRes.task);
          await loadApprovals(cid, taskRes.task.id);
        } catch {
          setTask(null);
          await loadApprovals(cid);
        }
      } else {
        setTask(null);
        await loadApprovals(cid);
      }
    },
    [loadApprovals, syncUrl],
  );

  const refreshConversationList = useCallback(async (cid: string) => {
    const list = await apiFetch<{ conversations: Conversation[] }>(
      `/api/conversations?clientId=${cid}`,
    );
    const sorted = list.conversations
      .slice()
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
    setConversations(sorted);
    return sorted;
  }, []);

  const createConversation = useCallback(
    async (cid: string, title = "New chat") => {
      const created = await apiFetch<{ conversation: Conversation }>(
        "/api/conversations",
        {
          method: "POST",
          body: JSON.stringify({ clientId: cid, title }),
        },
      );
      setConversations((prev) => [created.conversation, ...prev]);
      await openConversation(cid, created.conversation);
      return created.conversation;
    },
    [openConversation],
  );

  const bootstrapWorkspace = useCallback(
    async (cid: string, preferredConversationId?: string | null) => {
      setBootstrapping(true);
      try {
        const sorted = await refreshConversationList(cid);
        const preferred =
          (preferredConversationId
            ? sorted.find((c) => c.id === preferredConversationId)
            : null) ??
          sorted[0] ??
          null;

        if (preferred) {
          await openConversation(cid, preferred);
        } else {
          await createConversation(cid);
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to open workspace",
        );
      } finally {
        setBootstrapping(false);
      }
    },
    [createConversation, openConversation, refreshConversationList],
  );

  useEffect(() => {
    if (queryClientId && queryClientId !== selectedClientId) {
      setSelectedClientId(queryClientId);
    }
  }, [queryClientId, selectedClientId, setSelectedClientId]);

  useEffect(() => {
    if (!clientId) return;
    void bootstrapWorkspace(clientId, queryConversationId);
    // Only re-bootstrap when the client changes (not every conversation click).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const hasStreamingMessage = useMemo(
    () =>
      messages.some(
        (m) => m.role === "assistant" && m.metadata?.streaming,
      ),
    [messages],
  );

  useEffect(() => {
    if (!conversationId || !clientId) return;

    const taskActive =
      task != null && (task.status === "running" || task.status === "queued");
    if (!taskActive && !hasStreamingMessage && !sending) return;

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const taskId =
          task?.id ??
          (messages
            .map((m) => m.metadata?.taskId)
            .find((id): id is string => typeof id === "string") ??
            null);

        let nextTask = task;
        if (taskId) {
          const taskRes = await apiFetch<{ task: Task }>(
            `/api/tasks/${taskId}`,
          );
          nextTask = taskRes.task;
          if (!cancelled) setTask(nextTask);
        }

        const msgRes = await apiFetch<{
          conversation: Conversation;
          messages: Message[];
        }>(`/api/conversations/${conversationId}/messages`);
        if (cancelled) return;

        setMessages(msgRes.messages);

        if (
          nextTask &&
          (nextTask.status === "running" || nextTask.status === "queued")
        ) {
          if (typeof nextTask.agent_state?.statusLabel === "string") {
            setStatusLabel(nextTask.agent_state.statusLabel);
          }
        } else {
          setSending(false);
          setStatusLabel(null);
        }
      } catch {
        // Transient network errors during a long run should not break the chat.
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    clientId,
    conversationId,
    hasStreamingMessage,
    sending,
    task?.id,
    task?.status,
  ]);

  async function handleNewChat() {
    if (!clientId || sending) return;
    try {
      await createConversation(clientId);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create chat",
      );
    }
  }

  async function handleSelectConversation(id: string) {
    if (!clientId || sending || id === conversationId) return;
    const found = conversations.find((c) => c.id === id);
    if (!found) return;
    try {
      setBootstrapping(true);
      await openConversation(clientId, found);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to open chat",
      );
    } finally {
      setBootstrapping(false);
    }
  }

  async function handleDeleteConversation(id: string) {
    if (!clientId || sending || deletingId) return;
    const label =
      conversations.find((c) => c.id === id)?.title?.trim() || "this chat";
    const confirmed = window.confirm(
      `Delete "${label}" permanently? Messages in this chat will be removed.`,
    );
    if (!confirmed) return;
    setDeletingId(id);
    try {
      await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
      const remaining = conversations.filter((c) => c.id !== id);
      setConversations(remaining);
      if (conversationId === id) {
        setMessages([]);
        setTask(null);
        setApprovals([]);
        if (remaining[0]) {
          await openConversation(clientId, remaining[0]);
        } else {
          await createConversation(clientId);
        }
      }
      toast.success("Chat deleted");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete chat",
      );
    } finally {
      setDeletingId(null);
    }
  }

  async function sendMessage(content: string) {
    if (!conversationId || !clientId) return;

    const optimistic: Message = {
      id: `local_${Date.now()}`,
      conversation_id: conversationId,
      role: "user",
      content,
      tool_call_id: null,
      metadata: null,
      created_at: new Date().toISOString(),
    };
    const streamingId = `stream_${Date.now()}`;
    const streamingMessage: Message = {
      id: streamingId,
      conversation_id: conversationId,
      role: "assistant",
      content: "",
      tool_call_id: null,
      metadata: { streaming: true },
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimistic, streamingMessage]);
    setSending(true);
    setStatusLabel("Starting…");

    // Bump active chat to top of history immediately.
    setConversations((prev) =>
      prev
        .map((c) =>
          c.id === conversationId
            ? { ...c, updated_at: new Date().toISOString() }
            : c,
        )
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        ),
    );

    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/messages?stream=1`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          credentials: "same-origin",
          body: JSON.stringify({ content, runAgent: true }),
        },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          payload?.error?.message ?? `Send failed (${response.status})`,
        );
      }

      let assistantId = streamingId;

      await readSse(response, {
        onEvent: (event, data) => {
          const payload = data as Record<string, unknown>;

          if (event === "conversation") {
            const next = payload.conversation as Conversation;
            setConversations((prev) =>
              prev
                .map((c) => (c.id === next.id ? next : c))
                .sort(
                  (a, b) =>
                    new Date(b.updated_at).getTime() -
                    new Date(a.updated_at).getTime(),
                ),
            );
          }

          if (event === "user_message") {
            const message = payload.message as Message;
            setMessages((prev) =>
              prev.map((m) => (m.id === optimistic.id ? message : m)),
            );
          }

          if (event === "assistant_message") {
            const message = payload.message as Message;
            assistantId = message.id;
            setMessages((prev) =>
              prev.map((m) => (m.id === streamingId ? message : m)),
            );
          }

          if (event === "progress") {
            const nextTask = payload.task as Task | undefined;
            if (nextTask) setTask(nextTask);
            if (typeof payload.label === "string") {
              setStatusLabel(payload.label);
            } else if (
              nextTask &&
              typeof nextTask.agent_state?.statusLabel === "string"
            ) {
              setStatusLabel(nextTask.agent_state.statusLabel);
            }
            const taskUi = nextTask?.agent_state?.ui ?? null;
            // Reflect live gather/write status in the streaming bubble
            if (
              typeof payload.summary === "string" &&
              payload.summary.trim()
            ) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId || m.id === streamingId
                    ? {
                        ...m,
                        content: payload.summary as string,
                        metadata: {
                          ...(m.metadata ?? {}),
                          streaming: true,
                          label: payload.label,
                          phase: payload.phase,
                          ui: taskUi ?? m.metadata?.ui ?? null,
                        },
                      }
                    : m,
                ),
              );
            } else if (typeof payload.label === "string") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId || m.id === streamingId
                    ? !m.content || m.metadata?.liveStatus
                      ? {
                          ...m,
                          content: `_${payload.label}_`,
                          metadata: {
                            ...(m.metadata ?? {}),
                            streaming: true,
                            liveStatus: true,
                            label: payload.label,
                            phase: payload.phase,
                            ui: taskUi ?? m.metadata?.ui ?? null,
                          },
                        }
                      : {
                          ...m,
                          metadata: {
                            ...(m.metadata ?? {}),
                            streaming: true,
                            label: payload.label,
                            phase: payload.phase,
                            ui: taskUi ?? m.metadata?.ui ?? null,
                          },
                        }
                    : m,
                ),
              );
            }
          }

          if (event === "task") {
            const nextTask = payload.task as Task | undefined;
            if (nextTask) setTask(nextTask);
            if (
              nextTask &&
              typeof nextTask.agent_state?.statusLabel === "string"
            ) {
              setStatusLabel(nextTask.agent_state.statusLabel);
            }
          }

          if (event === "delta") {
            const contentText = String(payload.content ?? "");
            const deltaUi = payload.ui ?? null;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId || m.id === streamingId
                  ? {
                      ...m,
                      content: contentText,
                      metadata: {
                        ...(m.metadata ?? {}),
                        streaming: true,
                        liveStatus: false,
                        label: payload.label,
                        phase: payload.phase,
                        ui: deltaUi ?? m.metadata?.ui ?? null,
                      },
                    }
                  : m,
              ),
            );
            if (typeof payload.label === "string") {
              setStatusLabel(payload.label);
            }
          }

          if (event === "done") {
            const nextTask = payload.task as Task;
            const message = payload.message as Message;
            const nextConversation = payload.conversation as
              | Conversation
              | undefined;
            setTask(nextTask);
            if (nextConversation) {
              setConversations((prev) =>
                prev
                  .map((c) =>
                    c.id === nextConversation.id ? nextConversation : c,
                  )
                  .sort(
                    (a, b) =>
                      new Date(b.updated_at).getTime() -
                      new Date(a.updated_at).getTime(),
                  ),
              );
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId || m.id === streamingId ? message : m,
              ),
            );
            setStatusLabel(
              typeof nextTask.agent_state?.statusLabel === "string"
                ? nextTask.agent_state.statusLabel
                : null,
            );
          }

          if (event === "error") {
            const err = String(payload.message ?? "Agent failed");
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId || m.id === streamingId
                  ? {
                      ...m,
                      content: m.content || `Something went wrong: ${err}`,
                      metadata: { streaming: false, status: "error" },
                    }
                  : m,
              ),
            );
            toast.error(err);
          }
        },
      });

      const refreshed = await apiFetch<{
        conversation: Conversation;
        messages: Message[];
      }>(`/api/conversations/${conversationId}/messages`);
      setMessages(refreshed.messages);
      await refreshConversationList(clientId);

      const convTaskId = refreshed.conversation.task_id;
      if (convTaskId) {
        try {
          const taskRes = await apiFetch<{ task: Task }>(
            `/api/tasks/${convTaskId}`,
          );
          setTask(taskRes.task);
          await loadApprovals(clientId, taskRes.task.id);
        } catch {
          await loadApprovals(clientId);
        }
      } else {
        await loadApprovals(clientId);
      }
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Send failed");
      setMessages((prev) =>
        prev.filter((m) => m.id !== optimistic.id && m.id !== streamingId),
      );
    } finally {
      setSending(false);
      setStatusLabel(null);
    }
  }

  return (
    <div className="flex h-[calc(100vh-7.5rem)] min-h-[560px] flex-col">
      <PageHeader
        title="Workspace"
        description="Chat with the Adspirer agent. Diagnose freely; execute actions require approval."
        actions={
          <Select
            value={clientId ?? undefined}
            onValueChange={(value) => {
              setSelectedClientId(value);
              syncUrl(value, null);
            }}
          >
            <SelectTrigger className="w-[240px]">
              <SelectValue placeholder="Select client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {!clientId ? (
        <LoadingState label="Select a client to begin" />
      ) : bootstrapping && !conversationId ? (
        <LoadingState label={`Opening workspace for ${clientName ?? "client"}…`} />
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
          <ChatHistorySidebar
            conversations={conversations}
            activeId={conversationId}
            onSelect={(id) => void handleSelectConversation(id)}
            onNewChat={() => void handleNewChat()}
            onDelete={(id) => void handleDeleteConversation(id)}
            deletingId={deletingId}
            disabled={sending || Boolean(deletingId)}
            className="min-h-0"
          />

          <Card className="flex h-full min-h-0 flex-col overflow-hidden">
            <CardHeader className="shrink-0 border-b border-border py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-sm">
                    {clientName ?? "Client"} ·{" "}
                    {activeConversation?.title?.trim() || "New chat"}
                  </CardTitle>
                  {activeConversation ? (
                    <p className="text-[11px] text-muted">
                      Updated {formatRelative(activeConversation.updated_at)}
                    </p>
                  ) : null}
                </div>
                {conversationId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted hover:bg-danger-muted hover:text-danger"
                    disabled={sending || Boolean(deletingId)}
                    onClick={() => void handleDeleteConversation(conversationId)}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {deletingId === conversationId ? "Deleting…" : "Delete"}
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
              {bootstrapping ? (
                <div className="p-4">
                  <LoadingState label="Loading chat…" />
                </div>
              ) : (
                <ChatPanel
                  messages={messages}
                  onSend={sendMessage}
                  sending={sending}
                  statusLabel={statusLabel}
                  className="h-full min-h-0"
                  clientId={clientId ?? undefined}
                  conversationId={conversationId}
                  taskId={task?.id ?? null}
                  clientName={clientName}
                  inlineApprovals={approvals}
                  onWorkflowRefresh={refreshWorkflow}
                />
              )}
            </CardContent>
          </Card>

          <div className="flex min-h-0 flex-col gap-4 overflow-auto">
            <TaskProgress task={task} />
            {approvals.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Approvals
                </p>
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    clientName={clientName}
                    compact
                    onUpdated={async (updated) => {
                      setApprovals((prev) =>
                        prev
                          .map((a) => (a.id === updated.id ? updated : a))
                          .filter((a) =>
                            ["pending", "edited"].includes(a.status),
                          ),
                      );
                      await refreshWorkflow();
                    }}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="p-4 text-sm text-muted">
                  No pending approvals. Ask the agent to implement a change to
                  queue an execute action.
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function WorkspacePage() {
  return (
    <Suspense fallback={<LoadingState label="Loading workspace…" />}>
      <WorkspaceInner />
    </Suspense>
  );
}
