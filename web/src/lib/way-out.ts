// The way out (M56 spec 07; the rule is in experiments/reader-stability/ARCHITECTURE.md, "The way out:
// an invariant, not a state", and the M56 README, "The way out"). In every state of the pane's Surface
// the raw rows and the key pad are one tap from the composer, and nothing hides the key pad but a pane
// that is gone, a device that may not write, or a link that is down. This file is the one place that
// says so: a pure function of the Surface, the three facts the composer keeps beside it and one reading
// (whether a key can be sent at all). The composer renders what it decides, and one test per state
// (components/composer.way-out.test.tsx) holds the rule. The placeholder does not name the state (it
// did in 1.22.0 and went back to the plain reply line): the notices and the Screen pill do.
//
// Pure: no DOM, no clock, and no harness name.

import { sendSlot, type ComposerFacts } from "./send-slot";
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

/** The one thing the composer reads besides the Surface and the facts. */
export interface WayOutReadings {
  /** Some key can be sent through this multiplexer (the `sendKeys` capability). */
  readonly keysCapable: boolean;
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
}

/** The way out for a Surface, the three facts and the readings. */
export function wayOut(surface: Surface, facts: ComposerFacts, readings: WayOutReadings): WayOut {
  const state = wayOutState(surface, facts);
  const keysOpen = state !== "gone" && state !== "readOnly" && readings.keysCapable;
  const keysSendable = keysOpen && state !== "offline";
  return { state, keysOpen, keysSendable };
}
