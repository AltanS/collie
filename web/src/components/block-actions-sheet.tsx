import { Copy, Pin, PinOff, SquareDashedText } from "lucide-react";
import { useLayoutEffect } from "react";

import { ActionRow } from "@/components/action-sheet-rows";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { activateBlock, deactivateBlock, endSelectText, selectTextIn } from "@/lib/block-select";
import type { ChatItem } from "@/lib/chat-items";
import { canCopyText, copyText } from "@/lib/clipboard";
import { t } from "@/lib/i18n";
import { itemCopyText, itemTitle } from "@/lib/message-pins";
import { setStatus } from "@/lib/status";

// WHAT A CHAT BLOCK OFFERS (M90 spec 02): Pin or Unpin, Copy text and Select text. A tap on the block shows its ⋯ and
// the ⋯ opens this sheet; a hold, or a right click on a desk, opens it at once (stream-block.tsx). The title
// says which block it is, in words ("Your message", "Reply", "Tool: git"), because the sheet opens over the
// stream and the block under the finger is no longer the thing in view.
//
// Close-then-act, the way every action row does it (pane-actions-sheet.tsx): the copy runs inside the same tap
// that closes the sheet, so the clipboard write still counts as the person's own. Pin and Unpin do not wait
// on the network here; the pane view's hook marks the block at once and takes the mark back on a refusal.
//
// THE BLOCK IS TINTED WHILE ITS SHEET IS OPEN (2026-11-06): the sheet covers the lower half of the stream, so the
// block it is about carries `data-active` (lib/block-select.ts) and the hold's tint until the sheet closes.
//
// SELECT TEXT (2026-11-06). On a touch screen a pinnable block takes no selection at rest, so that its hold opens
// this sheet every time (index.css). The row gives that one block's text back to the native selection
// (lib/block-select.ts) and says how in a status line; a press outside the block ends it, and so does this sheet
// opening again. On a desk the block was selectable already, and the row makes it so all the same: one sheet.

interface BlockActionsSheetProps {
  /** The block the sheet is for; `null` is closed. */
  item: ChatItem | null;
  /** Whether the block is pinned (or on its way to being): the row reads Unpin. */
  pinned: boolean;
  /** The pin is still on its way, so there is no pin id to drop yet: the Unpin row stands dimmed and takes no tap. */
  pinning?: boolean;
  onClose: () => void;
  onPin: (item: ChatItem) => void;
  onUnpin: (item: ChatItem) => void;
}

const ROW_ICON = "size-4 shrink-0 text-muted-foreground";

export function BlockActionsSheet({ item, pinned, pinning = false, onClose, onPin, onUnpin }: BlockActionsSheetProps) {
  useLocale();
  // While open, its block is marked (`data-active`, a tint), set before paint so the hold's tint flows into it with no
  // frame between. Opening again ends a select mode it started.
  const itemId = item?.id ?? null;
  useLayoutEffect(() => {
    if (itemId === null) return;
    endSelectText();
    activateBlock(itemId);
    return () => deactivateBlock(itemId);
  }, [itemId]);
  if (item === null) return null;
  const copy = async () => {
    try {
      await copyText(itemCopyText(item));
      setStatus(t("copyable.done"), "success");
    } catch {
      setStatus(t("copyable.failed"), "error");
    }
  };
  return (
    <BottomSheet open onClose={onClose} title={itemTitle(item)}>
      <div data-slot="block-actions" className="flex flex-col gap-1">
        <ActionRow
          icon={pinned ? <PinOff className={ROW_ICON} /> : <Pin className={ROW_ICON} />}
          label={t(pinned ? "pins.action.unpin" : "pins.action.pin")}
          disabled={pinned && pinning}
          onClick={() => {
            if (pinned && pinning) return;
            onClose();
            if (pinned) onUnpin(item);
            else onPin(item);
          }}
        />
        {canCopyText() && (
          <ActionRow
            icon={<Copy className={ROW_ICON} />}
            label={t("pins.action.copy")}
            onClick={() => {
              onClose();
              void copy();
            }}
          />
        )}
        <ActionRow
          icon={<SquareDashedText className={ROW_ICON} />}
          label={t("pins.action.selectText")}
          onClick={() => {
            onClose();
            selectTextIn(item.id);
            setStatus(t("pins.selectText.hint"), "info", 6000);
          }}
        />
      </div>
    </BottomSheet>
  );
}
