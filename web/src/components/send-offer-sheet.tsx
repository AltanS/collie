// THE DRAFT OFFERS AS A SHEET (a trial, 2026-11-20). When the agent's box already holds a draft, the
// bridge refuses the send (`draft_present`) and offers Add to it, Replace and Cancel (M56 spec 05). Those
// three choices act on text the person may have typed at the desk, so they open as the app's one modal,
// `BottomSheet`, with a line under each row that says what it does. Every other offer set (Submit and
// Discard, Send anyway, Keys) stays in the strip under the field (send-offer-strip.tsx), unchanged.
//
// The sheet shows no quote of the draft: the bridge's refusal carries no draft text, and the phone's own
// read of the screen may be older or newer than the read the bridge refused on.
//
// Closing without a choice (the scrim, the drag down, Escape, the close button) is the strip's ✕: the
// caller drops the offer and hides its notice, nothing is sent, the message stays in the field.
// Portalled to `<body>`, so no transformed ancestor of the composer can move the fixed layer.

import { createPortal } from "react-dom";

import { ActionRow, DestructiveActionRow } from "@/components/action-sheet-rows";
import { Icon } from "@/components/icons/icon";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { SendOffer } from "@/lib/surface/send";

const DRAFT_OFFERS: ReadonlySet<SendOffer> = new Set<SendOffer>(["append", "replace", "cancel"]);

/** The draft's offer sets open as the sheet: Add and/or Replace, with Cancel, and nothing else. */
export function opensAsSheet(offers: readonly SendOffer[]): boolean {
  return (offers.includes("append") || offers.includes("replace")) && offers.every((offer) => DRAFT_OFFERS.has(offer));
}

interface SendOfferSheetProps {
  offers: readonly SendOffer[];
  /** A send is running, a launch is starting or the pane cannot be written: the rows wait. */
  disabled: boolean;
  onOffer: (offer: SendOffer) => void;
  onDismiss: () => void;
  /** The refusal's own sentence. Drawn under the title only when it says more than the plain draft words (a returned queued card). */
  sentence: string | null;
}

const ROW_ICON = "size-4 shrink-0 text-muted-foreground";

export function SendOfferSheet({ offers, disabled, onOffer, onDismiss, sentence }: SendOfferSheetProps) {
  useLocale();
  const plain = sentence === null || sentence === t("composer.protocol.draft") || sentence === t("composer.protocol.draftCommand");
  return createPortal(
    <BottomSheet open onClose={onDismiss} title={t("composer.protocol.draftSheet.title")}>
      <div className="flex flex-col gap-1" data-testid="send-offer-sheet">
        {plain ? null : <p className="px-3 pb-2 text-xs leading-snug text-muted-foreground">{sentence}</p>}
        {offers.includes("append") && (
          <ActionRow
            icon={<Icon name="add" className={ROW_ICON} />}
            label={t("composer.protocol.append")}
            hint={t("composer.protocol.draftSheet.appendHint")}
            disabled={disabled}
            onClick={() => onOffer("append")}
          />
        )}
        {offers.includes("replace") && (
          // Destructive in look, one tap in act: the sheet is already the deliberate step, as the strip's button was.
          <DestructiveActionRow
            icon={<Icon name="delete" className="size-4 shrink-0" />}
            label={t("composer.protocol.replace")}
            confirmLabel={t("composer.protocol.replace")}
            closingLabel={t("composer.protocol.replace")}
            armed={false}
            closing={false}
            hint={t("composer.protocol.draftSheet.replaceHint")}
            disabled={disabled}
            onClick={() => onOffer("replace")}
          />
        )}
        {offers.includes("cancel") && (
          <ActionRow
            icon={<Icon name="dismiss" className={ROW_ICON} />}
            label={t("composer.protocol.cancel")}
            hint={t("composer.protocol.draftSheet.cancelHint")}
            disabled={disabled}
            onClick={() => onOffer("cancel")}
          />
        )}
      </div>
    </BottomSheet>,
    document.body,
  );
}
