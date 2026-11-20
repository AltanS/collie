// The Send Protocol's offers at the thumb (M56 spec 05): one strip under the field with a button per
// next action the bridge's answer offered, and a ✕ that sends nothing. The words of the outcome, and the
// way on (the card, the screen, the Keys dock), are the notice beside it (M56 spec 07, composer.tsx).

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { ACTION_ICON_TAP, CAUTION_ACTION, CAUTION_ACTION_TAP } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { SendOffer } from "@/lib/surface/send";

interface SendOfferStripProps {
  offers: readonly SendOffer[];
  /** A send is running or the pane cannot be written: the buttons wait. */
  disabled: boolean;
  onOffer: (offer: SendOffer) => void;
  onDismiss: () => void;
  /** The cap's extra confirm is the next commit (M56 spec 09): its button says so. */
  capConfirm?: boolean;
}

const LABEL_KEYS = {
  append: "composer.protocol.append",
  replace: "composer.protocol.replace",
  cancel: "composer.protocol.cancel",
  submit: "composer.protocol.submit",
  discard: "composer.protocol.discard",
  // One word on every screen: it says what the tap asks for and never whether Enter goes, because the
  // phone's read can differ from the bridge's (the M102 review, pass 2). The receipt says what happened.
  commit: "composer.protocol.commitPast",
  keys: "composer.protocol.keys",
} as const satisfies Record<SendOffer, string>;

export function SendOfferStrip({ offers, disabled, onOffer, onDismiss, capConfirm = false }: SendOfferStripProps) {
  useLocale();
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-3.5 py-1.5" data-testid="send-offers">
      {offers.map((offer) => (
        <Button
          key={offer}
          type="button"
          variant="outline"
          size="sm"
          className={cn(CAUTION_ACTION, CAUTION_ACTION_TAP, "touch-manipulation")}
          disabled={disabled}
          onClick={() => onOffer(offer)}
        >
          {t(offer === "commit" && capConfirm ? "composer.protocol.commitCapPast" : LABEL_KEYS[offer])}
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("ml-auto size-8 shrink-0 touch-manipulation text-muted-foreground", ACTION_ICON_TAP)}
        aria-label={t("composer.protocol.dismissAria")}
        onClick={onDismiss}
      >
        <Icon name="dismiss" className="size-4" />
      </Button>
    </div>
  );
}
