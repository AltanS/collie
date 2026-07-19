import { useEffect, useRef, useState } from "react";
import { Pencil, XCircle } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionRow, DestructiveActionRow, RenameView } from "@/components/action-sheet-rows";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { TabView } from "@/lib/types";

interface TabActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The tab these actions target. Null while nothing is selected (sheet closed). */
  tab: TabView | null;
  /** Session scope for the rename/close writes (undefined = primary). */
  session?: string;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed tab id — the parent falls back to "All"/Home if
   *  it was the selected/viewed tab, or revalidates so it drops out of the strip. */
  onClosed: (tabId: string) => void;
}

type Mode = "actions" | "rename";

// Long-press actions for a single tab — the SAME structure as the pane sheet (the user asked for
// them to match): opens on an action-list view (Rename / Close tab), with rename tucked behind its
// own tap so opening the sheet never shoves a keyboard-triggering input at you. Shares the action
// rows + rename view (action-sheet-rows) with the pane sheet so the two can't drift. Two differences
// from a pane, both live-verified: a tab label can't be cleared (herdr stores "" literally and
// rejects null), so a blank field can't be saved; and closing a tab kills EVERY pane inside it, so
// the confirm names the blast radius. The label is user text rendered only into an <input> value /
// text node — never markup. Both actions are writes, so under read-only they're replaced by a note.
export function TabActionsSheet({
  open,
  onClose,
  tab,
  session,
  readOnly = false,
  onRenamed,
  onClosed,
}: TabActionsSheetProps) {
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const { pending, confirm, reset } = usePendingConfirm();
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) tab, AND
  // whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the live
  // label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(tab?.label ?? "");
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab?.tabId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

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

  // Two-tap: the first tap arms (row flips to the blast-radius confirm), the second closes.
  async function requestClose() {
    if (!tab || closing) return;
    if (!confirm(tab.tabId)) return;
    setClosing(true);
    try {
      const res = await api.closeTab(tab.tabId, session);
      if (res.ok) {
        onClose();
        onClosed(tab.tabId);
      } else {
        setStatus(res.error ?? "Close failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setClosing(false);
    }
  }

  const confirming = !!tab && pending === tab.tabId;
  // Closing a tab kills every pane in it — name the blast radius on the confirm so it's honest. The
  // count rides on the tab record (snapshot `pane_count`); fall back to a plain confirm if it's 0.
  const paneCount = tab?.paneCount ?? 0;
  const confirmLabel =
    paneCount > 0 ? `Tap again to close ${paneCount} pane${paneCount === 1 ? "" : "s"}` : "Tap again to close";

  return (
    <BottomSheet open={open} onClose={onClose} title={tab ? `Tab ${tab.label}` : "Tab"}>
      {readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">
          Read-only — this device isn't authorised to rename or close tabs.
        </p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          <ActionRow
            icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
            label="Rename"
            onClick={() => setMode("rename")}
          />
          <DestructiveActionRow
            icon={<XCircle className="size-4 shrink-0" />}
            label="Close tab"
            confirmLabel={confirmLabel}
            closingLabel="Closing…"
            armed={confirming}
            closing={closing}
            onClick={() => void requestClose()}
          />
        </div>
      ) : (
        <RenameView
          inputRef={inputRef}
          label={label}
          onLabelChange={setLabel}
          onSave={() => void save()}
          onBack={() => setMode("actions")}
          saving={saving}
          // A tab has no "clear" (herdr stores "" literally, rejects null), so a blank field can't be
          // saved — Save disables. This is the one rename difference from a pane.
          canSave={!!trimmed}
          placeholder="name this tab"
        />
      )}
    </BottomSheet>
  );
}
