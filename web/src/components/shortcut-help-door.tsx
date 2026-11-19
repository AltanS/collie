import { useEffect, useRef, useState } from "react";

import { ShortcutList } from "@/components/shortcut-list";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { useShortcutHandler } from "@/hooks/use-shortcut-handler";
import { t } from "@/lib/i18n";
import { closeShortcutHelp, openShortcutHelp, useShortcutHelpOpen } from "@/lib/shortcuts/help";
import { useShortcutKeymap } from "@/lib/shortcuts/state";
import type { Keymap } from "@/lib/shortcuts/types";

// THE SHORTCUT LIST'S SHEET (M108). Mounted once in the root layout. It answers the `help` action
// (`prefix+?`) and opens from the Settings row (components/shortcut-settings-row.tsx) through the same
// store, so the shortcut is a second path to a control that is on screen, never the only one.
//
// The sheet is the app's own BottomSheet; the list inside it is presentational and reads the live
// keymap, so a change in `shortcuts.toml` shows while the sheet is open. Esc closes it (the sheet's own
// key). `/` puts the cursor in the filter, as the cap in the field says. The list scrolls inside the
// sheet, between its filter and its foot, so the filter and the diagnostics stay in view: the `max-h` is
// the sheet's 82dvh less its title row and padding.

function SheetBody({ keymap }: { keymap: Keymap }) {
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.activeElement === filterRef.current) return;
      event.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <ShortcutList
      keymap={keymap}
      query={query}
      onQueryChange={setQuery}
      filterRef={filterRef}
      className="-mx-4 -my-3 max-h-[calc(82dvh-7.5rem)]"
    />
  );
}

export function ShortcutHelpDoor() {
  useLocale();
  const isOpen = useShortcutHelpOpen();
  const keymap = useShortcutKeymap();
  useShortcutHandler("help", openShortcutHelp);
  if (keymap === null) return null;
  return (
    <BottomSheet open={isOpen} onClose={closeShortcutHelp} title={t("shortcuts.list.title")}>
      <SheetBody keymap={keymap} />
    </BottomSheet>
  );
}
