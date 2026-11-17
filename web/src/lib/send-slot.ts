// The composer's Send slot as a pure function of the pane's Surface and three facts (M56 spec 06; the
// table is in the M56 README and experiments/reader-stability/ARCHITECTURE.md, "What the composer
// draws, per state"). The composer takes no other input about the screen: no dialog flags, no host
// block, no lock. The bridge's Surface says what owns the keyboard; the device and the pane say
// whether a write can leave this phone at all.
//
// The slot names what the Send button does, never whether a send is safe: the bridge reads the screen
// again at S0 and decides. A phone that is one poll behind therefore never sends into a dialog, and a
// screen that turned free since the last poll does not cost an extra tap where the slot still lets the
// tap through.

import { t } from "./i18n";
import { askOf, isFree, type Surface } from "./surface/surface";

/** The three facts the composer keeps beside the Surface: the pane, the device and the link. */
export interface ComposerFacts {
  /** The pane is gone (no agent, no shell). */
  readonly gone: boolean;
  /** This device may read and not write. */
  readonly readOnly: boolean;
  /** The pane has not been read lately, or the page draws a saved copy: nothing is sent from it. */
  readonly offline: boolean;
  /**
   * A fact the phone knows before any read stops text for this pane: its machine cannot be reached
   * (`hostBlock`), or sending text is off there (an unmarked pane). Only then is a box out of reach a
   * lock. A box the bridge's own read could not reach is no lock: the person may send the override
   * there (M102 spec 03, invariant I4). Absent: false.
   */
  readonly blocked?: boolean;
}

/**
 * What the Send slot is, one word per row of the table:
 *
 * - `gone`, `readOnly`: the field is locked and says why.
 * - `unreachable`: a fact the phone knows stops text (a host the lead cannot reach, sending switched
 *   off: `blocked`); the field is locked and names the reason.
 * - `offline`: the field stays typeable, Send waits for a live read.
 * - `answer`: `modal ask`; with a draft the slot is the word "Answer the dialog", which goes to the
 *   card and sends nothing; an empty box keeps its microphone.
 * - `running`: `turn running`; Send asks the bridge, which types the text and presses Enter where the
 *   harness queues a message for after the turn (the answer says `queued`), and refuses where it does
 *   not; the key pad is the way to stop the turn.
 * - `manual`: every other screen Collie cannot call free (`unknown(no-match)`, a weak cue, `modal
 *   unreadable`, a stale, torn or contested read, a box the read could not reach); Send asks the
 *   bridge, which reads the screen again, and a refusal that carries the rows hash offers the person's
 *   override, Send anyway (M102 spec 03, invariant I4). A pane with no profile (a bare shell) reads
 *   `unknown(no-match)` too, but the bridge types its text and presses Enter on the first tap,
 *   unless a password prompt stands on its last rows.
 * - `draft`: the box holds a draft at the desk; Send asks the bridge, which offers Add, Replace, Cancel.
 * - `send`: `free`, the fast path.
 */
export type SendSlot = "gone" | "readOnly" | "unreachable" | "offline" | "answer" | "running" | "manual" | "draft" | "send";

/** The Surface of a pane the bridge has not read yet: nothing is known, and the manual Send is open. */
export const UNREAD_SURFACE: Surface = { revision: 0, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" };

/** A Surface whose box cannot be reached, for a fact the phone knows before any read (a host refusal, sending off).
 *  A sign-in field the read named stays named: what is typed for it keeps no draft (fail closed). */
export function unreachable(surface: Surface): Surface {
  const out: Surface = { revision: surface.revision, turn: "unknown", modal: "unknown", composer: "unreachable" };
  return surface.field === "secret" ? { ...out, field: "secret" } : out;
}

/** The Send slot of a Surface and the three facts. Pure: one input, one slot. */
export function sendSlot(surface: Surface, facts: ComposerFacts): SendSlot {
  if (facts.gone) return "gone";
  if (facts.readOnly) return "readOnly";
  if (facts.blocked === true) return "unreachable";
  if (facts.offline) return "offline";
  if (askOf(surface.modal) !== null) return "answer";
  if (surface.turn === "running") return "running";
  if (isFree(surface)) return "send";
  if (surface.composer === "draft") return "draft";
  // Every screen that is not free, not an ask Collie read and not a draft: the bridge reads again and
  // decides, and its refusal with the rows hash offers the override (invariant I4).
  return "manual";
}

/** Whether the field itself is locked: nothing typed here can ever leave this phone for this pane. */
export function fieldLocked(slot: SendSlot): boolean {
  return slot === "gone" || slot === "readOnly" || slot === "unreachable";
}

/** The composer's Surface for a pane, with the reason when its box is out of reach. */
export interface PaneSurface {
  readonly surface: Surface;
  readonly unreachableNote: string | undefined;
}

/**
 * The Surface the composer gets for a pane: the bridge's read when it has one. A fact the phone knows
 * before any read folds in as `composer: unreachable` with its reason: the pane's machine the lead
 * cannot reach (`hostBlock`, CREW_PROTOCOL.md §10.3, which names the machine), and a bridge that does
 * not mark the pane for the Send Protocol (sending text is off there, or a crew member older than the
 * protocol). A marked pane with no read yet is {@link UNREAD_SURFACE}: the two-tap Send stays open,
 * and the bridge reads the screen at the tap either way.
 */
export function paneSurface(read: Surface | undefined, marked: boolean, hostBlock: string | undefined): PaneSurface {
  const surface = read ?? UNREAD_SURFACE;
  if (hostBlock !== undefined) return { surface: unreachable(surface), unreachableNote: hostBlock };
  if (!marked) return { surface: unreachable(surface), unreachableNote: t("composer.placeholder.sendOff") };
  return { surface, unreachableNote: undefined };
}
