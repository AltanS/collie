import type { ReactNode } from "react";
import { Icon } from "@/components/icons/icon";

import { Button } from "@/components/ui/button";
import { Notice, NOTICE_ACTION } from "@/components/ui/notice";
import { capSentence, noteKey, type NextStep, type SendNote, type SendReading, type SendReply, type StepButton } from "@/lib/send-protocol";
import { shortHash, type Surface } from "@/lib/surface/surface";
import { t as translate, tn, type MessageKey } from "@/lib/i18n";
import type { ClearReason, ClearReceipt } from "@/lib/surface/clear";
import type { StopReason, StopReceipt } from "@/lib/surface/stop";

// WHAT BECAME OF A SEND, AT THE THUMB (M56 specs 06, 07 and 14). The terminal composer and the
// composer of a program pane both tell the outcome of a send here, with the same words and the same
// box: the bridge's verdict, what it saw, and the bridge's own words under it. Each composer adds the
// buttons it can act on.

/** The sentence for an answer that did not send: the bridge's verdict, then what it saw on the screen. */
export function answerSentence(reading: SendReading): string {
  // The cap's sentence names the count, the harness and its version (M56 spec 09).
  const note =
    reading.cap === null
      ? translate(noteKey(reading.note))
      : capSentence(reading.cap, (vars) => translate("composer.protocol.capConfirmPast", vars));
  // A draft refusal already says what the screen held, and "The agent is working" already says the turn runs.
  if (reading.surface === null || reading.note === "draft" || reading.note === "draftCommand" || reading.note === "draftUnseen" || reading.note === "agentBusy") return note;
  // What Collie saw comes first, then the verdict and its next step (M102 spec 02), so the sentence ends
  // on what the person can do.
  return `${translate(`composer.surface.${reading.surface}`)} ${note}`;
}

/** What the Send slot's notice says about the last send, and where it points. */
export interface SendRefusal {
  readonly sentence: string;
  /** The bridge's own words under the sentence, or null. */
  readonly detail: string | null;
  /** The screen holds an ask or an overlay Collie cannot read: a button goes to its card. */
  readonly toCard: boolean;
  /** The next move is reading the screen: a button shows the raw rows. */
  readonly screen: boolean;
  /** `neutral` for an outcome that is not a failure (a discard), `caution` for the rest. */
  readonly tone: "caution" | "neutral";
  /** The step that gets the person on (M102 spec 02); null for a sentence the phone raised itself. */
  readonly step?: NextStep | null;
  /** The step is Send again and waits for the other send on this pane to end. */
  readonly waits?: boolean;
  /** The Surface revision the answer read; a waiting Send again turns on at a later one. */
  readonly atRevision?: number;
  /** A Stop's receipt, not a refused send (M102 spec 11): it stands under the password notice and in Type mode. */
  readonly isReceipt?: boolean;
}

/** The words of each step that draws its own button (M102 spec 02). */
const STEP_LABELS = {
  sendAgain: "composer.step.sendAgain",
  stop: "composer.step.stop",
  emptyBox: "composer.step.emptyBox",
  screen: "composer.controls.screen",
} as const satisfies Record<StepButton, MessageKey>;

/** The button word of a step, or null for a step whose button is the strip's, the card's or the field. */
export function stepLabel(step: NextStep | null | undefined): string | null {
  switch (step) {
    case "sendAgain":
    case "stop":
    case "emptyBox":
    case "screen":
      return translate(STEP_LABELS[step]);
    default:
      return null;
  }
}

/** The answers whose next move is to read the screen before anything else (the spec's "read the screen, then send again"). */
export const READ_THE_SCREEN: ReadonlySet<SendNote> = new Set<SendNote>(["unknown", "unconfirmed", "capConfirm", "moved", "probeFailed"]);

/** A sentence the phone itself raised before the bridge was asked (a link that is down, a dialog that owns the keys). */
export function phoneRefusal(sentence: string, toCard = false): SendRefusal {
  return { sentence, detail: null, toCard, screen: false, tone: "caution" };
}

/** The sentence of each refusal a Stop can answer (M68), one string key per closed reason. */
const STOP_REFUSALS = {
  dialog_open: "belt.stop.receipt.refused.dialogOpen",
  draft_present: "belt.stop.receipt.refused.draftPresent",
  no_profile: "belt.stop.receipt.refused.noProfile",
  turn_idle: "belt.stop.receipt.refused.turnIdle",
  unreadable: "belt.stop.receipt.refused.unreadable",
  press_failed: "belt.stop.receipt.refused.pressFailed",
  pane_gone: "belt.stop.receipt.refused.paneGone",
  unsupported_build: "belt.stop.receipt.refused.unsupportedBuild",
} as const satisfies Record<StopReason, MessageKey>;

/**
 * The notice a Stop's receipt gets under the box, in the box a send's refusal uses (M68 spec 02). `stopped`
 * is the one calm word. `pressed` and every refusal are cautions: the turn may still run, or nothing was
 * pressed. A refused Stop behind an open dialog points at the card, where the answer is.
 */
export function stopNotice(receipt: StopReceipt): SendRefusal {
  if (receipt.outcome === "stopped") return { sentence: withReturned(translate("belt.stop.receipt.stopped"), receipt), detail: null, toCard: false, screen: false, tone: "neutral" };
  // No receipt came back (a crew member that did not answer in time): the key may have gone in, so the
  // person reads the pane before a second tap.
  if (receipt.outcome === "unknown") return phoneRefusal(translate("belt.stop.receipt.unknown"));
  if (receipt.outcome === "pressed") {
    // The key opened a dialog: the turn is not the story now, its card is.
    if (receipt.reason === "dialog_open") return phoneRefusal(withReturned(translate("belt.stop.receipt.pressedDialog"), receipt), true);
    return phoneRefusal(withReturned(translate("belt.stop.receipt.pressed"), receipt));
  }
  const reason = receipt.reason ?? "unreadable";
  return phoneRefusal(translate(STOP_REFUSALS[reason]), reason === "dialog_open");
}

/**
 * A Stop sentence with the clause for the queued messages a read-back saw back in the input box
 * (ADR 0122): "Stopped. 1 queued message is back in the box." Only what the bridge saw is counted.
 */
function withReturned(sentence: string, receipt: StopReceipt): string {
  const count = receipt.returned?.length ?? 0;
  return count === 0 ? sentence : `${sentence} ${tn("belt.stop.receipt.returned", count)}`;
}

/** The sentence of each refusal a Clear can answer (ADR 0116), one string key per closed reason. */
const CLEAR_REFUSALS = {
  no_profile: "keys.clear.receipt.refused.noProfile",
  no_draft: "keys.clear.receipt.refused.noDraft",
  dialog_open: "keys.clear.receipt.refused.dialogOpen",
  unreadable: "keys.clear.receipt.refused.unreadable",
  press_failed: "keys.clear.receipt.refused.pressFailed",
  pane_gone: "keys.clear.receipt.refused.paneGone",
  stale_screen: "keys.clear.receipt.refused.staleScreen",
  unsupported_build: "keys.clear.receipt.refused.unsupportedBuild",
  // Another bridge writes into the pane (M102 spec 16): nothing was pressed, and a later tap can clear.
  pane_busy: "keys.clear.receipt.refused.paneBusy",
} as const satisfies Record<ClearReason, MessageKey>;

/**
 * The words a Clear's receipt gets, in the floating notice above the belt (composer.tsx `clearCard`).
 * `cleared` is the one calm word. A refusal is a caution; one behind an open dialog points at the card.
 * `unknown` (no receipt came back) tells the person to read the pane before a second tap.
 */
export function clearNotice(receipt: ClearReceipt): SendRefusal {
  if (receipt.outcome === "cleared") return { sentence: translate("keys.clear.receipt.cleared"), detail: null, toCard: false, screen: false, tone: "neutral" };
  if (receipt.outcome === "unknown") return phoneRefusal(translate("keys.clear.receipt.unknown"));
  const reason = receipt.reason ?? "unreadable";
  return phoneRefusal(translate(CLEAR_REFUSALS[reason]), reason === "dialog_open");
}

const WAIT_WORDS = {
  waits: "composer.step.sendAgainWaits",
  ready: "composer.step.sendAgainReady",
  awaiting: "cannotTell.waiting",
} as const satisfies Record<"waits" | "ready" | "awaiting", MessageKey>;

interface RefusalActionsProps {
  /** The step's own button (M102 spec 02), first: the action that changes the situation. */
  readonly step: { readonly word: string; readonly disabled: boolean; readonly onPress: () => void } | null;
  /** A Send again that waits for another send: its reason while it is off, then that it turned on.
   *  `awaiting`: it waits for the agent's own word on an `unknown` send, in the "cannot tell" card's words. */
  readonly wait: "waits" | "ready" | "awaiting" | null;
  readonly onCard: (() => void) | null;
  readonly onScreen: (() => void) | null;
  readonly onKeys: (() => void) | null;
}

/**
 * The way on, as buttons in a stop card's notice (M102 spec 02): the step first, then the card (or, with
 * no card, the Screen), then Open Keys, so a card holds at most two buttons plus the card and the Keys pad
 * is never dropped. Each only where it can act; nothing at all renders no row. The reason a waiting Send
 * again is off sits under the row, in a live region, so a screen reader hears when it turns on.
 */
export function RefusalActions({ step, wait, onCard, onScreen, onKeys }: RefusalActionsProps) {
  if (step === null && onCard === null && onScreen === null && onKeys === null) return null;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {step !== null && (
        <Button variant="ghost" size="sm" className={NOTICE_ACTION} disabled={step.disabled} onClick={step.onPress}>
          {step.word}
        </Button>
      )}
      {onCard !== null && (
        <Button variant="ghost" size="sm" className={NOTICE_ACTION} onClick={onCard}>
          {translate("composer.send.dialogFirst")}
        </Button>
      )}
      {onScreen !== null && (
        <Button variant="ghost" size="sm" className={NOTICE_ACTION} onClick={onScreen}>
          {translate("composer.controls.screen")}
        </Button>
      )}
      {onKeys !== null && (
        <Button variant="ghost" size="sm" className={NOTICE_ACTION} onClick={onKeys}>
          {translate("composer.protocol.openKeys")}
        </Button>
      )}
      {wait !== null && (
        <span className="basis-full text-right text-[11px] text-muted-foreground" aria-live="polite">
          {translate(WAIT_WORDS[wait])}
        </span>
      )}
    </span>
  );
}

/** The notice for an answer that did not send, from the bridge's reading of it. */
export function readingRefusal(reading: SendReading): SendRefusal {
  return {
    sentence: answerSentence(reading),
    detail: reading.detail,
    toCard: reading.toCard,
    screen: READ_THE_SCREEN.has(reading.note),
    tone: reading.note === "discarded" ? "neutral" : "caution",
    step: reading.step,
    waits: reading.waits,
  };
}

/** The sentence a program pane's answer gets: a key under `durable.protocol.*`. */
export type ProgramNote = "askOpen" | "notRead" | "notFree" | "moved" | "busy" | "paneGone" | "writeFailed" | "idReused" | "unknown" | "refused";

/**
 * The program's word for an answer that did not send (M56 spec 14). A program has no screen and no
 * input box, so none of the terminal's sentences fit. A `not_free` says why by the state the answer
 * carried: an open question, a state Collie cannot read, or the program's own no.
 */
export function programNote(reading: SendReading): ProgramNote {
  switch (reading.note) {
    case "moved":
      return "moved";
    case "notFree":
      if (reading.toCard) return "askOpen";
      return reading.surface === "unreachable" || reading.surface === "stale" ? "notRead" : "notFree";
    case "busy":
      return "busy";
    case "paneGone":
      return "paneGone";
    case "writeFailed":
      return "writeFailed";
    case "idReused":
      return "idReused";
    case "unknown":
      return "unknown";
    default:
      return "refused";
  }
}

/**
 * The notice for a program pane's answer that did not send: program words only. The driver's own
 * words show under them only where they carry the program's reason (a refusal from the program).
 */
export function programRefusal(reply: SendReply, reading: SendReading): SendRefusal {
  const note = programNote(reading);
  const detail = (note === "writeFailed" || note === "refused") && reply.detail !== null && reply.detail !== "" ? reply.detail : null;
  return { sentence: translate(`durable.protocol.${note}`), detail, toCard: note === "askOpen", screen: false, tone: "caution" };
}

/**
 * Which notice a person hid: the screen it is about (the Surface's revision and a hash of the whole
 * Surface) and its words. A hidden notice stays hidden until a refusal carries another key, so the
 * same words over the same screen never come back after the ✕ (the 2026-10-16 field case had no way
 * to close the notice at all). `surface` is the Surface the answer carried, else the one on screen.
 */
export function refusalKey(refusal: SendRefusal, surface: Surface | null): string {
  const screen = surface === null ? "-" : `${String(surface.revision)}:${shortHash(JSON.stringify(surface))}`;
  return `${screen}\n${shortHash(`${refusal.sentence}\n${refusal.detail ?? ""}`)}`;
}

/** The box at the thumb. `action` is the composer's own buttons, or undefined for none. `onDismiss`
 *  adds the ✕ that hides the notice. */
export function SendRefusalNotice({ refusal, action, onDismiss }: { refusal: SendRefusal; action?: ReactNode; onDismiss?: () => void }) {
  const icon = refusal.tone === "caution" ? <Icon name="warning" /> : <Icon name="ok" />;
  // A screen reader hears the notice when it appears (M102, the chaos run): a refusal answers the person's
  // own tap, so a caution interrupts; a neutral receipt (Stopped, Cleared, Discarded) waits its turn.
  const announce = refusal.tone === "caution" ? "alert" : "status";
  const words = (
    <>
      <span data-slot="composer-refusal">{refusal.sentence}</span>
      {refusal.detail !== null && (
        <span data-slot="composer-refusal-detail" className="block text-muted-foreground">
          {refusal.detail}
        </span>
      )}
    </>
  );
  if (onDismiss === undefined) {
    return (
      <Notice tone={refusal.tone} variant="box" className="mb-2" icon={icon} action={action} announce={announce}>
        {words}
      </Notice>
    );
  }
  return (
    <Notice
      tone={refusal.tone}
      variant="box"
      className="mb-2"
      icon={icon}
      action={action}
      onDismiss={onDismiss}
      announce={announce}
      dismissLabel={translate("composer.protocol.dismissNotice")}
    >
      {words}
    </Notice>
  );
}
