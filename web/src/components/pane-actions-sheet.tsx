import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2 } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";

interface PaneActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane these actions target. Null while nothing is selected (sheet closed). */
  pane: AgentView | null;
  /** Session scope for the rename/close writes (undefined = primary). */
  session?: string;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed pane id — the parent navigates Home if it's the
   *  pane currently open, or revalidates so it drops out of the list. */
  onClosed: (paneId: string) => void;
}

/** The display name of a pane: its user label if set, else the agent name (or "shell"). */
function paneName(pane: AgentView): string {
  return pane.paneLabel ?? (pane.kind === "shell" ? "shell" : pane.agent);
}

// Long-press actions for a single pane: rename (set/clear its label) and close (kill). Reached by
// long-pressing a pane pill. The label is user text rendered only into an <input> value / text node
// — never markup — so it stays within the pane-output XSS boundary. Both actions are writes, so under
// read-only they're replaced by a note. Close reuses the app's two-tap arm-then-confirm.
export function PaneActionsSheet({
  open,
  onClose,
  pane,
  session,
  readOnly = false,
  onRenamed,
  onClosed,
}: PaneActionsSheetProps) {
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const { pending, confirm, reset } = usePendingConfirm();

  // Prefill the input from the current label whenever the sheet opens on a (new) pane. Intentionally
  // NOT keyed on the live label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    if (!open) return;
    setLabel(pane?.paneLabel ?? "");
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane?.paneId]);

  async function save() {
    if (!pane || saving) return;
    const next = label.trim();
    setSaving(true);
    try {
      const res = await api.renamePane(pane.paneId, next, session);
      if (res.ok) {
        setStatus(next ? "Renamed" : "Label cleared", "success");
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

  // Two-tap: the first tap arms (button flips to "Tap again to close"), the second closes.
  async function requestClose() {
    if (!pane || closing) return;
    if (!confirm(pane.paneId)) return;
    setClosing(true);
    try {
      const res = await api.closePane(pane.paneId, session);
      if (res.ok) {
        onClose();
        onClosed(pane.paneId);
      } else {
        setStatus(res.error ?? "Close failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setClosing(false);
    }
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }

  const confirming = !!pane && pending === pane.paneId;

  return (
    <BottomSheet open={open} onClose={onClose} title={pane ? paneName(pane) : "Pane"}>
      {readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">
          Read-only — this device isn't authorised to rename or close panes.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="name this pane"
              className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </label>
          <Button onClick={() => void save()} disabled={saving} className="h-11">
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>

          {/* Close (kill) — separated so it doesn't sit flush against Save, and two-tap confirmed. */}
          <div className="mt-1 border-t border-border/60 pt-3">
            <Button
              variant={confirming ? "destructive" : "outline"}
              onClick={() => void requestClose()}
              disabled={closing}
              className="h-11 w-full"
            >
              {closing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : confirming ? (
                "Tap again to close"
              ) : (
                "Close pane"
              )}
            </Button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
