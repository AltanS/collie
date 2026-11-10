// MORPH'S READER: pure rules over what the phone already holds. No I/O and no React.
//
// The wire's own readers (lib/morph/wire.ts) check what the bridge sends. This file reads what the Morph
// body shows from that and from the Chat data the session screen already has: which of the three states
// is on screen, the agent's text answer, the words a tap sends, and the hint a send carries.
//
// ── THE THREE STATES ─────────────────────────────────────────────────────────────────────────────
//   empty    no screen yet. The body says how to begin.
//   working  the agent's turn runs (the pane's own status, the signal Chat reads). The last screen stays,
//            dimmed, so nothing jumps when the next one lands.
//   text     the agent took a request AFTER the screen was drawn and answered it in text, without a new
//            show: a person turn newer than the screen, then an agent reply after it, and the turn is
//            over. The text is drawn under the screen. The reply that ENDS the turn in which the agent
//            drew the screen is older than no person turn after the screen, so it never counts.
//   view     the screen alone.
//
// ── THE REQUEST, AND WHERE IT STANDS ─────────────────────────────────────────────────────────────
// The body opens with the operator's latest request, without the hint, and one quiet status line under
// it (`morphStatusOf`). The request comes from what the composer told the view when the send started
// (`MorphRequest`), and after a reload, when that is gone, from the latest person turn in the chat window
// the session screen already holds, its hint stripped (`stripMorphHint`).

import { isCommand } from "@/lib/send-protocol";
import { kidsOf } from "@/lib/tricks/layout";
import type { View, ViewNode } from "@/lib/tricks/schema";
import type { TranscriptEntry } from "@/lib/types";

import { MORPH_DRAWING_MAX_MS, type MorphChoice, type MorphDrawing, type MorphView } from "./wire";

/** The word Morph. A name, never translated, so it is no dictionary key (like a typeface's family name). */
export const MORPH_NAME = "Morph";

export type MorphState = "empty" | "working" | "text" | "view";

/** The agent's text answer the body draws in the `text` state. */
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

/** Which state the Morph body is in. */
export function morphStateOf({
  view,
  working,
  answer,
}: {
  view: MorphView | undefined;
  working: boolean;
  answer: MorphTextAnswer | null;
}): MorphState {
  if (working) return "working";
  // A text answer with no screen is still an answer: the body draws it, so nothing reads as empty.
  if (view === undefined) return answer === null ? "empty" : "text";
  if (answer !== null) return "text";
  return "view";
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

// ── the decision block ──────────────────────────────────────────────────────────────────────────

/**
 * The control a pick in the decision block is filed under, beside the view's own `v/...` paths, so the
 * picks logic holds both: the block's options share the parent `choice`, so one pick moves the mark.
 */
export function choiceControl(index: number): string {
  return `choice/${String(index)}`;
}

/** The option marked among the picks, or null. */
export function pickedOption(controls: readonly string[]): number | null {
  for (const control of controls.toReversed()) {
    const match = /^choice\/(\d+)$/u.exec(control);
    if (match !== null) return Number(match[1]);
  }
  return null;
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

/** The picks the operator made on one session's screen: the controls marked, for one `rev` of that screen. */
export interface MorphPicks {
  address: string;
  rev: number;
  controls: readonly string[];
}

const NO_PICKS: readonly string[] = [];

/** The controls marked on the screen now: none once the screen is another one (a new `rev`) or another session's. */
export function picksFor(held: MorphPicks | null, { address, rev }: { address: string; rev: number | undefined }): readonly string[] {
  return held !== null && held.address === address && held.rev === rev ? held.controls : NO_PICKS;
}

/**
 * The picks after a tap the bridge confirmed: that button is marked, and the mark of its siblings in the
 * same bar goes (one pick per bar). The marks of other bars and groups stay. A pick on a new `rev`
 * starts again.
 */
export function picksAfter(held: MorphPicks | null, { address, rev, control }: { address: string; rev: number; control: string }): MorphPicks {
  const bar = parentControl(control);
  const kept = picksFor(held, { address, rev }).filter((other) => parentControl(other) !== bar);
  return { address, rev, controls: [...kept, control] };
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

/** The latest person turn with words once its hint is stripped, or null. `at` is its time in ms. */
export function latestRequestIn(entries: readonly TranscriptEntry[], wording: { head?: string | undefined; hint?: string | undefined }): { text: string; at: number } | null {
  for (const entry of entries.toReversed()) {
    if (entry.role !== "user" || entry.abandoned === true) continue;
    const text = stripMorphHint(textOf(entry), wording).trim();
    const at = timeOf(entry.ts);
    if (text !== "" && !Number.isNaN(at)) return { text, at };
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
  | { kind: "morphing"; note: string | null }
  | { kind: "answered"; at: string };

/** Whether a status leaves the request unanswered, so the screen under it is the old one. */
export function isUnanswered(status: MorphStatus | null): boolean {
  return status !== null && status.kind !== "notSent" && status.kind !== "answered";
}

/**
 * Where a request stands, in this order: the send in flight; the send that failed; a screen drawn after
 * the request; the agent's `morph start` (fresh, newer than the request and the screen); a text answer
 * once the turn ended; the pane's own working status; and last, the bridge's confirmation.
 * `now` is on the bridge's clock, in ms. Null when there is no request.
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
  if (view !== undefined && timeOf(view.at) > request.at) return { kind: "answered", at: view.at };
  const drawn = drawing === undefined ? Number.NaN : timeOf(drawing.at);
  const viewAt = view === undefined ? Number.NEGATIVE_INFINITY : timeOf(view.at);
  if (drawing !== undefined && drawn >= request.at && drawn > viewAt && now - drawn < MORPH_DRAWING_MAX_MS) {
    return { kind: "morphing", note: drawing.note ?? null };
  }
  const answer = working ? null : textAnswerAfter(entries, new Date(request.at - 1).toISOString());
  if (answer !== null) return { kind: "answered", at: answer.ts };
  if (working) return { kind: "working" };
  return { kind: "sent" };
}
