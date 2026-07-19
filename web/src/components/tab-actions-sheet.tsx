import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2 } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { TabView } from "@/lib/types";

interface TabActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The tab this rename targets. Null while nothing is selected (sheet closed). */
  tab: TabView | null;
  /** Session scope for the rename write (undefined = primary). */
  session?: string;
  /** This device isn't authorised to write — show a read-only note instead of the input. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
}

// Long-press actions for a single tab. Tabs support ONLY rename — herdr has a `tab.close` too, but
// Collie deliberately doesn't wire tab-close — so, unlike the pane sheet's action list, this opens
// straight into the rename input (no extra tap), with the current label prefilled and autofocused so
// the phone keyboard pops immediately. Unlike a pane label, a tab label can't be cleared (herdr
// stores an empty string literally and rejects null — both live-verified), so a blank field can't be
// saved (Save disables). The label is user text rendered only into an <input> value / text node —
// never markup — so it stays within the pane-output XSS boundary. Under read-only it's a note.
export function TabActionsSheet({
  open,
  onClose,
  tab,
  session,
  readOnly = false,
  onRenamed,
}: TabActionsSheetProps) {
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reprefill the label whenever the sheet opens on a (new) tab, so reopening never keeps a stale
  // edit. Intentionally NOT keyed on the live label, so a background poll landing while you type
  // can't clobber your edit.
  useEffect(() => {
    if (!open) return;
    setLabel(tab?.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab?.tabId]);

  // Autofocus the input when the sheet opens (BottomSheet moves focus to the panel first; this
  // parent-level effect runs after that child effect, so the input wins). Skipped under read-only,
  // where there's no input.
  useEffect(() => {
    if (open && !readOnly) inputRef.current?.focus();
  }, [open, readOnly]);

  const trimmed = label.trim();

  async function save() {
    if (!tab || saving || !trimmed) return;
    setSaving(true);
    try {
      const res = await api.renameTab(tab.tabId, trimmed, session);
      if (res.ok) {
        setStatus("Renamed", "success");
        onRenamed();
        onClose();
      } else {
        setStatus(res.error ?? "Rename failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Rename tab">
      {readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">
          Read-only — this device isn't authorised to rename tabs.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Label</span>
            <input
              ref={inputRef}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="name this tab"
              className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </label>
          <Button onClick={() => void save()} disabled={saving || !trimmed} className="h-11">
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}
