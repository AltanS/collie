// The way out (M56 spec 07; the rule is in experiments/reader-stability/ARCHITECTURE.md, "The way out:
// an invariant, not a state", and the M56 README, "The way out"). In every state of the pane's Surface
// the raw rows and the key pad are one tap from the composer, the composer names the state in its
// placeholder, and nothing hides the key pad but a pane that is gone, a device that may not write,
// or a link that is down. This file is the one place that says so: a pure function of the Surface,
// the three facts the composer keeps beside it and two readings (whether a key can be sent at all,
// and when the pane was last read). The composer renders what it decides, and one test per state
// (components/composer.way-out.test.tsx) holds the rule.
//
// Pure: no DOM, no clock of its own (the caller hands `now`), and no harness name.

import type { MessageKey } from "./i18n";
import type { DialogNoun } from "./harness/dialog-contract";
import { askNoun, sendSlot, type ComposerFacts } from "./send-slot";
import type { Surface } from "./surface/surface";

/**
 * The thirteen states a composer can be in, one word each. Eight come from the Surface (`free`, `draft`,
 * `ask`, `unreadable`, `running`, and the `unknown` family `no-match`, `contested`, `stale`, `torn`),
 * `unreachable` is the Surface's `composer: unreachable`, and three are facts the phone keeps: the pane
 * is `gone`, the device is `readOnly`, the link is `offline`.
 */
export const WAY_OUT_STATES = [
  "free",
  "draft",
  "ask",
  "unreadable",
  "running",
  "no-match",
  "contested",
  "stale",
  "torn",
  "unreachable",
  "gone",
  "readOnly",
  "offline",
] as const;
export type WayOutState = (typeof WAY_OUT_STATES)[number];

/** The state of a Surface and the three facts. The order is the Send slot's own (`sendSlot`), so the two never disagree. */
export function wayOutState(surface: Surface, facts: ComposerFacts): WayOutState {
  switch (sendSlot(surface, facts)) {
    case "gone":
      return "gone";
    case "readOnly":
      return "readOnly";
    case "unreachable":
      return "unreachable";
    case "offline":
      return "offline";
    case "answer":
      return "ask";
    case "running":
      return "running";
    case "send":
      return "free";
    case "draft":
      return "draft";
    case "manual":
      return surface.modal === "unreadable" ? "unreadable" : "no-match";
    case "wait":
      return surface.reason === "stale" || surface.reason === "torn" || surface.reason === "contested" ? surface.reason : "no-match";
  }
}

/** The placeholder key per noun, so the box names what is waiting. */
export const DIALOG_PLACEHOLDER = {
  menu: "composer.placeholder.menuWaiting",
  permission: "composer.placeholder.permissionWaiting",
  question: "composer.placeholder.questionWaiting",
  dialog: "composer.placeholder.dialogWaiting",
} as const satisfies Record<DialogNoun, MessageKey>;

/** What the placeholder says: a catalog key, and the one parameter a sentence takes (the age of a stale read). */
export interface WayOutWords {
  readonly key: MessageKey;
  readonly params?: Readonly<Record<string, string>>;
}

/** What a reading of the pane's last read gives: its age as the person reads it, or null when there is no read to age. */
export function ageWords(readAt: number | undefined, now: number): string | null {
  if (readAt === undefined) return null;
  const secs = Math.max(0, Math.floor((now - readAt) / 1000));
  if (secs < 60) return `${secs} s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h`;
  return `${Math.floor(hrs / 24)} d`;
}

/** The two things the composer reads besides the Surface and the facts. */
export interface WayOutReadings {
  /** Some key can be sent through this multiplexer (the `sendKeys` capability). */
  readonly keysCapable: boolean;
  /** When the phone last read this pane (epoch ms), or undefined. For the age of a stale read. */
  readonly readAt: number | undefined;
  readonly now: number;
  /** The Surface is the stand-in for a pane the bridge has not read yet (`UNREAD_SURFACE`), not a read. */
  readonly unread: boolean;
  /** The pane is a bare shell: it has no input box for the bridge to find, so "no match" is its ordinary state. */
  readonly shell: boolean;
}

export interface WayOut {
  readonly state: WayOutState;
  /**
   * The Keys dock can be opened: in every state but a pane that is gone and a device that may not
   * write, and never while the multiplexer cannot send any key at all. A box out of reach, a refused
   * send, an ask the phone cannot read and a stale read all keep it.
   */
  readonly keysOpen: boolean;
  /**
   * A key can be sent now: the dock is open and the link is up. Offline the dock still opens (the
   * person can see what it holds) and its buttons wait.
   */
  readonly keysSendable: boolean;
  /** The placeholder's words, or null where the ordinary placeholder (a reply, a shell line) is the name of the state. */
  readonly words: WayOutWords | null;
}

/** The way out for a Surface, the three facts and the readings. */
export function wayOut(surface: Surface, facts: ComposerFacts, readings: WayOutReadings): WayOut {
  const state = wayOutState(surface, facts);
  const keysOpen = state !== "gone" && state !== "readOnly" && readings.keysCapable;
  const keysSendable = keysOpen && state !== "offline";
  return { state, keysOpen, keysSendable, words: wordsOf(state, surface, readings) };
}

function wordsOf(state: WayOutState, surface: Surface, readings: WayOutReadings): WayOutWords | null {
  switch (state) {
    case "free":
      return null;
    case "gone":
      return { key: "composer.placeholder.gone" };
    case "readOnly":
      return { key: "composer.placeholder.readOnly" };
    case "unreachable":
      return { key: "composer.placeholder.unreachable" };
    case "offline":
      // Offline names its reason on the Send button ("Reconnect to send") and in the connection banner,
      // and the field stays typeable, so its placeholder stays the ordinary one.
      return null;
    case "ask":
      return { key: DIALOG_PLACEHOLDER[askNoun(surface) ?? "dialog"] };
    case "running":
      return { key: "composer.placeholder.running" };
    case "draft":
      return { key: "composer.placeholder.draft" };
    case "unreadable":
      return { key: "composer.placeholder.unreadable" };
    case "no-match":
      // A pane the bridge has not read yet has no observation to name, and a bare shell has no input box
      // to find: the ordinary placeholder (a reply, a shell line) stays for both.
      return readings.unread || readings.shell ? null : { key: "composer.placeholder.noMatch" };
    case "contested":
      return { key: "composer.placeholder.contested" };
    case "torn":
      return { key: "composer.placeholder.torn" };
    case "stale": {
      const age = ageWords(readings.readAt, readings.now);
      return age === null ? { key: "composer.placeholder.staleNoAge" } : { key: "composer.placeholder.stale", params: { age } };
    }
  }
}
