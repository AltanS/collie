import { Pin } from "lucide-react";
import { useRef } from "react";

import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { useMediaQuery } from "@/hooks/use-media-query";
import { t } from "@/lib/i18n";
import { retirePinHint } from "@/lib/pin-hint";

interface PinHintProps {
  /** Draw the line. The list decides (`showsPinHint`, lib/pin-hint.ts); this only draws it. */
  open: boolean;
  /**
   * The X held focus when it was pressed, and it is on its way out: put focus somewhere that stays.
   * The list hands it to the first row below, so focus never falls to `body`.
   */
  onFocusLeaves?: () => void;
}

// THE PIN HINT (M38/02): one quiet line on the Panes tab, in the place the Pinned group takes once a
// pane is pinned, that says a hold pins a pane. The pin glyph is the pane actions sheet's own Pin to
// top glyph, so the line and the row it leads to wear one mark.
//
// A NOTICE, NOT A NEW SHAPE. It is a scope notice (DESIGN.md §11): it outlives the next interaction
// and belongs to this view, so it is `ui/notice.tsx`'s neutral box inside `ui/collapse.tsx`, the
// quiet register with muted ink and no status colour, a uniform edge on all four sides and no accent
// rail. The X is the Notice's own, a 24px face with a 46px reach, named "Dismiss hint".
//
// THE WORDS FOLLOW THE POINTER. A device whose primary pointer is fine (a mouse) is told to
// right-click: the hold hook treats `contextmenu` as the same trigger, and nobody holds a mouse button
// on a row to find a menu.
//
// IT LEAVES WITHOUT A JUMP. The X or the first pin retires it, and it slides shut through `Collapse`
// (§11 rule 1), holding its words through the exit. The list's `gap-5` rides inside the collapse
// (`-mt-5` outside, `pt-5` inside), so the gap closes with the box and nothing drops 20px when the
// box finally unmounts. At first paint it is simply there, with no entrance.
export function PinHint({ open, onFocusLeaves }: PinHintProps) {
  useLocale();
  const pointerFine = useMediaQuery("(pointer: fine)");
  const box = useRef<HTMLDivElement>(null);
  return (
    <Collapse open={open} className="-mt-5">
      {open ? (
        <div ref={box} className="pt-5">
          <Notice
            tone="neutral"
            variant="box"
            icon={<Pin />}
            dismissLabel={t("home.pinHint.dismiss")}
            onDismiss={() => {
              const hadFocus = box.current?.contains(document.activeElement) ?? false;
              retirePinHint();
              if (hadFocus) onFocusLeaves?.();
            }}
          >
            {pointerFine ? t("home.pinHint.rightClick") : t("home.pinHint.hold")}
          </Notice>
        </div>
      ) : null}
    </Collapse>
  );
}
