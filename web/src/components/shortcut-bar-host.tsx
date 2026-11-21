import { ShortcutModeBar, ShortcutNoticeText } from "@/components/shortcut-mode-bar";
import { Notice } from "@/components/ui/notice";
import { useAvailableShortcutActions } from "@/hooks/use-shortcut-handler";
import { isShortcutBarUp, useShortcutKeymap, useShortcutMode, useShortcutNotice } from "@/lib/shortcuts/state";

// THE MODE BAR, PLACED (M108, option 4 of the design round, picked by Altan on 2026-11-19). Mounted once
// in the root layout. While the prefix or a sticky mode is active, a band of the info tone (the blue of
// the WalkyTalky strip) sits along the foot of the window, over the view, so nothing in the page moves:
// it is `fixed`, out of flow, and reserves no space. The Notice is translucent, so an opaque
// page-coloured backing sits under it and the composer never shows through. 32px: it covers the
// composer's bottom padding and nothing a person aims at. When the hints do not fit one line they wrap
// to a second, and the band grows up from the foot; a word is never cut. `Esc` leaves the mode, which the resolver
// (hooks/use-shortcuts.ts) handles; the bar only draws. It names the actions that work on this screen
// (the registry's handlers), and when a key has no target here it says "Not on this screen" for two
// seconds, in the same band: alone when no mode is active, in the hints' place when one is.

export function ShortcutBarHost() {
  const mode = useShortcutMode();
  const keymap = useShortcutKeymap();
  const available = useAvailableShortcutActions();
  const isNoticeShown = useShortcutNotice();
  if (keymap === null) return null;
  if (!isShortcutBarUp(mode, keymap) && !isNoticeShown) return null;
  return (
    <div data-slot="mode-band" className="fixed inset-x-0 bottom-0 z-40 bg-background">
      <Notice
        tone="info"
        variant="box"
        announce="none"
        className="h-auto min-h-8 flex-nowrap items-center rounded-none border-x-0 border-b-0 border-t py-1 font-normal"
      >
        {mode === "normal" ? (
          <ShortcutNoticeText />
        ) : (
          <ShortcutModeBar mode={mode} keymap={keymap} available={available} isNoticeShown={isNoticeShown} className="w-full" />
        )}
      </Notice>
    </div>
  );
}
