"use client";

import { MessageSquarePlus, Trash2 } from "lucide-react";
import type { Conversation } from "@/types";
import { formatRelative } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { displayChatTitle } from "@/lib/agent/title-format";

function conversationLabel(conversation: Conversation): string {
  return displayChatTitle(conversation.title);
}

export function ChatHistorySidebar({
  conversations,
  activeId,
  onSelect,
  onNewChat,
  onDelete,
  deletingId,
  disabled,
  className,
  newChatLabel = "New chat",
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete?: (id: string) => void;
  deletingId?: string | null;
  disabled?: boolean;
  className?: string;
  newChatLabel?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col rounded-xl border border-border bg-card",
        className,
      )}
    >
      <div className="shrink-0 border-b border-border p-3">
        <Button
          className="w-full justify-start gap-2"
          onClick={onNewChat}
          disabled={disabled}
        >
          <MessageSquarePlus className="h-4 w-4" />
          {newChatLabel}
        </Button>
      </div>

      <div className="px-3 pb-1 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Chat history
        </p>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted">
            No chats yet. Start a new one.
          </p>
        ) : (
          <ul className="space-y-1">
            {conversations.map((conversation) => {
              const active = conversation.id === activeId;
              const deleting = deletingId === conversation.id;
              const label = conversationLabel(conversation);
              return (
                <li key={conversation.id} className="group relative">
                  <button
                    type="button"
                    disabled={disabled || deleting}
                    onClick={() => onSelect(conversation.id)}
                    className={cn(
                      "w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                      active
                        ? "bg-accent/15 text-foreground"
                        : "text-muted hover:bg-secondary/60 hover:text-foreground",
                    )}
                  >
                    <p className="truncate pr-7 text-sm font-medium">
                      {label}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] opacity-70">
                      {formatRelative(conversation.updated_at)}
                    </p>
                  </button>
                  {onDelete ? (
                    <button
                      type="button"
                      title="Delete chat"
                      aria-label={`Delete ${conversation.title?.trim() || conversationLabel(conversation)}`}
                      disabled={disabled || Boolean(deletingId)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(conversation.id);
                      }}
                      className={cn(
                        "absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted transition-colors hover:bg-danger-muted hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger",
                        active || deleting
                          ? "opacity-100"
                          : "opacity-60 sm:opacity-0 sm:group-hover:opacity-100",
                      )}
                    >
                      <Trash2
                        className={cn(
                          "h-3.5 w-3.5",
                          deleting && "animate-pulse text-danger",
                        )}
                      />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
