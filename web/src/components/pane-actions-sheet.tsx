import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, Loader2, Pencil, XCircle } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import { paneDisplayName } from "@/lib/types";
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

type Mode = "actions" | "rename";

// Long-press actions for a single pane: rename (set/clear its label) and close (kill). Reached by
// long-pressing a pane pill. Opens on an action-list view (Rename / Close pane); rename is a second
// tap away so the sheet doesn't shove a keyboard-triggering input at you just to close a pane. The
// label is user text rendered only into an <input> value / text node — never markup — so it stays
// within the pane-output XSS boundary. Both actions are writes, so under read-only they're replaced
// by a note. Close reuses the app's two-tap arm-then-confirm and is destructive-styled from the very
// first tap, not just once armed.
export function PaneActionsSheet({
  open,
  onClose,
  pane,
  session,
  readOnly = false,
  onRenamed,
  onClosed,
}: PaneActionsSheetProps) {
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const { pending, confirm, reset } = usePendingConfirm();
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) pane,
  // AND whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the
  // live label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(pane?.paneLabel ?? "");
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane?.paneId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

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

  // Two-tap: the first tap arms (row flips to "Tap again to close"), the second closes.
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
    <BottomSheet open={open} onClose={onClose} title={pane ? paneDisplayName(pane) : "Pane"}>
      {readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">
          Read-only — this device isn't authorised to rename or close panes.
        </p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setMode("rename")}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent active:bg-muted"
          >
            <Pencil className="size-4 shrink-0 text-muted-foreground" />
            Rename
          </button>

          {/* Close (kill) — destructive-styled from the first tap, not just once armed; two-tap confirmed. */}
          <button
            type="button"
            onClick={() => void requestClose()}
            disabled={closing}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors disabled:opacity-60",
              confirming
                ? "bg-destructive text-destructive-foreground"
                : "text-destructive hover:bg-destructive/10 active:bg-destructive/15",
            )}
          >
            {closing ? (
              <Loader2 className="size-4 shrink-0 animate-spin" />
            ) : (
              <XCircle className="size-4 shrink-0" />
            )}
            {closing ? "Closing…" : confirming ? "Tap again to close" : "Close pane"}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setMode("actions")}
            className="flex items-center gap-1 self-start rounded-md py-1 pr-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted"
          >
            <ChevronLeft className="size-3.5" />
            Back
          </button>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Label</span>
            <input
              ref={inputRef}
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
        </div>
      )}
    </BottomSheet>
  );
}
