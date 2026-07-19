import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { ChevronLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Shared building blocks for the long-press action sheets — pane AND tab — so the two stay visually
// and behaviourally identical (the user's ask: "they should be the same"). The plain action row, the
// two-tap destructive row, and the rename view are authored ONCE here; each sheet owns its own
// state/handlers and just composes these, differing only in domain semantics (which RPC, whether a
// blank clears, the blast-radius wording). A label rendered here is user text going only into an
// <input> value / text node — never markup — so it stays within the pane-output XSS boundary.

/** A plain (non-destructive) action row: leading icon + label. Used for "Rename". */
export function ActionRow({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent active:bg-muted"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The destructive close row: destructive-styled from the very first render (not just once armed) and
 * two-tap confirmed — the first tap arms (row flips to `confirmLabel`), the second fires `onClick`.
 * The `armed` / `closing` flags + the three labels are owned by the caller (its usePendingConfirm +
 * closing state), so the arm→confirm→spinner choreography looks and behaves the same on both sheets.
 */
export function DestructiveActionRow({
  icon,
  label,
  confirmLabel,
  closingLabel,
  armed,
  closing,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  confirmLabel: string;
  closingLabel: string;
  armed: boolean;
  closing: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={closing}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors disabled:opacity-60",
        armed
          ? "bg-destructive text-destructive-foreground"
          : "text-destructive hover:bg-destructive/10 active:bg-destructive/15",
      )}
    >
      {closing ? <Loader2 className="size-4 shrink-0 animate-spin" /> : icon}
      {closing ? closingLabel : armed ? confirmLabel : label}
    </button>
  );
}

/**
 * The rename view behind the "Rename" tap: a Back row, a prefilled label input (autofocused by the
 * caller via `inputRef`), and Save. `canSave` lets a sheet refuse a blank field — tabs have no
 * "clear" so they pass `canSave = trimmed.length > 0`, while a pane passes `true` always so saving a
 * blank field clears its label. Enter in the input saves.
 */
export function RenameView({
  inputRef,
  label,
  onLabelChange,
  onSave,
  onBack,
  saving,
  canSave,
  placeholder,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
  onLabelChange: (value: string) => void;
  onSave: () => void;
  onBack: () => void;
  saving: boolean;
  canSave: boolean;
  placeholder: string;
}) {
  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onSave();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
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
          onChange={(e) => onLabelChange(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </label>
      <Button onClick={onSave} disabled={saving || !canSave} className="h-11">
        {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
      </Button>
    </div>
  );
}
