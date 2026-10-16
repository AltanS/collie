// The Send Protocol's offers at the thumb (M56 spec 05): one strip under the field with a button per
// next action the bridge's answer offered, and a ✕ that sends nothing. The words of the outcome, and the
// way on (the card, the screen, the Keys dock), are the notice beside it (M56 spec 07, composer.tsx).

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
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
  commit: "composer.protocol.commit",
  keys: "composer.protocol.keys",
} as const satisfies Record<SendOffer, string>;

export function SendOfferStrip({ offers, disabled, onOffer, onDismiss, capConfirm = false }: SendOfferStripProps) {
  useLocale();
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground" data-testid="send-offers">
      {offers.map((offer) => (
        <Button key={offer} variant="ghost" size="sm" className="h-7 px-2 text-xs font-medium" disabled={disabled} onClick={() => onOffer(offer)}>
          {t(offer === "commit" && capConfirm ? "composer.protocol.commitCap" : LABEL_KEYS[offer])}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto size-6 shrink-0 text-muted-foreground"
        aria-label={t("composer.protocol.dismissAria")}
        onClick={onDismiss}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}
