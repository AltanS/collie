import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";

// The inline navigation tray: the keys you need to drive an interactive agent prompt (selection
// menus, multi-select forms, numbered choices) WITHOUT covering the terminal mirror — it docks
// above the composer, so you watch the menu update as you press. Keys follow Herdr's verified
// `pane.send_keys` grammar (see HERDR_API.md): special keys bare, modifier chords joined with "+".
//
// Sticky Shift: Herdr rejects a bare "Shift" keypress, so the Shift button is a one-shot modifier —
// arm it, and the next key is sent as `shift+…` (e.g. shift+enter = newline, shift+tab = mode).

interface NavTrayProps {
  onSend: (keys: string[]) => void;
  disabled?: boolean;
}

interface CtrlDef {
  label: string;
  keys: string[];
  danger?: boolean;
}

const CONTROL: CtrlDef[] = [
  { label: "Ctrl C", keys: ["ctrl+c"] },
  { label: "Ctrl D", keys: ["ctrl+d"], danger: true },
  { label: "Ctrl U", keys: ["ctrl+u"] },
  { label: "Ctrl R", keys: ["ctrl+r"] },
  { label: "Ctrl L", keys: ["ctrl+l"] },
  { label: "Ctrl Z", keys: ["ctrl+z"], danger: true },
];

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function NavTray({ onSend, disabled }: NavTrayProps) {
  const [shift, setShift] = useState(false);
  const [ctrlOpen, setCtrlOpen] = useState(false);
  const { pending, confirm } = usePendingConfirm(); // danger ctrl two-tap

  // Send keys, applying a one-shot Shift to plain keys (chords already containing "+" are left as-is
  // so we never produce "shift+ctrl+c"). Shift always disarms after a press.
  function fire(keys: string[]) {
    if (disabled) return;
    const out = shift ? keys.map((k) => (k.includes("+") ? k : `shift+${k}`)) : keys;
    setShift(false);
    onSend(out);
  }

  function pressCtrl(item: CtrlDef) {
    if (disabled) return;
    if (item.danger && !confirm(item.label)) return; // first tap arms the confirm
    fire(item.keys);
  }

  const navBtn = (content: ReactNode, keys: string[], aria?: string) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => fire(keys)}
      aria-label={aria}
      className="h-10 px-0 text-sm font-medium"
    >
      {content}
    </Button>
  );

  return (
    <div className="space-y-2 border-t border-border/60 bg-muted/30 px-3 py-2.5">
      {/* Navigate: arrows + Esc */}
      <div className="grid grid-cols-5 gap-1.5">
        {navBtn(<ArrowLeft className="mx-auto size-4" />, ["Left"], "Left")}
        {navBtn(<ArrowUp className="mx-auto size-4" />, ["Up"], "Up")}
        {navBtn(<ArrowDown className="mx-auto size-4" />, ["Down"], "Down")}
        {navBtn(<ArrowRight className="mx-auto size-4" />, ["Right"], "Right")}
        {navBtn("Esc", ["Escape"])}
      </div>

      {/* Tab · Shift (sticky) · Space · Enter */}
      <div className="grid grid-cols-4 gap-1.5">
        {navBtn("Tab", ["Tab"])}
        <Button
          type="button"
          variant={shift ? "default" : "outline"}
          size="sm"
          disabled={disabled}
          onClick={() => setShift((s) => !s)}
          aria-pressed={shift}
          className="h-10 px-0 text-sm font-medium"
        >
          ⇧ Shift
        </Button>
        {navBtn("Space", ["Space"])}
        {navBtn("⏎ Enter", ["Enter"])}
      </div>

      {/* Pick a numbered option */}
      <div className="grid grid-cols-9 gap-1">
        {DIGITS.map((d) => (
          <Button
            key={d}
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => fire([d])}
            className="h-9 px-0 font-mono text-sm"
          >
            {d}
          </Button>
        ))}
      </div>

      {/* Control chords (collapsed by default; expanding keeps everything inline, never covering
          the mirror). Ctrl-D / Ctrl-Z need a second tap to fire. */}
      <div>
        <button
          type="button"
          onClick={() => setCtrlOpen((o) => !o)}
          className="flex items-center gap-1 px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          Ctrl
          <ChevronDown className={cn("size-3 transition-transform", ctrlOpen && "rotate-180")} />
        </button>
        {ctrlOpen && (
          <div className="mt-1 grid grid-cols-3 gap-1.5">
            {CONTROL.map((item) => {
              const isPending = pending === item.label;
              return (
                <Button
                  key={item.label}
                  type="button"
                  variant={isPending ? "destructive" : "outline"}
                  size="sm"
                  disabled={disabled}
                  onClick={() => pressCtrl(item)}
                  className={cn("h-10 text-sm font-medium", item.danger && !isPending && "text-destructive")}
                >
                  {isPending ? "Confirm?" : item.label}
                </Button>
              );
            })}
          </div>
        )}
      </div>

      {shift && (
        <p className="px-1 text-[11px] text-muted-foreground">⇧ armed — next key sends as shift+…</p>
      )}
    </div>
  );
}
