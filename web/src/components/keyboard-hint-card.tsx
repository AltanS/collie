import { Fragment, type ReactNode } from "react";

import { Keycaps, actionCombos } from "@/components/shortcut-list";
import { Button } from "@/components/ui/button";
import { Notice, NOTICE_ACTION } from "@/components/ui/notice";
import { useAnySheetOpen } from "@/components/ui/sheet";
import { useAppHeaderBottom } from "@/hooks/use-app-header-bottom";
import { useLocale } from "@/hooks/use-locale";
import { useHardwareKeyboardSeen } from "@/lib/hardware-keyboard";
import { t } from "@/lib/i18n";
import { useCatchingUp, useLocked } from "@/lib/idle";
import { markKeyboardHintDone, useKeyboardHintDone } from "@/lib/keyboard-hint";
import { openShortcutHelp } from "@/lib/shortcuts/help";
import { useShortcutKeymap, useShortcutMode } from "@/lib/shortcuts/state";
import type { Keymap } from "@/lib/shortcuts/types";

// THE ONE-TIME KEYBOARD HINT (M108, asked for by Altan on 2026-11-20). A small card at the top right of
// the window, once the device has shown a hardware key press: "You have a keyboard. Collie takes Herdr's
// keys. Press Ctrl B then ? to see them all." The keys are drawn from the live keymap as key caps: the
// prefix, and the first binding of `help`, so a key changed in `shortcuts.toml` shows as changed. With `help`
// unbound the sentence that names it is left out. It is done for good (lib/keyboard-hint.ts) when the person closes
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

/** The words of a template with each `{name}` slot filled by a node. A slot the template names and the call lacks is a bug. */
function withSlots(template: string, slots: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return template.split(/\{(\w+)\}/u).map((part, at) => {
    if (at % 2 === 0) return part;
    const slot = slots[part];
    if (slot === undefined) throw new Error(`The keyboard hint has no slot {${part}}`);
    return <Fragment key={`${part}-${at}`}>{slot}</Fragment>;
  });
}

/** The sentence that names the `help` key, or null when `help` is unbound. It reads the first binding. */
function seeAllSentence(keymap: Keymap): ReactNode[] | null {
  const first = actionCombos({ keymap, id: "help" })[0];
  if (first === undefined) return null;
  const key = <Keycaps caps={first.caps} />;
  if (!first.viaPrefix) return withSlots(t("shortcuts.hint.seeDirect"), { key });
  return withSlots(t("shortcuts.hint.seePrefixed"), { prefix: <Keycaps caps={first.prefixCaps} />, key });
}

function showShortcuts(): void {
  markKeyboardHintDone();
  openShortcutHelp("screen");
}

function HintCard({ keymap }: { keymap: Keymap }) {
  const top = useAppHeaderBottom() + GAP;
  const seeAll = seeAllSentence(keymap);
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
          {t("shortcuts.hint.body")}
          {seeAll !== null && <> {seeAll}</>}
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
