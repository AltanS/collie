import { useLayoutEffect, useState } from "react";

import { ActionRow } from "@/components/action-sheet-rows";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { BlockTextSheet } from "@/components/block-text-sheet";
import { activateBlock, blockElement, deactivateBlock } from "@/lib/block-select";
import type { ChatItem } from "@/lib/chat-items";
import { canCopyText, copyText } from "@/lib/clipboard";
import { flashCopied } from "@/lib/copied-flash";
import { t } from "@/lib/i18n";
import { itemCopyText, itemTitle } from "@/lib/message-pins";
import { setStatus } from "@/lib/status";
import { Icon } from "@/components/icons/icon";

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
// SELECT TEXT (2026-11-23). On a touch screen a pinnable block takes no selection at rest, so that its hold opens
// this sheet every time (index.css). The row closes this sheet and opens a second one with the block's text, where the
// native selection works (components/block-text-sheet.tsx). The block itself never goes into a select mode. On a desk
// the block is selectable at rest, and the row opens the same sheet: one way.
//
// A COPY SHOWS WHAT IT COPIED. Copy text flashes the block it copied (lib/copied-flash.ts) once the clipboard took it;
// the sheet is gone by then, so the block is found by its item id (lib/block-select.ts).

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

/** The actions sheet, and the text sheet its Select text row opens. The second lives here, so no caller wires it. */
export function BlockActionsSheet(props: BlockActionsSheetProps) {
  const [textOf, setTextOf] = useState<ChatItem | null>(null);
  return (
    <>
      <BlockActions {...props} onSelectText={setTextOf} />
      <BlockTextSheet item={textOf} onClose={() => setTextOf(null)} />
    </>
  );
}

function BlockActions({
  item,
  pinned,
  pinning = false,
  onClose,
  onPin,
  onUnpin,
  onSelectText,
}: BlockActionsSheetProps & { onSelectText: (item: ChatItem) => void }) {
  useLocale();
  // While open, its block is marked (`data-active`, a tint), set before paint so the hold's tint flows into it with no
  // frame between.
  const itemId = item?.id ?? null;
  useLayoutEffect(() => {
    if (itemId === null) return;
    activateBlock(itemId);
    return () => deactivateBlock(itemId);
  }, [itemId]);
  if (item === null) return null;
  const copy = async () => {
    try {
      await copyText(itemCopyText(item));
      flashCopied(blockElement(item.id));
      setStatus(t("copyable.done"), "success");
    } catch {
      setStatus(t("copyable.failed"), "error");
    }
  };
  return (
    <BottomSheet open onClose={onClose} title={itemTitle(item)}>
      <div data-slot="block-actions" className="flex flex-col gap-1">
        <ActionRow
          icon={pinned ? <Icon name="unpin" className={ROW_ICON} /> : <Icon name="pin" className={ROW_ICON} />}
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
            icon={<Icon name="copy" className={ROW_ICON} />}
            label={t("pins.action.copy")}
            onClick={() => {
              onClose();
              void copy();
            }}
          />
        )}
        <ActionRow
          icon={<Icon name="select-text" className={ROW_ICON} />}
          label={t("pins.action.selectText")}
          onClick={() => {
            onClose();
            onSelectText(item);
          }}
        />
      </div>
    </BottomSheet>
  );
}
