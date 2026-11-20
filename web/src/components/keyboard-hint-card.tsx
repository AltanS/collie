import { Keycaps } from "@/components/shortcut-list";
import { Button } from "@/components/ui/button";
import { Notice, NOTICE_ACTION } from "@/components/ui/notice";
import { useAnySheetOpen } from "@/components/ui/sheet";
import { useAppHeaderBottom } from "@/hooks/use-app-header-bottom";
import { useLocale } from "@/hooks/use-locale";
import { useHardwareKeyboardSeen } from "@/lib/hardware-keyboard";
import { t } from "@/lib/i18n";
import { useCatchingUp, useLocked } from "@/lib/idle";
import { markKeyboardHintDone, useKeyboardHintDone } from "@/lib/keyboard-hint";
import { chordKeycaps } from "@/lib/shortcuts/parse";
import { openShortcutHelp } from "@/lib/shortcuts/help";
import { useShortcutKeymap, useShortcutMode } from "@/lib/shortcuts/state";
import type { Keymap } from "@/lib/shortcuts/types";

// THE ONE-TIME KEYBOARD HINT (M108, asked for by Altan on 2026-11-20). A small card at the top right of
// the window, once the device has shown a hardware key press: "You have a keyboard. Collie takes Herdr's
// keys. Press Ctrl B then ? to see them all." The prefix is drawn from the live keymap, so a prefix changed
// in `shortcuts.toml` shows as changed. It is done for good (lib/keyboard-hint.ts) when the person closes
// it, opens the list from it, or presses the prefix.
//
// IT HOLDS NO SPACE. `fixed`, out of flow, so nothing moves when it arrives or leaves (DESIGN.md §2), on an
// opaque page-coloured backing because the info tone is translucent. Its top is the header's bottom edge
// plus a gap (hooks/use-app-header-bottom.ts), so it never covers the header's controls: the mark's row and
// the chips and the gear on the dashboard, and on the large-screen pane layout both the space's row with
// its previous and next buttons and the focused column's docked header. It sits at `z-[25]`: over the page
// and the header (`z-20`), under the strip band (`z-30`), so a connection or update strip, which needs its
// Retry or its tap, is never covered by it. The strip then hides its top edge for as long as it shows.
//
// NOT SHOWN: under the idle lock or the catch-up cover, while a sheet is open (the tour included), and
// while the mode bar is up (the person is already pressing keys). The words are English only until the next
// translation pass (`PENDING_TRANSLATION`).

/** The gap between the header's bottom edge and the card, in px. */
const GAP = 8;

/** The body around its `{prefix}` slot: the words before, and the words after. */
function bodyParts(): readonly [string, string] {
  const [before = "", after = ""] = t("shortcuts.hint.body").split("{prefix}");
  return [before, after];
}

function primaryPrefixCaps(keymap: Keymap): string[] {
  const first = keymap.prefix[0];
  if (first === undefined) throw new Error("The keymap has no prefix chord");
  return chordKeycaps({ chord: first, mac: keymap.mac });
}

function showShortcuts(): void {
  markKeyboardHintDone();
  openShortcutHelp();
}

function HintCard({ keymap }: { keymap: Keymap }) {
  const top = useAppHeaderBottom() + GAP;
  const [before, after] = bodyParts();
  return (
    <div
      data-slot="keyboard-hint"
      className="fixed right-3 z-[25] w-[min(22rem,calc(100vw-1.5rem))] rounded-sm bg-background shadow-md"
      style={{ top }}
    >
      <Notice
        tone="info"
        variant="box"
        announce="status"
        onDismiss={markKeyboardHintDone}
        dismissLabel={t("shortcuts.hint.close")}
        action={
          <Button type="button" variant="outline" size="sm" className={NOTICE_ACTION} onClick={showShortcuts}>
            {t("shortcuts.hint.show")}
          </Button>
        }
      >
        <span className="font-semibold">{t("shortcuts.hint.title")}</span>
        <span className="font-normal">
          {before}
          <Keycaps caps={primaryPrefixCaps(keymap)} />
          {after}
        </span>
      </Notice>
    </div>
  );
}

export function KeyboardHintCard() {
  useLocale();
  const hasKeyboard = useHardwareKeyboardSeen();
  const isDone = useKeyboardHintDone();
  const keymap = useShortcutKeymap();
  const mode = useShortcutMode();
  const isLocked = useLocked();
  const isCatchingUp = useCatchingUp();
  const isSheetOpen = useAnySheetOpen();
  if (!hasKeyboard || isDone || keymap === null) return null;
  if (isLocked || isCatchingUp || isSheetOpen || mode !== "normal") return null;
  return <HintCard keymap={keymap} />;
}
