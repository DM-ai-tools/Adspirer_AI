"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { DocumentsPanel } from "@/components/workspace/documents-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_CHAT_TITLE,
  DEFAULT_V2_CHAT_TITLE,
  displayChatTitle,
  isV2ChatTitle,
} from "@/lib/agent/title-format";
import { MetaConnectButton } from "@/components/meta-connect-button";
import { handleMetaOAuthReturn } from "@/lib/meta/oauth-return";

/**
 * Soft-merge server messages into local state without remounting the whole list.
 * Matches by id or metadata.serverId so optimistic/streaming rows stay stable.
 */
function mergeServerMessages(
  local: Message[],
  server: Message[],
): Message[] {
  if (!server.length) return local;
  if (!local.length) return server;

  const byId = new Map(server.map((m) => [m.id, m]));
  const used = new Set<string>();
  const merged = local.map((m) => {
    const isTemp =
      m.id.startsWith("local_") ||
      m.id.startsWith("stream_") ||
      Boolean(m.metadata?.streaming);
    const serverId =
      typeof m.metadata?.serverId === "string" ? m.metadata.serverId : null;
    const match = byId.get(m.id) ?? (serverId ? byId.get(serverId) : undefined);
    if (!match) return m;
    used.add(match.id);
    // Never clobber an in-flight optimistic / streaming bubble.
    if (isTemp) {
      return {
        ...m,
        metadata: {
          ...(match.metadata ?? {}),
          ...(m.metadata ?? {}),
          serverId: match.id,
          streaming: m.metadata?.streaming ?? false,
        },
      };
    }
    return {
      ...match,
      metadata: {
        ...(match.metadata ?? {}),
        ...(m.metadata ?? {}),
        streaming: false,
      },
    };
  });

  for (const msg of server) {
    if (!used.has(msg.id)) merged.push(msg);
  }
  return merged;
}

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

function WorkspaceInner({
  workspaceVersion,
}: {
  workspaceVersion: "v1" | "v2";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    clients,
    selectedClientId,
    setSelectedClientId,
    refresh,
  } = useApp();

  const queryClientId = searchParams.get("clientId");
  const queryConversationId = searchParams.get("conversationId");
  const workspacePath = workspaceVersion === "v2" ? "/workspace-v2" : "/workspace";
  const apiBase = workspaceVersion === "v2" ? "/api/v2" : "/api";
  const apiPath = useCallback(
    (path: string) => `${apiBase}${path.startsWith("/") ? path : `/${path}`}`,
    [apiBase],
  );
  const clientId = queryClientId || selectedClientId;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [metaAccountStatus, setMetaAccountStatus] = useState<{
    ready: boolean;
    facebookConnected: boolean;
    primaryAccount: {
      meta_account_name: string;
      meta_account_id: string;
    } | null;
    mappedAccounts: Array<{
      meta_account_name: string;
      meta_account_id: string;
      access_status: string;
    }>;
    mappedCount: number;
  } | null>(null);
  const [selectedMetaAccountId, setSelectedMetaAccountId] = useState<
    string | null
  >(null);

  const clientName = useMemo(
    () => clients.find((c) => c.id === clientId)?.name,
    [clients, clientId],
  );

  useEffect(() => {
    if (workspaceVersion !== "v2") return;
    handleMetaOAuthReturn({
      searchParams,
      pathname: workspacePath,
      replace: (url) => router.replace(url, { scroll: false }),
      toastSuccess: (msg) => toast.success(msg),
      toastError: (msg) => toast.error(msg),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- OAuth return once
  }, [workspaceVersion]);

  useEffect(() => {
    if (workspaceVersion !== "v2" || !clientId) {
      setMetaAccountStatus(null);
      setSelectedMetaAccountId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{
          ready: boolean;
          facebookConnected: boolean;
          primaryAccount: {
            meta_account_name: string;
            meta_account_id: string;
          } | null;
          mappedAccounts: Array<{
            meta_account_name: string;
            meta_account_id: string;
            access_status: string;
          }>;
        }>(`/api/v2/clients/${clientId}/meta-account`);
        if (cancelled) return;

        const granted = data.mappedAccounts.filter(
          (a) => a.access_status === "granted",
        );
        const storageKey = `adspirer_selected_meta_account_${clientId}`;
        const saved =
          typeof window !== "undefined"
            ? window.localStorage.getItem(storageKey)
            : null;
        const client = clients.find((c) => c.id === clientId);
        const nameMatch = client
          ? granted.find(
              (a) =>
                a.meta_account_name.trim().toLowerCase() ===
                client.name.trim().toLowerCase(),
            )
          : undefined;

        const nextId =
          (saved && granted.some((a) => a.meta_account_id === saved)
            ? saved
            : null) ??
          nameMatch?.meta_account_id ??
          data.primaryAccount?.meta_account_id ??
          granted[0]?.meta_account_id ??
          null;

        setMetaAccountStatus({
          ready: data.ready,
          facebookConnected: data.facebookConnected,
          primaryAccount: data.primaryAccount,
          mappedAccounts: data.mappedAccounts,
          mappedCount: data.mappedAccounts.length,
        });
        setSelectedMetaAccountId(nextId);
      } catch {
        if (!cancelled) {
          setMetaAccountStatus(null);
          setSelectedMetaAccountId(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceVersion, clientId, clients]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  const syncUrl = useCallback(
    (nextClientId: string, nextConversationId: string | null) => {
      const params = new URLSearchParams();
      params.set("clientId", nextClientId);
      if (nextConversationId) {
        params.set("conversationId", nextConversationId);
      }
      const qs = params.toString();
      router.replace(qs ? `${workspacePath}?${qs}` : workspacePath, {
        scroll: false,
      });
    },
    [router, workspacePath],
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
    // Never wipe the in-flight optimistic/streaming thread on focus.
    if (sendingRef.current) return;
    const activeTaskId = task?.id ?? null;
    const msgRes = await apiFetch<{
      conversation: Conversation;
      messages: Message[];
    }>(apiPath(`/conversations/${conversationId}/messages`));
    setMessages((prev) => mergeServerMessages(prev, msgRes.messages));
    await loadApprovals(clientId, activeTaskId);
    if (activeTaskId) {
      try {
        const taskRes = await apiFetch<{ task: Task }>(
          `/api/tasks/${activeTaskId}`,
        );
        setTask(taskRes.task);
      } catch {
        // ignore
      }
    }
    await refresh();
  }, [clientId, conversationId, task, loadApprovals, refresh, apiPath]);

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
      }>(apiPath(`/conversations/${conversation.id}/messages`));
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
    [loadApprovals, syncUrl, apiPath],
  );

  const refreshConversationList = useCallback(async (cid: string) => {
    const list = await apiFetch<{ conversations: Conversation[] }>(
      apiPath(`/conversations?clientId=${cid}`),
    );
    const sorted = list.conversations
      .slice()
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
    setConversations(sorted);
    return sorted;
  }, [apiPath]);

  const createConversation = useCallback(
    async (cid: string, title = workspaceVersion === "v2" ? DEFAULT_V2_CHAT_TITLE : DEFAULT_CHAT_TITLE) => {
      const created = await apiFetch<{ conversation: Conversation }>(
        apiPath("/conversations"),
        {
          method: "POST",
          body: JSON.stringify({ clientId: cid, title }),
        },
      );
      setConversations((prev) => [created.conversation, ...prev]);
      await openConversation(cid, created.conversation);
      return created.conversation;
    },
    [openConversation, apiPath, workspaceVersion],
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
    setConversationId(null);
    setMessages([]);
    setTask(null);
    setApprovals([]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void bootstrapWorkspace(clientId, queryConversationId);
    // Re-bootstrap when the client or workspace version changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, workspaceVersion]);

  const hasStreamingMessage = useMemo(
    () =>
      messages.some(
        (m) => m.role === "assistant" && m.metadata?.streaming,
      ),
    [messages],
  );

  // Keep latest values for the poller without restarting the interval on every delta.
  const taskRef = useRef(task);
  const messagesRef = useRef(messages);
  useEffect(() => {
    taskRef.current = task;
  }, [task]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!conversationId || !clientId) return;

    const taskActive =
      task != null && (task.status === "running" || task.status === "queued");
    if (!taskActive && !hasStreamingMessage && !sending) return;

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const currentTask = taskRef.current;
        const currentMessages = messagesRef.current;
        const taskId =
          currentTask?.id ??
          (currentMessages
            .map((m) => m.metadata?.taskId)
            .find((id): id is string => typeof id === "string") ??
            null);

        let nextTask = currentTask;
        if (taskId) {
          const taskRes = await apiFetch<{ task: Task }>(
            `/api/tasks/${taskId}`,
          );
          nextTask = taskRes.task;
          if (!cancelled) setTask(nextTask);
        }

        // While SSE is live, only refresh task progress — never wipe the chat.
        if (sendingRef.current) {
          if (
            nextTask &&
            (nextTask.status === "running" || nextTask.status === "queued") &&
            typeof nextTask.agent_state?.statusLabel === "string"
          ) {
            setStatusLabel(nextTask.agent_state.statusLabel);
          }
          return;
        }

        const msgRes = await apiFetch<{
          conversation: Conversation;
          messages: Message[];
        }>(apiPath(`/conversations/${conversationId}/messages`));
        if (cancelled) return;

        setMessages((prev) => mergeServerMessages(prev, msgRes.messages));

        if (
          nextTask &&
          (nextTask.status === "running" || nextTask.status === "queued")
        ) {
          if (typeof nextTask.agent_state?.statusLabel === "string") {
            setStatusLabel(nextTask.agent_state.statusLabel);
          }
        } else {
          sendingRef.current = false;
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
    apiPath,
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
      await apiFetch(apiPath(`/conversations/${id}`), { method: "DELETE" });
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

    const clientUserId = `local_${Date.now()}`;
    const optimistic: Message = {
      id: clientUserId,
      conversation_id: conversationId,
      role: "user",
      content,
      tool_call_id: null,
      metadata: { clientTempId: clientUserId },
      created_at: new Date().toISOString(),
    };
    // Keep React keys stable for the whole turn so bubbles don't remount.
    const streamingId = `stream_${Date.now()}`;
    const streamingMessage: Message = {
      id: streamingId,
      conversation_id: conversationId,
      role: "assistant",
      content: "",
      tool_call_id: null,
      metadata: { streaming: true, clientTempId: streamingId },
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimistic, streamingMessage]);
    sendingRef.current = true;
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
        `${apiPath(`/conversations/${conversationId}/messages`)}?stream=1`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          credentials: "same-origin",
          body: JSON.stringify({
            content,
            runAgent: true,
            ...(workspaceVersion === "v2" && selectedMetaAccountId
              ? { metaAccountId: selectedMetaAccountId }
              : {}),
          }),
        },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          payload?.error?.message ?? `Send failed (${response.status})`,
        );
      }

      let assistantId = streamingId;
      let finalTaskId: string | null = null;

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
            // Keep the local React key; store server id in metadata.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === clientUserId
                  ? {
                      ...message,
                      id: clientUserId,
                      metadata: {
                        ...(message.metadata ?? {}),
                        ...(m.metadata ?? {}),
                        serverId: message.id,
                        clientTempId: clientUserId,
                      },
                    }
                  : m,
              ),
            );
          }

          if (event === "assistant_message") {
            const message = payload.message as Message;
            assistantId = message.id;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingId
                  ? {
                      ...message,
                      id: streamingId,
                      content: message.content || m.content,
                      metadata: {
                        ...(message.metadata ?? {}),
                        ...(m.metadata ?? {}),
                        streaming: true,
                        serverId: message.id,
                        clientTempId: streamingId,
                      },
                    }
                  : m,
              ),
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
            finalTaskId = nextTask?.id ?? null;
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
            // One final in-place swap to the persisted message (stable enough).
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === streamingId || m.id === assistantId) {
                  return {
                    ...message,
                    metadata: {
                      ...(message.metadata ?? {}),
                      streaming: false,
                    },
                  };
                }
                if (m.id === clientUserId) {
                  const serverId =
                    typeof m.metadata?.serverId === "string"
                      ? m.metadata.serverId
                      : null;
                  return serverId
                    ? {
                        ...m,
                        id: serverId,
                        metadata: {
                          ...(m.metadata ?? {}),
                          streaming: false,
                        },
                      }
                    : m;
                }
                return m;
              }),
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

      // Soft reconcile approvals/task — do NOT replace the whole message list
      // (that remounts bubbles and causes the disappear/reappear glitch).
      await refreshConversationList(clientId);
      await loadApprovals(clientId, finalTaskId);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Send failed");
      setMessages((prev) =>
        prev.filter((m) => m.id !== clientUserId && m.id !== streamingId),
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
      setStatusLabel(null);
    }
  }

  return (
    <div className="flex h-[calc(100vh-7.5rem)] min-h-[560px] flex-col">
      <PageHeader
        title={workspaceVersion === "v2" ? "Workspace V2" : "Workspace"}
        description={
          workspaceVersion === "v2"
            ? "Chat with the Meta-direct agent (no Adspirer API dependency). Execute actions still require approval."
            : "Chat with the Adspirer agent. Diagnose freely; execute actions require approval."
        }
        actions={
          <div className="flex items-center gap-3">
            {workspaceVersion === "v2" && (
              <MetaConnectButton
                variant="compact"
                returnTo="/workspace-v2"
                showManageLink
              />
            )}
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
          </div>
        }
      />

      {workspaceVersion === "v2" && clientId && metaAccountStatus ? (
        <div
          className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
            selectedMetaAccountId
              ? "border-emerald-500/30 bg-emerald-500/10 text-foreground"
              : "border-amber-500/30 bg-amber-500/10 text-foreground"
          }`}
        >
          {selectedMetaAccountId ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Ad account for chat:</span>
              {metaAccountStatus.mappedAccounts.filter(
                (a) => a.access_status === "granted",
              ).length > 1 ? (
                <Select
                  value={selectedMetaAccountId}
                  onValueChange={(value) => {
                    setSelectedMetaAccountId(value);
                    if (clientId) {
                      window.localStorage.setItem(
                        `adspirer_selected_meta_account_${clientId}`,
                        value,
                      );
                    }
                  }}
                >
                  <SelectTrigger className="h-7 max-w-[320px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {metaAccountStatus.mappedAccounts
                      .filter((a) => a.access_status === "granted")
                      .map((a) => (
                        <SelectItem
                          key={a.meta_account_id}
                          value={a.meta_account_id}
                        >
                          {a.meta_account_name} ({a.meta_account_id})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              ) : (
                <span>
                  {
                    metaAccountStatus.mappedAccounts.find(
                      (a) => a.meta_account_id === selectedMetaAccountId,
                    )?.meta_account_name
                  }{" "}
                  ({selectedMetaAccountId})
                </span>
              )}
            </div>
          ) : (
            <p>
              <span className="font-medium">No ad account ready for this client.</span>{" "}
              {!metaAccountStatus.facebookConnected
                ? "Connect Facebook, sync, then map TR Internal Marketing under Connections."
                : metaAccountStatus.mappedCount === 0
                  ? "Sync ad accounts, then map the account to this client under Connections."
                  : "Mapped accounts exist but none are granted — check Connections."}
            </p>
          )}
        </div>
      ) : null}

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
            newChatLabel={workspaceVersion === "v2" ? "New V2 chat" : "New chat"}
            className="min-h-0"
          />

          <Card className="flex h-full min-h-0 flex-col overflow-hidden">
            <CardHeader className="shrink-0 border-b border-border py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-1.5 text-sm">
                    {isV2ChatTitle(activeConversation?.title) ? (
                      <span className="shrink-0 rounded bg-accent-muted px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-accent">
                        V2
                      </span>
                    ) : null}
                    <span className="truncate">
                      {clientName ?? "Client"} ·{" "}
                      {displayChatTitle(activeConversation?.title) || DEFAULT_CHAT_TITLE}
                    </span>
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
                  apiBase={apiBase}
                  inlineApprovals={approvals}
                  onWorkflowRefresh={refreshWorkflow}
                  placeholder={
                    workspaceVersion === "v2"
                      ? "Ask the Meta-direct agent to audit, create campaigns, or propose changes…"
                      : "Ask Adspirer to audit, create campaigns, or propose changes…"
                  }
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
            <DocumentsPanel
              clientId={clientId}
              conversationId={conversationId}
              apiBase={apiBase}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkspaceClient({
  workspaceVersion,
}: {
  workspaceVersion: "v1" | "v2";
}) {
  return <WorkspaceInner workspaceVersion={workspaceVersion} />;
}
