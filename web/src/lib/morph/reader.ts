// MORPH'S READER: pure rules over what the phone already holds. No I/O and no React.
//
// The wire's own readers (lib/morph/wire.ts) check what the bridge sends. This file reads what the Morph
// body shows from that and from the Chat data the session screen already has: which of the three states
// is on screen, the agent's text answer, the words a tap sends, and the hint a send carries.
//
// ── FRESH AND STALE BLOCKS ───────────────────────────────────────────────────────────────────────
// A screen is a list of blocks, each stamped with the time it was last set, kept or shown
// (lib/morph/wire.ts). Against the operator's latest request a block is FRESH when its time is the
// request's or later, and STALE when it is older (`splitScreen`): the agent drew it for an earlier
// request. The body shows the fresh blocks as the answer, and the stale ones folded away under
// "Earlier screen", at full contrast but out of reach, never promoted to an answer. With no request,
// or a request that was not sent, nothing is split: the screen is shown whole.
//
// ── THE STATES ───────────────────────────────────────────────────────────────────────────────────
//   empty     no screen and no request. The body says how to begin.
//   view      a screen and no request: the screen alone.
//   working   a request the agent has not answered yet (sending, sent, working, morphing).
//   answered  the turn ended with fresh blocks (they are the answer), or with a text answer.
//   notSent   the send failed: the screen is live again, as it was.

// ── THE REQUEST, AND WHERE IT STANDS ─────────────────────────────────────────────────────────────
// The body opens with the operator's latest request, without the hint, and one quiet status line under
// it (`morphStatusOf`). The request comes from what the composer told the view when the send started
// (`MorphRequest`), and after a reload, when that is gone, from the latest person turn in the chat window
// the session screen already holds, its hint stripped (`stripMorphHint`).

import { isCommand } from "@/lib/send-protocol";
import { reservedLead } from "@/lib/surface/send";
import { kidsOf } from "@/lib/tricks/layout";
import type { View, ViewNode } from "@/lib/tricks/schema";
import type { TranscriptEntry } from "@/lib/types";

import { MORPH_DRAWING_MAX_MS, morphBlocksOf, type MorphChoice, type MorphDrawing, type MorphNote, type MorphView } from "./wire";

/** The word Morph. A name, never translated, so it is no dictionary key (like a typeface's family name). */
export const MORPH_NAME = "Morph";

export type MorphState = "empty" | "view" | "working" | "answered" | "notSent";

/** The agent's text answer the body draws when a turn ended with no fresh block. */
export interface MorphTextAnswer {
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
export function textAnswerAfter(entries: readonly TranscriptEntry[], viewAt: string): MorphTextAnswer | null {
  const drawn = timeOf(viewAt);
  if (Number.isNaN(drawn)) return null;
  let answer: MorphTextAnswer | null = null;
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

/** Which state the Morph body is in, from where the request stands. */
export function morphStateOf({ view, status }: { view: MorphView | undefined; status: MorphStatus | null }): MorphState {
  if (status === null) return view === undefined ? "empty" : "view";
  if (status.kind === "notSent") return "notSent";
  if (status.kind === "answered") return "answered";
  return "working";
}

/**
 * The text a send carries while the Morph view shows: `head + " " + text + " " + hint`, on one line, so the
 * terminal reads `[morph] from operator: <text> [rules: ...]`. A session whose bridge served no head (an
 * older one) sends `text + " " + hint`. No head and no hint for an empty hint, for a text with a reserved
 * lead (`/`, `!`, `@`: a command, a shell line, a file mention, whose words the harness reads as its
 * own), and for a send with attachments.
 */
export function withMorphHint({ text, hint, head, attachments }: { text: string; hint: string | undefined; head?: string | undefined; attachments: number }): string {
  if (hint === undefined || hint.trim() === "") return text;
  if (attachments > 0) return text;
  if (isCommand(text.trimStart())) return text;
  const lead = head === undefined || head.trim() === "" ? "" : `${head} `;
  return `${lead}${text} ${hint}`;
}

/** The node at a renderer control path (`v/0/2/1`), or undefined when the path names none. */
export function nodeAtControl(view: View, control: string): ViewNode | undefined {
  const steps = control.split("/");
  if (steps[0] !== "v" || steps.length < 2) return undefined;
  let list: readonly ViewNode[] = view;
  let node: ViewNode | undefined;
  for (const step of steps.slice(1)) {
    if (!/^\d+$/.test(step)) return undefined;
    node = list[Number(step)];
    if (node === undefined) return undefined;
    list = kidsOf(node);
  }
  return node;
}

/** The labelled `group` a control sits in, nearest first, or null. */
function groupLabelOf(view: View, control: string): string | null {
  const steps = control.split("/");
  let list: readonly ViewNode[] = view;
  let label: string | null = null;
  for (const step of steps.slice(1)) {
    const node: ViewNode | undefined = list[Number(step)];
    if (node === undefined) return label;
    const own = node.kind === "group" ? (node.attrs?.label?.trim() ?? "") : "";
    if (own !== "") label = own;
    list = kidsOf(node);
  }
  return label;
}

/**
 * The words a tap on a button sends, read from the button node the control names (the renderer's own path),
 * so the words are the ones on screen: `tapped "<label>"`, or `tapped "<label>": <value>` when the button has
 * a value that is not its label, and `tapped "<label>" in "<group label>"` before the colon when the button
 * sits in a labelled group. Null when the control names no button, so nothing is sent.
 */
export function tapTextOf({ view, control }: { view: View; control: string }): string | null {
  const node = nodeAtControl(view, control);
  if (node?.kind !== "button") return null;
  const label = node.attrs.label.trim();
  if (label === "") return null;
  const group = groupLabelOf(view, control);
  const named = group === null ? `tapped "${label}"` : `tapped "${label}" in "${group}"`;
  const value = node.attrs.value?.trim() ?? "";
  return value === "" || value === label ? named : `${named}: ${node.attrs.value ?? ""}`;
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

// ── controls, keyed by block ────────────────────────────────────────────────────────────────────
//
// The body draws every block on its own (`renderView([node])`), so the renderer names a button inside a
// block by a path that starts at `v/0`. A pick is filed under the BLOCK instead: `b:<id>#<content key>`
// and the rest of the path (`b:plan#k3x/1/0`), and the decision block's under `choice#<content key>/<i>`.
// So a pick stays marked while its block holds the same content, through edits of other blocks and a new
// `rev`, and goes when that block changes or leaves.

/** A short, stable key of a value's content: the same JSON gives the same key. Not for security. */
export function contentKey(value: ViewNode | MorphChoice): string {
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
export function choicePrefix(choice: MorphChoice): string {
  return `choice#${contentKey(choice)}`;
}

/** The control a pick in the decision block is filed under. */
export function choiceControl(choice: MorphChoice, index: number): string {
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

/** One block of the screen as the body draws it: its place in the view, its node, its time and its prefix. */
export interface MorphBlockView {
  readonly id: string;
  readonly index: number;
  readonly at: string;
  readonly node: ViewNode;
  /** The label of a pending block (a placeholder for one in work). */
  readonly pending: string | undefined;
  readonly prefix: string;
}

/** The screen's blocks, in order. */
export function screenBlocks(view: MorphView): MorphBlockView[] {
  const blocks = morphBlocksOf(view);
  return view.view.map((node, index) => {
    const block = blocks[index];
    const id = block?.id ?? `b${String(index + 1)}`;
    return { id, index, at: block?.at ?? view.at, node, pending: block?.pending, prefix: blockPrefix(id, node) };
  });
}

/** Every prefix a pick may be filed under on this screen: a pick under another one is gone. */
export function livePrefixes(view: MorphView | undefined): Set<string> {
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

/** The words a tap in one block sends: {@link tapTextOf} over the whole view, at the block's place. */
export function blockTapTextOf({ view, block, rendered }: { view: View; block: MorphBlockView; rendered: string }): string | null {
  return tapTextOf({ view, control: `v/${String(block.index)}${rendered.slice("v/0".length)}` });
}

/** A block's node with the picks filed under it marked pressed. */
export function pressedNode(block: MorphBlockView, controls: readonly string[]): View {
  const rendered = controls.flatMap((control) => renderedControl(block.prefix, control) ?? []);
  return withPressed([block.node], rendered);
}

/** The screen split against the request: what the agent drew for it, and what it drew before. */
export interface MorphSplit {
  readonly fresh: readonly MorphBlockView[];
  readonly stale: readonly MorphBlockView[];
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
export function splitScreen(view: MorphView | undefined, requestAt: number | null): MorphSplit {
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

/**
 * The words a pick in the decision block sends: `picked "<label>"`, or `picked "<label>": <value>` when the
 * option has a value that is not its label. Null when the index names no option, so nothing is sent.
 */
export function pickTextOf(choice: MorphChoice, index: number): string | null {
  const option = choice.options[index];
  if (option === undefined) return null;
  const label = option.label.trim();
  const value = option.value?.trim() ?? "";
  return value === "" || value === label ? `picked "${label}"` : `picked "${label}": ${value}`;
}

/** The picture refs the decision block draws as previews: the row of pictures leaves them out. */
export function previewRefs(choice: MorphChoice | undefined): Set<number> {
  return new Set((choice?.options ?? []).flatMap((option) => (option.preview === undefined ? [] : [option.preview])));
}

/** The control path of a button's parent: its siblings share it. */
export function parentControl(control: string): string {
  return control.slice(0, Math.max(0, control.lastIndexOf("/")));
}

/** The picks the operator made on one session's screen: the controls marked, each filed under its block. */
export interface MorphPicks {
  address: string;
  controls: readonly string[];
}

const NO_PICKS: readonly string[] = [];

/** The controls marked on the screen now: those whose block still holds the same content, for this session only. */
export function picksFor(held: MorphPicks | null, { address, live }: { address: string; live: ReadonlySet<string> }): readonly string[] {
  if (held === null || held.address !== address) return NO_PICKS;
  const kept = held.controls.filter((control) => live.has(prefixOf(control)));
  return kept.length === held.controls.length ? held.controls : kept;
}

/**
 * The picks after a tap the bridge confirmed: that button is marked, and the mark of its siblings in the
 * same bar goes (one pick per bar). The marks of other bars and blocks stay while their blocks do.
 */
export function picksAfter(held: MorphPicks | null, { address, live, control }: { address: string; live: ReadonlySet<string>; control: string }): MorphPicks {
  const bar = parentControl(control);
  const kept = picksFor(held, { address, live }).filter((other) => parentControl(other) !== bar);
  return { address, controls: [...kept, control] };
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────

/** How far a send got: in flight, confirmed by the bridge, or not sent. */
export type MorphSendPhase = "sending" | "sent" | "failed";

/** What the composer tells the Morph view about a send that carried the hint (the plain text, never the hint). */
export interface MorphRequestNote {
  /** The text as the operator wrote it, or the words a tap on a button sends. */
  text: string;
  phase: MorphSendPhase;
  /** The composer's own refusal words for a `failed` send, or null. */
  reason: string | null;
}

/** The latest request of one session. `at` is when the send began, on the bridge's clock, in ms. */
export interface MorphRequest extends MorphRequestNote {
  at: number;
}

/** The wording of the build before the head and the tail were split: one trailing `[morph: ...]` bracket. */
const LEGACY_OPEN = "[morph:";
/** The tail of the split wording, and the head, as the bridge words them. */
const TAIL_OPEN = "[rules:";
const HEAD_OPEN = "[morph] from operator:";

/** The text without the tail: the exact `hint`, else a trailing `[rules: ... morph help ...]`, else the legacy bracket. */
function withoutTail(text: string, hint: string | undefined): string {
  if (hint !== undefined && hint.trim() !== "" && text.endsWith(hint)) return text.slice(0, text.length - hint.length).trimEnd();
  if (!text.trimEnd().endsWith("]")) return text;
  const rules = text.lastIndexOf(TAIL_OPEN);
  if (rules >= 0 && !text.slice(rules).includes("\n") && text.slice(rules).includes("morph help")) return text.slice(0, rules).trimEnd();
  const legacy = text.lastIndexOf(LEGACY_OPEN);
  if (legacy < 0 || text.slice(legacy).includes("\n")) return text;
  return text.slice(0, legacy).trimEnd();
}

/**
 * A text without the Morph wording a send added: the head in front (`[morph] from operator:`) and the
 * tail behind (`[rules: ...]`). The exact `head` and `hint` the session served go first; failing that, any
 * leading head and any trailing `[rules: ... morph help ...]` bracket on one line go too, so wording that
 * changed since the send (a rebuild, another path) is still taken off, and so does the one-bracket hint of
 * an earlier build. Anything else is returned as it was.
 */
export function stripMorphHint(text: string, wording: { head?: string | undefined; hint?: string | undefined } = {}): string {
  const body = withoutTail(text, wording.hint);
  const exact = wording.head !== undefined && wording.head.trim() !== "" && body.startsWith(wording.head);
  const head = exact ? wording.head : body.startsWith(HEAD_OPEN) ? HEAD_OPEN : null;
  return head === null || head === undefined ? body : body.slice(head.length).trimStart();
}

/** The leads of a person turn that is no request to the agent: a slash command and a shell line. An `@` turn is a prompt with a mention. */
const NOT_A_REQUEST_LEADS = ["/", "!"] as const;

/**
 * The latest person turn with words once its hint is stripped, or null. `at` is its time in ms. A slash
 * command (`/model`) or a shell line (`!ls`) typed in the terminal is no request, so it is skipped.
 */
export function latestRequestIn(entries: readonly TranscriptEntry[], wording: { head?: string | undefined; hint?: string | undefined }): { text: string; at: number } | null {
  for (const entry of entries.toReversed()) {
    if (entry.role !== "user" || entry.abandoned === true) continue;
    const text = stripMorphHint(textOf(entry), wording).trim();
    const at = timeOf(entry.ts);
    if (text === "" || Number.isNaN(at)) continue;
    if (reservedLead(text, NOT_A_REQUEST_LEADS) !== null) continue;
    return { text, at };
  }
  return null;
}

/**
 * The request held after the composer's word. The start of a send, or a note about another text, is a new
 * request stamped with `clock` (now on the bridge's clock, in ms). The end of the same send keeps the time
 * it began, so a screen drawn after it still counts as an answer to it.
 */
export function requestAfter(held: MorphRequest | undefined, note: MorphRequestNote, clock: number): MorphRequest {
  const fresh = note.phase === "sending" || held === undefined || held.text !== note.text;
  return { ...note, at: fresh ? clock : held.at };
}

/**
 * The request the body shows. What the composer told the view while the send is in flight or failed;
 * once it is sent, a person turn in the chat that is newer and says something else (the operator wrote
 * in the terminal) takes over. With nothing told (a reload), the chat's latest person turn, or null.
 */
export function morphRequestOf({
  local,
  entries,
  wording,
}: {
  local: MorphRequest | undefined;
  entries: readonly TranscriptEntry[];
  /** The head and the tail the session's bridge serves, to take off the chat's copy of the text. */
  wording: { head?: string | undefined; hint?: string | undefined };
}): MorphRequest | null {
  const journal = latestRequestIn(entries, wording);
  const fromJournal: MorphRequest | null = journal === null ? null : { text: journal.text, at: journal.at, phase: "sent", reason: null };
  if (local === undefined) return fromJournal;
  if (local.phase !== "sent") return local;
  if (fromJournal !== null && fromJournal.at > local.at && fromJournal.text !== local.text) return fromJournal;
  return local;
}

/** The one status line under the request. Each kind has its own words in the view. */
export type MorphStatus =
  | { kind: "sending" }
  | { kind: "notSent"; reason: string | null }
  | { kind: "sent" }
  | { kind: "working" }
  | { kind: "morphing" }
  | { kind: "answered"; at: string };

/** Whether a status leaves the request unanswered, so the screen under it is the old one. */
export function isUnanswered(status: MorphStatus | null): boolean {
  return status !== null && status.kind !== "notSent" && status.kind !== "answered";
}

/**
 * Where a request stands, in this order: the send in flight; the send that failed; the turn over with a
 * fresh block or a fresh choice (the answer); the agent's `morph start` for this request (fresh and not
 * older than {@link MORPH_DRAWING_MAX_MS}); a text answer once the turn ended; the pane's own working
 * status; and last, the bridge's confirmation. A fresh block while the turn still runs is a part of the
 * answer, not yet the answer. `now` is on the bridge's clock, in ms. Null when there is no request.
 */
export function morphStatusOf({
  request,
  view,
  drawing,
  working,
  entries,
  now,
}: {
  request: MorphRequest | null;
  view: MorphView | undefined;
  drawing: MorphDrawing | undefined;
  working: boolean;
  entries: readonly TranscriptEntry[];
  now: number;
}): MorphStatus | null {
  if (request === null) return null;
  if (request.phase === "sending") return { kind: "sending" };
  if (request.phase === "failed") return { kind: "notSent", reason: request.reason };
  const { freshAt } = splitScreen(view, request.at);
  if (!working && freshAt !== null) return { kind: "answered", at: freshAt };
  const drawn = drawing === undefined ? Number.NaN : timeOf(drawing.at);
  if (drawn >= request.at && now - drawn < MORPH_DRAWING_MAX_MS) return { kind: "morphing" };
  const answer = working ? null : textAnswerAfter(entries, new Date(request.at - 1).toISOString());
  if (answer !== null) return { kind: "answered", at: answer.ts };
  if (working) return { kind: "working" };
  return { kind: "sent" };
}

/** How many of the agent's notes the body shows for one request, newest last. */
export const MORPH_NOTES_SHOWN = 4;

/** The notes the agent's `morph start` calls said for this request (at its time or later), newest last. */
export function requestNotes(drawing: MorphDrawing | undefined, requestAt: number): MorphNote[] {
  const notes = drawing?.notes ?? (drawing?.note === undefined ? [] : [{ at: drawing.at, note: drawing.note }]);
  return notes.filter((note) => timeOf(note.at) >= requestAt).slice(-MORPH_NOTES_SHOWN);
}

// ── the receipt of a pick ───────────────────────────────────────────────────────────────────────

/** What the body shows in place of the request bubble when the request was a pick or a tap. */
export interface MorphReceipt {
  readonly kind: "pick" | "tap";
  /** The label picked or tapped. */
  readonly label: string;
  /** What it answered: the choice's question, the button's group, or the screen's title; null for none. */
  readonly context: string | null;
  /** The picture ref of the option's preview, or null. */
  readonly preview: number | null;
}

const PICKED_RE = /^picked "(.+?)"(?::\s|$)/u;
const TAPPED_RE = /^tapped "(.+?)"(?: in "(.+?)")?(?::\s|$)/u;

/**
 * The receipt of a request whose words are a pick (`picked "<label>"`) or a tap (`tapped "<label>"`), with
 * what it answered read from the screen; null for a typed request, which keeps the chat bubble.
 */
export function pickReceiptOf(text: string, view: MorphView | undefined): MorphReceipt | null {
  const picked = PICKED_RE.exec(text);
  if (picked !== null) {
    const label = picked[1] ?? "";
    const option = view?.choice?.options.find((candidate) => candidate.label === label);
    return { kind: "pick", label, context: view?.choice?.question ?? view?.title ?? null, preview: option?.preview ?? null };
  }
  const tapped = TAPPED_RE.exec(text);
  if (tapped === null) return null;
  return { kind: "tap", label: tapped[1] ?? "", context: tapped[2] ?? view?.title ?? null, preview: null };
}
