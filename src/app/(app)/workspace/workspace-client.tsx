"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ClipboardCheck,
  FileText,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Approval, Conversation, Message, Task } from "@/types";
import { apiFetch } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { LoadingState } from "@/components/shared/loading-state";
import { ChatPanel } from "@/components/ai/chat-panel";
import { ChatHistorySidebar } from "@/components/ai/chat-history-sidebar";
import { ApprovalsPanel } from "@/components/workspace/approvals-panel";
import { DocumentsPanel } from "@/components/workspace/documents-panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_CHAT_TITLE, displayChatTitle } from "@/lib/agent/title-format";
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
  let changed = false;
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
    const serverFinished = match.metadata?.streaming !== true;
    if (isTemp) {
      // A bubble whose stream ended without a final event (network drop,
      // tail timeout): once the server row is finished it wins, keeping the
      // local key so the bubble doesn't remount.
      if (serverFinished && (match.content?.trim() || m.role === "user")) {
        changed = true;
        return {
          ...match,
          id: m.id,
          metadata: {
            ...(match.metadata ?? {}),
            serverId: match.id,
            clientTempId: m.metadata?.clientTempId ?? m.id,
            streaming: false,
          },
        };
      }
      return m;
    }
    // Unchanged rows keep their object identity so memoised parsing and
    // rendering are skipped on every poll.
    if (
      match.content === m.content &&
      m.metadata?.streaming !== true &&
      metadataCovers(m.metadata, match.metadata)
    ) {
      return m;
    }
    changed = true;
    return {
      ...match,
      metadata: {
        ...(m.metadata ?? {}),
        ...(match.metadata ?? {}),
        streaming: false,
      },
    };
  });

  for (const msg of server) {
    if (!used.has(msg.id)) {
      merged.push(msg);
      changed = true;
    }
  }
  return changed ? merged : local;
}

function metadataCovers(
  local: Record<string, unknown> | null | undefined,
  server: Record<string, unknown> | null | undefined,
): boolean {
  if (!server) return true;
  for (const [key, value] of Object.entries(server)) {
    if (key === "streaming") continue;
    if (JSON.stringify(local?.[key]) !== JSON.stringify(value)) return false;
  }
  return true;
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

const WORKSPACE_PATH = "/workspace";
const API_BASE = "/api";

function readStoredAccount(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeAccount(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / storage disabled — selection just won't persist
  }
}

type MetaAccountStatus = {
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
};

function WorkspaceInner() {
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
  // "Ask agent" links (?prompt=…): read once — the URL is rewritten as soon
  // as a chat opens — and only prefill until the operator moves on.
  const [pendingPrompt, setPendingPrompt] = useState(
    () => searchParams.get("prompt")?.slice(0, 2_000) || undefined,
  );
  const workspacePath = WORKSPACE_PATH;
  const apiBase = API_BASE;
  const apiPath = useCallback(
    (path: string) => `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`,
    [],
  );
  const clientId = queryClientId || selectedClientId;
  // Latest client the operator picked. Async loads started for an earlier
  // client compare against this before writing state, so a slow response for
  // client A can never render under client B.
  const activeClientRef = useRef<string | null>(clientId ?? null);
  useEffect(() => {
    activeClientRef.current = clientId ?? null;
  }, [clientId]);
  const streamAbortRef = useRef<AbortController | null>(null);

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
  // Ad-account info is tagged with the client it was loaded for; anything
  // for a different client reads as "not loaded", so a send right after a
  // client switch can never carry the previous client's account.
  const [metaAccount, setMetaAccount] = useState<{
    clientId: string;
    status: MetaAccountStatus | null;
    selectedId: string | null;
  } | null>(null);
  const metaAccountStatus =
    metaAccount && metaAccount.clientId === clientId ? metaAccount.status : null;
  const selectedMetaAccountId =
    metaAccount && metaAccount.clientId === clientId ? metaAccount.selectedId : null;
  const setSelectedMetaAccountId = (id: string) =>
    setMetaAccount((prev) => (prev ? { ...prev, selectedId: id } : prev));

  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [historyDrawer, setHistoryDrawer] = useState(false);
  const [panel, setPanel] = useState<"approvals" | "files" | null>(null);
  const [docsVersion, setDocsVersion] = useState(0);
  const activeConversationRef = useRef<string | null>(null);

  const clientName = useMemo(
    () => clients.find((c) => c.id === clientId)?.name,
    [clients, clientId],
  );
  // Read clients without re-running effects every time the list refreshes.
  const clientsRef = useRef(clients);
  useEffect(() => {
    clientsRef.current = clients;
  }, [clients]);

  useEffect(() => {
    handleMetaOAuthReturn({
      searchParams,
      pathname: workspacePath,
      replace: (url) => router.replace(url, { scroll: false }),
      toastSuccess: (msg) => toast.success(msg),
      toastError: (msg) => toast.error(msg),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- OAuth return once
  }, []);

  useEffect(() => {
    if (!clientId) return;
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
        const saved = readStoredAccount(selectedAccountKey(clientId));
        const client = clientsRef.current.find((c) => c.id === clientId);
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

        setMetaAccount({
          clientId,
          status: {
            ready: data.ready,
            facebookConnected: data.facebookConnected,
            primaryAccount: data.primaryAccount,
            mappedAccounts: data.mappedAccounts,
            mappedCount: data.mappedAccounts.length,
          },
          selectedId: nextId,
        });
      } catch {
        if (!cancelled) setMetaAccount({ clientId, status: null, selectedId: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

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

  /** Every approval raised in this chat (any status) — pending ones drive the panel. */
  const loadApprovals = useCallback(async (cid: string, convId: string | null) => {
    if (!convId) {
      setApprovals([]);
      return;
    }
    const { approvals: list } = await apiFetch<{ approvals: Approval[] }>(
      `/api/approvals?clientId=${cid}&conversationId=${convId}`,
    );
    if (activeClientRef.current === cid && activeConversationRef.current === convId) {
      setApprovals(list);
    }
  }, []);

  const refreshWorkflow = useCallback(async () => {
    if (!clientId || !conversationId) return;
    // Never wipe the in-flight optimistic/streaming thread on focus.
    if (sendingRef.current) return;
    const convId = conversationId;
    const activeTaskId = task?.id ?? null;
    const [msgRes, taskRes] = await Promise.all([
      apiFetch<{ conversation: Conversation; messages: Message[] }>(
        apiPath(`/conversations/${convId}/messages`),
      ),
      activeTaskId
        ? apiFetch<{ task: Task }>(`/api/tasks/${activeTaskId}`).catch(() => null)
        : Promise.resolve(null),
      loadApprovals(clientId, convId),
    ]);
    // The operator may have switched chats while this was loading.
    if (activeConversationRef.current !== convId || sendingRef.current) return;
    setMessages((prev) => mergeServerMessages(prev, msgRes.messages));
    if (taskRes) setTask(taskRes.task);
  }, [clientId, conversationId, task, loadApprovals, apiPath]);

  useEffect(() => {
    if (!clientId || !conversationId) return;
    // focus and visibilitychange both fire when returning to the tab.
    let last = 0;
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - last < 2_000) return;
      last = Date.now();
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
      if (activeClientRef.current !== cid) return;
      activeConversationRef.current = conversation.id;
      setConversationId(conversation.id);
      syncUrl(cid, conversation.id);
      const stale = () =>
        activeClientRef.current !== cid ||
        activeConversationRef.current !== conversation.id;

      const [msgRes, taskRes] = await Promise.all([
        apiFetch<{ conversation: Conversation; messages: Message[] }>(
          apiPath(`/conversations/${conversation.id}/messages`),
        ),
        conversation.task_id
          ? apiFetch<{ task: Task }>(`/api/tasks/${conversation.task_id}`).catch(() => null)
          : Promise.resolve(null),
        loadApprovals(cid, conversation.id),
      ]);
      if (stale()) return;
      setMessages(msgRes.messages);
      setTask(taskRes?.task ?? null);
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
    if (activeClientRef.current === cid) setConversations(sorted);
    return sorted;
  }, [apiPath]);

  const createConversation = useCallback(
    async (cid: string, title = DEFAULT_CHAT_TITLE) => {
      const created = await apiFetch<{ conversation: Conversation }>(
        apiPath("/conversations"),
        {
          method: "POST",
          body: JSON.stringify({ clientId: cid, title }),
        },
      );
      if (activeClientRef.current === cid) {
        setConversations((prev) => [created.conversation, ...prev]);
      }
      await openConversation(cid, created.conversation);
      return created.conversation;
    },
    [openConversation, apiPath],
  );

  const bootstrapWorkspace = useCallback(
    async (cid: string, preferredConversationId?: string | null) => {
      setBootstrapping(true);
      try {
        const sorted = await refreshConversationList(cid);
        if (activeClientRef.current !== cid) return;
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
    // Leaving a client mid-reply: stop reading its stream (the run itself
    // continues server-side and shows up when you come back).
    streamAbortRef.current?.abort();
    activeConversationRef.current = null;
    // Resetting per-client state is the point of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversationId(null);
    setMessages([]);
    setTask(null);
    setApprovals([]);
    void bootstrapWorkspace(clientId, queryConversationId);
    // Re-bootstrap when the client changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  useEffect(() => () => streamAbortRef.current?.abort(), []);

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
      // The SSE stream already delivers task progress for this tab; polling is
      // only for runs we are not streaming (page reloaded mid-run, other tab).
      if (cancelled || sendingRef.current || document.hidden) return;
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

        // A stream may have started while the task request was in flight.
        if (sendingRef.current) return;

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
          // A run that finished outside this tab's stream: pick up the
          // approvals and title it produced.
          if (currentTask && ["running", "queued"].includes(currentTask.status)) {
            void loadApprovals(clientId, conversationId);
            void refreshConversationList(clientId);
          }
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
    loadApprovals,
    refreshConversationList,
  ]);

  async function handleNewChat() {
    if (!clientId || sending) return;
    setHistoryDrawer(false);
    setPendingPrompt(undefined);
    // Don't pile up empty chats: the current one is already blank.
    if (conversationId && messages.length === 0) return;
    try {
      await createConversation(clientId);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create chat",
      );
    }
  }

  async function handleSelectConversation(id: string) {
    setHistoryDrawer(false);
    if (!clientId || sending || id === conversationId) return;
    setPendingPrompt(undefined);
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

  /** Returns false when nothing reached the server, so the composer keeps the text. */
  async function sendMessage(content: string): Promise<boolean> {
    if (!conversationId || !clientId || sendingRef.current) return false;
    setPendingPrompt(undefined);
    const sendClientId = clientId;
    const sendConversationId = conversationId;

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

    const abort = new AbortController();
    streamAbortRef.current = abort;
    let accepted = false;
    try {
      const response = await fetch(
        `${apiPath(`/conversations/${conversationId}/messages`)}?stream=1`,
        {
          signal: abort.signal,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          credentials: "same-origin",
          body: JSON.stringify({
            content,
            runAgent: true,
            ...(selectedMetaAccountId
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

      accepted = true;
      let assistantId = streamingId;
      // The reply as streamed so far. Deltas append to it (`append` + `total`
      // length check) or reset it (`content`); progress summaries only show
      // while no reply text has arrived.
      let replyText = "";

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
              payload.summary.trim() &&
              !replyText
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
            const append = typeof payload.append === "string" ? payload.append : null;
            const total = typeof payload.total === "number" ? payload.total : null;
            if (typeof payload.content === "string") {
              replyText = payload.content;
            } else if (append != null) {
              // Out of sync (missed event): keep what we have; the next reset
              // or the final message brings the full text.
              if (total == null || replyText.length === total - append.length) {
                replyText += append;
              }
            }
            const contentText = replyText;
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
            // One final in-place swap to the persisted message (stable enough).
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === streamingId || m.id === assistantId) {
                  // Keep the bubble's React key; the server id rides along.
                  return {
                    ...message,
                    id: m.id,
                    metadata: {
                      ...(message.metadata ?? {}),
                      serverId: message.id,
                      clientTempId: m.metadata?.clientTempId ?? m.id,
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
                      metadata: {
                        ...(m.metadata ?? {}),
                        streaming: false,
                        liveStatus: false,
                        status: "error",
                      },
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
      if (activeClientRef.current === sendClientId) {
        await Promise.all([
          refreshConversationList(sendClientId),
          loadApprovals(sendClientId, sendConversationId),
          refresh(),
        ]);
      }
      return true;
    } catch (error) {
      if (abort.signal.aborted) return true;
      toast.error(error instanceof Error ? error.message : "Send failed");
      if (!accepted) {
        // Nothing was saved server-side: drop the optimistic bubbles and let
        // the composer restore the text for a retry.
        setMessages((prev) =>
          prev.filter((m) => m.id !== clientUserId && m.id !== streamingId),
        );
        return false;
      }
      // The server already has the message (and may still be running the
      // task); reload the thread instead of deleting what the operator sent.
      sendingRef.current = false;
      void refreshWorkflow();
      return true;
    } finally {
      if (streamAbortRef.current === abort) streamAbortRef.current = null;
      sendingRef.current = false;
      setSending(false);
      setStatusLabel(null);
    }
  }

  const grantedAccounts =
    metaAccountStatus?.mappedAccounts.filter((a) => a.access_status === "granted") ?? [];
  const pendingApprovals = approvals.filter((a) =>
    ["pending", "edited"].includes(a.status),
  );
  const taskRunning =
    sending || (task != null && ["queued", "running"].includes(task.status));
  const awaitingOperator =
    !taskRunning && task?.agent_state?.awaitingOperator === true;
  const chatTitle =
    displayChatTitle(activeConversation?.title) || DEFAULT_CHAT_TITLE;

  const toggleHistory = () => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setHistoryCollapsed((v) => !v);
    } else {
      setHistoryDrawer((v) => !v);
    }
  };

  const historySidebar = (
    <ChatHistorySidebar
      conversations={conversations}
      activeId={conversationId}
      onSelect={(id) => void handleSelectConversation(id)}
      onNewChat={() => void handleNewChat()}
      onDelete={(id) => void handleDeleteConversation(id)}
      deletingId={deletingId}
      disabled={sending || bootstrapping || Boolean(deletingId)}
      newChatLabel="New chat"
      className="h-full"
    />
  );

  return (
    // Fills the viewport under the app header so the conversation gets all
    // the vertical space; side panels collapse into drawers on small screens.
    <div className="flex h-[calc(100dvh-5.5rem)] min-h-[520px] flex-col gap-3 md:h-[calc(100dvh-6.5rem)]">
      {/* Top bar: who and which ad account we're working on */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 text-muted hover:text-foreground"
          onClick={toggleHistory}
          aria-label="Toggle chat history"
          title="Chat history"
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <h1 className="mr-1 text-base font-semibold text-foreground">Workspace</h1>
        <Select
          value={clientId ?? undefined}
          disabled={sending}
          onValueChange={(value) => {
            setSelectedClientId(value);
            syncUrl(value, null);
          }}
        >
          <SelectTrigger
            className="h-9 w-[200px]"
            aria-label="Client"
            title={sending ? "Wait for the current reply to finish" : "Client"}
          >
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

        {clientId && metaAccountStatus ? (
          selectedMetaAccountId ? (
            grantedAccounts.length > 1 ? (
              <Select
                value={selectedMetaAccountId}
                disabled={sending}
                onValueChange={(value) => {
                  setSelectedMetaAccountId(value);
                  if (clientId) storeAccount(selectedAccountKey(clientId), value);
                }}
              >
                <SelectTrigger className="h-9 w-[260px]" aria-label="Ad account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {grantedAccounts.map((a) => (
                    <SelectItem key={a.meta_account_id} value={a.meta_account_id}>
                      {a.meta_account_name} · {a.meta_account_id.replace(/^act_/, "")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span
                className="inline-flex h-9 max-w-[280px] items-center gap-1.5 truncate rounded-md border border-border bg-card px-3 text-xs text-muted"
                title={selectedMetaAccountId}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                <span className="truncate text-foreground">
                  {grantedAccounts.find((a) => a.meta_account_id === selectedMetaAccountId)
                    ?.meta_account_name ?? selectedMetaAccountId}
                </span>
              </span>
            )
          ) : (
            <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-warning/40 bg-warning-muted px-3 text-xs text-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              {!metaAccountStatus.facebookConnected
                ? "Connect Facebook to use live data"
                : metaAccountStatus.mappedCount === 0
                  ? "No ad account mapped — see Connections"
                  : "Ad account access not granted — see Connections"}
            </span>
          )
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <MetaConnectButton variant="compact" returnTo={WORKSPACE_PATH} showManageLink />
          <Button
            type="button"
            variant={panel === "approvals" ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setPanel((p) => (p === "approvals" ? null : "approvals"))}
          >
            <ClipboardCheck className="h-4 w-4" />
            Approvals
            {pendingApprovals.length ? (
              <span className="rounded-full bg-warning px-1.5 text-[11px] font-semibold text-background">
                {pendingApprovals.length}
              </span>
            ) : null}
          </Button>
          <Button
            type="button"
            variant={panel === "files" ? "secondary" : "ghost"}
            size="icon"
            className="h-9 w-9"
            aria-label="Files"
            title="Files for this client"
            onClick={() => setPanel((p) => (p === "files" ? null : "files"))}
          >
            <FileText className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {!clientId ? (
        <LoadingState label="Select a client to begin" />
      ) : (
        <div className="relative flex min-h-0 flex-1 gap-3">
          {/* History: column on desktop, drawer on small screens */}
          {!historyCollapsed ? (
            <div className="hidden w-64 shrink-0 lg:block">{historySidebar}</div>
          ) : null}
          {historyDrawer ? (
            <div className="fixed inset-0 z-40 lg:hidden">
              <button
                type="button"
                aria-label="Close chat history"
                className="absolute inset-0 bg-background/70 backdrop-blur-sm"
                onClick={() => setHistoryDrawer(false)}
              />
              <div className="absolute inset-y-0 left-0 w-[85vw] max-w-xs p-3">{historySidebar}</div>
            </div>
          ) : null}

          {/* Conversation */}
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/60">
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground" title={chatTitle}>
                  {chatTitle}
                </p>
              </div>
              {taskRunning ? (
                <span className="inline-flex max-w-[45%] items-center gap-1.5 truncate text-xs text-muted">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                  <span className="truncate">{statusLabel ?? "Working…"}</span>
                </span>
              ) : pendingApprovals.length ? (
                <button
                  type="button"
                  onClick={() => setPanel("approvals")}
                  className="inline-flex items-center gap-1.5 rounded-full bg-warning-muted px-2.5 py-1 text-xs font-medium text-warning"
                >
                  <ClipboardCheck className="h-3.5 w-3.5" />
                  {pendingApprovals.length} awaiting approval
                </button>
              ) : awaitingOperator ? (
                <span className="text-xs text-muted">Waiting on your reply</span>
              ) : task?.status === "error" ? (
                <span className="inline-flex items-center gap-1 text-xs text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" /> Last reply failed
                </span>
              ) : null}
              {conversationId ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted"
                      aria-label="Chat options"
                      disabled={sending || Boolean(deletingId)}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void handleNewChat()}>
                      New chat
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-danger focus:text-danger"
                      onSelect={() => void handleDeleteConversation(conversationId)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Delete chat
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              {bootstrapping ? (
                <div className="p-4">
                  <LoadingState label={`Opening ${clientName ?? "workspace"}…`} />
                </div>
              ) : (
                <ChatPanel
                  key={conversationId ?? "none"}
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
                  onReviewApprovals={() => setPanel("approvals")}
                  onDocumentUploaded={() => setDocsVersion((v) => v + 1)}
                  initialInput={pendingPrompt}
                  placeholder={`Ask about ${clientName ?? "this account"} — performance, an audit, or a change to propose…`}
                />
              )}
            </div>
          </section>

          {/* Approvals / files: column on desktop, drawer on small screens */}
          {panel ? (
            <>
              <button
                type="button"
                aria-label="Close panel"
                className="fixed inset-0 z-30 bg-background/70 backdrop-blur-sm xl:hidden"
                onClick={() => setPanel(null)}
              />
              <aside className="fixed inset-y-0 right-0 z-40 flex w-[92vw] max-w-sm flex-col overflow-hidden border-l border-border bg-card xl:static xl:z-auto xl:w-[360px] xl:max-w-none xl:shrink-0 xl:rounded-xl xl:border">
                <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
                  {(["approvals", "files"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setPanel(key)}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-sm transition-colors",
                        panel === key
                          ? "bg-secondary font-medium text-foreground"
                          : "text-muted hover:text-foreground",
                      )}
                    >
                      {key === "approvals"
                        ? `Approvals${pendingApprovals.length ? ` (${pendingApprovals.length})` : ""}`
                        : "Files"}
                    </button>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-8 w-8 text-muted"
                    aria-label="Close panel"
                    onClick={() => setPanel(null)}
                  >
                    <span className="hidden xl:inline">
                      <PanelRight className="h-4 w-4" />
                    </span>
                    <X className="h-4 w-4 xl:hidden" />
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {panel === "approvals" ? (
                    <ApprovalsPanel
                      approvals={approvals}
                      clientName={clientName}
                      onUpdated={async (updated) => {
                        setApprovals((prev) =>
                          prev.map((a) => (a.id === updated.id ? updated : a)),
                        );
                        await refreshWorkflow();
                      }}
                    />
                  ) : (
                    <DocumentsPanel
                      key={docsVersion}
                      clientId={clientId}
                      conversationId={conversationId}
                      apiBase={apiBase}
                      className="border-0 bg-transparent shadow-none"
                    />
                  )}
                </div>
              </aside>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function selectedAccountKey(clientId: string): string {
  return `spendsmith_selected_meta_account_${clientId}`;
}

export function WorkspaceClient() {
  return <WorkspaceInner />;
}
