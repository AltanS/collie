import { Copy, Pin, PinOff } from "lucide-react";

import { ActionRow } from "@/components/action-sheet-rows";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import type { ChatItem } from "@/lib/chat-items";
import { canCopyText, copyText } from "@/lib/clipboard";
import { t } from "@/lib/i18n";
import { itemCopyText, itemTitle } from "@/lib/message-pins";
import { setStatus } from "@/lib/status";

// WHAT A HOLD (OR THE ⋯) ON A CHAT BLOCK OFFERS (M90 spec 02): two rows, Pin or Unpin and Copy text. The title
// says which block it is, in words ("Your message", "Reply", "Tool: git"), because the sheet opens over the
// stream and the block under the finger is no longer the thing in view.
//
// Close-then-act, the way every action row does it (pane-actions-sheet.tsx): the copy runs inside the same tap
// that closes the sheet, so the clipboard write still counts as the person's own. Pin and Unpin do not wait
// on the network here; the pane view's hook marks the block at once and takes the mark back on a refusal.

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
      </div>
    </BottomSheet>
  );
}
