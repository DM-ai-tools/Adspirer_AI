"use client";

import { MessageSquarePlus, Trash2 } from "lucide-react";
import type { Conversation } from "@/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { displayChatTitle } from "@/lib/agent/title-format";

function conversationLabel(conversation: Conversation): string {
  return displayChatTitle(conversation.title);
}

const GROUPS = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;

function groupFor(iso: string, now = new Date()): (typeof GROUPS)[number] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(iso).getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - 86_400_000) return "Yesterday";
  if (t >= startOfToday - 7 * 86_400_000) return "Previous 7 days";
  return "Older";
}

function timeLabel(iso: string, group: (typeof GROUPS)[number]): string {
  const d = new Date(iso);
  if (group === "Today" || group === "Yesterday") {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
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
        "flex min-h-0 flex-col rounded-xl border border-border bg-card/60",
        className,
      )}
    >
      <div className="shrink-0 p-2.5">
        <Button
          variant="secondary"
          className="h-9 w-full justify-start gap-2"
          onClick={onNewChat}
          disabled={disabled}
        >
          <MessageSquarePlus className="h-4 w-4" />
          {newChatLabel}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted">
            No chats yet. Start a new one.
          </p>
        ) : (
          <div className="space-y-3">
            {GROUPS.map((group) => {
              const items = conversations.filter((c) => groupFor(c.updated_at) === group);
              if (!items.length) return null;
              return (
                <div key={group}>
                  <p className="px-2.5 pb-1 text-[11px] font-medium text-muted">{group}</p>
                  <ul className="space-y-0.5">
                    {items.map((conversation) => {
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
                              "w-full rounded-lg px-2.5 py-1.5 text-left transition-colors",
                              active
                                ? "bg-accent/15 text-foreground"
                                : "text-foreground/80 hover:bg-secondary/60 hover:text-foreground",
                            )}
                          >
                            <p className="truncate pr-7 text-sm">{label}</p>
                            <p className="text-[11px] text-muted">
                              {timeLabel(conversation.updated_at, group)}
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
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
