// One Chat item and one folded run of steps. Ports of `ItemView`, `ToolCard`, `ToolGroup`,
// `Disclosure` and `UserTurn` from web/src/components/chat-cards.tsx, drawn the same way: a typed
// tool call gets its kind's glyph and Collie's word for it, the subject it acted on, and its state;
// what it printed (a command's output, an edit's diff) folds behind one tap.
import { on, type Handle, type RemixNode } from "remix/component";
import {
  ArrowRightLeft,
  Bot,
  ChevronRight,
  CircleHelp,
  FilePlus,
  FileText,
  Globe,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  User,
  Wrench,
  type IconNode,
} from "lucide";

import type { ChatItem, ChatToolCall, ChatToolStatus } from "@web/lib/chat-items";
import { clockTime } from "@web/lib/format";
import { t, tn } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { Collapse } from "../ui/collapse";
import { Icon } from "../ui/icon";
import { StatusDot } from "../ui/status-dot";
import { MarkdownText } from "./markdown";
import { failedCount, LIVE_TAIL, runSummary, shortPath, stepLine, toolLabel, toolsOf } from "./steps";

const FOLD_ROW =
  "flex min-h-11 w-full min-w-0 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const KIND_ICON = {
  edit: Pencil,
  execute: SquareTerminal,
  read: FileText,
  search: Search,
  fetch: Globe,
  task: Bot,
  other: Wrench,
  question: CircleHelp,
  delete: Trash2,
  move: ArrowRightLeft,
} satisfies Record<ChatToolCall["kind"], IconNode>;

function clockTimeOf(iso: string | undefined): string {
  if (iso === undefined) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : clockTime(ms);
}

function BadBadge(handle: Handle<{ text: string }>) {
  return () => (
    <span class="inline-flex shrink-0 items-center rounded-md border border-status-blocked/30 bg-status-blocked/15 px-1.5 py-0.5 text-[11px] font-medium text-status-blocked">
      {handle.props.text}
    </span>
  );
}

function statusNode(status: ChatToolStatus, exitCode: number | undefined): RemixNode {
  if (status === "running") return <StatusDot status="working" live label={t("chat.card.status.running")} class="size-2" />;
  if (status === "failed") return <BadBadge text={t("chat.card.status.failed")} />;
  if (status === "denied") return <BadBadge text={t("chat.card.status.denied")} />;
  if (exitCode !== undefined && exitCode !== 0) return <BadBadge text={t("chat.card.status.exit", { code: exitCode })} />;
  return null;
}

/** What a call printed or changed, as text, or null when it has nothing to show. */
function bodyOf(tool: ChatToolCall): string | null {
  switch (tool.kind) {
    case "execute":
      return [`$ ${tool.command}`, tool.output ?? ""].filter((part) => part !== "").join("\n");
    case "edit":
      return tool.diff && tool.diff.length > 0 ? tool.diff.map((h) => [h.header, ...h.lines].join("\n")).join("\n") : null;
    case "search":
    case "fetch":
      return tool.output ?? null;
    case "task":
    case "other":
      return tool.output ?? (tool.summary.includes("\n") ? tool.summary : null);
    case "question":
      return tool.summary;
    case "read":
    case "delete":
    case "move":
      return null;
  }
}

/** The subject a card's head row shows beside its label. */
function subjectOf(tool: ChatToolCall): { text: string; mono: boolean } | null {
  switch (tool.kind) {
    case "edit":
    case "read":
    case "delete":
      return { text: shortPath(tool.path), mono: true };
    case "move":
      return { text: `${shortPath(tool.path)} → ${shortPath(tool.to ?? "")}`, mono: true };
    case "execute":
      return tool.description ? { text: tool.description, mono: false } : { text: tool.command.split("\n")[0] ?? "", mono: true };
    case "search":
      return { text: tool.where ? `${tool.query} ${t("chat.card.searchIn", { where: shortPath(tool.where) })}` : tool.query, mono: true };
    case "fetch":
      return { text: tool.url, mono: true };
    case "task":
    case "other":
    case "question":
      return tool.summary.includes("\n") ? null : { text: tool.summary, mono: false };
  }
}

export function ToolCard(handle: Handle<{ tool: ChatToolCall; status: ChatToolStatus; note?: string }>) {
  let open = false;
  return () => {
    const { tool, status, note } = handle.props;
    const subject = subjectOf(tool);
    const body = bodyOf(tool);
    const icon = tool.kind === "edit" && tool.created ? FilePlus : KIND_ICON[tool.kind];
    return (
      <div data-slot="tool-card" data-kind={tool.kind} class="overflow-hidden rounded-lg border border-border bg-card">
        <button
          type="button"
          aria-expanded={body === null ? undefined : open}
          disabled={body === null}
          class="flex min-h-9 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs disabled:cursor-default"
          mix={on("click", () => {
            open = !open;
            void handle.update();
          })}
        >
          <Icon icon={icon} class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="shrink-0 font-medium">{toolLabel(tool)}</span>
          <span
            class={cn(
              "min-w-0 flex-1 truncate",
              subject?.mono ? "font-mono text-[11px] [font-variant-ligatures:none]" : "font-content text-muted-foreground",
            )}
          >
            {subject?.text ?? ""}
          </span>
          {tool.kind === "edit" && (
            <span class="shrink-0 font-mono text-xs tabular-nums">
              <span class="text-status-done">+{tool.added}</span> <span class="text-status-blocked">−{tool.removed}</span>
            </span>
          )}
          {tool.kind === "read" && tool.range && (
            <span class="shrink-0 text-muted-foreground tabular-nums">
              {t("chat.card.lines", { from: tool.range[0], to: tool.range[1] })}
            </span>
          )}
          {statusNode(status, tool.kind === "execute" ? tool.exitCode : undefined)}
        </button>
        {open && body !== null && (
          <pre class="max-h-80 overflow-auto border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words">
            {body}
          </pre>
        )}
        <Collapse open={note !== undefined}>
          <p data-slot="question-note" class="flex items-start gap-2 border-t border-border px-3 py-2.5 text-xs text-muted-foreground">
            <Icon icon={SquareTerminal} class="mt-px size-3.5 shrink-0" />
            <span class="min-w-0">{note ?? ""}</span>
          </p>
        </Collapse>
      </div>
    );
  };
}

/** A fold whose body enters the DOM only while it is open. */
function Disclosure(handle: Handle<{ label: string; text: string; italic?: boolean }>) {
  let open = false;
  return () => (
    <div class="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        class={cn(FOLD_ROW, "px-0")}
        mix={on("click", () => {
          open = !open;
          void handle.update();
        })}
      >
        <Icon icon={ChevronRight} class={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        {handle.props.label}
      </button>
      {open && (
        <MarkdownText
          text={handle.props.text}
          class={cn("px-5 pb-1 text-muted-foreground", handle.props.italic && "italic")}
        />
      )}
    </div>
  );
}

const NOTICE_FOLD_CHARS = 160;

const NO_NOTES: Readonly<Record<string, string>> = {};

export function ItemView(handle: Handle<{ item: ChatItem; note?: string }>) {
  return () => {
    const { item, note } = handle.props;
    switch (item.kind) {
      case "user": {
        const time = clockTimeOf(item.ts);
        return (
          <div data-slot="user-turn" class="rounded-md border border-status-working/25 bg-status-working/8 px-3 py-2">
            <div class="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-status-working uppercase">
              <Icon icon={User} class="size-3.5" />
              {t("transcript.youLabel")}
              {time && <span class="font-normal tabular-nums opacity-80">{time}</span>}
            </div>
            <p class="font-content text-sm break-words whitespace-pre-wrap">{item.text}</p>
          </div>
        );
      }
      case "reply":
        return <MarkdownText text={item.text} />;
      case "thinking":
        return <Disclosure label={t("chat.card.thinking")} text={item.text} italic />;
      case "notice": {
        const folds = item.note === true && (item.text.length > NOTICE_FOLD_CHARS || item.text.includes("\n"));
        if (!folds) return <p class="py-1 text-center text-xs text-muted-foreground">{item.text}</p>;
        return <Disclosure label={t("transcript.systemLabel")} text={item.text} />;
      }
      case "compacted":
        if (item.text === undefined) {
          const time = clockTimeOf(item.ts);
          return (
            <p class="py-1 text-center text-xs text-muted-foreground">
              {t("transcript.summaryLabel")}
              {time && ` · ${time}`}
            </p>
          );
        }
        return <Disclosure label={t("transcript.summaryLabel")} text={item.text} />;
      case "tool":
        return <ToolCard tool={item.tool} status={item.status} note={note} />;
    }
  };
}

/**
 * A run of steps. Folded to one summary row when it is finished; a run with a step still running
 * shows its newest {@link LIVE_TAIL} steps, the earlier ones behind one tap.
 */
export function ToolGroup(handle: Handle<{
  items: readonly ChatItem[];
  /** Settings → Appearance "Tool calls": off, a running run does not open itself (a tap still does). */
  liveOpens?: boolean;
  /** Per item id, a "waiting on the dialog below" note (web/src/lib/question-waiting.ts). */
  notes?: Readonly<Record<string, string>>;
}>) {
  let open = false;
  let held = false;
  const toggle = (next: boolean) => {
    open = next;
    void handle.update();
  };
  return () => {
    const { items, liveOpens = true, notes = NO_NOTES } = handle.props;
    const live = liveOpens && items.some((i) => (i.kind === "tool" && i.status === "running") || notes[i.id] !== undefined);
    // A run that was live on screen keeps its layout once it finishes, so the card is not pulled out
    // from under the eye.
    if (live) held = true;
    const summary = runSummary(items);
    if (open || live || (held && liveOpens)) {
      const firstWaiting = items.findIndex((i) => notes[i.id] !== undefined);
      const start = open ? 0 : Math.max(0, Math.min(items.length - LIVE_TAIL, firstWaiting >= 0 ? firstWaiting : items.length));
      return (
        <div data-slot="tool-group" class="flex flex-col gap-1.5">
          {open ? (
            <button type="button" aria-expanded class={cn(FOLD_ROW, "rounded-md border border-border")} mix={on("click", () => toggle(false))}>
              <Icon icon={ChevronRight} class="size-3.5 shrink-0 rotate-90" />
              <span class="min-w-0 truncate">{summary}</span>
            </button>
          ) : (
            start > 0 && (
              <button
                type="button"
                aria-expanded={false}
                class={cn(FOLD_ROW, "rounded-md border border-border")}
                mix={on("click", () => toggle(true))}
              >
                <Icon icon={ChevronRight} class="size-3.5 shrink-0" />
                <span class="min-w-0 truncate tabular-nums">{tn("chat.run.earlier", start, { summary })}</span>
              </button>
            )
          )}
          {items.slice(start).map((item) => (
            <ItemView key={item.id} item={item} note={notes[item.id]} />
          ))}
        </div>
      );
    }
    const tools = toolsOf(items);
    const last = tools[tools.length - 1];
    const step = last ? stepLine(last.tool) : null;
    const failed = failedCount(items);
    return (
      <button
        type="button"
        data-slot="tool-group"
        aria-expanded={false}
        class="flex min-h-11 w-full min-w-0 flex-col justify-center gap-0.5 rounded-md border border-border px-3 py-1.5 text-left active:bg-muted"
        mix={on("click", () => toggle(true))}
      >
        <span class="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon icon={ChevronRight} class="size-3.5 shrink-0" />
          <span class="min-w-0 truncate">{summary}</span>
          {failed > 0 && <BadBadge text={tn("chat.run.failed", failed)} />}
        </span>
        {step && (
          <span class="flex min-w-0 items-baseline gap-1.5 pl-5 text-xs text-muted-foreground">
            {step.verb && <span class="shrink-0">{step.verb}</span>}
            <span class={cn("min-w-0 truncate", step.mono ? "font-mono text-[11px]" : "font-content")}>{step.subject}</span>
          </span>
        )}
      </button>
    );
  };
}
