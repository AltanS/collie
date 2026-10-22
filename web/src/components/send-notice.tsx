import type { ReactNode } from "react";
import { Check, TriangleAlert } from "lucide-react";

import { Notice } from "@/components/ui/notice";
import { capSentence, type SendNote, type SendReading, type SendReply } from "@/lib/send-protocol";
import { shortHash, type Surface } from "@/lib/surface/surface";
import { t as translate } from "@/lib/i18n";

// WHAT BECAME OF A SEND, AT THE THUMB (M56 specs 06, 07 and 14). The terminal composer and the
// composer of a program pane both tell the outcome of a send here, with the same words and the same
// box: the bridge's verdict, what it saw, and the bridge's own words under it. Each composer adds the
// buttons it can act on.

/** The sentence for an answer that did not send: the bridge's verdict, then what it saw on the screen. */
export function answerSentence(reading: SendReading): string {
  // The cap's sentence names the count, the harness and its version (M56 spec 09).
  const note =
    reading.cap === null
      ? translate(`composer.protocol.${reading.note}`)
      : capSentence(reading.cap, (vars) => translate("composer.protocol.capConfirm", vars));
  // A draft refusal already says what the screen held, and "The agent is working" already says the turn runs.
  if (reading.surface === null || reading.note === "draft" || reading.note === "draftCommand" || reading.note === "agentBusy") return note;
  return `${note} ${translate(`composer.surface.${reading.surface}`)}`;
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
}

/** The answers whose next move is to read the screen before anything else (the spec's "read the screen, then send again"). */
export const READ_THE_SCREEN: ReadonlySet<SendNote> = new Set<SendNote>(["unknown", "unconfirmed", "capConfirm", "moved", "probeFailed"]);

/** A sentence the phone itself raised before the bridge was asked (a link that is down, a dialog that owns the keys). */
export function phoneRefusal(sentence: string, toCard = false): SendRefusal {
  return { sentence, detail: null, toCard, screen: false, tone: "caution" };
}

/** The notice for an answer that did not send, from the bridge's reading of it. */
export function readingRefusal(reading: SendReading): SendRefusal {
  return {
    sentence: answerSentence(reading),
    detail: reading.detail,
    toCard: reading.toCard,
    screen: READ_THE_SCREEN.has(reading.note),
    tone: reading.note === "discarded" ? "neutral" : "caution",
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
  const icon = refusal.tone === "caution" ? <TriangleAlert /> : <Check />;
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
      <Notice tone={refusal.tone} variant="box" className="mb-2" icon={icon} action={action}>
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
      dismissLabel={translate("composer.protocol.dismissNotice")}
    >
      {words}
    </Notice>
  );
}
