// The Chat stream's pure helpers: how a run of steps folds, and how one step reads in a few words.
// Ports of `groupRuns`, `stepLine`, `shortPath` and the fold summary from
// web/src/components/chat-cards.tsx, which keeps them inside a React file. The items themselves come
// from web/src/lib/chat-items.ts (`itemsOf`), read-only and unchanged.
import type { ChatItem, ChatToolCall } from "@web/lib/chat-items";
import { t, tn, type PluralKey } from "@web/lib/i18n";

/**
 * Split the stream into single items and runs of consecutive tool and thinking items. A run of at
 * least `minRun` becomes one fold; a shorter one stays as single items.
 */
export function groupRuns(items: readonly ChatItem[], minRun = 3): ChatItem[][] {
  const out: ChatItem[][] = [];
  let run: ChatItem[] = [];
  const flush = (): void => {
    if (run.length >= minRun) out.push(run);
    else for (const item of run) out.push([item]);
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

/** An absolute path under a home directory, shortened to `~`. */
export function shortPath(p: string): string {
  return p.replace(/^\/var\/home\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

export interface StepLine {
  verb: string;
  subject: string;
  /** A path, a command or a query is mono; a sentence an agent wrote is prose. */
  mono: boolean;
}

/** One step, in a few words. A tool's own name and a sub-agent's name are the harness's words. */
export function stepLine(call: ChatToolCall): StepLine {
  switch (call.kind) {
    case "edit":
      return { verb: t(call.created ? "chat.step.created" : "chat.step.edited"), subject: shortPath(call.path), mono: true };
    case "execute":
      return call.description
        ? { verb: "", subject: call.description, mono: false }
        : { verb: "$", subject: call.command.split("\n")[0] ?? "", mono: true };
    case "read":
      return { verb: t("chat.step.read"), subject: shortPath(call.path), mono: true };
    case "search":
      return { verb: t("chat.step.searched"), subject: call.query, mono: true };
    case "fetch":
      return { verb: t("chat.step.fetched"), subject: call.url, mono: true };
    case "task":
      return { verb: `${call.agent}:`, subject: call.summary, mono: false };
    case "question":
    case "other":
      return { verb: `${call.name}:`, subject: call.summary.split("\n")[0] ?? "", mono: false };
    case "delete":
      return { verb: t("chat.step.deleted"), subject: shortPath(call.path), mono: true };
    case "move":
      return { verb: t("chat.step.moved"), subject: shortPath(call.path), mono: true };
  }
}

/** The label a tool card's head row wears: Collie's word for the kind, or the tool's own name. */
export function toolLabel(call: ChatToolCall): string {
  switch (call.kind) {
    case "edit":
      return t(call.created ? "chat.card.create" : "chat.card.edit");
    case "execute":
      return t("chat.card.run");
    case "read":
      return t("chat.card.read");
    case "search":
      return t("chat.card.search");
    case "fetch":
      return t("chat.card.fetch");
    case "task":
      return t("chat.card.agent", { agent: call.agent });
    case "question":
      return t("chat.tool.question");
    case "other":
      return call.name;
    case "delete":
      return t("chat.card.delete");
    case "move":
      return t("chat.card.move");
  }
}

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** The tool items of a run. */
export function toolsOf(items: readonly ChatItem[]): ToolItem[] {
  return items.filter((i): i is ToolItem => i.kind === "tool");
}

/** A folded run's summary: each kind counted on its own and read as a whole noun phrase. */
export function runSummary(items: readonly ChatItem[]): string {
  const tools = toolsOf(items);
  const count = (kind: ChatToolCall["kind"]): number => tools.filter((step) => step.tool.kind === kind).length;
  const parts: readonly (readonly [number, PluralKey])[] = [
    [count("execute"), "chat.run.commands"],
    [count("edit"), "chat.run.edits"],
    [count("read"), "chat.run.reads"],
    [count("search") + count("fetch"), "chat.run.searches"],
    [count("task"), "chat.run.agents"],
    [count("other") + count("question") + count("delete") + count("move"), "chat.run.others"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, key]) => tn(key, n))
    .join(", ");
}

/** How many steps of a run failed or were denied. */
export function failedCount(items: readonly ChatItem[]): number {
  return toolsOf(items).filter((step) => step.status === "failed" || step.status === "denied").length;
}
