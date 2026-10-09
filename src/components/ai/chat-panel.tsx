"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { toast } from "sonner";
import type { Approval, Message } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import {
  InlineCreativeCards,
  type CreativeDraftCard,
} from "@/components/ai/workflow-cards";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatComposer, type ChatComposerHandle } from "@/components/ai/chat-composer";
import { cn } from "@/lib/utils";
import { resolveAssistantDisplay } from "@/lib/agent/message-reconcile";
import {
  GENERIC_FALLBACK_REPLY,
  humanizeAgentReply,
} from "@/lib/agent/reply-format";
import { humanToolLabel } from "@/lib/tools/display-labels";
import { looksLikeFullAuditMarkdown } from "@/lib/report/from-markdown";
import { columnAlignments } from "@/lib/reports/layout";
import { ChatDocumentAttachButton } from "@/components/workspace/documents-panel";
import { useCreativeStatus } from "@/hooks/use-creative-status";
import { TargetingPickerCard } from "@/components/ai/targeting-picker";
import type {
  CampaignTargetingSelection,
} from "@/lib/adspirer/targeting";
import {
  composeCopyApprovedMessage,
  composeFormatChoiceMessage,
  composeImageSourceMessage,
  composeOptimizeAdMessage,
  composeServicesMessage,
  composeSkipTargetingMessage,
  composeTargetingMessage,
  composeVideoSourceMessage,
  stripComposerMarkers,
} from "@/lib/chat/action-messages";
import {
  inferConversationFlow,
  showCampaignCreativeUi,
  showImageChoiceUi,
} from "@/lib/chat/infer-flow";

const SUGGESTIONS: Array<{ title: string; prompt: string }> = [
  {
    title: "Audit the account",
    prompt: "Audit the account and summarize spend, delivery, and risks",
  },
  {
    title: "Find wasted spend",
    prompt:
      "Which campaigns or ads are spending without results in the last 14 days, and what should we change?",
  },
  {
    title: "Optimise live ads",
    prompt: "Optimize ads in this account",
  },
  {
    title: "Launch a campaign",
    prompt: "Create a Meta campaign for this account",
  },
];

const APPROVAL_STATUS_UI: Record<string, { label: string; tone: string }> = {
  pending: { label: "Awaiting approval", tone: "text-warning" },
  edited: { label: "Edited · awaiting approval", tone: "text-warning" },
  approved: { label: "Applying…", tone: "text-accent" },
  executing: { label: "Applying…", tone: "text-accent" },
  executed: { label: "Applied on Meta", tone: "text-success" },
  rejected: { label: "Rejected", tone: "text-muted" },
  failed: { label: "Failed", tone: "text-danger" },
  cancelled: { label: "Cancelled", tone: "text-muted" },
};

type ServiceOption = { id: string; name: string; description?: string };

type ToolProposal = {
  tool: string;
  args: Record<string, unknown>;
  rationale?: string;
};

type ParsedAssistant = {
  displayText: string;
  services: ServiceOption[] | null;
  copies: Array<{
    id: string;
    angle: string;
    primary_text: string;
    headline: string;
    description?: string;
    cta?: string;
  }> | null;
  ads: Array<{
    id: string;
    name: string;
    status?: string;
    creative_summary?: string;
  }> | null;
  imageChoice: {
    landing_page_url?: string;
    brand_url?: string;
    headline?: string;
    primary_text?: string;
    reference_notes?: string;
  } | null;
  formatChoice: { selected?: "image" | "video" | null } | null;
  videoChoice: {
    landing_page_url?: string;
    headline?: string;
    primary_text?: string;
  } | null;
  targetingPicker: { account_id?: string | null } | null;
  creativePicker: {
    drafts?: CreativeDraftCard[];
    status?: string;
  } | null;
  pendingApprovalIds: string[];
  proposals: ToolProposal[];
};

function readMetaServices(
  metadata: Record<string, unknown> | null | undefined,
): ServiceOption[] | null {
  const ui = metadata?.ui as
    | { servicePicker?: { services?: ServiceOption[] } }
    | null
    | undefined;
  const services = ui?.servicePicker?.services;
  if (!Array.isArray(services) || !services.length) return null;
  return services.filter((s) => s?.name?.trim());
}

function readMetaCopies(
  metadata: Record<string, unknown> | null | undefined,
) {
  const ui = metadata?.ui as
    | {
        copyPicker?: {
          copies?: Array<{
            id: string;
            angle: string;
            primary_text: string;
            headline: string;
            description?: string;
            cta?: string;
          }>;
        };
      }
    | null
    | undefined;
  const copies = ui?.copyPicker?.copies;
  if (!Array.isArray(copies) || !copies.length) return null;
  return copies.filter((c) => c?.headline && c?.primary_text);
}

function readMetaAds(metadata: Record<string, unknown> | null | undefined) {
  const ui = metadata?.ui as
    | {
        adPicker?: {
          ads?: Array<{
            id: string;
            name: string;
            status?: string;
            creative_summary?: string;
          }>;
        };
      }
    | null
    | undefined;
  const ads = ui?.adPicker?.ads;
  if (!Array.isArray(ads) || !ads.length) return null;
  return ads.filter((a) => a?.id && a?.name);
}

function readMetaCreativePicker(
  metadata: Record<string, unknown> | null | undefined,
) {
  const ui = metadata?.ui as
    | { creativePicker?: { drafts?: CreativeDraftCard[]; status?: string } }
    | null
    | undefined;
  return ui?.creativePicker ?? null;
}

function readPendingApprovalIds(
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const ids = metadata?.pendingApprovalIds ?? metadata?.pendingApprovalId;
  if (Array.isArray(ids)) return ids.map(String);
  if (typeof ids === "string") return [ids];
  return [];
}

function readMetaImageChoice(
  metadata: Record<string, unknown> | null | undefined,
) {
  const ui = metadata?.ui as
    | {
        imageChoice?: {
          landing_page_url?: string;
          brand_url?: string;
          headline?: string;
          primary_text?: string;
          reference_notes?: string;
        };
      }
    | null
    | undefined;
  return ui?.imageChoice ?? null;
}

function readMetaFormatChoice(
  metadata: Record<string, unknown> | null | undefined,
) {
  const ui = metadata?.ui as
    | { formatChoice?: { selected?: "image" | "video" | null } }
    | null
    | undefined;
  return ui?.formatChoice ?? null;
}

function readMetaVideoChoice(
  metadata: Record<string, unknown> | null | undefined,
) {
  const ui = metadata?.ui as
    | {
        videoChoice?: {
          landing_page_url?: string;
          headline?: string;
          primary_text?: string;
        };
      }
    | null
    | undefined;
  return ui?.videoChoice ?? null;
}

function readMetaTargetingPicker(
  metadata: Record<string, unknown> | null | undefined,
) {
  const ui = metadata?.ui as
    | { targetingPicker?: { account_id?: string | null } }
    | null
    | undefined;
  return ui?.targetingPicker ?? null;
}

function parseAssistantContent(
  content: string,
  metadata: Record<string, unknown> | null | undefined,
): ParsedAssistant {
  const humanized = humanizeAgentReply(content ?? "");
  const metaServices = readMetaServices(metadata);
  const metaCopies = readMetaCopies(metadata);
  const metaAds = readMetaAds(metadata);
  const metaImageChoice = readMetaImageChoice(metadata);
  const metaFormatChoice = readMetaFormatChoice(metadata);
  const metaVideoChoice = readMetaVideoChoice(metadata);
  const metaTargetingPicker = readMetaTargetingPicker(metadata);
  const metaCreativePicker = readMetaCreativePicker(metadata);
  const pendingApprovalIds = readPendingApprovalIds(metadata);
  const services = metaServices?.length
    ? metaServices
    : humanized.servicePicker?.services ?? null;
  const copies = metaCopies?.length
    ? metaCopies
    : humanized.copyPicker?.copies ?? null;
  const ads = metaAds?.length ? metaAds : humanized.adPicker?.ads ?? null;
  const imageChoice = metaImageChoice ?? humanized.imageChoice ?? null;
  const formatChoice = metaFormatChoice ?? humanized.formatChoice ?? null;
  const videoChoice = metaVideoChoice ?? humanized.videoChoice ?? null;
  const targetingPicker =
    metaTargetingPicker ?? humanized.targetingPicker ?? null;
  const creativePicker = metaCreativePicker ?? null;

  return {
    displayText: resolveAssistantDisplay(humanized.display, {
      servicePicker: services?.length ? { services } : null,
      copyPicker: copies?.length ? { copies } : null,
      adPicker: ads?.length ? { ads } : null,
      imageChoice,
      formatChoice,
      videoChoice,
      targetingPicker,
      creativePicker,
    }),
    services,
    copies,
    ads,
    imageChoice,
    formatChoice,
    videoChoice,
    targetingPicker,
    creativePicker,
    pendingApprovalIds,
    proposals: humanized.toolCalls.map((t) => ({
      tool: t.name,
      args: t.args,
      rationale: t.rationale,
    })),
  };
}

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)<>]*[^\s)<>.,;:!?'"])/g);
  return parts.map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          title={part}
          className="break-all text-accent underline-offset-2 hover:underline"
        >
          {part.replace(/^https?:\/\/(www\.)?/, "").replace(/\?.*$/, "")}
        </a>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/** Memoised: while one reply streams, earlier bubbles skip re-rendering. */
/** Cells of a markdown table row: `| a | b |` → ["a", "b"]. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableDivider = (line: string) =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

const FormattedMessageBody = memo(function FormattedMessageBody({
  text,
}: {
  text: string;
}) {
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let listStart = 1;

  const flushList = () => {
    if (!listItems.length) return;
    const ordered = listOrdered;
    const start = listStart;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-2 space-y-1.5">
        {listItems.map((item, idx) => (
          <li key={idx} className="flex gap-2.5 text-sm leading-relaxed text-foreground/90">
            {ordered ? (
              <span className="min-w-[1.25rem] shrink-0 text-right font-medium tabular-nums text-accent">
                {start + idx}.
              </span>
            ) : (
              <span className="mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
            )}
            <span className="min-w-0">{renderInline(item)}</span>
          </li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Markdown table: header row, divider row, then body rows.
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushList();
      const header = tableCells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        const cells = tableCells(lines[j]);
        // "|" inside a campaign name splits the first cell — fold it back.
        const overflow = cells.length - header.length;
        rows.push(
          overflow > 0
            ? [cells.slice(0, overflow + 1).join(" | "), ...cells.slice(overflow + 1)]
            : cells,
        );
        j += 1;
      }
      const align = columnAlignments(rows, header.length);
      blocks.push(
        <div key={`tbl-${i}`} className="my-3 overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full text-left text-xs">
            <thead className="bg-secondary/50 text-muted">
              <tr>
                {header.map((cell, c) => (
                  <th
                    key={c}
                    className={cn(
                      "whitespace-nowrap px-3 py-2 font-medium",
                      align[c] === "right" && "text-right",
                    )}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((row, r) => (
                <tr key={r} className="border-t border-border-subtle/70 even:bg-secondary/20">
                  {header.map((_, c) => (
                    <td
                      key={c}
                      className={cn(
                        "px-3 py-2 align-top text-foreground/90",
                        align[c] === "right" && "whitespace-nowrap text-right",
                      )}
                    >
                      {renderInline(row[c] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j - 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      blocks.push(<hr key={`hr-${i}`} className="my-3 border-border-subtle" />);
      continue;
    }
    if (heading) {
      flushList();
      const level = heading[1].length;
      blocks.push(
        <p
          key={`h-${i}`}
          className={cn(
            "font-semibold tracking-tight text-foreground first:mt-0",
            level <= 2 ? "mb-1.5 mt-5 text-base" : "mb-1 mt-4 text-sm",
          )}
        >
          {renderInline(heading[2])}
        </p>,
      );
      continue;
    }
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (listItems.length && ordered !== listOrdered) flushList();
      if (!listItems.length) {
        listOrdered = ordered;
        listStart = numbered ? Number(numbered[1]) : 1;
      }
      listItems.push((bullet?.[1] ?? numbered?.[2])!);
      continue;
    }
    flushList();
    if (!line.trim()) {
      // A blank line between list items doesn't end the list.
      if (listItems.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i + 1] ?? "")) continue;
      blocks.push(<div key={`sp-${i}`} className="h-2" />);
      continue;
    }
    blocks.push(
      <p key={`p-${i}`} className="text-sm leading-relaxed text-foreground/90">
        {renderInline(line)}
      </p>,
    );
  }
  flushList();

  return <div className="space-y-0.5">{blocks}</div>;
});

function ToolProposalCards({ proposals }: { proposals: ToolProposal[] }) {
  if (!proposals.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {proposals.map((p, i) => (
        <div
          key={`${p.tool}-${i}`}
          className="rounded-lg border border-border bg-secondary/30 px-3 py-2"
        >
          <p className="text-xs font-medium text-foreground">
            Proposed:{" "}
            <span className="text-accent">{humanToolLabel(p.tool)}</span>
          </p>
          {p.rationale ? (
            <p className="mt-1 text-xs text-muted">{p.rationale}</p>
          ) : null}
          <dl className="mt-2 grid gap-1 text-[11px] text-muted">
            {Object.entries(p.args)
              .slice(0, 8)
              .map(([k, v]) => (
                <div key={k} className="grid grid-cols-[7rem_1fr] gap-2">
                  <dt className="font-mono text-muted/80">{k}</dt>
                  <dd className="truncate text-foreground/80">
                    {typeof v === "string" || typeof v === "number"
                      ? String(v)
                      : JSON.stringify(v)}
                  </dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

export function ChatPanel({
  messages,
  onSend,
  disabled,
  sending: sendingProp,
  statusLabel,
  placeholder = "Ask for an audit, a new campaign, or changes to propose…",
  className,
  clientId,
  conversationId,
  taskId,
  clientName,
  apiBase = "/api",
  inlineApprovals = [],
  onWorkflowRefresh,
  initialInput,
  onStop,
  onReviewApprovals,
  onDocumentUploaded,
}: {
  messages: Message[];
  /** Resolve `false` when the message never reached the server. */
  onSend: (content: string) => Promise<void | boolean> | void;
  disabled?: boolean;
  sending?: boolean;
  statusLabel?: string | null;
  placeholder?: string;
  className?: string;
  clientId?: string;
  conversationId?: string | null;
  taskId?: string | null;
  clientName?: string;
  apiBase?: string;
  inlineApprovals?: Approval[];
  onWorkflowRefresh?: () => void | Promise<void>;
  /** Prefills the composer (e.g. "Ask agent" from Monitoring); never auto-sent. */
  initialInput?: string;
  /** Stop waiting for the in-flight reply (the server may still finish it). */
  onStop?: () => void;
  /** Opens the Approvals panel (where queued changes are approved or edited). */
  onReviewApprovals?: () => void;
  onDocumentUploaded?: () => void;
}) {
  const composerRef = useRef<ChatComposerHandle>(null);
  const [sendingLocal, setSendingLocal] = useState(false);
  const [feedbackById, setFeedbackById] = useState<
    Record<string, "up" | "down">
  >({});
  const [selectedByMessage, setSelectedByMessage] = useState<
    Record<string, string[]>
  >({});
  const [selectedCopyByMessage, setSelectedCopyByMessage] = useState<
    Record<string, string>
  >({});
  const [selectedAdByMessage, setSelectedAdByMessage] = useState<
    Record<string, string>
  >({});
  const [startingCreatives, setStartingCreatives] = useState(false);
  const [attachedNames, setAttachedNames] = useState<string[]>([]);
  const [exportProgress, setExportProgress] = useState<{
    format: "md" | "docx" | "pdf" | "xlsx";
    step: number;
    label: string;
    percent: number;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** True when the user is near the bottom — only then do we follow new messages. */
  const stickToBottomRef = useRef(true);
  const sending = sendingProp ?? sendingLocal;
  const apiPath = (path: string) =>
    `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;

  // Images render on the server, so the chat watches the drafts rather than
  // the request that started them — leaving and returning keeps the progress.
  const {
    drafts: liveCreativeDrafts,
    progress: creativeProgress,
    active: creativesRendering,
    refresh: refreshCreativeStatus,
  } = useCreativeStatus({
    clientId,
    conversationId,
    enabled: Boolean(clientId && conversationId),
  });

  const isNearBottom = (el: HTMLDivElement, thresholdPx = 120) =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;

  const handleMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearBottom(el);
  };

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages, statusLabel]);

  /** Resolves false when nothing was delivered, so the composer keeps the text. */
  async function submit(content: string): Promise<boolean> {
    const trimmed = stripComposerMarkers(content).trim();
    if (!trimmed || sending || disabled) return false;
    // Sending a message should always jump back to the latest reply.
    stickToBottomRef.current = true;
    setSendingLocal(true);
    try {
      return (await onSend(trimmed)) !== false;
    } finally {
      setSendingLocal(false);
    }
  }

  function applyToComposer(block: string, marker: string) {
    composerRef.current?.merge(block, marker);
    toast.message("Added to your message — review and press Send when ready.");
  }

  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy — select the text instead");
    }
  }

  async function sendFeedback(messageId: string, rating: "up" | "down") {
    if (messageId.startsWith("stream_") || messageId.startsWith("local_")) {
      return;
    }
    try {
      await apiFetch(apiPath("/feedback"), {
        method: "POST",
        body: JSON.stringify({ messageId, rating }),
      });
      setFeedbackById((prev) => ({ ...prev, [messageId]: rating }));
      toast.success(
        rating === "up"
          ? "Thanks — we'll lean into this style next time"
          : "Thanks — we'll avoid repeating that approach",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Feedback failed");
    }
  }

  async function exportReport(
    format: "md" | "docx" | "pdf" | "xlsx",
    title: string,
    content: string,
    report?: unknown,
  ) {
    if (exportProgress) return;

    const steps = [
      { label: "Preparing report content…", percent: 12 },
      { label: "Cleaning spacing & formatting…", percent: 32 },
      { label: "Verifying professional layout…", percent: 55 },
      { label: "Building download file…", percent: 78 },
      { label: "Starting download…", percent: 92 },
    ] as const;

    setExportProgress({
      format,
      step: 0,
      label: steps[0].label,
      percent: steps[0].percent,
    });

    const advance = (index: number) => {
      const s = steps[Math.min(index, steps.length - 1)];
      setExportProgress({
        format,
        step: index,
        label: s.label,
        percent: s.percent,
      });
    };

    advance(2);

    try {
      const response = await fetch(apiPath("/reports/export"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, format, report }),
      });

      advance(3);

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? "Export failed");
      }

      const quality = response.headers.get("X-Report-Quality") ?? "pass";
      const score = response.headers.get("X-Report-Quality-Score");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `spendsmith-report.${format}`;

      advance(4);

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      // Revoking synchronously can cancel the download in some browsers.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

      setExportProgress({
        format,
        step: steps.length,
        label: "Download ready",
        percent: 100,
      });
      await new Promise((r) => setTimeout(r, 350));

      if (quality === "pass") {
        toast.success(`Downloaded ${filename}`, {
          description: score
            ? `Quality check passed (score ${score}).`
            : "Quality check passed.",
        });
      } else {
        toast.message(`Downloaded ${filename}`, {
          description:
            "Exported after cleanup — review spacing once if anything looks off.",
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally {
      setExportProgress(null);
    }
  }

  function toggleService(messageId: string, serviceId: string) {
    setSelectedByMessage((prev) => {
      const current = prev[messageId] ?? [];
      const next = current.includes(serviceId)
        ? current.filter((id) => id !== serviceId)
        : [...current, serviceId];
      return { ...prev, [messageId]: next };
    });
  }

  function confirmServices(messageId: string, services: ServiceOption[]) {
    const selectedIds = selectedByMessage[messageId] ?? [];
    if (!selectedIds.length) {
      toast.error("Select at least one service");
      return;
    }
    const picked = services.filter((s) => selectedIds.includes(s.id));
    applyToComposer(composeServicesMessage(picked), "services");
  }

  function confirmCopy(
    messageId: string,
    copies: NonNullable<ParsedAssistant["copies"]>,
  ) {
    const copyId = selectedCopyByMessage[messageId];
    const picked = copies.find((c) => c.id === copyId);
    if (!picked) {
      toast.error("Select a copy variant");
      return;
    }
    applyToComposer(composeCopyApprovedMessage(picked), "copy");
  }

  function confirmAd(
    messageId: string,
    ads: NonNullable<ParsedAssistant["ads"]>,
  ) {
    const adId = selectedAdByMessage[messageId];
    const picked = ads.find((a) => a.id === adId);
    if (!picked) {
      toast.error("Select an ad to optimize");
      return;
    }
    applyToComposer(composeOptimizeAdMessage(picked), "optimize");
  }

  async function addTargetingToComposer(
    selection: CampaignTargetingSelection,
  ) {
    if (taskId && clientId) {
      try {
        await apiFetch(apiPath("/workflow/targeting"), {
          method: "POST",
          body: JSON.stringify({ clientId, taskId, targeting: selection }),
        });
      } catch {
        // Composer still carries the selection for the agent.
      }
    }
    applyToComposer(composeTargetingMessage(selection), "targeting");
  }

  function addSkipTargetingToComposer() {
    applyToComposer(composeSkipTargetingMessage(), "targeting");
  }

  const conversationFlow = useMemo(
    () => inferConversationFlow(messages),
    [messages],
  );
  const showCreativeUi = showCampaignCreativeUi(conversationFlow);
  const showImageUi = showImageChoiceUi(conversationFlow);

  // Messages keep object identity unless they change, so only the streaming
  // reply is re-parsed per token instead of every message in the thread.
  const [parseCache] = useState(() => new WeakMap<Message, ParsedAssistant>());
  const parsedById = useMemo(() => {
    const cache = parseCache;
    const map = new Map<string, ParsedAssistant>();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      let parsed = cache.get(m);
      if (!parsed) {
        parsed = parseAssistantContent(m.content, m.metadata);
        cache.set(m, parsed);
      }
      map.set(m.id, parsed);
    }
    return map;
  }, [messages, parseCache]);

  const latestPickerMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const parsed = parsedById.get(m.id);
      if (parsed?.services?.length) return m.id;
    }
    return null;
  }, [messages, parsedById]);

  const latestCopyPickerMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const parsed = parsedById.get(m.id);
      if (parsed?.copies?.length) return m.id;
    }
    return null;
  }, [messages, parsedById]);

  const latestAdPickerMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const parsed = parsedById.get(m.id);
      if (parsed?.ads?.length) return m.id;
    }
    return null;
  }, [messages, parsedById]);

  const latestImageChoiceMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const parsed = parsedById.get(m.id);
      if (parsed?.imageChoice) return m.id;
    }
    return null;
  }, [messages, parsedById]);

  const latestFormatChoiceMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const parsed = parsedById.get(m.id);
      if (parsed?.formatChoice) return m.id;
    }
    return null;
  }, [messages, parsedById]);

  const latestVideoChoiceMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const parsed = parsedById.get(m.id);
      if (parsed?.videoChoice) return m.id;
    }
    return null;
  }, [messages, parsedById]);

  const latestTargetingPickerMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const parsed = parsedById.get(m.id);
      if (parsed?.targetingPicker) return m.id;
    }
    return null;
  }, [messages, parsedById]);

  /**
   * Every generation event carries its own snapshot of the drafts, which would
   * otherwise render a duplicate set of cards per message with stale statuses.
   * Collapse them into one live set shown on the most recent picker message.
   */
  const { creativeCardsMessageId, creativeCards } = useMemo(() => {
    const byDraftId = new Map<string, CreativeDraftCard>();
    let lastMessageId: string | null = null;
    let lastAssistantId: string | null = null;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      lastAssistantId = m.id;
      const picker = parsedById.get(m.id)?.creativePicker;
      if (!picker?.drafts?.length) continue;
      lastMessageId = m.id;
      for (const draft of picker.drafts) {
        byDraftId.set(draft.id, { ...byDraftId.get(draft.id), ...draft });
      }
    }

    // Snapshots freeze at the moment their message was written, so the poll —
    // which reflects images finishing on the server — always wins.
    for (const live of liveCreativeDrafts) {
      byDraftId.set(live.id, {
        ...byDraftId.get(live.id),
        ...live,
      } as CreativeDraftCard);
    }

    return {
      // A batch started from the button has no picker message yet; hang its
      // cards off the newest reply so they show up without a chat reload.
      creativeCardsMessageId: lastMessageId ?? lastAssistantId,
      creativeCards: Array.from(byDraftId.values()),
    };
  }, [messages, parsedById, liveCreativeDrafts]);

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col", className)}>
      {exportProgress ? (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 px-4 backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-lg">
            <div className="mb-3 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              <p className="text-sm font-medium text-foreground">
                Preparing{" "}
                {exportProgress.format === "docx"
                  ? "Word"
                  : exportProgress.format === "xlsx"
                    ? "Excel"
                    : exportProgress.format.toUpperCase()}{" "}
                report
              </p>
            </div>
            <p className="mb-3 text-xs text-muted">{exportProgress.label}</p>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{ width: `${exportProgress.percent}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Cleaning text, verifying layout, then downloading — please wait.
            </p>
          </div>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        onScroll={handleMessagesScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-5 sm:px-6"
      >
        <div className="mx-auto w-full max-w-4xl space-y-6 pb-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center px-2 pt-[8vh] text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/15 text-accent">
                <Sparkles className="h-5 w-5" />
              </div>
              <p className="mt-4 text-lg font-semibold text-foreground">
                What should we work on{clientName ? ` for ${clientName}` : ""}?
              </p>
              <p className="mt-1 max-w-md text-sm text-muted">
                Ask about performance, request an audit, or plan changes. Nothing
                goes live on Meta until you approve it.
              </p>
              <div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    disabled={sending || disabled}
                    onClick={() => void submit(s.prompt)}
                    className="rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-accent/40 hover:bg-secondary/40 disabled:opacity-50"
                  >
                    <p className="text-sm font-medium text-foreground">{s.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">{s.prompt}</p>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => {
              const streaming = Boolean(message.metadata?.streaming);
              const feedback = feedbackById[message.id];
              const parsed =
                message.role === "assistant"
                  ? parsedById.get(message.id)
                  : null;
              const services = parsed?.services ?? null;
              const copies = parsed?.copies ?? null;
              const ads = parsed?.ads ?? null;
              const imageChoice = parsed?.imageChoice ?? null;
              const selected = selectedByMessage[message.id] ?? [];
              const selectedCopy = selectedCopyByMessage[message.id];
              const selectedAd = selectedAdByMessage[message.id];
              const isLatestPicker = message.id === latestPickerMessageId;
              const isLatestCopyPicker =
                message.id === latestCopyPickerMessageId;
              const isLatestAdPicker = message.id === latestAdPickerMessageId;
              const isLatestImageChoice =
                message.id === latestImageChoiceMessageId;
              const isLatestFormatChoice =
                message.id === latestFormatChoiceMessageId;
              const isLatestVideoChoice =
                message.id === latestVideoChoiceMessageId;
              const isLatestTargetingPicker =
                message.id === latestTargetingPickerMessageId;
              const formatChoice = parsed?.formatChoice ?? null;
              const videoChoice = parsed?.videoChoice ?? null;
              const targetingPicker = parsed?.targetingPicker ?? null;
              const displayText = parsed?.displayText ?? message.content;
              const isStreamingPlaceholder =
                !displayText.trim() ||
                displayText.trim() === GENERIC_FALLBACK_REPLY ||
                /^_(.+)_\s*$/.test(displayText.trim()) ||
                displayText.trim() === "Writing reply…";
              const liveLabel =
                typeof message.metadata?.label === "string"
                  ? message.metadata.label
                  : statusLabel;
              const isReport =
                Boolean(message.metadata?.isReport) ||
                (/^#\s+.+/m.test(parsed?.displayText ?? "") &&
                  /\b(executive summary|recommendations|next steps|session report)\b/i.test(
                    parsed?.displayText ?? "",
                  )) ||
                /\bMeta Ads Account Audit\b/i.test(
                  parsed?.displayText ?? message.content,
                );
              const reportTitle =
                (typeof message.metadata?.reportTitle === "string" &&
                  message.metadata.reportTitle) ||
                parsed?.displayText?.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
                "Spendsmith report";
              const reportData = message.metadata?.reportData ?? undefined;
              // Prefer the body that still contains the full audit tables/headers.
              // Humanized displayText used to win and drop campaign/KPI rows.
              const rawBody = message.content || "";
              const displayBody = parsed?.displayText || "";
              const reportBody = (() => {
                const rawOk = looksLikeFullAuditMarkdown(rawBody);
                const displayOk = looksLikeFullAuditMarkdown(displayBody);
                if (rawOk && !displayOk) return rawBody;
                if (displayOk && !rawOk) return displayBody;
                if (rawOk && displayOk) {
                  return rawBody.length >= displayBody.length
                    ? rawBody
                    : displayBody;
                }
                return rawBody || displayBody;
              })();
              const pendingApprovals = parsed?.pendingApprovalIds?.length
                ? parsed.pendingApprovalIds
                : Array.isArray(message.metadata?.pendingApprovalIds)
                  ? (message.metadata?.pendingApprovalIds as string[])
                  : message.metadata?.pendingApprovalId
                    ? [String(message.metadata.pendingApprovalId)]
                    : [];
              const messageApprovals = inlineApprovals.filter((a) =>
                pendingApprovals.includes(a.id),
              );

              const isUser = message.role === "user";
              const isAssistant = message.role === "assistant";
              return (
                <div
                  key={message.id}
                  className={cn(
                    "group flex gap-3",
                    isUser ? "justify-end" : "justify-start",
                  )}
                >
                  {isAssistant ? (
                    <div
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent"
                      aria-hidden
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                    </div>
                  ) : null}
                  <div
                    className={cn(
                      "text-sm leading-relaxed",
                      isUser
                        ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-accent-foreground"
                        : message.role === "system"
                          ? "mx-auto max-w-[90%] rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted"
                          : "min-w-0 flex-1 text-foreground",
                    )}
                  >
                    {isAssistant && !streaming && isReport ? (
                      <span className="mb-2 inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                        <FileText className="h-3 w-3" /> Report
                      </span>
                    ) : null}

                    {message.role === "assistant" ? (
                      <>
                        {streaming && isStreamingPlaceholder ? (
                          <div className="flex items-center gap-2 py-1 text-sm text-muted">
                            <span className="flex gap-1" aria-hidden>
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
                            </span>
                            {liveLabel ?? "Thinking…"}
                          </div>
                        ) : (
                          <FormattedMessageBody text={displayText} />
                        )}
                        {streaming && !isStreamingPlaceholder ? (
                          <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" />
                        ) : null}
                        {!streaming && parsed?.proposals?.length ? (
                          <ToolProposalCards proposals={parsed.proposals} />
                        ) : null}
                      </>
                    ) : (
                      <div className="whitespace-pre-wrap">{message.content}</div>
                    )}

                    {!streaming && message.role === "assistant" && pendingApprovals.length > 0 ? (
                      // One place to act on approvals (the Approvals panel);
                      // the chat shows what was queued and its live status.
                      <div className="mt-3 rounded-xl border border-border bg-secondary/30 px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-foreground">
                            {pendingApprovals.length} change
                            {pendingApprovals.length === 1 ? "" : "s"} queued for approval
                          </p>
                          {onReviewApprovals ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="h-7 text-xs"
                              onClick={onReviewApprovals}
                            >
                              Review
                            </Button>
                          ) : null}
                        </div>
                        {messageApprovals.length ? (
                          <ul className="mt-2 space-y-1">
                            {messageApprovals.map((a) => {
                              const s = APPROVAL_STATUS_UI[a.status] ?? {
                                label: a.status,
                                tone: "text-muted",
                              };
                              return (
                                <li key={a.id} className="flex items-center justify-between gap-3 text-xs">
                                  <span className="min-w-0 truncate text-muted">
                                    {humanToolLabel(a.tool_name)}
                                    {a.rationale ? ` — ${a.rationale}` : ""}
                                  </span>
                                  <span className={cn("shrink-0 font-medium", s.tone)}>{s.label}</span>
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <p className="mt-1 text-[11px] text-muted">
                            Nothing changes on Meta until you approve.
                          </p>
                        )}
                      </div>
                    ) : null}

                    {message.id === creativeCardsMessageId &&
                    creativeCards.length ? (
                      <>
                        {creativesRendering && creativeProgress ? (
                          <div className="mt-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-2 text-xs text-muted">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                            <span>
                              Rendering stills —{" "}
                              {creativeProgress.succeeded +
                                creativeProgress.failed +
                                creativeProgress.stalled}{" "}
                              of {creativeProgress.total} done. Safe to switch
                              pages; this keeps running.
                            </span>
                          </div>
                        ) : null}
                        <InlineCreativeCards
                          drafts={creativeCards}
                          disabled={disabled || sending}
                          onUpdated={async () => {
                            refreshCreativeStatus();
                            await onWorkflowRefresh?.();
                          }}
                        />
                      </>
                    ) : null}

                    {!streaming && services && isLatestPicker ? (
                      <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-xs font-semibold text-foreground">
                            Select services for ad sets / ads
                          </p>
                          <p className="text-[10px] text-muted">
                            {selected.length} selected · {services.length} found
                          </p>
                        </div>
                        <div className="grid gap-1.5 sm:grid-cols-2">
                          {services.map((service) => {
                            const on = selected.includes(service.id);
                            return (
                              <button
                                key={service.id}
                                type="button"
                                onClick={() =>
                                  toggleService(message.id, service.id)
                                }
                                className={cn(
                                  "rounded-lg border px-2.5 py-2 text-left transition-colors",
                                  on
                                    ? "border-accent bg-accent/10"
                                    : "border-border bg-secondary/30 hover:border-accent/40",
                                )}
                              >
                                <div className="flex items-start gap-2">
                                  <span
                                    className={cn(
                                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                                      on
                                        ? "border-accent bg-accent text-accent-foreground"
                                        : "border-border",
                                    )}
                                  >
                                    {on ? <Check className="h-3 w-3" /> : null}
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block text-xs font-medium text-foreground">
                                      {service.name}
                                    </span>
                                    {service.description ? (
                                      <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                                        {service.description}
                                      </span>
                                    ) : null}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-8"
                            disabled={disabled || sending}
                            onClick={() =>
                              setSelectedByMessage((prev) => ({
                                ...prev,
                                [message.id]: services.map((s) => s.id),
                              }))
                            }
                          >
                            Select all
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8"
                            disabled={
                              disabled || sending || selected.length === 0
                            }
                            onClick={() =>
                              confirmServices(message.id, services)
                            }
                          >
                            Create ad sets + ads for selected → Add to message
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {!streaming && copies && isLatestCopyPicker ? (
                      <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-xs font-semibold text-foreground">
                            Approve an ad copy variant
                          </p>
                          <p className="text-[10px] text-muted">
                            {copies.length} options
                          </p>
                        </div>
                        <div className="grid gap-2">
                          {copies.map((copy) => {
                            const on = selectedCopy === copy.id;
                            return (
                              <button
                                key={copy.id}
                                type="button"
                                onClick={() =>
                                  setSelectedCopyByMessage((prev) => ({
                                    ...prev,
                                    [message.id]: copy.id,
                                  }))
                                }
                                className={cn(
                                  "rounded-lg border px-2.5 py-2 text-left transition-colors",
                                  on
                                    ? "border-accent bg-accent/10"
                                    : "border-border bg-secondary/30 hover:border-accent/40",
                                )}
                              >
                                <div className="flex items-start gap-2">
                                  <span
                                    className={cn(
                                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                                      on
                                        ? "border-accent bg-accent text-accent-foreground"
                                        : "border-border",
                                    )}
                                  >
                                    {on ? <Check className="h-3 w-3" /> : null}
                                  </span>
                                  <span className="min-w-0 space-y-1">
                                    <span className="block text-xs font-medium text-foreground">
                                      {copy.id} · {copy.angle}
                                    </span>
                                    <span className="block text-[11px] font-medium text-foreground">
                                      {copy.headline}
                                    </span>
                                    <span className="block text-[11px] leading-snug text-muted">
                                      {copy.primary_text}
                                    </span>
                                    {copy.cta ? (
                                      <span className="inline-block rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted">
                                        CTA: {copy.cta}
                                      </span>
                                    ) : null}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          disabled={disabled || sending || !selectedCopy}
                          onClick={() => confirmCopy(message.id, copies)}
                        >
                          Use selected copy → Add to message
                        </Button>
                      </div>
                    ) : null}

                    {!streaming && ads && isLatestAdPicker ? (
                      <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
                        <p className="text-xs font-semibold text-foreground">
                          Select an ad to optimize
                        </p>
                        <div className="grid gap-1.5">
                          {ads.map((ad) => {
                            const on = selectedAd === ad.id;
                            return (
                              <button
                                key={ad.id}
                                type="button"
                                onClick={() =>
                                  setSelectedAdByMessage((prev) => ({
                                    ...prev,
                                    [message.id]: ad.id,
                                  }))
                                }
                                className={cn(
                                  "rounded-lg border px-2.5 py-2 text-left transition-colors",
                                  on
                                    ? "border-accent bg-accent/10"
                                    : "border-border bg-secondary/30 hover:border-accent/40",
                                )}
                              >
                                <span className="block text-xs font-medium text-foreground">
                                  {ad.name}
                                </span>
                                <span className="mt-0.5 block font-mono text-[10px] text-muted">
                                  {ad.id}
                                  {ad.status ? ` · ${ad.status}` : ""}
                                </span>
                                {ad.creative_summary ? (
                                  <span className="mt-0.5 block text-[11px] text-muted">
                                    {ad.creative_summary}
                                  </span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          className="h-8"
                          disabled={disabled || sending || !selectedAd}
                          onClick={() => confirmAd(message.id, ads)}
                        >
                          Optimize selected ad → Add to message
                        </Button>
                      </div>
                    ) : null}

                    {!streaming &&
                    showCreativeUi &&
                    targetingPicker &&
                    isLatestTargetingPicker &&
                    clientId ? (
                      <TargetingPickerCard
                        clientId={clientId}
                        accountId={targetingPicker.account_id}
                        apiBase={apiBase}
                        disabled={disabled || sending}
                        onConfirm={(selection) =>
                          void addTargetingToComposer(selection)
                        }
                        onSkip={addSkipTargetingToComposer}
                      />
                    ) : null}

                    {!streaming &&
                    showCreativeUi &&
                    formatChoice &&
                    isLatestFormatChoice ? (
                      <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                        <p className="text-xs font-semibold text-foreground">
                          Campaign format
                        </p>
                        <p className="text-[11px] text-muted">
                          Image uses a still (URL or generate). Video needs a
                          public MP4/MOV URL or an existing Meta video ID —
                          Spendsmith does not generate videos.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="h-8"
                            disabled={disabled || sending}
                            onClick={() =>
                              applyToComposer(
                                composeFormatChoiceMessage("image"),
                                "format",
                              )
                            }
                          >
                            Image ad
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-8"
                            disabled={disabled || sending}
                            onClick={() =>
                              applyToComposer(
                                composeFormatChoiceMessage("video"),
                                "format",
                              )
                            }
                          >
                            Video ad
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {!streaming &&
                    showCreativeUi &&
                    videoChoice &&
                    isLatestVideoChoice ? (
                      <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                        <p className="text-xs font-semibold text-foreground">
                          Video creative
                        </p>
                        <p className="text-[11px] text-muted">
                          Provide a public https video URL (MP4/MOV) or a Meta
                          video ID already in the ad account.
                          {videoChoice.landing_page_url
                            ? ` Landing page on file: ${videoChoice.landing_page_url}`
                            : ""}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="h-8"
                            disabled={disabled || sending}
                            onClick={() =>
                              applyToComposer(
                                composeVideoSourceMessage("url"),
                                "video",
                              )
                            }
                          >
                            I have a video URL
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-8"
                            disabled={disabled || sending}
                            onClick={() =>
                              applyToComposer(
                                composeVideoSourceMessage("meta_id"),
                                "video",
                              )
                            }
                          >
                            I have a Meta video ID
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {!streaming &&
                    showImageUi &&
                    imageChoice &&
                    isLatestImageChoice &&
                    !creativesRendering ? (
                      <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                        <p className="text-xs font-semibold text-foreground">
                          Creative image
                        </p>
                        <p className="text-[11px] text-muted">
                          Provide your own URL, or generate stills here from your
                          ad copy
                          {imageChoice.brand_url || imageChoice.landing_page_url
                            ? ` + brand URL (${imageChoice.brand_url || imageChoice.landing_page_url})`
                            : " + brand URL"}{" "}
                          (colours / logo / guidelines).
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-8"
                            disabled={disabled || sending}
                            onClick={() =>
                              applyToComposer(
                                composeImageSourceMessage("url"),
                                "image",
                              )
                            }
                          >
                            I have an image URL
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8"
                            disabled={
                              disabled ||
                              sending ||
                              !clientId ||
                              startingCreatives
                            }
                            onClick={() => {
                              void (async () => {
                                setStartingCreatives(true);
                                try {
                                  const brandOrLanding =
                                    imageChoice.brand_url ||
                                    imageChoice.landing_page_url;
                                  await apiFetch(
                                    apiPath("/workflow/creatives/generate"),
                                    {
                                      method: "POST",
                                      body: JSON.stringify({
                                        clientId,
                                        conversationId,
                                        taskId,
                                        landingPageUrl:
                                          imageChoice.landing_page_url,
                                        brandUrl: imageChoice.brand_url,
                                        headline: imageChoice.headline,
                                        primaryText: imageChoice.primary_text,
                                        referenceBrief:
                                          imageChoice.reference_notes,
                                        analyzeBrand: true,
                                      }),
                                    },
                                  );
                                  toast.success(
                                    brandOrLanding
                                      ? "Generating branded creatives — they'll appear in this chat"
                                      : "Generating creatives — they'll appear in this chat",
                                  );
                                  refreshCreativeStatus();
                                  await onWorkflowRefresh?.();
                                } catch (err) {
                                  toast.error(
                                    err instanceof Error
                                      ? err.message
                                      : "Generation failed",
                                  );
                                } finally {
                                  setStartingCreatives(false);
                                }
                              })();
                            }}
                          >
                            {startingCreatives ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            Generate images here
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {message.role === "assistant" &&
                    (parsed?.displayText || message.content) &&
                    !streaming ? (
                      <div
                        className={cn(
                          "mt-2 flex flex-wrap items-center gap-0.5 text-muted transition-opacity",
                          !isReport &&
                            "sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100",
                        )}
                      >
                        <button
                          type="button"
                          title="Copy"
                          aria-label="Copy reply"
                          onClick={() => void copyMessage(displayText)}
                          className="rounded-md p-1.5 transition-colors hover:bg-secondary hover:text-foreground"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Good reply — teach the agent"
                          aria-label="Good reply"
                          onClick={() => void sendFeedback(message.id, "up")}
                          className={cn(
                            "rounded-md p-1.5 transition-colors hover:bg-secondary hover:text-foreground",
                            feedback === "up" && "bg-accent/15 text-accent",
                          )}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Bad reply — teach the agent"
                          aria-label="Bad reply"
                          onClick={() => void sendFeedback(message.id, "down")}
                          className={cn(
                            "rounded-md p-1.5 transition-colors hover:bg-secondary hover:text-foreground",
                            feedback === "down" && "bg-danger-muted text-danger",
                          )}
                        >
                          <ThumbsDown className="h-3.5 w-3.5" />
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              disabled={Boolean(exportProgress)}
                              className={cn(
                                "ml-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50",
                                isReport
                                  ? "border border-accent/40 bg-accent/10 font-medium text-accent hover:bg-accent/20"
                                  : "hover:bg-secondary hover:text-foreground",
                              )}
                            >
                              <Download className="h-3.5 w-3.5" />
                              {isReport ? "Download report" : "Export"}
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            <DropdownMenuItem
                              onSelect={() =>
                                void exportReport("pdf", reportTitle, reportBody, reportData)
                              }
                            >
                              <Download className="mr-2 h-3.5 w-3.5" /> PDF
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                void exportReport("docx", reportTitle, reportBody, reportData)
                              }
                            >
                              <FileText className="mr-2 h-3.5 w-3.5" /> Word (.docx)
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                void exportReport("xlsx", reportTitle, reportBody, reportData)
                              }
                            >
                              <FileSpreadsheet className="mr-2 h-3.5 w-3.5" /> Excel (.xlsx)
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                void exportReport("md", reportTitle, reportBody, reportData)
                              }
                            >
                              <FileText className="mr-2 h-3.5 w-3.5" /> Markdown
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <span
                          className="ml-2 text-[11px]"
                          title={new Date(message.created_at).toLocaleString()}
                        >
                          {formatRelative(message.created_at)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
          {sending && statusLabel && !messages.some((m) => m.metadata?.streaming) ? (
            <div className="flex items-center gap-2 pl-10 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
              {statusLabel}
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>

      <ChatComposer
        ref={composerRef}
        initialValue={initialInput}
        placeholder={placeholder}
        disabled={disabled}
        sending={sending}
        onSubmit={submit}
        onStop={onStop}
        leading={
          <ChatDocumentAttachButton
            clientId={clientId}
            conversationId={conversationId}
            apiBase={apiBase}
            disabled={disabled || sending}
            onUploaded={(filename) => {
              setAttachedNames((prev) =>
                prev.includes(filename) ? prev : [...prev.slice(-4), filename],
              );
              onDocumentUploaded?.();
            }}
          />
        }
        footer={
          attachedNames.length ? (
            <span className="block truncate text-accent">
              Attached: {attachedNames.join(", ")}
            </span>
          ) : (
            "Changes wait for your approval — nothing goes live automatically."
          )
        }
      />
    </div>
  );
}
