// The blocks of a session stream: user turns, replies, thinking, notices and tool cards.
//
// These draw a session as the agent's own record has it (`lib/chat-items.ts`), which is the half of
// Chat that a journal can feed. They came out of the session-stream prototype, where they were built
// against THESE primitives from the start — `MarkdownText` for agent prose, `DiffView` for a diff,
// `mirror-space` for command output, `OneOf` for every reserved slot — so the move changed the
// address and not the drawing.
//
// ── WHAT A CARD CANNOT DO ON ITS OWN, AND THE SLOT THAT SAYS SO ──────────────
// A card may have something waiting on it: a permission dialog, a question. Collie has no channel
// that can say so. A session log records that a dialog was ANSWERED, never that one is open, so file
// mode emits no such event and there is no collie code path that could fill it. The card therefore
// carries a {@link CardWaiting} SLOT that a host fills, and collie declares no `Ask`, no `Question`
// and no `Answer`: a seam with no caller is a guess (ADR 0073 point 8), and the first real dialog
// channel deserves to shape its own types rather than inherit a prototype's.
//
// ── TRANSLATED, SINCE THE SCREEN THAT MOUNTS THEM LANDED ────────────────────
// M41/10 left the copy here as English literals on purpose: nothing rendered these, so no operator
// could read a word of them. M41/11 mounts them (`components/session-stream.tsx`) and pays the debt
// it named — every string below is a `t()` key with an entry in all seven catalogues.
//
// EVERY COMPONENT HERE THAT CALLS `t()` ALSO CALLS `useLocale()`. That is the repo rule (CLAUDE.md
// → Frontend data layer) and it is load bearing twice over: `t()` reads a module store at call
// time, so a component needs a reason to render again when the answer changes — and two of these
// are `memo`, so a parent re-rendering is not that reason. What a card DRAWS is still never
// translated: a path, a command, a query, a URL, a sub-agent's name, a tool's own name and a
// harness's own name are the agent's words or the machine's, and they go through as they arrived.

import { createContext, memo, useContext, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRightLeft,
  Bot,
  ChevronRight,
  FilePlusCorner,
  FileText,
  Globe,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  User,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { DiffView, TokenLine, useSyntaxTokens } from "@/components/changes-view";
import { MarkdownText } from "@/components/markdown-text";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import { StatusDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { useLocale } from "@/hooks/use-locale";
import type { ChatItem, ChatToolCall, ChatToolStatus } from "@/lib/chat-items";
import { clockTime } from "@/lib/format";
import { t, tn, type PluralKey } from "@/lib/i18n";
import type { Hunk } from "@/lib/types";
import type { DiffRow } from "@/lib/unified-diff";
import { cn } from "@/lib/utils";

/**
 * How a harness spells its own name. Its own word, so it never goes through a dictionary.
 *
 * A `Map` rather than an object, because the caller's key is any string Herdr reported and a lookup
 * that has to widen its own table to accept one is a table that has stopped saying anything
 * (agent-icon-data.ts does the same, for the same reason).
 */
const HARNESS_LABELS = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "opencode"],
  ["pi", "pi"],
]);

/** The harness's own name for itself, or the key back when nobody has taught us one. */
export function harnessLabel(harness: string): string {
  return HARNESS_LABELS.get(harness) ?? harness;
}

// ---------- the host's slot ----------

/**
 * What a HOST has waiting on one tool card, and what it leaves behind when that is gone.
 *
 * Collie fills none of these, and that is the point: the ask path is ABSENT here rather than
 * dormant. A host that holds a live dialog channel supplies `id` and `body` while it waits, and
 * `note` in their place afterwards; the card owns the glide between the two so the blocks around it
 * never jump (DESIGN.md §11, hard rule 1).
 */
export interface CardWaiting {
  /** Names the waiting thing, for the `data-waiting` anchor a host scrolls to. */
  id?: string;
  /** Drawn on the card while it waits. The host owns its chrome; the card owns the glide. */
  body?: ReactNode;
  /** One line drawn in `body`'s place as it leaves, for a close the reader did not cause. */
  note?: string;
}

/**
 * Per item id, what a host has waiting on that item's card. Empty everywhere in collie.
 *
 * A context rather than a prop because {@link ToolGroup} renders its own {@link ItemView}s, so a
 * prop would have to be threaded through a component whose job has nothing to do with it.
 */
export const CardWaitingCtx = createContext<Record<string, CardWaiting>>({});

// ---------- items ----------

/**
 * Split the stream into single items and runs of consecutive tool items.
 *
 * `minRun` is where a run becomes a fold. Three by default: two steps side by side read as two
 * things that happened, and folding them buys a line and costs a tap.
 *
 * ONE means every step folds, including a lone one, and that is how "tool calls off" is drawn
 * (Settings → Appearance). The stream then carries one summary line where the cards were, which is
 * the same treatment collie's History page gives a turn's steps — one idea, one look, two surfaces.
 */
export function groupRuns(items: ChatItem[], minRun = 3): ChatItem[][] {
  const out: ChatItem[][] = [];
  let run: ChatItem[] = [];
  const flush = () => {
    if (run.length >= minRun) out.push(run);
    else for (const i of run) out.push([i]);
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "thinking") run.push(item);
    else {
      flush();
      out.push([item]);
    }
  }
  flush();
  return out;
}

/** A live run shows only its newest steps; the rest wait behind one tap. */
export const LIVE_TAIL = 6;

/**
 * A full-width fold row: the 44px tap floor as a drawn box (DESIGN.md §6), muted small chrome text,
 * the same shape as the pane's own "Show entire history" row (agent-chat.tsx).
 */
const FOLD_ROW =
  "flex min-h-11 w-full min-w-0 items-center justify-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export const ToolGroup = memo(
  function ToolGroup({ items }: { items: ChatItem[] }) {
    useLocale();
    const waiting = useContext(CardWaitingCtx);
    const live = items.some((i) => (i.kind === "tool" && i.status === "running") || waiting[i.id]);
    const [open, setOpen] = useState(false);
    // A run that was live on screen keeps its live layout once it finishes. Folding it the moment
    // its last step is done (the step the reader just allowed, say) would pull the card out from
    // under the eye: a state change may repaint, not re-lay-out (DESIGN.md §2). A run that was
    // already finished when the page drew it opens folded, as before.
    const [held, setHeld] = useState(false);
    if (live && !held) setHeld(true);
    const tools = items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool");
    // `step`, not `t` — `t` is the translator in this file now.
    const count = (k: string) => tools.filter((step) => step.tool.kind === k).length;
    // Each kind is counted on its own and read through `tn()`, so every part of the summary is a
    // whole noun phrase in its own language rather than a number glued to a word.
    const parts: readonly (readonly [number, PluralKey])[] = [
      [count("execute"), "chat.run.commands"],
      [count("edit"), "chat.run.edits"],
      [count("read"), "chat.run.reads"],
      [count("search") + count("fetch"), "chat.run.searches"],
      [count("task"), "chat.run.agents"],
      [count("other") + count("delete") + count("move"), "chat.run.others"],
    ];
    const summary = parts
      .filter(([n]) => n > 0)
      .map(([n, key]) => tn(key, n))
      .join(", ");
    const failed = tools.filter((step) => step.status === "failed" || step.status === "denied").length;
    if (open || live || held) {
      const firstWaiting = items.findIndex((i) => waiting[i.id]);
      const start = open
        ? 0
        : Math.max(0, Math.min(items.length - LIVE_TAIL, firstWaiting >= 0 ? firstWaiting : items.length));
      return (
        <div className="flex flex-col gap-1.5">
          {open ? (
            <button
              type="button"
              aria-expanded
              className={cn(FOLD_ROW, "justify-start rounded-md border border-border")}
              onClick={() => setOpen(false)}
            >
              <ChevronRight className="size-3.5 shrink-0 rotate-90" />
              <span className="min-w-0 truncate">{summary}</span>
            </button>
          ) : (
            start > 0 && (
              <button
                type="button"
                aria-expanded={false}
                className={cn(FOLD_ROW, "justify-start rounded-md border border-border")}
                onClick={() => setOpen(true)}
              >
                <ChevronRight className="size-3.5 shrink-0" />
                {/* `tabular-nums` on the whole run rather than on one span: the sentence is one
                    message now, and every number in it (the count and the summary's own) steps. */}
                <span className="min-w-0 truncate tabular-nums">{tn("chat.run.earlier", start, { summary })}</span>
              </button>
            )
          )}
          {items.slice(start).map((i) => (
            <ItemView key={i.id} item={i} />
          ))}
        </div>
      );
    }
    const last = tools[tools.length - 1];
    const step = last ? stepLine(last.tool) : null;
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full min-w-0 flex-col justify-center gap-0.5 rounded-md border border-border px-3 py-1.5 text-left transition-colors active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{summary}</span>
          {failed > 0 && <BadBadge>{tn("chat.run.failed", failed)}</BadBadge>}
        </span>
        {step && (
          <span className="flex min-w-0 items-baseline gap-1.5 pl-5 text-xs text-muted-foreground">
            {step.verb && <span className="shrink-0">{step.verb}</span>}
            <span className={cn("min-w-0 truncate", step.mono ? "font-mono text-[11px]" : "font-content")}>
              {step.subject}
            </span>
          </span>
        )}
      </button>
    );
  },
  // The waiting slot arrives through a context, and a context change re-renders its consumers
  // whatever this says, so the comparator only has to answer for the items.
  (a, b) => a.items.length === b.items.length && a.items.every((x, k) => x === b.items[k]),
);

/**
 * One step in a few words: a verb in chrome type and the subject it acted on.
 *
 * `mono` says which face the subject wears — a path, a command or a query is mono, and a sentence an
 * agent wrote is prose (DESIGN.md §5).
 */
export interface StepLine {
  verb: string;
  subject: string;
  mono: boolean;
}

/** One step, in a few words, for a folded run and for a host's own chrome. */
export function stepLine(call: ChatToolCall): StepLine {
  switch (call.kind) {
    case "edit":
      return { verb: t(call.created ? "chat.step.created" : "chat.step.edited"), subject: shortPath(call.path), mono: true };
    case "execute":
      return call.description
        ? { verb: "", subject: call.description, mono: false }
        : { verb: "$", subject: call.command.split("\n")[0]!, mono: true };
    case "read":
      return { verb: t("chat.step.read"), subject: shortPath(call.path), mono: true };
    case "search":
      return { verb: t("chat.step.searched"), subject: call.query, mono: true };
    case "fetch":
      return { verb: t("chat.step.fetched"), subject: call.url, mono: true };
    // A sub-agent's name and a tool's own name are the harness's vocabulary, never a dictionary's.
    case "task":
      return { verb: `${call.agent}:`, subject: call.summary, mono: false };
    case "other":
      return { verb: `${call.name}:`, subject: call.summary.split("\n")[0] ?? "", mono: false };
    case "delete":
      return { verb: t("chat.step.deleted"), subject: shortPath(call.path), mono: true };
    case "move":
      return { verb: t("chat.step.moved"), subject: shortPath(call.path), mono: true };
  }
}

export const ItemView = memo(function ItemView({ item }: { item: ChatItem }) {
  useLocale();
  const waiting = useContext(CardWaitingCtx)[item.id];
  switch (item.kind) {
    case "user":
      return <UserTurn text={item.text} ts={item.ts} />;
    case "reply":
      // Agent prose: MarkdownText wears `font-content`, never the app face (DESIGN.md §5).
      return <MarkdownText text={item.text} />;
    case "thinking":
      return (
        <Disclosure label={t("chat.card.thinking")} icon={ChevronRight}>
          {() => <MarkdownText text={item.text} className="px-5 pb-1 italic text-muted-foreground" />}
        </Disclosure>
      );
    case "notice":
      return <p className="py-1 text-center text-xs text-muted-foreground">{item.text}</p>;
    case "tool":
      return <ToolCard tool={item.tool} status={item.status} waiting={waiting} />;
  }
});

/**
 * The reader's own turn, as collie's transcript draws one (transcript-view.tsx): a bordered well
 * with a "You" caption. The caption is chrome; the words are content (`font-content`, §5).
 *
 * ── AND IT IS THE ONE THING ON THE PAGE WITH A COLOUR ──
 * A `bg-muted/50` well was a grey box in a column of grey boxes: a reader scrolling back for "what
 * did I actually ask" had to READ each block to find their own. The wash is `status-working`, the
 * brand's orange, so the reader's own turns are findable at a glance and at arm's length.
 *
 * ORANGE AND NOT THE INFO BLUE, which was the first cut. Inline code wears that blue now
 * (markdown-text.tsx), and History draws Markdown inside a user turn, so a chip would have landed
 * on a ground of its own hue and had only its edge left to separate it. Two colours, two jobs: the
 * blue is "this is literal", the orange is "this is yours".
 */
function UserTurn({ text, ts }: { text: string; ts?: string }) {
  const time = ts ? clockTimeOf(ts) : "";
  return (
    <div className="rounded-md border border-status-working/25 bg-status-working/8 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-status-working">
        <User className="size-3.5" />
        {/* The transcript's own word for the reader, so History and Chat never disagree. */}
        {t("transcript.youLabel")}
        {time && <span className="font-normal tabular-nums opacity-80">{time}</span>}
      </div>
      <p className="font-content whitespace-pre-wrap break-words text-sm">{text}</p>
    </div>
  );
}

function clockTimeOf(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : clockTime(ms);
}

/**
 * A fold whose body enters the DOM only while it is open. The row is the 44px floor as a drawn box;
 * opening it is a shift the reader caused and watches (DESIGN.md §2, allowed case a).
 */
export function Disclosure({
  label,
  icon: Icon,
  children,
}: {
  label: ReactNode;
  icon: LucideIcon;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(FOLD_ROW, "justify-start px-0")}>
        <Icon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && children()}
    </div>
  );
}

// ---------- tool cards ----------

/** The red chip the status palette draws for a fault (status-badge.tsx's `blocked` chip). */
function BadBadge({ children }: { children: string }) {
  return (
    <Badge variant="outline" className="border-status-blocked/30 bg-status-blocked/15 text-status-blocked">
      {children}
    </Badge>
  );
}

/**
 * A tool's state at the end of its head row. Every state it can show is rendered in ONE grid cell
 * (`ui/one-of.tsx`), so the slot is as wide as the widest of them in every state and a card going
 * from running to done repaints and never moves its path (DESIGN.md §2, "a reserved slot").
 */
function StatusSlot({ status, exitCode }: { status: ChatToolStatus; exitCode?: number }) {
  const exit = exitCode != null && exitCode !== 0 ? t("chat.card.status.exit", { code: exitCode }) : null;
  const active =
    status === "running" ? "running" : status === "failed" || status === "denied" ? status : exit ? "exit" : null;
  return (
    <OneOf
      active={active}
      className="shrink-0 items-center justify-items-end"
      options={[
        {
          key: "running",
          node: <StatusDot status="working" live label={t("chat.card.status.running")} className="size-2" />,
        },
        { key: "failed", node: <BadBadge>{t("chat.card.status.failed")}</BadBadge> },
        { key: "denied", node: <BadBadge>{t("chat.card.status.denied")}</BadBadge> },
        ...(exit ? [{ key: "exit", node: <BadBadge>{exit}</BadBadge> }] : []),
      ]}
    />
  );
}

const KIND_ICON = {
  edit: Pencil,
  execute: SquareTerminal,
  read: FileText,
  search: Search,
  fetch: Globe,
  task: Bot,
  other: Wrench,
  delete: Trash2,
  move: ArrowRightLeft,
} satisfies Record<ChatToolCall["kind"], LucideIcon>;

/** A card's head row: glyph, the kind as a chrome word, the subject, the state slot. */
function ToolHead({
  icon: Icon,
  label,
  children,
  trailing,
  status,
  exitCode,
}: {
  icon: LucideIcon;
  label: string;
  children?: ReactNode;
  trailing?: ReactNode;
  status: ChatToolStatus;
  exitCode?: number;
}) {
  return (
    <div className="flex min-h-9 min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {trailing}
      <StatusSlot status={status} exitCode={exitCode} />
    </div>
  );
}

/** A path as collie's Changes view draws one: the folder muted, the file name in full ink, mono. */
export function PathLabel({ path, className }: { path: string; className?: string }) {
  const short = shortPath(path);
  const cut = short.lastIndexOf("/");
  return (
    <span className={cn("flex min-w-0 font-mono text-[11px]", className)} title={path}>
      {cut >= 0 && <span className="min-w-0 truncate text-muted-foreground">{short.slice(0, cut + 1)}</span>}
      <span className="max-w-full shrink-0 truncate font-medium text-foreground">{short.slice(cut + 1)}</span>
    </span>
  );
}

/**
 * The host's part of a card, and the glide it arrives and leaves on.
 *
 * Both halves go through `Collapse` (DESIGN.md §11, hard rule 1), so the blocks around the card
 * glide rather than jump. The note takes the body's place as the body leaves, which is why they are
 * two collapses and not one: the two move together.
 */
function WaitingArea({ waiting, line }: { waiting?: CardWaiting; line?: boolean }) {
  const body = waiting?.body;
  const note = waiting?.note;
  return (
    <>
      <Collapse open={body !== undefined}>{body}</Collapse>
      <Collapse open={body === undefined && note !== undefined}>
        {note && (
          <p
            className={cn(
              "flex items-start gap-2 text-xs text-muted-foreground",
              line ? "px-2 pb-1.5" : "border-t border-border px-3 py-2.5",
            )}
          >
            <SquareTerminal className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0">{note}</span>
          </p>
        )}
      </Collapse>
    </>
  );
}

export function ToolCard({
  tool,
  status,
  waiting,
  preview,
}: {
  tool: ChatToolCall;
  status: ChatToolStatus;
  waiting?: CardWaiting;
  preview?: boolean;
}) {
  useLocale();
  // `data-waiting` lets a host find the card of the thing it is waiting on (scroll to it, see if it
  // is on screen).
  const anchor = waiting?.id;
  // A card waiting on the reader recolours the edge it always has (DESIGN.md §2): the border is in
  // every card's base, so the body arriving changes paint, not the box.
  const held = waiting?.body !== undefined && "border-status-blocked";
  switch (tool.kind) {
    case "edit":
      return (
        <Card data-waiting={anchor} className={cn("gap-0 overflow-hidden py-0", held)}>
          <ToolHead
            icon={tool.created ? FilePlusCorner : Pencil}
            label={t(tool.created ? "chat.card.create" : "chat.card.edit")}
            status={status}
            trailing={
              <span className="shrink-0 font-mono text-xs tabular-nums">
                <span className="text-status-done">+{tool.added}</span>{" "}
                <span className="text-status-blocked">−{tool.removed}</span>
              </span>
            }
          >
            <PathLabel path={tool.path} />
          </ToolHead>
          {tool.diff && tool.diff.length > 0 && (
            <HunkDiff hunks={tool.diff} path={tool.path} limit={preview ? 30 : 16} />
          )}
          <WaitingArea waiting={waiting} />
        </Card>
      );
    case "execute":
      return (
        <Card data-waiting={anchor} className={cn("gap-0 overflow-hidden py-0", held)}>
          <ToolHead icon={SquareTerminal} label={t("chat.card.run")} status={status} exitCode={tool.exitCode}>
            {tool.description && (
              <span className="font-content min-w-0 truncate text-muted-foreground">{tool.description}</span>
            )}
          </ToolHead>
          <CommandBlock command={tool.command} output={tool.output} preview={preview} />
          <WaitingArea waiting={waiting} />
        </Card>
      );
    case "read":
      return (
        <LineTool anchor={anchor} icon={FileText} label={t("chat.card.read")} status={status} waiting={waiting}>
          <PathLabel path={tool.path} />
          {tool.range && (
            <span className="shrink-0 pl-1.5 text-muted-foreground tabular-nums">
              {t("chat.card.lines", { from: tool.range[0], to: tool.range[1] })}
            </span>
          )}
        </LineTool>
      );
    case "search":
    case "fetch":
    case "task":
    case "other":
    case "delete":
    case "move": {
      // `tool.name` is the tool's own name, reported by the harness — the one label here that is
      // not Collie's word and therefore not a key.
      const label =
        tool.kind === "search"
          ? t("chat.card.search")
          : tool.kind === "fetch"
            ? t("chat.card.fetch")
            : tool.kind === "task"
              ? t("chat.card.agent", { agent: tool.agent })
              : tool.kind === "other"
                ? tool.name
                : tool.kind === "delete"
                  ? t("chat.card.delete")
                  : t("chat.card.move");
      const output = "output" in tool ? tool.output : undefined;
      // What an agent or a machine wrote: a query, a URL or a path is mono; a summary is prose, so
      // it wears the content face (DESIGN.md §5).
      const subject =
        tool.kind === "search" ? (
          // The query is what was searched, so it keeps its width; the folder gives way first.
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="max-w-[70%] shrink-0 truncate font-mono text-[11px]">{tool.query}</span>
            {tool.where && (
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {t("chat.card.searchIn", { where: shortPath(tool.where) })}
              </span>
            )}
          </span>
        ) : tool.kind === "fetch" ? (
          <span className="min-w-0 truncate font-mono text-[11px]">{tool.url}</span>
        ) : tool.kind === "delete" ? (
          <PathLabel path={tool.path} />
        ) : tool.kind === "move" ? (
          <span className="min-w-0 truncate font-mono text-[11px]">
            {shortPath(tool.path)} → {shortPath(tool.to ?? "")}
          </span>
        ) : !("summary" in tool) || tool.summary.includes("\n") ? null : (
          <span className="font-content min-w-0 truncate text-muted-foreground">{tool.summary}</span>
        );
      const body = (tool.kind === "task" || tool.kind === "other") && tool.summary.includes("\n") ? tool.summary : null;
      return (
        <LineTool
          anchor={anchor}
          icon={KIND_ICON[tool.kind]}
          label={label}
          status={status}
          output={output}
          body={body}
          waiting={waiting}
        >
          {subject}
        </LineTool>
      );
    }
  }
}

/**
 * A one-line tool: glyph, kind, subject. A row with output behind it is a button at the 44px floor;
 * a row with nothing to open is a plain line, so a run of reads stays dense. The edge is reserved
 * transparent in every state and recoloured while something waits on it (DESIGN.md §2).
 */
function LineTool({
  anchor,
  icon: Icon,
  label,
  status,
  output,
  body,
  waiting,
  children,
}: {
  anchor?: string;
  icon: LucideIcon;
  label: string;
  status: ChatToolStatus;
  output?: string;
  body?: string | null;
  waiting?: CardWaiting;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const row = (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      <StatusSlot status={status} />
      {output !== undefined && (
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      )}
    </>
  );
  return (
    <div
      data-waiting={anchor}
      className={cn("rounded-md border border-transparent", waiting?.body !== undefined && "border-status-blocked bg-card")}
    >
      {output !== undefined ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs transition-colors active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {row}
        </button>
      ) : (
        <div className="flex min-h-7 min-w-0 items-center gap-2 px-2 text-xs">{row}</div>
      )}
      {body && <p className="font-content whitespace-pre-wrap break-words px-2 pb-1.5 text-sm">{body}</p>}
      {open && output !== undefined && (
        <pre className="mx-2 mb-2 max-h-80 overflow-auto rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words">
          {output}
        </pre>
      )}
      <WaitingArea waiting={waiting} line />
    </div>
  );
}

/**
 * The command and its output in collie's mirror look: dark under every theme and inverted in light
 * (DESIGN.md §8, ADR 0002, `components/mirror-space.ts`). Inside it every colour is a dark-space
 * literal, never a token and never a `dark:` variant. The fold controls around it are app chrome.
 */
function CommandBlock({ command, output, preview }: { command: string; output?: string; preview?: boolean }) {
  const [open, setOpen] = useState(Boolean(preview));
  const [all, setAll] = useState(false);
  const lines = output ? output.replace(/\n+$/, "").split("\n") : [];
  const TAIL = 10;
  const shown = all ? lines : lines.slice(-TAIL);
  return (
    <>
      <div className={cn("mx-2 mb-2 overflow-hidden rounded-md font-mono text-[11px] leading-[1.4]", MIRROR_SPACE, MIRROR_INVERT)}>
        <div className="px-2.5 py-2">
          <div className="line-clamp-6 whitespace-pre-wrap break-words">
            <span className="text-[#23d18b]">$</span> {command}
          </div>
        </div>
        {open && lines.length > 0 && (
          <pre className="m-0 overflow-x-auto border-t border-white/10 px-2.5 py-2 whitespace-pre">{shown.join("\n")}</pre>
        )}
      </div>
      {/* Output that arrives after the card is on screen (the run the reader just allowed) slides
          its fold row in through Collapse; a card drawn with its output already has it at once. */}
      <Collapse open={lines.length > 0}>
        <div className="flex border-t border-border">
          {/* `tabular-nums` rides the whole row: the line count is one message now, so there is no
              span to hang it on, and the count steps as output arrives (DESIGN.md §5). */}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={cn(FOLD_ROW, "flex-1 tabular-nums")}
          >
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
            {open ? t("chat.card.output.hide") : tn("chat.card.output.show", lines.length)}
          </button>
          {open && lines.length > TAIL && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              className={cn(FOLD_ROW, "flex-1 border-l border-border tabular-nums")}
            >
              {all ? t("chat.card.output.showLast", { count: TAIL }) : tn("chat.card.output.showAll", lines.length)}
            </button>
          )}
        </div>
      </Collapse>
    </>
  );
}

const HUNK_HEADER = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/;

/** The hunks as unified-diff text for collie's DiffView, or null when a hunk has no line numbers. */
function numberedDiff(hunks: Hunk[], limit: number): string | null {
  const out: string[] = [];
  let left = limit;
  for (const h of hunks) {
    const m = HUNK_HEADER.exec(h.header);
    if (!m) return null;
    if (left <= 0) continue;
    // opencode names the file before the `@@` when an edit spans files; it stays in the row.
    const file = h.header.slice(0, m.index).trim();
    out.push(file ? `${m[0]} ${file}` : m[0]);
    const take = h.lines.slice(0, left);
    out.push(...take);
    left -= take.length;
  }
  return out.join("\n");
}

/**
 * A diff. With numbered hunks it is collie's own `DiffView` (changes-view.tsx: two gutters, the
 * +/− tints, syntax colour). Some harnesses send hunks with no line numbers (a before/after pair
 * the adapter diffed itself); DiffView needs numbers for its gutters, so those draw with the same
 * row tints and signs and no gutter, rather than with invented numbers.
 */
function HunkDiff({ hunks, path, limit }: { hunks: Hunk[]; path: string; limit: number }) {
  const [open, setOpen] = useState(false);
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  const max = open ? total : limit;
  const text = useMemo(() => numberedDiff(hunks, max), [hunks, max]);
  return (
    <div className="border-t border-border">
      {text !== null ? <DiffView diff={text} path={path} /> : <PlainDiff hunks={hunks} path={path} limit={max} />}
      {/* The same sentence a command's output fold says, so one message serves both. */}
      {total > limit && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(FOLD_ROW, "border-t border-border tabular-nums")}
        >
          {open ? t("chat.card.diff.less") : tn("chat.card.output.showAll", total)}
        </button>
      )}
    </div>
  );
}

const ROW_TONE = { "+": "bg-status-done/12", "-": "bg-status-blocked/12", " ": "" } as const;
const SIGN_TONE = { "+": "text-status-done", "-": "text-status-blocked", " ": "" } as const;

/** A `sign` as the row kind collie's highlighter reads. It never looks at a line number. */
const ROW_KIND = { "+": "add", "-": "del", " ": "context" } as const;

type PlainRow = { sep: true } | { sign: "+" | "-" | " "; text: string };

/**
 * A diff with no line numbers, drawn with the same row tints, the same signs and the SAME syntax
 * colour as `DiffView` above it. The gutters are the only thing missing, because they are the only
 * thing the numbers were for.
 *
 * The colour comes from collie's own `useSyntaxTokens` and `TokenLine` (changes-view.tsx), fed rows
 * this builds itself: `highlightRows` reads a row's `kind` and `text` and nothing else, so the
 * absent numbers cost nothing. Importing the hook rather than copying it is what keeps one token
 * kind on one colour wherever Collie draws a diff.
 */
function PlainDiff({ hunks, path, limit }: { hunks: Hunk[]; path: string; limit: number }) {
  const rows = useMemo<PlainRow[]>(() => {
    const out: PlainRow[] = [];
    let left = limit;
    hunks.forEach((h, k) => {
      if (left <= 0) return;
      if (k > 0) out.push({ sep: true });
      for (const l of h.lines.slice(0, left)) {
        const s = l[0];
        out.push({ sign: s === "+" || s === "-" ? s : " ", text: l.slice(1) });
      }
      left -= h.lines.length;
    });
    return out;
  }, [hunks, limit]);
  // A separator stands in for a `hunk` row, which is how the engine knows where one hunk ends: it
  // tokenizes each hunk's two sides on their own, so a gap between them must break the run.
  const diffRows = useMemo<DiffRow[]>(
    () =>
      rows.map((r) =>
        "sep" in r
          ? { kind: "hunk", header: "", oldStart: 0, newStart: 0 }
          : { kind: ROW_KIND[r.sign], oldNo: null, newNo: null, text: r.text },
      ),
    [rows],
  );
  const syntax = useSyntaxTokens(diffRows, path);
  return (
    <div className="font-mono text-xs leading-5 [font-variant-ligatures:none]">
      {rows.map((r, i) =>
        "sep" in r ? (
          <div key={i} className="border-y border-border px-3 py-1 text-muted-foreground">
            ⋯
          </div>
        ) : (
          <div key={i} className={cn("flex pl-1", ROW_TONE[r.sign])}>
            <span aria-hidden className={cn("w-[2ch] shrink-0 select-none text-center", SIGN_TONE[r.sign])}>
              {r.sign === "-" ? "−" : r.sign}
            </span>
            <span className="min-w-0 flex-1 pr-3 wrap-anywhere whitespace-pre-wrap">
              {syntax?.[i] ? <TokenLine tokens={syntax[i]} /> : r.text || " "}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

// ---------- helpers ----------

/** An absolute path under a home directory, shortened to `~`. */
export function shortPath(p: string): string {
  return p.replace(/^\/var\/home\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
