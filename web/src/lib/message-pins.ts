// Pinned messages on the phone (M90): the pure rules, in one place so the stream, the sheets and the hook
// agree on them.
//
// A pin is a COPY the bridge that owns the pane keeps of one Chat block (bridge/pins). The phone names a
// block by its Chat item id (lib/chat-items.ts) and never sends text. Nothing here touches the DOM or React,
// so every rule is table-testable.

import { apiErrorFields, apiErrorStatus } from "./api";
import { describeThrownError } from "./api-error-message";
import type { ChatItem } from "./chat-items";
import { t } from "./i18n";
import { compareSemver } from "./semver";
import type { PinFull, PinKind, PinRow, ToolCall } from "./types";

/** The first Collie release whose bridge keeps pins. A pane on an older machine has no pins route. */
export const PINS_SINCE = "1.28.0";

/**
 * Whether the machine that owns a pane keeps pins, from the version it reports.
 *
 * `undefined` is "not known (yet)", and reads as yes: the phone offers Pin and lets the machine answer. An
 * older machine's answer is a plain 404 with no `pin.*` code, which {@link pinFailure} words as "that
 * machine's Collie is older". Only the numeric core decides, so `1.28.0-edge.1` already keeps pins.
 */
export function hostKeepsPins(version: string | undefined): boolean {
  if (version === undefined) return true;
  const core = /^\d+\.\d+\.\d+/.exec(version.trim());
  if (core === null) return true;
  return compareSemver(core[0], PINS_SINCE) >= 0;
}

/**
 * Whether a Chat block can be pinned: its text, a reply, a thinking block, a notice or a tool card. Not a
 * picture, not the compaction marker (decision 5), not a text the program is still writing, which is
 * pinnable only once it settles (decision 8), and not a tool call that is still running. `partial` marks a
 * growing text on a durable pane only; {@link writingItemId} names the one a normal pane is writing.
 */
export function isPinnable(item: ChatItem): boolean {
  switch (item.kind) {
    case "image":
    case "compacted":
      return false;
    case "user":
      return true;
    case "reply":
    case "thinking":
    case "notice":
      return item.partial !== true;
    case "tool":
      return item.status !== "running";
  }
}

/**
 * The id of the item the agent is still writing, on a pane that does not mark it `partial`: the LAST reply or
 * thinking block of the stream while the agent is working, the same fact the stream draws its cursor from. A block
 * after it (a tool call, a person's line) means the text is done. `undefined` when the agent is idle or the stream
 * ends in anything else.
 */
export function writingItemId(blocks: readonly (readonly ChatItem[])[], working: boolean): string | undefined {
  if (!working) return undefined;
  const last = blocks.at(-1)?.at(-1);
  if (last === undefined) return undefined;
  return last.kind === "reply" || last.kind === "thinking" ? last.id : undefined;
}

/** The kind a pin of this block is filed under. Only called for a pinnable block. */
export function pinKindOf(item: ChatItem): PinKind {
  if (item.kind === "image" || item.kind === "compacted") return "notice";
  return item.kind;
}

/** A tool call's name in a few words, for a sheet title: the tool's own word where the call has one. */
export function toolNameOf(call: ToolCall): string {
  switch (call.kind) {
    case "other":
    case "question":
    case "plan":
      return call.name;
    case "task":
      return call.agent ?? t("chat.card.agentPlain");
    case "execute":
      return call.command.trim().split(/\s+/)[0] ?? call.command;
    case "edit":
      return t(call.created ? "chat.step.created" : "chat.step.edited");
    case "read":
      return t("chat.step.read");
    case "search":
      return t("chat.step.searched");
    case "fetch":
      return t("chat.step.fetched");
    case "delete":
      return t("chat.step.deleted");
    case "move":
      return t("chat.step.moved");
  }
}

/** The one-line gist of a tool call's input, as Chat's folded line shows it. */
function toolGist(call: ToolCall): string {
  switch (call.kind) {
    case "other":
    case "question":
    case "task":
      return call.summary;
    case "execute":
      return call.description ?? call.command;
    case "edit":
    case "read":
    case "delete":
    case "move":
      return call.path;
    case "search":
      return call.query;
    case "fetch":
      return call.url;
    case "plan":
      return call.name;
  }
}

/** "Tool: git", or the plain word "Tool" for a call that carries no name, never "Tool: ". */
function toolTitle(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? t("pins.sheet.kind.toolPlain") : t("pins.sheet.kind.tool", { name: trimmed });
}

/** The title of a block's actions sheet: what the block is, in words. */
export function itemTitle(item: ChatItem): string {
  if (item.kind === "tool") return toolTitle(toolNameOf(item.tool));
  return t(`pins.sheet.kind.${pinKindOf(item)}`, { name: "" });
}

/** The words Copy puts on the clipboard for a block: its text, a tool card's step line and what it printed. */
export function itemCopyText(item: ChatItem): string {
  switch (item.kind) {
    case "user":
    case "reply":
    case "thinking":
    case "notice":
      return item.text;
    case "compacted":
      return item.text ?? "";
    case "image":
      return "";
    case "tool": {
      const printed = "output" in item.tool && item.tool.output !== undefined ? item.tool.output : "";
      return [`${toolNameOf(item.tool)}: ${toolGist(item.tool)}`, printed].filter((part) => part !== "").join("\n");
    }
  }
}

/** The title of a pin: its kind in words, a tool card by its name. */
export function pinTitle(pin: Pick<PinRow, "kind" | "tool">): string {
  if (pin.kind === "tool") return toolTitle(pin.tool?.name ?? "");
  return t(`pins.sheet.kind.${pin.kind}`, { name: "" });
}

/**
 * A pin as the block Chat draws it, so the detail layer reads like Chat. A thinking block and a notice
 * are drawn as prose here: Chat folds both behind a label, and a detail view that opened on a closed
 * label would show nothing to read.
 */
export function pinAsItem(pin: PinFull): ChatItem {
  const base = { id: pin.itemId, ts: pin.ts };
  if (pin.kind === "user") return { ...base, kind: "user", text: pin.text };
  if (pin.kind === "tool") {
    const call: ToolCall = { kind: "other", name: pin.tool?.name ?? "", summary: pin.tool?.input ?? "" };
    return { ...base, kind: "tool", tool: pin.text === "" ? call : { ...call, output: pin.text }, status: "done" };
  }
  return { ...base, kind: "reply", text: pin.text };
}

/** The pins list as the stream wants it: Chat item id to pin id. A block being pinned maps to `""`. */
export function pinnedByItem(rows: readonly PinRow[], pending: ReadonlySet<string>): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const itemId of pending) map.set(itemId, "");
  for (const row of rows) map.set(row.itemId, row.id);
  return map;
}

/** Newest first, as the bridge sends them and as the sheet draws them. */
export function newestFirst(rows: readonly PinRow[]): PinRow[] {
  return rows.toSorted((a, b) => b.pinnedAt - a.pinnedAt);
}

/** A full pin's row: the list's own shape for a pin the phone has just made. */
export function rowOf(pin: PinFull, excerptChars = 400): PinRow {
  const { text, ...rest } = pin;
  return { ...rest, excerpt: text.slice(0, excerptChars), textLength: text.length };
}

/**
 * The block a pin leads back to among the blocks Chat holds, as an index into them, or -1 when it is not
 * loaded. The id first; when the id changed (a log rewritten under the same session) the first text of a
 * block that begins with the pin's anchor, which is the first 80 characters the bridge kept.
 */
export function blockOfPin(blocks: readonly (readonly ChatItem[])[], pin: Pick<PinRow, "itemId" | "anchor">): number {
  const byId = blocks.findIndex((group) => group.some((item) => item.id === pin.itemId));
  if (byId >= 0) return byId;
  if (pin.anchor === "") return -1;
  return blocks.findIndex((group) =>
    group.some((item) => "text" in item && item.text !== undefined && item.text.startsWith(pin.anchor)),
  );
}

const REASONS = {
  "pin.no_session": "pins.reason.noSession",
  "pin.item_not_found": "pins.reason.notFound",
  "pin.not_found": "pins.reason.gone",
  "pin.not_pinnable": "pins.reason.notPinnable",
  "pin.not_settled": "pins.reason.notSettled",
  "pin.cap": "pins.reason.cap",
} as const;

function isReasonCode(code: string | undefined): code is keyof typeof REASONS {
  return code !== undefined && Object.hasOwn(REASONS, code);
}

/**
 * Why a pin call failed, in the operator's language.
 *
 * A body with a `pin.*` code is the machine's own refusal. A 404 with NO code is the plain-text answer of a
 * machine whose Collie predates the route (CREW_PROTOCOL.md: the phone reads it as "update that machine"),
 * and the two are told apart by the code and nothing else. Every other failure takes the catalogue's wording.
 */
export function pinFailure<TThrown>(thrown: TThrown): string {
  const fields = apiErrorFields(thrown);
  if (isReasonCode(fields?.code)) return t(REASONS[fields.code]);
  if (apiErrorStatus(thrown) === 404) return t("pins.reason.olderBridge");
  return describeThrownError(thrown);
}
