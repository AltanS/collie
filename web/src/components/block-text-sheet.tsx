import { useRef } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useLocale } from "@/hooks/use-locale";
import type { ChatItem } from "@/lib/chat-items";
import { canCopyText, copyText } from "@/lib/clipboard";
import { flashCopied } from "@/lib/copied-flash";
import { t } from "@/lib/i18n";
import { itemCopyText, itemTitle } from "@/lib/message-pins";
import { setStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

// THE TEXT OF ONE CHAT BLOCK, to select (2026-11-23). The block actions sheet's Select text row closes that sheet and
// opens this one. A block on a touch screen takes no selection at rest, so that its hold opens the actions sheet every
// time (index.css); the way to its text is here: the words as plain text in a scroll area, and the native selection does
// the selecting, with its own handles and its own Copy. No selection code of ours.
//
// ONE SOURCE FOR THE TEXT. The words are `itemCopyText(item)`, the same string the Copy text row writes, so what this
// sheet shows is what a copy gives, for every kind of block. A tool's card is drawn in the mono face its output has.
//
// THE SCROLL AREA TAKES THE SHEET'S HEIGHT, as the status detail sheet's text does: it caps itself (`max-h-[50dvh]`)
// so a long reply scrolls inside the sheet and the foot stays in reach. It is marked `data-sheet-scroll`, so a pull
// down that starts inside it, scrolled, scrolls it and does not pull the sheet closed (ui/sheet.tsx).
//
// COPY ALL copies the whole text, shows the house's copied state on the button (as ui/copyable-block.tsx does) and
// flashes the text area (lib/copied-flash.ts). The sheet stays open. Closing it clears the selection with it.

interface BlockTextSheetProps {
  /** The block whose text the sheet shows; `null` is closed. */
  item: ChatItem | null;
  onClose: () => void;
}

export function BlockTextSheet({ item, onClose }: BlockTextSheetProps) {
  useLocale();
  const area = useRef<HTMLElement>(null);
  const [state, show] = useCopyFeedback();
  if (item === null) return null;
  // Closing clears the selection with it.
  const close = () => {
    window.getSelection()?.removeAllRanges();
    onClose();
  };
  const text = itemCopyText(item);
  const copyAll = async () => {
    try {
      await copyText(text);
      flashCopied(area.current);
      show("done");
      setStatus(t("copyable.done"), "success");
    } catch {
      show("failed");
      setStatus(t("copyable.failed"), "error");
    }
  };
  return (
    <BottomSheet open onClose={close} title={itemTitle(item)}>
      <div data-slot="block-text" className="flex flex-col gap-3">
        <section
          ref={area}
          data-slot="block-text-area"
          data-sheet-scroll=""
          aria-label={t("pins.textSheet.aria")}
          className={cn(
            "relative max-h-[50dvh] select-text overflow-y-auto overscroll-contain rounded-lg bg-muted px-3 py-2 break-words whitespace-pre-wrap",
            item.kind === "tool" ? "font-mono text-xs [font-variant-ligatures:none]" : "font-content text-sm",
          )}
        >
          {text}
        </section>
        {canCopyText() && (
          <Button type="button" size="lg" data-slot="block-text-copy" onClick={() => void copyAll()}>
            {state === "done" ? (
              <Icon name="copied" aria-hidden className="size-4" />
            ) : state === "failed" ? (
              <Icon name="copy-failed" aria-hidden className="size-4" />
            ) : (
              <Icon name="copy" aria-hidden className="size-4" />
            )}
            {state === "done" ? t("copyable.done") : state === "failed" ? t("copyable.failed") : t("pins.action.copyAll")}
          </Button>
        )}
      </div>
    </BottomSheet>
  );
}
