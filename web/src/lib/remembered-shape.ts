// A REMEMBERED SHAPE: the last known answer to "is this part of the page there?", so a component
// paints its first frame from it instead of from nothing (DESIGN.md §2, "Every layout shift is a
// defect"). A part that waits on a read that ends after the first paint has no place until the read
// lands, and everything after it moves. With this, the second visit on a device paints the part where
// it will stand.
//
// IT HOLDS SHAPE FACTS AND NOTHING ELSE: a boolean, a small whole number (0 to 99), or one word from
// a fixed list. The `ANSWERS` table below is the only way to name a fact, and its type makes a free
// string, an object or an array impossible. Never an identity, a name, an email, a path, a label, a
// message, or the count of something private: a fact says "a row is there", not what is in it. The
// device wipe (lib/wipe.ts) removes all of them on unpair anyway.
//
// localStorage, read synchronously on the first render. One key per fact under `collie:shape:`, scoped
// by the mount (`/` or `/collie/`) the way the on-device store is (lib/store.ts), because one origin
// can serve more than one Collie and each has its own answers. Missing, broken or blocked storage reads
// as "no answer" and never throws.

import { useEffect, useState } from "react";

import { basePath } from "./base-path";

/** The key prefix. The device wipe removes every key under it. */
export const ANSWER_PREFIX = "collie:shape:";

/** Largest whole number a count fact may hold. A shape is a small number, never a tally of anything. */
export const ANSWER_MAX_COUNT = 99;

export type AnswerKind = "flag" | "count" | readonly [string, ...string[]];

/** What a bridge said about one multiplexer capability: yes, no, or nothing (lib/remembered-mux.ts). */
const MUX_SAID = ["yes", "no", "unsaid"] as const;

/** The facts. A kind is `"flag"` (a boolean), `"count"` (0 to 99) or a fixed list of short words. */
export const ANSWERS = {
  "settings-accounts-row": "flag",
  "settings-tricks-row": "flag",
  "settings-install-card": "flag",
  // Package mux-config (lib/remembered-mux.ts): what the front machine's /api/config said last time.
  // One word per declared capability, `unsaid` when the bridge did not mention it, so a capability a
  // bridge stopped declaring is forgotten and not kept as a stale yes or no.
  "mux-paneGrid": MUX_SAID,
  "mux-gridScrollback": MUX_SAID,
  "mux-agentDetection": MUX_SAID,
  "mux-agentSessionRef": MUX_SAID,
  "mux-typeText": MUX_SAID,
  "mux-sendKeys": MUX_SAID,
  "mux-renamePane": MUX_SAID,
  "mux-closePane": MUX_SAID,
  "mux-setFocus": MUX_SAID,
  "mux-createTab": MUX_SAID,
  "mux-renameTab": MUX_SAID,
  "mux-closeTab": MUX_SAID,
  "mux-createSpace": MUX_SAID,
  "mux-createWorktree": MUX_SAID,
  "mux-pushTopologyEvents": MUX_SAID,
  "mux-pushPaneEvents": MUX_SAID,
  "mux-steerTurn": MUX_SAID,
  "mux-abortTurn": MUX_SAID,
  "mux-starters": MUX_SAID,
  "mux-renameSpace": MUX_SAID,
  "mux-programActions": MUX_SAID,
  "mux-programHistory": MUX_SAID,
  "mux-reopenConversation": MUX_SAID,
  "mux-spaces": ["one", "many"],
  "stt-offered": "flag",
} as const satisfies Record<string, AnswerKind>;

export type AnswerName = keyof typeof ANSWERS;
type ValueOf<K> = K extends "flag" ? boolean : K extends "count" ? number : K extends readonly (infer W)[] ? W : never;
/** What a fact holds: its kind's value and nothing wider. */
export type AnswerValue<N extends AnswerName> = ValueOf<(typeof ANSWERS)[N]>;

function keyOf(name: AnswerName): string {
  return `${ANSWER_PREFIX}${basePath()}:${name}`;
}

/** Exported for the test: how a stored string reads back for a kind. */
export function decodeAnswer(kind: AnswerKind, raw: string | null): boolean | number | string | undefined {
  if (raw === null) return undefined;
  if (kind === "flag") return raw === "1" ? true : raw === "0" ? false : undefined;
  if (kind === "count") return /^\d{1,2}$/.test(raw) ? Number(raw) : undefined;
  return kind.includes(raw) ? raw : undefined;
}

/** What a caller may offer to be stored. A kind accepts one of these and refuses the rest. */
export type AnswerInput = boolean | number | string;

/** Exported for the test: how a value is stored for a kind, or null when the kind refuses it. */
export function encodeAnswer(kind: AnswerKind, value: AnswerInput): string | null {
  if (kind === "flag") return value === true ? "1" : value === false ? "0" : null;
  if (kind === "count") return Number.isInteger(value) && /^\d{1,2}$/.test(String(value)) ? String(value) : null;
  return kind.find((word) => word === value) ?? null;
}

/** The remembered answer, or `undefined` when there is none. Never throws. */
export function readAnswer<N extends AnswerName>(name: N): AnswerValue<N> | undefined {
  try {
    // SAFETY: `decode` returns only a value the kind of `name` allows, which is `AnswerValue<N>`.
    return decodeAnswer(ANSWERS[name], localStorage.getItem(keyOf(name))) as AnswerValue<N> | undefined;
  } catch {
    return undefined;
  }
}

/** Remember an answer. A value the fact's kind does not allow is refused, and so is a blocked storage. Never throws. */
export function writeAnswer<N extends AnswerName>(name: N, value: AnswerValue<N>): void {
  try {
    const raw = encodeAnswer(ANSWERS[name], value);
    if (raw !== null) localStorage.setItem(keyOf(name), raw);
  } catch {
    // Blocked or full storage: the next visit paints without a memory, which is today's behaviour.
  }
}

/** Remove every remembered shape, of every mount. The device wipe calls it. Never throws. */
export function forgetAnswers(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(ANSWER_PREFIX)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Locked-down storage: nothing was written there either.
  }
}

/**
 * The fresh answer when the read has one, else the remembered one, else `undefined`. Pass `undefined`
 * as `fresh` while the read is in flight. The remembered answer is read once, on the first render, and
 * the fresh one is written when it arrives. `name` is a constant of the call site.
 */
export function useRememberedAnswer<N extends AnswerName>(name: N, fresh: AnswerValue<N> | undefined): AnswerValue<N> | undefined {
  const [held, setHeld] = useState(() => readAnswer(name));
  useEffect(() => {
    if (fresh === undefined) return;
    writeAnswer(name, fresh);
    setHeld(fresh);
  }, [name, fresh]);
  return fresh ?? held;
}
