// THE DRAFT OFFERS AS A MODAL (a trial, 2026-11-20). When the agent's box already holds a draft, the
// bridge refuses the send (`draft_present`) and offers Add to it, Replace and Cancel (M56 spec 05). Those
// choices act on text the person may have typed at the desk, and nothing goes on until one is made, so
// they open as the app's modal for a blocking decision (`ui/modal.tsx`, ADR 0167), centred: the title,
// the draft the bridge read, and one bordered button per choice with a line that says what it does.
// Every other offer set (Submit and Discard, Send anyway, Keys) stays in the strip under the field
// (send-offer-strip.tsx), unchanged.
//
// THE QUOTE is the box's text from the same read as the offer's rows hash (ADR 0166), so it is the draft
// Add to it and Replace act on, never a newer one. A bridge that could not read the box whole, a sign-in
// field and an older bridge send none: then there is no quote. An offer made again over a changed draft
// carries the new text, and the quote shows it.
//
// Closing without a choice (the scrim, Escape) is the strip's ✕: the caller drops the offer and hides its
// notice, nothing is sent, the message stays in the field.

import { useId } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { CAUTION_ACCENT, CAUTION_CHOICE } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { SendReply } from "@/lib/send-protocol";
import type { SendOffer } from "@/lib/surface/send";
import { cn } from "@/lib/utils";

const DRAFT_OFFERS: ReadonlySet<SendOffer> = new Set<SendOffer>(["append", "replace", "cancel"]);

/** The draft's offer sets open as the modal: Add and/or Replace, with Cancel, and nothing else. */
export function opensAsModal(offers: readonly SendOffer[]): boolean {
  return (offers.includes("append") || offers.includes("replace")) && offers.every((offer) => DRAFT_OFFERS.has(offer));
}

/** The draft the bridge read for the offer: its text, and whether the bridge cut it. */
export interface OfferDraft {
  readonly text: string;
  readonly cut: boolean;
}

/** The quoted draft an answer carries, or null when it carries none. */
export function offerDraft(reply: Pick<SendReply, "draftText" | "draftCut">): OfferDraft | null {
  return reply.draftText === undefined ? null : { text: reply.draftText, cut: reply.draftCut === true };
}

interface SendOfferModalProps {
  offers: readonly SendOffer[];
  /** The draft the offer is about, as the bridge read it; null draws no quote. */
  draft: OfferDraft | null;
  /** A send is running, a launch is starting or the pane cannot be written: the buttons wait. */
  disabled: boolean;
  onOffer: (offer: SendOffer) => void;
  onDismiss: () => void;
  /** The refusal's own sentence. Drawn under the title only when it says more than the plain draft words (a returned queued card). */
  sentence: string | null;
}

/** One choice: the whole width, at least 44px, the label and its line at the start, both inside the border. */
const CHOICE = "h-auto min-h-11 w-full flex-col items-start justify-center gap-0.5 whitespace-normal px-3 py-2.5 text-left";
/** Replace deletes the desk's draft: the destructive ink of `DestructiveActionRow`, with the edge a bordered choice needs. */
const DESTRUCTIVE_CHOICE = "shadow-none border-destructive/60 bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive active:bg-destructive/15";
/** Cancel: the plain outline, on the panel's own ground. */
const NEUTRAL_CHOICE = "shadow-none bg-transparent";

export function SendOfferModal({ offers, draft, disabled, onOffer, onDismiss, sentence }: SendOfferModalProps) {
  useLocale();
  const titleId = useId();
  const plain = sentence === null || sentence === t("composer.protocol.draft") || sentence === t("composer.protocol.draftCommand");
  return (
    <Modal placement="center" onClose={onDismiss} labelledBy={titleId} slot="send-offer-modal" className="max-h-[calc(min(var(--app-h),var(--modal-room))_-_1.5rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] w-[min(100vw_-_1.5rem,26rem)]">
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-4" data-testid="send-offer-modal">
        <h2 id={titleId} className={cn("flex items-center gap-2 text-sm font-semibold", CAUTION_ACCENT)}>
          <Icon name="warning" className="size-4 shrink-0" aria-hidden />
          {t("composer.protocol.draftSheet.title")}
        </h2>
        {plain ? null : <p className="text-xs leading-snug text-muted-foreground">{sentence}</p>}
        {draft === null ? null : (
          <figure className="flex flex-col gap-1" data-slot="offer-draft">
            <figcaption className="text-xs text-muted-foreground">{t("composer.protocol.draftSheet.quoteLabel")}</figcaption>
            <blockquote className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
              {/* At most about six lines (11px mono at the snug leading is 1.375em a line), then it scrolls inside itself. */}
              <div className="max-h-[8.25em] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground">
                {draft.text}
                {draft.cut ? <span data-slot="offer-draft-cut" className="block text-muted-foreground">…</span> : null}
              </div>
            </blockquote>
          </figure>
        )}
        <div className="flex flex-col gap-2">
          {offers.includes("append") && (
            <Choice tone={CAUTION_CHOICE} label={t("composer.protocol.append")} hint={t("composer.protocol.draftSheet.appendHint")} disabled={disabled} onClick={() => onOffer("append")} />
          )}
          {offers.includes("replace") && (
            <Choice tone={DESTRUCTIVE_CHOICE} label={t("composer.protocol.replace")} hint={t("composer.protocol.draftSheet.replaceHint")} disabled={disabled} onClick={() => onOffer("replace")} />
          )}
          {offers.includes("cancel") && (
            <Choice tone={NEUTRAL_CHOICE} label={t("composer.protocol.cancel")} hint={t("composer.protocol.draftSheet.cancelHint")} disabled={disabled} onClick={() => onOffer("cancel")} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function Choice({ tone, label, hint, disabled, onClick }: { tone: string; label: string; hint: string; disabled: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" className={cn(CHOICE, tone, "touch-manipulation")} disabled={disabled} onClick={onClick}>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs font-normal leading-snug text-muted-foreground">{hint}</span>
    </Button>
  );
}
