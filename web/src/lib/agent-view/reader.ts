// THE AGENT VIEW'S READER: pure rules over what the phone already holds. No I/O and no React.
//
// The wire's own readers (lib/agent-view/wire.ts) check what the bridge sends. This file reads what the
// agent view shows from that and from the Chat data the session screen already has: which of the states
// is on screen, the agent's text answer, the request block, the receipt, and the turns the bridge sent.
//
// ── FRESH AND STALE BLOCKS ───────────────────────────────────────────────────────────────────────
// A screen is a list of blocks, each stamped with the time it was last set, kept or shown
// (lib/agent-view/wire.ts). Against the operator's latest request a block is FRESH when its time is the
// request's or later, and STALE when it is older (`splitScreen`): the agent drew it for an earlier
// request. The view shows the fresh blocks as the answer, and the stale ones folded away under
// "Earlier screen", at full contrast but out of reach, never promoted to an answer. With no request,
// or a request that was not sent, nothing is split: the screen is shown whole.
//
// ── THE STATES ───────────────────────────────────────────────────────────────────────────────────
//   empty     no screen and no request. The view says how to begin.
//   view      a screen and no request: the screen alone.
//   working   a request the agent has not answered yet (sending, sent, working, drawing).
//   answered  the turn ended with fresh blocks (they are the answer), or with a text answer.
//   notSent   the send failed: the screen is live again, as it was.
//
// ── THE BRIDGE WRITES THE LINE ───────────────────────────────────────────────────────────────────
// A tap names the screen's rev and the renderer's control path; typed text goes as typed with the view's
// key. The bridge builds the line (head, tap words from ITS stored screen, tail) and answers it in
// `view.line`, which the view shows under "Sent to this session" (SECURITY rule 4). The phone never puts
// a head or a tail on a text. The words a tap names on the phone (`viewTapWords`, the bridge's own
// builder over the screen the phone holds) only draw the receipt while the send is in flight.
//
// ── A TURN THE VIEW SENT ─────────────────────────────────────────────────────────────────────────
// Chat and the request block draw a person turn without the view's head and tail ONLY when the bridge
// lists that exact line among the view's `sent` lines (lead condition 7): a typed line of the same shape
// that the bridge did not send stays as it was, head and all.

import { reservedLead } from "@/lib/surface/send";
import { kidsOf } from "@/lib/tricks/layout";
import { isTrickUrl, type View, type ViewNode } from "@/lib/tricks/schema";
import type { TranscriptEntry } from "@/lib/types";

import { isViewHeadLine, readsAsAddress, tapAbout, VIEW_CHOICE_BLOCK, VIEW_DRAWING_MAX_MS, VIEW_NO_PROFILE, viewBlocksOf, type ViewChoice, type ViewDrawing, type ViewNote, type ViewScreen, type ViewSent } from "./wire";

/** The longest trick name the switch row and the View choice show, in characters, the cut included. */
export const VIEW_NAME_SHOWN = 12;

/** A trick's name as the switch row and the View choice show it: cut to {@link VIEW_NAME_SHOWN} characters. */
export function shownTrickName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length <= VIEW_NAME_SHOWN) return chars.join("");
  return `${chars.slice(0, VIEW_NAME_SHOWN - 1).join("")}…`;
}

export type ViewState = "empty" | "view" | "working" | "answered" | "notSent";

/** The agent's text answer the view draws when a turn ended with no fresh block. */
export interface ViewTextAnswer {
  text: string;
  /** The reply's ISO time. */
  ts: string;
}

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function textOf(entry: TranscriptEntry): string {
  return entry.parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
}

/**
 * The agent's text answer to a request made after the screen was drawn, or null. The newest person turn
 * newer than `viewAt` is the request; the newest agent reply after it with words is the answer.
 */
export function textAnswerAfter(entries: readonly TranscriptEntry[], viewAt: string): ViewTextAnswer | null {
  const drawn = timeOf(viewAt);
  if (Number.isNaN(drawn)) return null;
  let answer: ViewTextAnswer | null = null;
  let asked = false;
  for (const entry of entries) {
    if (entry.abandoned === true) continue;
    const at = timeOf(entry.ts);
    if (entry.role === "user") {
      // A request after the screen opens a new question; an older answer stops counting.
      if (at > drawn) asked = true;
      answer = null;
      continue;
    }
    if (entry.role !== "assistant" || !asked) continue;
    const text = textOf(entry);
    if (text !== "") answer = { text, ts: entry.ts };
  }
  return answer;
}

/** Which state the view is in, from where the request stands. */
export function viewStateOf({ view, status }: { view: ViewScreen | undefined; status: ViewStatus | null }): ViewState {
  if (status === null) return view === undefined ? "empty" : "view";
  if (status.kind === "notSent") return "notSent";
  if (status.kind === "answered") return "answered";
  return "working";
}

/**
 * The view with the buttons at these control paths marked pressed (`pressed: "true"`), the operator's pick
 * kept visible until the agent's next screen. A path that names no button is left alone. The view given is
 * not changed.
 */
export function withPressed(view: View, controls: readonly string[]): View {
  if (controls.length === 0) return view;
  const picked = new Set(controls);
  const walk = (nodes: readonly ViewNode[], prefix: string): ViewNode[] =>
    nodes.map((node, index) => {
      const path = `${prefix}/${String(index)}`;
      if (node.kind === "button" && picked.has(path)) return { ...node, attrs: { ...node.attrs, pressed: "true" } };
      const kids = kidsOf(node);
      return kids.length === 0 ? node : Object.assign({}, node, { kids: walk(kids, path) });
    });
  return walk(view, "v");
}

/**
 * A link's words as the view draws them (SECURITY N1): words that read as a web address must be the
 * link's own target, else the target is drawn in their place. The wire refuses such a screen already;
 * this holds on the phone too, so no screen that slipped past shows one address and opens another.
 */
export function shownLinkText(text: string, href: string): string {
  return readsAsAddress(text) && text.trim() !== href ? href : text;
}

/**
 * The view with every link's and linked run's words held to {@link shownLinkText}, and every `href` that
 * is no web address (a session's, review 10 W11) blanked, so the renderer draws its words with nothing to
 * open. The wire refuses both already; this holds on the phone for a screen that slipped past. The view
 * given is not changed.
 */
export function withTrueLinks(view: View): View {
  const walk = (nodes: readonly ViewNode[]): ViewNode[] =>
    nodes.map((node) => {
      if (node.kind === "link") {
        const href = isTrickUrl(node.attrs.href) ? node.attrs.href : "";
        const text = href === "" ? node.text : shownLinkText(node.text, href);
        return text === node.text && href === node.attrs.href ? node : { ...node, text, attrs: { ...node.attrs, href } };
      }
      if (node.kind === "run" && node.attrs?.href !== undefined) {
        const href = isTrickUrl(node.attrs.href) ? node.attrs.href : "";
        const text = href === "" ? node.text : shownLinkText(node.text, href);
        return text === node.text && href === node.attrs.href ? node : { ...node, text, attrs: { ...node.attrs, href } };
      }
      if (node.kind === "row" && node.attrs?.href !== undefined && !isTrickUrl(node.attrs.href)) {
        const kids = kidsOf(node);
        const row = { ...node, attrs: { ...node.attrs, href: "" } };
        return kids.length === 0 ? row : Object.assign(row, { kids: walk(kids) });
      }
      const kids = kidsOf(node);
      return kids.length === 0 ? node : Object.assign({}, node, { kids: walk(kids) });
    });
  return walk(view);
}

// ── controls, keyed by block ────────────────────────────────────────────────────────────────────
//
// The view draws every block on its own (`renderView([node])`), so the renderer names a button inside a
// block by a path that starts at `v/0`. A pick is filed under the BLOCK instead: `b:<id>#<content key>`
// and the rest of the path (`b:plan#k3x/1/0`), and the decision block's under `choice#<content key>/<i>`.
// So a pick stays marked while its block holds the same content, through edits of other blocks and a new
// `rev`, and goes when that block changes or leaves.

/** A short, stable key of a value's content: the same JSON gives the same key. Not for security. */
export function contentKey(value: ViewNode | ViewChoice): string {
  const text = JSON.stringify(value) ?? "";
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/** The prefix every control of one block is filed under. */
export function blockPrefix(id: string, node: ViewNode): string {
  return `b:${id}#${contentKey(node)}`;
}

/** The prefix of the decision block's options. */
export function choicePrefix(choice: ViewChoice): string {
  return `choice#${contentKey(choice)}`;
}

/** The control a pick in the decision block is filed under. */
export function choiceControl(choice: ViewChoice, index: number): string {
  return `${choicePrefix(choice)}/${String(index)}`;
}

/** The option marked among the picks, or null. */
export function pickedOption(controls: readonly string[]): number | null {
  for (const control of controls.toReversed()) {
    const match = /^choice#[a-z0-9]+\/(\d+)$/u.exec(control);
    if (match !== null) return Number(match[1]);
  }
  return null;
}

/** The control of a tap inside a block, from the renderer's own path in that block's single-node render. */
export function blockControl(prefix: string, rendered: string): string {
  return `${prefix}${rendered.slice("v/0".length)}`;
}

/** The renderer's path in a block's single-node render, for a control filed under that block; null for another block's. */
export function renderedControl(prefix: string, control: string): string | null {
  if (control !== prefix && !control.startsWith(`${prefix}/`)) return null;
  return `v/0${control.slice(prefix.length)}`;
}

/** The control path the BRIDGE reads for a tap in one block: the renderer's path over the whole screen. */
export function screenControl(block: ScreenBlock, rendered: string): string {
  return `v/${String(block.index)}${rendered.slice("v/0".length)}`;
}

/** The control path the bridge reads for an option of the decision block. */
export function optionControl(index: number): string {
  return `choice/${String(index)}`;
}

/** One block of the screen as the view draws it: its place in the screen, its node, its time and its prefix. */
export interface ScreenBlock {
  readonly id: string;
  readonly index: number;
  readonly at: string;
  readonly node: ViewNode;
  /** The label of a pending block (a placeholder for one in work). */
  readonly pending: string | undefined;
  readonly prefix: string;
}

/** The screen's blocks, in order. */
export function screenBlocks(view: ViewScreen): ScreenBlock[] {
  const blocks = viewBlocksOf(view);
  return view.view.map((node, index) => {
    const block = blocks[index];
    const id = block?.id ?? `b${String(index + 1)}`;
    return { id, index, at: block?.at ?? view.at, node, pending: block?.pending, prefix: blockPrefix(id, node) };
  });
}

/** Every prefix a pick may be filed under on this screen: a pick under another one is gone. */
export function livePrefixes(view: ViewScreen | undefined): Set<string> {
  if (view === undefined) return new Set();
  const prefixes = new Set(screenBlocks(view).map((block) => block.prefix));
  if (view.choice !== undefined) prefixes.add(choicePrefix(view.choice));
  return prefixes;
}

/** The prefix a control is filed under: up to its first slash. */
function prefixOf(control: string): string {
  const slash = control.indexOf("/");
  return slash < 0 ? control : control.slice(0, slash);
}

/**
 * The picks Collie marked on the screen (review 10 W7, the bridge's own record of a tap), as the controls
 * the view files picks under, followed by `local` (the taps the phone saw confirmed since). A local pick
 * in a bar, or on the decision block, outranks a mark the bridge holds there: it is the newer.
 */
export function markedControls(view: ViewScreen | undefined, local: readonly string[]): readonly string[] {
  if (view?.picks === undefined) return local;
  const blocks = screenBlocks(view);
  const marked = view.picks.flatMap((pick) => {
    if (pick.block === VIEW_CHOICE_BLOCK) return view.choice === undefined ? [] : [choiceControl(view.choice, Number(pick.path))];
    const block = blocks.find((held) => held.id === pick.block);
    return block === undefined ? [] : [`${block.prefix}/${pick.path}`];
  });
  const bars = new Set(local.map((control) => (control.startsWith("choice#") ? "choice" : parentControl(control))));
  const kept = marked.filter((control) => !bars.has(control.startsWith("choice#") ? "choice" : parentControl(control)));
  return [...kept, ...local];
}

/** A block's node with the picks filed under it marked pressed. */
export function pressedNode(block: ScreenBlock, controls: readonly string[]): View {
  const rendered = controls.flatMap((control) => renderedControl(block.prefix, control) ?? []);
  return withPressed([block.node], rendered);
}

/** The screen split against the request: what the agent drew for it, and what it drew before. */
export interface ScreenSplit {
  readonly fresh: readonly ScreenBlock[];
  readonly stale: readonly ScreenBlock[];
  /** The decision block is fresh (false when there is none). */
  readonly isChoiceFresh: boolean;
  /** The decision block is stale (false when there is none). */
  readonly isChoiceStale: boolean;
  /** The time of the newest fresh block or fresh choice, or null when nothing is fresh. */
  readonly freshAt: string | null;
}

/**
 * The screen's blocks against the request's time `requestAt` (ms on the bridge's clock): fresh at that
 * time or later, stale before. With no time (no request, or one that was not sent) every block is fresh.
 */
export function splitScreen(view: ViewScreen | undefined, requestAt: number | null): ScreenSplit {
  if (view === undefined) return { fresh: [], stale: [], isChoiceFresh: false, isChoiceStale: false, freshAt: null };
  const blocks = screenBlocks(view);
  const isFresh = (at: string) => requestAt === null || timeOf(at) >= requestAt;
  const fresh = blocks.filter((block) => isFresh(block.at));
  const stale = blocks.filter((block) => !isFresh(block.at));
  const choiceAt = view.choiceAt ?? view.at;
  const hasChoice = view.choice !== undefined;
  const isChoiceFresh = hasChoice && isFresh(choiceAt);
  const times = [...fresh.map((block) => block.at), ...(isChoiceFresh ? [choiceAt] : [])];
  const freshAt = times.reduce<string | null>((newest, at) => (newest === null || timeOf(at) > timeOf(newest) ? at : newest), null);
  return { fresh, stale, isChoiceFresh, isChoiceStale: hasChoice && !isChoiceFresh, freshAt };
}

/** The picture refs the decision block draws as previews: the row of pictures leaves them out. */
export function previewRefs(choice: ViewChoice | undefined): Set<number> {
  return new Set((choice?.options ?? []).flatMap((option) => (option.preview === undefined ? [] : [option.preview])));
}

/** The control path of a button's parent: its siblings share it. */
export function parentControl(control: string): string {
  return control.slice(0, Math.max(0, control.lastIndexOf("/")));
}

/** The picks the operator made on one view's screen: the controls marked, each filed under its block. */
export interface ViewPicks {
  /** The view's key: the trick and the session. */
  key: string;
  controls: readonly string[];
}

const NO_PICKS: readonly string[] = [];

/** The controls marked on the screen now: those whose block still holds the same content, for this view only. */
export function picksFor(held: ViewPicks | null, { key, live }: { key: string; live: ReadonlySet<string> }): readonly string[] {
  if (held === null || held.key !== key) return NO_PICKS;
  const kept = held.controls.filter((control) => live.has(prefixOf(control)));
  return kept.length === held.controls.length ? held.controls : kept;
}

/**
 * The picks after a tap the bridge confirmed: that button is marked, and the mark of its siblings in the
 * same bar goes (one pick per bar). The marks of other bars and blocks stay while their blocks do.
 */
export function picksAfter(held: ViewPicks | null, { key, live, control }: { key: string; live: ReadonlySet<string>; control: string }): ViewPicks {
  const bar = parentControl(control);
  const kept = picksFor(held, { key, live }).filter((other) => parentControl(other) !== bar);
  return { key, controls: [...kept, control] };
}

// ── a turn the view sent ────────────────────────────────────────────────────────────────────────

/**
 * The head the bridge puts in front of a view's send: `[view:<trick> <address>] from operator:`, or
 * `[view:<trick>] from operator:`. It captures the trick and the address, which name the tail.
 */
const SENT_HEAD = /^\[view:([^\s\]]+)(?: ([^\]\n]+))?\] from operator:[ ]?/u;
/** Where the tail the bridge puts behind a send opens: ` [rules: <bin> trick view <trick> help...]`. */
const TAIL_OPEN = " [rules: ";

/** A text in a pattern, as itself. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Where the tail the bridge appended starts in `rest` (the words after the head), or -1. Only the exact
 * forms of `bridge/agent-view/service.ts` `viewHint` count (review 10 W6): the line ENDS with
 * ` trick view <trick> help]`, or ` help --session <address>]` (the head's address; any one when the head
 * is bare, as the head falls back to bare when the address is too long), and the tail opens at the LAST
 * ` [rules: ` before that end. So a label or a typed text that holds ` [rules: ` stays whole.
 */
function tailStart(rest: string, trick: string, address: string | undefined): number {
  const name = literal(` trick view ${trick} help`);
  const session = address === undefined ? String.raw`[^\n]+` : literal(address);
  const end = new RegExp(`${name}(?: --session ${session})?\\]$`, "u").exec(rest);
  if (end === null) return -1;
  return rest.lastIndexOf(TAIL_OPEN, end.index);
}

/**
 * A line the bridge sent from a view, without the head and the tail it put on it: the words the person
 * tapped or typed. Only for a line the bridge lists as sent (see {@link viewTurnText}); a text that merely
 * looks like one is never passed here. A line with no head is left as it is: the bridge writes no tail
 * without a head.
 */
export function sentWords(line: string): string {
  const head = SENT_HEAD.exec(line);
  if (head === null) return line;
  const rest = line.slice(head[0].length);
  const at = tailStart(rest, head[1] ?? "", head[2]);
  return at === -1 ? rest : rest.slice(0, at);
}

/**
 * A person turn as Chat and the request block draw it: without head and tail when the bridge sent that
 * exact line from a view AND its first line is a head by the one shared head rule ({@link isViewHeadLine},
 * the rule every door of the bridge runs). The phone has no head rule of its own; {@link sentWords} only
 * cuts the head the bridge wrote off a line already known to be one.
 */
export function viewTurnText(text: string, sentLines: ReadonlySet<string>): string {
  const line = sentLines.has(text) ? text : sentLines.has(text.trim()) ? text.trim() : null;
  if (line === null || !isViewHeadLine(line.split("\n", 1)[0] ?? "")) return text;
  return sentWords(line);
}

/** The catalog key of the words for a refusal of a send from a view, or of a view switch, by the bridge's code. */
export type ViewRefusalKey =
  | "view.refused.noProfile"
  | "view.refused.draft"
  | "view.refused.question"
  | "view.refused.busy"
  | "view.refused.changed"
  | "view.refused.off"
  | "view.refused.rate"
  | "view.refused.badControl"
  | "view.refused.notOnLead"
  | "view.refused.wrongSession"
  | "view.refused.other"
  | "composer.protocol.badHead";

/**
 * Collie's words for every refusal a send from a view or a switch can meet: the bridge's 409 codes and the
 * Send Protocol reasons a view send adds (`draft_present`, `not_free` for a question or a pane with no
 * profile, `busy`, `stale_view`, `bad_head`). No code reaches the screen: an unknown one gets the plain
 * "could not send" line. `detail` tells a `not_free` for a pane with no profile from one at a question.
 */
export function viewRefusalKey(code: string | null, detail: string | null = null): ViewRefusalKey {
  switch (code) {
    case "no_profile":
      return "view.refused.noProfile";
    case "not_free":
      return detail === VIEW_NO_PROFILE ? "view.refused.noProfile" : "view.refused.question";
    case "draft_present":
      return "view.refused.draft";
    case "question":
      return "view.refused.question";
    case "busy":
    case "turn_running":
      return "view.refused.busy";
    case "stale_view":
      return "view.refused.changed";
    case "view_off":
    case "trick_off":
    case "no_trick":
    case "not_a_view":
      return "view.refused.off";
    case "rate":
      return "view.refused.rate";
    case "bad_control":
      return "view.refused.badControl";
    case "not_on_lead":
      return "view.refused.notOnLead";
    case "wrong_session":
      return "view.refused.wrongSession";
    case "bad_head":
      return "composer.protocol.badHead";
    default:
      return "view.refused.other";
  }
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────

/** How far a send got: in flight, confirmed by the bridge, or not sent. */
export type ViewSendPhase = "sending" | "sent" | "failed";

/** What the composer tells the view about a send from it. */
export interface ViewRequestNote {
  /** The text as the operator wrote it, or the words a tap names (display only: the bridge builds the line). */
  text: string;
  phase: ViewSendPhase;
  /** The composer's own refusal words for a `failed` send, or null. */
  reason: string | null;
  /** The exact line the bridge typed (its answer's `view.line`), once it answered; null before and on a failure. */
  line?: string | null;
  /** What a tap answered on the screen it went from (review 10 W8); null for typed text or none known. */
  about?: string | null;
}

/** The latest request of one view. `at` is when the send began, on the bridge's clock, in ms. */
export interface ViewRequest extends ViewRequestNote {
  at: number;
  line: string | null;
}

/** The leads of a person turn that is no request to the agent: a slash command and a shell line. An `@` turn is a prompt with a mention. */
const NOT_A_REQUEST_LEADS = ["/", "!"] as const;

/**
 * The latest person turn with words, drawn as {@link viewTurnText} draws it, or null. `at` is its time in
 * ms; `line` is the turn's text when the bridge sent it from the view, else null. A slash command
 * (`/model`) or a shell line (`!ls`) typed in the terminal is no request, so it is skipped.
 */
export function latestRequestIn(entries: readonly TranscriptEntry[], sentLines: ReadonlySet<string>): { text: string; at: number; line: string | null } | null {
  for (const entry of entries.toReversed()) {
    if (entry.role !== "user" || entry.abandoned === true) continue;
    const raw = textOf(entry);
    const text = viewTurnText(raw, sentLines).trim();
    const at = timeOf(entry.ts);
    if (text === "" || Number.isNaN(at)) continue;
    if (reservedLead(text, NOT_A_REQUEST_LEADS) !== null) continue;
    return { text, at, line: sentLines.has(raw) ? raw : null };
  }
  return null;
}

/**
 * The request held after the composer's word. The start of a send, or a note about another text, is a new
 * request stamped with `clock` (now on the bridge's clock, in ms). The end of the same send keeps the time
 * it began, so a screen drawn after it still counts as an answer to it.
 */
export function requestAfter(held: ViewRequest | undefined, note: ViewRequestNote, clock: number): ViewRequest {
  const fresh = note.phase === "sending" || held === undefined || held.text !== note.text;
  return { ...note, line: note.line ?? null, at: fresh ? clock : held.at };
}

/**
 * The request the view shows. What the composer told the view while the send is in flight or failed;
 * once it is sent, a person turn in the chat or a line the bridge sent that is newer and says something
 * else (the operator wrote in the terminal, or on another phone) takes over. With nothing told (a
 * reload), the newer of the chat's latest person turn and the view's last sent line, or null.
 */
export function viewRequestOf({
  local,
  entries,
  sent,
}: {
  local: ViewRequest | undefined;
  entries: readonly TranscriptEntry[];
  /** The lines the bridge typed for this view, newest last. */
  sent: readonly ViewSent[];
}): ViewRequest | null {
  const lines = new Set(sent.map((item) => item.line));
  const journal = latestRequestIn(entries, lines);
  const last = sent.at(-1);
  // What a tap answered comes with the bridge's own line (review 10 W8), never from the screen shown now.
  const aboutOf = (line: string | null): string | null => (line === null ? null : (sent.findLast((item) => item.line === line)?.about ?? null));
  const fromSent: ViewRequest | null = last === undefined ? null : { text: sentWords(last.line).trim(), at: timeOf(last.at), phase: "sent", reason: null, line: last.line, about: last.about ?? null };
  const fromJournal: ViewRequest | null = journal === null ? null : { text: journal.text, at: journal.at, phase: "sent", reason: null, line: journal.line, about: aboutOf(journal.line) };
  const server = newerRequest(fromJournal, fromSent);
  if (local === undefined) return server;
  if (local.phase !== "sent") return local;
  if (server !== null && server.at > local.at && server.text !== local.text) return server;
  if (local.line === null && server !== null && server.text === local.text && server.line !== null) return { ...local, line: server.line, about: local.about ?? server.about ?? null };
  return local;
}

/** The newer of the two, the one with the bridge's line when both say the same words. */
function newerRequest(a: ViewRequest | null, b: ViewRequest | null): ViewRequest | null {
  if (a === null || b === null) return a ?? b;
  if (a.text === b.text) return a.line !== null ? { ...a, about: a.about ?? b.about ?? null } : { ...a, line: b.line, about: a.about ?? b.about ?? null };
  return (Number.isNaN(a.at) ? -Infinity : a.at) >= (Number.isNaN(b.at) ? -Infinity : b.at) ? a : b;
}

/** The one status line under the request. Each kind has its own words in the view. */
export type ViewStatus =
  | { kind: "sending" }
  | { kind: "notSent"; reason: string | null }
  | { kind: "sent" }
  | { kind: "working" }
  | { kind: "drawing" }
  | { kind: "answered"; at: string };

/** Whether a status leaves the request unanswered, so the screen under it is the old one. */
export function isUnanswered(status: ViewStatus | null): boolean {
  return status !== null && status.kind !== "notSent" && status.kind !== "answered";
}

/**
 * Where a request stands, in this order: the send in flight; the send that failed; the turn over with a
 * fresh block or a fresh choice (the answer); the agent's `start` for this request (fresh and not
 * older than {@link VIEW_DRAWING_MAX_MS}); a text answer once the turn ended; the pane's own working
 * status; and last, the bridge's confirmation. A fresh block while the turn still runs is a part of the
 * answer, not yet the answer. `now` is on the bridge's clock, in ms. Null when there is no request.
 */
export function viewStatusOf({
  request,
  view,
  drawing,
  working,
  entries,
  now,
}: {
  request: ViewRequest | null;
  view: ViewScreen | undefined;
  drawing: ViewDrawing | undefined;
  working: boolean;
  entries: readonly TranscriptEntry[];
  now: number;
}): ViewStatus | null {
  if (request === null) return null;
  if (request.phase === "sending") return { kind: "sending" };
  if (request.phase === "failed") return { kind: "notSent", reason: request.reason };
  const { freshAt } = splitScreen(view, request.at);
  if (!working && freshAt !== null) return { kind: "answered", at: freshAt };
  const drawn = drawing === undefined ? Number.NaN : timeOf(drawing.at);
  if (drawn >= request.at && now - drawn < VIEW_DRAWING_MAX_MS) return { kind: "drawing" };
  const answer = working ? null : textAnswerAfter(entries, new Date(request.at - 1).toISOString());
  if (answer !== null) return { kind: "answered", at: answer.ts };
  if (working) return { kind: "working" };
  return { kind: "sent" };
}

/** How many of the agent's notes the view shows for one request, newest last. */
export const VIEW_NOTES_SHOWN = 4;

/** The notes the agent's `start` calls said for this request (at its time or later), newest last. */
export function requestNotes(drawing: ViewDrawing | undefined, requestAt: number): ViewNote[] {
  const notes = drawing?.notes ?? (drawing?.note === undefined ? [] : [{ at: drawing.at, note: drawing.note }]);
  return notes.filter((note) => timeOf(note.at) >= requestAt).slice(-VIEW_NOTES_SHOWN);
}

// ── the receipt of a pick ───────────────────────────────────────────────────────────────────────

/** What the view shows in place of the request bubble when the request was a pick or a tap. */
export interface ViewReceipt {
  readonly kind: "pick" | "tap";
  /** The label picked or tapped. */
  readonly label: string;
  /**
   * What it answered: the button's group (in the words), else what the tap answered on the screen it went
   * from (the choice's question or the title, review 10 W8); null for none known.
   */
  readonly context: string | null;
  /** The picture ref of the option's preview, or null. */
  readonly preview: number | null;
}

/** One quoted tap word as the bridge quotes it (`"` and `\` escaped): the group captures the inside. */
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`;
const PICKED_RE = new RegExp(`^picked ${QUOTED}$`, "u");
const TAPPED_RE = new RegExp(`^tapped ${QUOTED}(?: in ${QUOTED})?$`, "u");

/** A quoted tap word read back: the escapes taken off. */
function unquote(text: string): string {
  return text.replace(/\\(.)/gu, "$1");
}

/**
 * The receipt of a request whose words are a pick (`picked "<label>"`) or a tap (`tapped "<label>"`); null
 * for a typed request, which keeps the chat bubble. `about` is what the tap answered when it was sent (the
 * request's own, review 10 W8): the screen shown now never names it. A pick's preview is drawn only while
 * the screen still asks that same question.
 */
export function pickReceiptOf(text: string, about: string | null, view: ViewScreen | undefined): ViewReceipt | null {
  const picked = PICKED_RE.exec(text);
  if (picked !== null) {
    const label = unquote(picked[1] ?? "");
    const asked = view?.choice === undefined ? null : tapAbout(view, "choice/0");
    const option = about !== null && asked === about ? view?.choice?.options.find((candidate) => candidate.label.trim() === label) : undefined;
    return { kind: "pick", label, context: about, preview: option?.preview ?? null };
  }
  const tapped = TAPPED_RE.exec(text);
  if (tapped === null) return null;
  const group = tapped[2] === undefined ? null : unquote(tapped[2]);
  return { kind: "tap", label: unquote(tapped[1] ?? ""), context: group ?? about, preview: null };
}
