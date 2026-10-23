import { useCallback, useMemo, useState } from "react";

import { useCrew } from "@/components/crew-provider";
import { cancelWalky } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { useWalkyLog } from "@/components/walky-log";
import { useWalkySend } from "@/hooks/use-walky-send";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { heldForPane, isHeld, paneAddress, stateWord, takeBackNote, WALKY_BODY_MAX, wasTaken, type WalkyReceipt } from "@/lib/walky";
import type { NoticeTone } from "@/components/ui/notice";

/** Who a message in the composer is addressed to, when it is not simply this pane. */
export interface WalkyAim {
  /** One address, `<memberId>/<paneId>`, with `#<token>` when the sender named an instance. */
  to: string;
  /** The message being answered. */
  replyTo?: string;
  /** The words the strip names the target with: the sender's own label. */
  label: string;
}

/** What the composer says about the last message: a tone and a sentence, until it is dismissed. */
export interface WalkyNote {
  tone: NoticeTone;
  text: string;
}

function toneOf(receipt: WalkyReceipt): NoticeTone {
  if (!wasTaken(receipt)) return "danger";
  return receipt.state === "delivered" || receipt.state === "accepted" ? "success" : "caution";
}

/** The line under the box for a receipt: its state in words, and for a held one when it will be typed. */
function outcomeNote(label: string, receipt: WalkyReceipt): WalkyNote {
  const text = t("walky.composer.outcome", { label, state: stateWord(receipt) });
  return { tone: toneOf(receipt), text: isHeld(receipt) ? `${text}. ${t("walky.state.heldHint")}` : text };
}

/**
 * The composer's message mode (M62 spec 05): the long-press Send menu's "Send as message", and the
 * Reply opened from the pane's Messages sheet. It decides nothing about the box; the composer hands
 * it the text and learns, through `onTaken`, when the draft may go.
 *
 * The draft goes only when the bridge TOOK the message (any receipt but refused or expired), the way
 * a verified reply clears it. A refusal leaves the text where it was, with the bridge's reason beside
 * the box, so the person can fix the cause and send again.
 *
 * A first answer of `accepted` ("queued") is not the end (M62 hardening I): the strip then follows
 * the receipt in the pane's own walky list (`useWalkyLog`, read on the ordinary revalidation, no poll
 * of its own) and shows the final word once the receipt leaves `accepted`. A held message (`accepted`
 * with a reason, M62 spec 02) shows "held" with its reason and when it will be typed. A message to
 * another pane is not in this pane's list, so its strip keeps the first word.
 */
export function useWalkyComposer({
  paneId,
  instance,
  scope,
  onTaken,
  onChanged,
}: {
  paneId: string;
  /** The pane's current session instance, when its machine reports one. The address then names it. */
  instance?: string | undefined;
  scope: Scope | undefined;
  /** The message left. The composer clears its draft and revalidates the pane. */
  onTaken: () => void;
  /** A held message was taken back: the pane's list should be read again. Default: nothing, the poll reads it. */
  onChanged?: (() => void) | undefined;
}) {
  const { lead } = useCrew();
  const { send, sending } = useWalkySend();
  const [aim, setAim] = useState<WalkyAim | null>(null);
  const [note, setNote] = useState<WalkyNote | null>(null);
  // The message the strip still follows: sent, answered `accepted`, and not dismissed.
  const [followed, setFollowed] = useState<{ id: string; label: string } | null>(null);
  const log = useWalkyLog();
  const address = paneAddress(paneId, scope, lead, instance);

  const sendMessage = useCallback(
    async (line: string): Promise<boolean> => {
      const body = line.trim();
      if (body === "") {
        setNote({ tone: "caution", text: t("walky.composer.empty") });
        return false;
      }
      const label = aim?.label ?? t("walky.composer.toThisPane");
      if (body.length > WALKY_BODY_MAX) {
        setNote({ tone: "danger", text: t("walky.composer.failed", { error: t("walky.composer.tooLong") }) });
        return false;
      }
      setFollowed(null);
      setNote({ tone: "info", text: t("walky.composer.sending") });
      const result = await send(aim?.to ?? address, body, aim?.replyTo);
      // A second tap while one is in flight: the first one's answer is the one that reports.
      if (result === null) return false;
      if (!result.ok) {
        setNote({ tone: "danger", text: t("walky.composer.failed", { error: result.error }) });
        return false;
      }
      const receipt = result.receipts[0];
      if (receipt === undefined) {
        setNote({ tone: "danger", text: t("walky.composer.failed", { error: t("walky.crew.noReceipts") }) });
        return false;
      }
      setNote(outcomeNote(label, receipt));
      if (receipt.state === "accepted") setFollowed({ id: receipt.id, label });
      if (!wasTaken(receipt)) return false;
      setAim(null);
      onTaken();
      return true;
    },
    [aim, address, send, onTaken],
  );

  // The receipt the pane's list holds now for the followed message, once it has left `accepted` or is held.
  const later = followed === null ? undefined : log?.byId.get(followed.id)?.receipt;
  // The followed message while the list says it is held (M62 spec 03): the strip offers Cancel for it. The
  // operator sent it, so the operator may take it back; the list's next read shows how it ended.
  const heldId = followed !== null && later !== undefined && isHeld(later) ? followed.id : null;
  const cancelFollowed = useCallback(async () => {
    if (heldId === null) return;
    try {
      const line = takeBackNote(await cancelWalky(heldId));
      onChanged?.();
      if (line !== null) setNote({ tone: "caution", text: line });
    } catch (thrown) {
      setNote({ tone: "danger", text: t("walky.sheet.takeBackFailed", { error: describeThrownError(thrown) }) });
    }
  }, [heldId, onChanged]);
  const shown = useMemo<WalkyNote | null>(
    () => (followed !== null && later !== undefined && (later.state !== "accepted" || isHeld(later)) ? outcomeNote(followed.label, later) : note),
    [followed, later, note],
  );

  // The messages held for THIS pane (M62 spec 03): what the mark above the box counts. Read from the same
  // list as everything else, so it adds no request of its own, and it goes when the hold ends either way.
  const held = useMemo(() => (log === null ? 0 : heldForPane(log.rows, address).length), [log, address]);

  return {
    aim,
    note: shown,
    sending,
    /** How many messages wait for this pane's box to clear (M62 spec 03). */
    held,
    /** Take the followed message back while it is held (M62 spec 03), or null when nothing of the operator's is held. */
    cancelFollowed: heldId === null ? null : cancelFollowed,
    /** Open the box for a message to `to`: a reply to an agent's message. */
    startMessage: setAim,
    clearAim: useCallback(() => setAim(null), []),
    dismissNote: useCallback(() => {
      setNote(null);
      setFollowed(null);
    }, []),
    sendMessage,
  };
}
