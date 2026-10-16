// The lab's verdict (M56 spec 10): from what the run saw, pass, fail or walk-only. Pure.
//
// PASS needs two things and nothing more: zero `free` on any dialog screen, and a settled send.
// A "dialog screen" is a screen the lab expected to be a dialog (the safe list says so), or one the
// generic cues read as a strong dialog, or one the Surface read as a modal. A free read on any of them
// means the phone would send into a dialog.
//
// A harness with no profile runs only the walk. If the walk is clean, the result is `walk-only`: the
// ledger says the walk ran and the readers were not exercised. It never moves a verified version.

import type { CueStrength } from "../../../web/src/lib/surface/cues";
import type { Surface } from "../../../web/src/lib/surface/surface";

export type ScreenExpect = "dialog" | "idle" | "either";

/** One screen the lab reached, as the Surface read it. */
export interface ScreenFact {
  /** The leg that reached it: `start`, `walk`, `send` or `ask`. */
  readonly leg: string;
  /** What the lab did to get here, e.g. `/model`. */
  readonly label: string;
  readonly expects: ScreenExpect;
  readonly surface: Pick<Surface, "turn" | "composer"> & { readonly modal: "none" | "ask" | "unreadable" | "unknown"; readonly reason?: string | undefined };
  readonly free: boolean;
  readonly cue: CueStrength;
  /** The rows as plain text. Redacted before they leave the lab. */
  readonly rows: readonly string[];
}

export type LegStatus = "pass" | "fail" | "not-reached";

export interface LegFact {
  readonly name: "walk" | "send" | "ask";
  readonly status: LegStatus;
  readonly detail: string;
}

export interface SendFact {
  readonly outcome: string;
  readonly reason?: string | undefined;
  readonly probed: boolean;
  readonly keys: number;
}

export interface AskFact {
  readonly outcome: string;
  readonly reason?: string | undefined;
  /** The file the declined command would have made. It must not exist. */
  readonly fileCreated: boolean;
}

export interface WalkFact {
  readonly reached: boolean;
  readonly returned: boolean;
  /** The `/` menu listed at least one command, or the harness has no list to walk. */
  readonly menuRead: boolean;
  /** A command that started a model turn. A safe command never does, so this is a bug of the list. */
  readonly startedTurn: string | null;
  readonly sent: readonly string[];
  readonly unclassified: readonly string[];
  readonly missing: readonly string[];
}

export interface LabFacts {
  readonly harness: string;
  readonly version: string;
  /** The status of the harness's profile at this version, or `none`. */
  readonly profile: "verified" | "provisional" | "revoked" | "none";
  readonly walk: WalkFact;
  readonly screens: readonly ScreenFact[];
  readonly send: SendFact | null;
  readonly ask: AskFact | null;
  readonly turns: number;
}

export type LabVerdictResult = "pass" | "fail" | "walk-only";

export interface Verdict {
  readonly result: LabVerdictResult;
  /** Why, one sentence each. Empty on a pass. */
  readonly reasons: readonly string[];
  /** The dialog screens that read free. */
  readonly freeOnDialog: readonly ScreenFact[];
}

export const SETTLED_OUTCOMES: readonly string[] = ["sent", "effective"];

/** Whether the lab takes a screen for a dialog. */
export function isDialogScreen(screen: ScreenFact): boolean {
  return screen.expects === "dialog" || screen.cue === "strong" || screen.surface.modal === "ask" || screen.surface.modal === "unreadable";
}

export function judge(facts: LabFacts): Verdict {
  const freeOnDialog = facts.screens.filter((screen) => isDialogScreen(screen) && screen.free);
  const reasons: string[] = [];
  for (const screen of freeOnDialog) reasons.push(`${screen.label} is a dialog and the Surface read it free`);
  if (!facts.walk.reached) reasons.push("the walk could not start: no free box at the start");
  else if (!facts.walk.returned) reasons.push("the walk could not get back to a free box");
  if (!facts.walk.menuRead) reasons.push("the / menu listed no command");
  if (facts.walk.startedTurn !== null) reasons.push(`${facts.walk.startedTurn} is on the safe list and it started a model turn`);
  if (facts.profile === "none") return { result: reasons.length === 0 ? "walk-only" : "fail", reasons, freeOnDialog };
  if (facts.send === null) reasons.push("no send was made");
  else if (!SETTLED_OUTCOMES.includes(facts.send.outcome)) reasons.push(`the probed send did not settle: ${facts.send.outcome}${facts.send.reason === undefined ? "" : ` (${facts.send.reason})`}`);
  if (facts.ask !== null && facts.ask.fileCreated) reasons.push("the declined command made its file");
  return { result: reasons.length === 0 ? "pass" : "fail", reasons, freeOnDialog };
}
