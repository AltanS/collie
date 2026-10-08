import { EyeOff } from "lucide-react";

import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { retireMaskedHint } from "@/lib/masked-hint";

interface MaskedHintProps {
  /** Draw the line. The pane decides (text in scope holds a mask, device has not retired it). */
  open: boolean;
  className?: string;
}

// ONE QUIET LINE, ONCE PER DEVICE, THAT SAYS THE DOTS ARE ON PURPOSE. The bridge hides known secret
// shapes before text leaves the machine (bridge/redact.ts), so a key on the mirror reads `sk-o••••`.
// Without a word of explanation that looks like a rendering fault, and the operator's next move is
// to hunt for a switch. There is none on the phone, by design: a switch here would let any paired or
// stolen phone unmask. The sentence therefore names the one place the real value lives.
//
// A SCOPE NOTICE, like the pin hint (DESIGN.md §11): it belongs to this view and outlives the next
// interaction, so it is `ui/notice.tsx`'s neutral box inside `ui/collapse.tsx`, and it slides shut
// rather than dropping the mirror under it by its own height. The X is the only way it retires.
export function MaskedHint({ open, className }: MaskedHintProps) {
  useLocale();
  return (
    <Collapse open={open}>
      {open ? (
        <Notice
          tone="neutral"
          variant="box"
          icon={<EyeOff />}
          className={className}
          dismissLabel={t("pane.maskedHint.dismiss")}
          onDismiss={retireMaskedHint}
        >
          {t("pane.maskedHint.body")}
        </Notice>
      ) : null}
    </Collapse>
  );
}
