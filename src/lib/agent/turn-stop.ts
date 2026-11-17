import type { AgentHistoryMessage } from "@/lib/agent/history";
import type { Task } from "@/types";

/**
 * Stopping a reply midway, and resuming it.
 *
 * Stop: the operator's Stop button (or typing "stop") marks the task cancelled. The running turn checks
 * that flag as its text streams (both inline and background runs pass through the same progress hook),
 * stops writing, and keeps what it had written, ending it with STOPPED_MARKER.
 *
 * Resume: the marker stays in the chat history, so the next turn knows the last reply was cut off and
 * what it was answering. "continue", or "continue but for each campaign", re-runs that request with the
 * operator's change and writes the complete reply again.
 */

/** Ends a stopped reply; also how the next turn recognises one in the history. */
export const STOPPED_MARKER = "_Stopped before the reply finished. Type “continue” to resume, or say what to change._";

/** Thrown from the progress hook to unwind a run the operator stopped. */
export class TurnStopped extends Error {
  constructor() {
    super("Stopped by the operator");
    this.name = "TurnStopped";
  }
}

/**
 * Watches the task for a stop, reading it at most every `everyMs` so the token stream isn't slowed by
 * a database read per token. Once stopped, it stays stopped.
 */
export function createStopWatch(taskId: string, read: (id: string) => Promise<Task>, everyMs = 750) {
  let stopped = false;
  let lastRead = 0;
  return {
    get stopped() {
      return stopped;
    },
    /** True when the operator has stopped this turn. `force` reads now, ignoring the throttle. */
    async check(force = false): Promise<boolean> {
      if (stopped) return true;
      const now = Date.now();
      if (!force && now - lastRead < everyMs) return false;
      lastRead = now;
      const task = await read(taskId).catch(() => null);
      if (task?.status === "cancelled") stopped = true;
      return stopped;
    },
  };
}

/** The stopped reply as kept: what was written, then the marker; a status line alone is not a reply. */
export function stoppedReplyContent(partial: string, isStatusLine: boolean): string {
  const text = isStatusLine ? "" : partial.trimEnd();
  return text ? `${text}\n\n${STOPPED_MARKER}` : STOPPED_MARKER;
}

export type StoppedTurn = {
  /** What the stopped reply was answering: the operator's message just before it. */
  request: string;
  /** The history before that request, as the stopped turn saw it. */
  historyBefore: AgentHistoryMessage[];
};

/**
 * The stopped reply this message may be resuming: the assistant's last message ends with the marker.
 * Null when the last reply finished normally.
 */
export function stoppedTurn(history: AgentHistoryMessage[]): StoppedTurn | null {
  const at = history.findLastIndex((m) => m.role === "assistant");
  if (at < 0 || !history[at]!.content.trimEnd().endsWith(STOPPED_MARKER)) return null;
  const askAt = history.slice(0, at).findLastIndex((m) => m.role === "user");
  if (askAt < 0) return null;
  return { request: history[askAt]!.content, historyBefore: history.slice(0, askAt) };
}

/** Only a resume, with no change: "continue", "go on", "resume", "keep going". */
const RESUME_ONLY = /^\s*(?:ok(?:ay)?[,.]?\s*)?(?:please\s+)?(?:continue|resume|go on|carry on|keep going|proceed|go ahead|finish(?: it| that)?|complete(?: it| that)?)\s*(?:please)?[.!]*\s*$/i;
/** A resume with a change: "continue but …", "go on and …", "resume, focus on …". */
const RESUME_WITH_CHANGE = /^\s*(?:ok(?:ay)?[,.]?\s*)?(?:please\s+)?(?:continue|resume|go on|carry on|keep going|proceed|go ahead)\b[\s,:;-]*(?:but|and|with|only|just|focus|make|also)?\b/i;

/** The word patterns' reading (no model): does this message resume the stopped reply? */
export function looksLikeResume(message: string): boolean {
  return RESUME_ONLY.test(message) || RESUME_WITH_CHANGE.test(message);
}

/** Stop words typed while a reply is running: they only stop it, they are not sent. */
export function isStopCommand(message: string): boolean {
  return /^\s*(?:stop|wait|pause|hold on|hang on|cancel)(?: it| that| please)?\s*[.!]*\s*$/i.test(message);
}

/** The request to run when resuming: the original, plus the operator's change when they gave one. */
export function resumedRequest(stopped: StoppedTurn, message: string): string {
  if (RESUME_ONLY.test(message)) return stopped.request;
  return `${stopped.request}\n\nThe operator stopped the previous reply partway and then said: "${message.trim()}". Apply that to this request.`;
}
