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

import { isCommand } from "@/lib/send-protocol";
import { kidsOf } from "@/lib/tricks/layout";
import type { View, ViewNode } from "@/lib/tricks/schema";
import type { TranscriptEntry } from "@/lib/types";

import type { MorphView } from "./wire";

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
  if (view === undefined) return "empty";
  if (answer !== null) return "text";
  return "view";
}

/**
 * The text a send carries while the Morph view shows: `text + " " + hint`, on one line. No hint for an
 * empty hint, for a text with a reserved lead (`/`, `!`, `@`: a command, a shell line, a file mention,
 * whose words the harness reads as its own), and for a send with attachments.
 */
export function withMorphHint({ text, hint, attachments }: { text: string; hint: string | undefined; attachments: number }): string {
  if (hint === undefined || hint.trim() === "") return text;
  if (attachments > 0) return text;
  if (isCommand(text.trimStart())) return text;
  return `${text} ${hint}`;
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

/**
 * The words a tap on a button sends: its `value` when it has words, else its label. Read from the button
 * node the control names, the renderer's own path, so the words are the ones on screen. Null when the
 * control names no button, so nothing is sent.
 */
export function tapTextOf({ view, control }: { view: View; control: string }): string | null {
  const node = nodeAtControl(view, control);
  if (node?.kind !== "button") return null;
  const value = node.attrs.value?.trim() ?? "";
  if (value !== "") return node.attrs.value ?? null;
  const label = node.attrs.label.trim();
  return label === "" ? null : label;
}
