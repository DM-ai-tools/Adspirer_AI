"use client";

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { mergeComposerDraft } from "@/lib/chat/action-messages";

export type ChatComposerHandle = {
  /** Merge a picker block into the draft (replaces an earlier block with the same marker). */
  merge: (block: string, marker: string) => void;
  focus: () => void;
};

const MAX_HEIGHT_PX = 220;

/**
 * Message box. Owns its own text state so typing never re-renders the
 * conversation above it (long chats used to lag on every keystroke).
 */
export const ChatComposer = forwardRef<
  ChatComposerHandle,
  {
    initialValue?: string;
    placeholder?: string;
    disabled?: boolean;
    sending?: boolean;
    /** Resolve `false` when the message was not delivered — the text comes back. */
    onSubmit: (text: string) => Promise<boolean | void> | boolean | void;
    onStop?: () => void;
    leading?: ReactNode;
    footer?: ReactNode;
  }
>(function ChatComposer(
  { initialValue, placeholder, disabled, sending, onSubmit, onStop, leading, footer },
  ref,
) {
  const [value, setValue] = useState(initialValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    merge: (block, marker) => {
      setValue((prev) => mergeComposerDraft(prev, block, marker));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    focus: () => textareaRef.current?.focus(),
  }));

  // Grow with the text up to a cap, then scroll inside the box.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const canSend = Boolean(value.trim()) && !disabled && !sending;

  async function send() {
    if (!canSend) return;
    const text = value;
    setValue("");
    const delivered = await onSubmit(text);
    if (delivered === false) setValue((current) => current || text);
  }

  return (
    <form
      className="shrink-0 px-3 pb-3 pt-2 sm:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-4xl items-end gap-2 rounded-2xl border border-border bg-card px-2 py-2 shadow-sm transition-colors",
          "focus-within:border-accent/50",
          disabled && "opacity-60",
        )}
      >
        {leading}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Message"
          className="max-h-[220px] min-h-[40px] flex-1 resize-none bg-transparent px-1.5 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {sending && onStop ? (
          <button
            type="button"
            onClick={onStop}
            title="Stop waiting for this reply"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground transition-colors hover:bg-secondary/70"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            title="Send (Enter)"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground transition-opacity disabled:opacity-40"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        )}
      </div>
      <div className="mx-auto mt-1.5 flex w-full max-w-4xl items-center justify-between gap-2 px-1 text-[11px] text-muted">
        <div className="min-w-0">{footer}</div>
        <span className="hidden shrink-0 sm:inline">Enter to send · Shift + Enter for a new line</span>
      </div>
    </form>
  );
});
