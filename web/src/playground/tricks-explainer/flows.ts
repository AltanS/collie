// The map's steps for the three examples, one list each, read by the chapters' step players and by the
// website's figures (../explainer-figures.tsx), so each animation is defined once. Plain data: this module
// imports no fixture and no component.
// DEV-ONLY, like the rest of `src/playground/`.

import type { Seg } from "./hues";
import type { MapFocus } from "./map";

/** Morph's sample session: a fictional machine, as every name on this page. */
export const ADDRESS = "lodge/w54:p1B#sx56";
export const BIN = "/home/you/.local/bin/collie";
export const REQUEST = "Which tests broke after the rename?";

/** What a request typed in the Morph view becomes: Collie's head, your words, and where the rules are. One line. */
export const REQUEST_LINE: readonly Seg[] = [
  { t: `[view:morph ${ADDRESS}] from operator:`, hue: "bridge", n: 1 },
  { t: " " },
  { t: REQUEST, hue: "you", n: 2 },
  { t: " " },
  { t: `[rules: ${BIN} trick view morph help --session ${ADDRESS}]`, hue: "bridge", n: 3 },
];

/** One run of a program trick: the bridge hands facts, the program prints, the phone draws. */
export const PROGRAM_FLOW: readonly MapFocus[] = [
  { lit: ["bridge"] },
  { lit: ["bridge", "trick"], arrow: "run", payload: "facts", hue: "bridge" },
  { lit: ["bridge", "trick"], arrow: "run", payload: "JSON", hue: "trick", back: true },
  { lit: ["bridge"] },
  { lit: ["bridge", "phone"], arrow: "link", payload: "2 parts", hue: "trick", back: true },
];

/** A trick asks on the Hill: its program lists a Decision, you answer, the program gets your tap. */
export const HILL_FLOW: readonly MapFocus[] = [
  { lit: ["bridge", "trick"], arrow: "run", payload: "facts", hue: "bridge" },
  { lit: ["bridge", "trick"], arrow: "run", payload: "decisions", hue: "trick", back: true },
  { lit: ["bridge"] },
  { lit: ["bridge", "phone"], arrow: "link", payload: "Decision", hue: "trick", back: true },
  { lit: ["you", "phone"], arrow: "tap", payload: "Rerun", hue: "you" },
  { lit: ["bridge", "trick"], arrow: "run", payload: "tap", hue: "you" },
  { lit: ["trick"] },
];

/** One turn of an agent view: you ask, the agent draws a screen, you tap, the agent acts. */
export const VIEW_FLOW: readonly MapFocus[] = [
  { lit: ["you", "phone"], arrow: "tap", payload: "request", hue: "you" },
  { lit: ["phone", "bridge", "agent"], arrow: "type", payload: "[view:morph …]", hue: "bridge" },
  { lit: ["agent"], arrow: "cmd", payload: "start", hue: "agent" },
  { lit: ["agent", "bridge"], arrow: "cmd", payload: "screen.json", hue: "agent" },
  { lit: ["bridge", "phone"], arrow: "link", payload: "screen", hue: "agent", back: true },
  { lit: ["you", "phone"], arrow: "tap", payload: "Fix both", hue: "you" },
  { lit: ["bridge", "agent"], arrow: "type", payload: 'tapped "Fix both"', hue: "bridge" },
  { lit: ["agent", "bridge"], arrow: "cmd", payload: "new screen", hue: "agent" },
];
