// The thirteen states of the way out (M56 spec 07), as props a Composer takes: the Surface the bridge
// read and the three facts the phone keeps. One table, read by the way-out tests (composer.test.tsx,
// composer.way-out.test.tsx) and by the playground's numbered cards (playground/composer-states.tsx),
// so a card, a test and a placeholder always talk about the same state.

import type { Surface } from "@/lib/surface/surface";
import { WAY_OUT_STATES, type WayOutState } from "@/lib/way-out";

/** What a state is, as props: the Surface, the facts, and how long ago the pane was last read. */
export interface WayOutCase {
  readonly state: WayOutState;
  /** The card's number in the playground, 1 to 13, in the order of `WAY_OUT_STATES`. */
  readonly n: number;
  readonly title: string;
  readonly surface: Surface;
  readonly gone: boolean;
  readonly readOnly: boolean;
  /** The pane's screen is a saved copy: nothing is sent from it. */
  readonly offline: boolean;
  /** The words a caller folds in for a box out of reach (a machine the lead cannot reach). */
  readonly unreachableNote?: string;
  /** How long ago the last read landed, in ms; the age a stale Surface names. */
  readonly readAgeMs: number;
  /** The one thing a person does here, in the card's words. */
  readonly reach: string;
}

const base = { turn: "unknown", modal: "unknown", composer: "unknown" } as const;

const ASK: Surface = {
  revision: 5,
  turn: "idle",
  modal: { ask: { id: "ask-1", kind: "menu", options: [{ id: "1", label: "Opus" }, { id: "2", label: "Sonnet" }], channel: "keys", hash: "0a1b2c" } },
  composer: "unknown",
};

const FACTS = { gone: false, readOnly: false, offline: false, readAgeMs: 800 } as const;

const CASES = {
  free: {
    title: "free",
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    ...FACTS,
    reach: "an idle agent with an empty input box. Send is the fast path.",
  },
  draft: {
    title: "composer draft",
    surface: { revision: 2, turn: "idle", modal: "none", composer: "draft" },
    ...FACTS,
    reach: "type half a message at the desk, then tap Send on the phone. The bridge refuses, and Add to it, Replace and Cancel appear at the thumb.",
  },
  ask: {
    title: "modal ask",
    surface: ASK,
    ...FACTS,
    reach: "open /model in Claude. The menu lifts as a card and owns the keys; a draft turns Send into Answer the dialog.",
  },
  unreadable: {
    title: "modal unreadable",
    surface: { revision: 6, turn: "idle", modal: "unreadable", composer: "unknown" },
    ...FACTS,
    reach: "open /tasks on a narrow pane, where the footer wraps and no card lifts. Send takes two taps; Screen and Keys stay open.",
  },
  running: {
    title: "turn running",
    surface: { revision: 7, turn: "running", modal: "none", composer: "empty" },
    ...FACTS,
    reach: "send a long task and look while the agent works. Keys can stop it.",
  },
  "no-match": {
    title: "unknown, no match",
    surface: { revision: 8, ...base, reason: "no-match" },
    ...FACTS,
    reach: "a harness with no profile, or a screen the cues do not match. Send takes two taps: prepare, then commit.",
  },
  contested: {
    title: "unknown, contested",
    surface: { revision: 9, ...base, reason: "contested" },
    ...FACTS,
    reach: "two sources of the pane's state disagree for longer than the settle time. Send asks the bridge to read the screen again.",
  },
  stale: {
    title: "unknown, stale",
    surface: { revision: 10, ...base, reason: "stale" },
    ...FACTS,
    readAgeMs: 12_000,
    reach: "the bridge's last read of the pane is older than two polls. The next tap reads again.",
  },
  torn: {
    title: "unknown, torn",
    surface: { revision: 11, ...base, reason: "torn" },
    ...FACTS,
    reach: "the screen changed while it was being read. Send reads it again.",
  },
  unreachable: {
    title: "composer unreachable",
    surface: { revision: 12, turn: "unknown", modal: "unknown", composer: "unreachable" },
    ...FACTS,
    unreachableNote: "workshop is not answering",
    reach: "a pane on a machine the lead cannot reach, or a bridge with sending off. The field is locked; the Keys dock still opens.",
  },
  gone: {
    title: "pane gone",
    surface: { revision: 13, turn: "idle", modal: "none", composer: "empty" },
    ...FACTS,
    gone: true,
    reach: "close the pane's agent on the machine. The board says Pane is gone.",
  },
  readOnly: {
    title: "read-only device",
    surface: { revision: 14, turn: "idle", modal: "none", composer: "empty" },
    ...FACTS,
    readOnly: true,
    reach: "open a pane from a device the bridge lets read and not write.",
  },
  offline: {
    title: "offline",
    surface: { revision: 15, turn: "idle", modal: "none", composer: "empty" },
    ...FACTS,
    offline: true,
    reach: "lose the link, or open a saved copy. Send says Reconnect to send; the field keeps the draft.",
  },
} satisfies Record<WayOutState, Omit<WayOutCase, "state" | "n">>;

/** The thirteen cases, in the order of `WAY_OUT_STATES`. */
export const WAY_OUT_CASES: readonly WayOutCase[] = WAY_OUT_STATES.map((state, index) => Object.assign({ state, n: index + 1 }, CASES[state]));

/** One case by its state. */
export function wayOutCase(state: WayOutState): WayOutCase {
  const found = WAY_OUT_CASES.find((c) => c.state === state);
  if (found === undefined) throw new Error(`no way-out case for ${state}`);
  return found;
}
