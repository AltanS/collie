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
import type { PhoneFacts } from "./phone";
import { phoneReasons } from "./phone-verdict";
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
  /** Commands the menu marks "(removed)": reported, never sent. Left out when the walk read none. */
  readonly removed?: readonly string[];
}

/** Which legs a run makes: every leg (the nightly run), or the phone leg alone (a hand run, `--leg phone`). */
export const LAB_LEGS = ["all", "phone"] as const;
export type LabLegs = (typeof LAB_LEGS)[number];

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
  /** Why the send or the ask made no fact: a dialog no reader lifted, a turn cap, a box that was not free. */
  readonly sendNote?: string | undefined;
  readonly askNote?: string | undefined;
  /** Absent means `all`. A phone-only run is judged by its phone leg alone. */
  readonly legs?: LabLegs | undefined;
  /** The phone leg's results (phone.ts), or null when it did not run. Absent for a harness with no phone leg. */
  readonly phone?: PhoneFacts | null | undefined;
  /** Why the phone leg did not run, when `phone` is null. */
  readonly phoneNote?: string | undefined;
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

/** The phone leg's part of the verdict: one reason per failed scenario, or one when the leg should have run and did not. */
function phonePart(facts: LabFacts): string[] {
  if (facts.phone === undefined) return [];
  if (facts.phone === null) return [`the phone leg did not run${facts.phoneNote === undefined || facts.phoneNote === "" ? "" : `: ${facts.phoneNote}`}`];
  return phoneReasons(facts.phone.results);
}

export function judge(facts: LabFacts): Verdict {
  if (facts.legs === "phone") {
    // A phone-only run: the walk, the send and the ask did not run, so they say nothing.
    const reasons = facts.phone === undefined ? ["this harness has no phone leg"] : phonePart(facts);
    return { result: reasons.length === 0 ? "pass" : "fail", reasons, freeOnDialog: [] };
  }
  const freeOnDialog = facts.screens.filter((screen) => isDialogScreen(screen) && screen.free);
  const reasons: string[] = [];
  for (const screen of freeOnDialog) reasons.push(`${screen.label} is a dialog and the Surface read it free`);
  if (!facts.walk.reached) reasons.push("the walk could not start: no free box at the start");
  else if (!facts.walk.returned) reasons.push("the walk could not get back to a free box");
  if (!facts.walk.menuRead) reasons.push("the / menu listed no command");
  if (facts.walk.startedTurn !== null) reasons.push(`${facts.walk.startedTurn} is on the safe list and it started a model turn`);
  if (facts.profile === "none") return { result: reasons.length === 0 ? "walk-only" : "fail", reasons, freeOnDialog };
  if (facts.send === null) reasons.push(`no send was made${facts.sendNote === undefined || facts.sendNote === "" ? "" : `: ${facts.sendNote}`}`);
  else if (!SETTLED_OUTCOMES.includes(facts.send.outcome)) reasons.push(`the probed send did not settle: ${facts.send.outcome}${facts.send.reason === undefined ? "" : ` (${facts.send.reason})`}`);
  // The ask is a pass condition: it must reach `sent` or `effective`, and the declined command must not have run.
  // A dialog that no reader lifts is the case this catches, so the reason carries the leg's own note.
  if (facts.ask === null) reasons.push(`no ask answer was made${facts.askNote === undefined || facts.askNote === "" ? "" : `: ${facts.askNote}`}`);
  else {
    if (!SETTLED_OUTCOMES.includes(facts.ask.outcome)) reasons.push(`the ask answer did not settle: ${facts.ask.outcome}${facts.ask.reason === undefined ? "" : ` (${facts.ask.reason})`}`);
    if (facts.ask.fileCreated) reasons.push("the declined command made its file");
  }
  reasons.push(...phonePart(facts));
  return { result: reasons.length === 0 ? "pass" : "fail", reasons, freeOnDialog };
}
