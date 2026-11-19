import { ShortcutModeBar } from "@/components/shortcut-mode-bar";
import { Notice } from "@/components/ui/notice";
import { useShortcutKeymap, useShortcutMode } from "@/lib/shortcuts/state";

// THE MODE BAR, PLACED (M108, option 4 of the design round, picked by Altan on 2026-11-19). Mounted once
// in the root layout. While the prefix or a sticky mode is active, a band of the info tone (the blue of
// the WalkyTalky strip) sits along the foot of the window, over the view, so nothing in the page moves:
// it is `fixed`, out of flow, and reserves no space. The Notice is translucent, so an opaque
// page-coloured backing sits under it and the composer never shows through. 32px: it covers the
// composer's bottom padding and nothing a person aims at. `Esc` leaves the mode, which the resolver
// (hooks/use-shortcuts.ts) handles; the bar only draws.

export function ShortcutBarHost() {
  const mode = useShortcutMode();
  const keymap = useShortcutKeymap();
  if (mode === "normal" || keymap === null) return null;
  return (
    <div data-slot="mode-band" className="fixed inset-x-0 bottom-0 z-40 bg-background">
      <Notice
        tone="info"
        variant="box"
        announce="none"
        className="h-8 min-h-0 flex-nowrap items-center rounded-none border-x-0 border-b-0 border-t py-0 font-normal"
      >
        <ShortcutModeBar mode={mode} keymap={keymap} className="w-full" />
      </Notice>
    </div>
  );
}
