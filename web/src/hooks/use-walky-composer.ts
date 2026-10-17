import { useCallback, useState } from "react";

import { useCrew } from "@/components/crew-provider";
import { useWalkySend } from "@/hooks/use-walky-send";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { paneAddress, stateWord, WALKY_BODY_MAX, wasTaken, type WalkyReceipt } from "@/lib/walky";
import type { NoticeTone } from "@/components/ui/notice";

/** Who a message in the composer is addressed to, when it is not simply this pane. */
export interface WalkyAim {
  /** One address, `<memberId>/<paneId>`. */
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

/**
 * The composer's message mode (M62 spec 05): the long-press Send menu's "Send as message", and the
 * Reply opened from the pane's Messages sheet. It decides nothing about the box; the composer hands
 * it the text and learns, through `onTaken`, when the draft may go.
 *
 * The draft goes only when the bridge TOOK the message (any receipt but refused or expired), the way
 * a verified reply clears it. A refusal leaves the text where it was, with the bridge's reason beside
 * the box, so the person can fix the cause and send again.
 */
export function useWalkyComposer({
  paneId,
  scope,
  onTaken,
}: {
  paneId: string;
  scope: Scope | undefined;
  /** The message left. The composer clears its draft and revalidates the pane. */
  onTaken: () => void;
}) {
  const { lead } = useCrew();
  const { send, sending } = useWalkySend();
  const [aim, setAim] = useState<WalkyAim | null>(null);
  const [note, setNote] = useState<WalkyNote | null>(null);
  const address = paneAddress(paneId, scope, lead);

  const sendMessage = useCallback(
    async (line: string): Promise<boolean> => {
      const body = line.trim();
      if (body === "") {
        setNote({ tone: "caution", text: t("walky.composer.empty") });
        return false;
      }
      const label = aim?.label ?? t("walky.composer.toThisPane");
      if (body.length > WALKY_BODY_MAX) {
        setNote({ tone: "danger", text: t("walky.composer.failed", { error: t("composer.draft.tooLong") }) });
        return false;
      }
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
      setNote({ tone: toneOf(receipt), text: t("walky.composer.outcome", { label, state: stateWord(receipt) }) });
      if (!wasTaken(receipt)) return false;
      setAim(null);
      onTaken();
      return true;
    },
    [aim, address, send, onTaken],
  );

  return {
    aim,
    note,
    sending,
    /** Open the box for a message to `to`: a reply to an agent's message. */
    startMessage: setAim,
    clearAim: useCallback(() => setAim(null), []),
    dismissNote: useCallback(() => setNote(null), []),
    sendMessage,
  };
}
