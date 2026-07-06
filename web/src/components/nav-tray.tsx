import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useKeyQueue } from "@/hooks/use-key-queue";
import { KeyQueueStrip } from "@/components/key-queue-strip";

// The inline navigation tray: the keys you need to drive an interactive agent prompt (selection
// menus, multi-select forms, numbered choices) WITHOUT covering the terminal mirror — it docks
// above the composer, so you watch the menu update as you press. Keys follow Herdr's verified
// `pane.send_keys` grammar (see HERDR_API.md): special keys bare, modifier chords joined with "+".
//
// Two modes, driven by useKeyQueue. When nothing is armed and the queue is empty, a key press fires
// immediately (the classic path). Arm a modifier (⇧ Shift / Ctrl) — or once any key is queued — and
// the tray enters compose mode: presses stage a visible key queue (the strip) that you review and
// Send as ONE call. Herdr rejects a bare "Shift"/"Ctrl" keypress, so the modifiers are one-shot: arm,
// and the next key is composed as `shift+…` / `ctrl+…`, then the modifier disarms.

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

// Two views behind a segmented toggle: the keys pad (arrows/Esc, Tab/Space/Enter, modifiers, Ctrl
// presets) and a phone-dialer digit grid. Digits were a cramped nine-across sliver row; on their own
// tab they get large, thumb-sized targets. The tab is component state only (resets to "keys" each
// open — the sheet unmounts the tray when closed), while the armed modifier, the key queue, and the
// Ctrl-expand persist across the toggle so a composed sequence survives switching to the digit pad.
type Tab = "keys" | "digits";

export function NavTray({ onSend, disabled }: NavTrayProps) {
  const [tab, setTab] = useState<Tab>("keys");
  const [ctrlOpen, setCtrlOpen] = useState(false);
  const { queue, mod, composing, arm, press, pushBase, removeAt, clear, take } = useKeyQueue();
  const { pending, confirm, reset } = usePendingConfirm(); // danger ctrl two-tap (immediate path only)

  // Route a key press through the queue: fire immediately when idle, stage when composing.
  function fire(keys: string[]) {
    if (disabled) return;
    const r = press(keys);
    if (r.mode === "fire") onSend(r.keys);
  }

  // Ctrl presets. When composing, a tap just stages the chord (the Send review IS the confirm — no
  // two-tap, and the strip's Send shows destructive styling for c/d/z). When firing immediately, the
  // danger chords (d/z) keep the original two-tap confirm.
  function pressCtrl(item: CtrlDef) {
    if (disabled) return;
    if (!composing && item.danger && !confirm(item.label)) return; // first tap arms the confirm
    fire(item.keys);
  }

  // Send the whole queue as one ordered call, then reset any stray confirm.
  function sendQueue() {
    if (disabled) return;
    const keys = take();
    reset();
    if (keys.length > 0) onSend(keys);
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

  const modBtn = (m: "shift" | "ctrl", label: ReactNode) => (
    <Button
      type="button"
      variant={mod === m ? "default" : "outline"}
      size="sm"
      disabled={disabled}
      onClick={() => arm(m)}
      aria-pressed={mod === m}
      className="h-10 px-0 text-sm font-medium"
    >
      {label}
    </Button>
  );

  return (
    <div className="space-y-2 border-t border-border/60 bg-muted/30 px-3 py-2.5">
      {/* Staging strip — visible only while composing (a modifier armed or keys queued). Same on
          both tabs; the review-and-Send surface replaces the old "⇧ armed" hint line. */}
      <KeyQueueStrip
        queue={queue}
        mod={mod}
        onRemove={removeAt}
        onClear={clear}
        onSend={sendQueue}
        onBaseChar={pushBase}
        disabled={disabled}
      />

      {/* Segmented toggle: the keys pad vs. the phone-dialer digit grid. Same pressed language as the
          composer's view toggles (secondary = active, ghost = inactive). */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-background/60 p-1">
        <Button
          type="button"
          variant={tab === "keys" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setTab("keys")}
          aria-pressed={tab === "keys"}
          className="h-8 text-sm font-medium"
        >
          Keys
        </Button>
        <Button
          type="button"
          variant={tab === "digits" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setTab("digits")}
          aria-pressed={tab === "digits"}
          className="h-8 font-mono text-sm"
        >
          123
        </Button>
      </div>

      {tab === "keys" ? (
        <>
          {/* Navigate: arrows + Esc */}
          <div className="grid grid-cols-5 gap-1.5">
            {navBtn(<ArrowLeft className="mx-auto size-4" />, ["Left"], "Left")}
            {navBtn(<ArrowUp className="mx-auto size-4" />, ["Up"], "Up")}
            {navBtn(<ArrowDown className="mx-auto size-4" />, ["Down"], "Down")}
            {navBtn(<ArrowRight className="mx-auto size-4" />, ["Right"], "Right")}
            {navBtn("Esc", ["Escape"])}
          </div>

          {/* Tab · Space · Enter */}
          <div className="grid grid-cols-3 gap-1.5">
            {navBtn("Tab", ["Tab"])}
            {navBtn("Space", ["Space"])}
            {navBtn("⏎ Enter", ["Enter"])}
          </div>

          {/* Modifiers (sticky, one-shot, radio): arm one and the next key composes as its chord.
              Same pressed styling as everything else (default = armed, outline = idle). */}
          <div className="grid grid-cols-2 gap-1.5">
            {modBtn("shift", "⇧ Shift")}
            {modBtn("ctrl", "Ctrl")}
          </div>

          {/* Ctrl presets (collapsed by default; expanding keeps everything inline, never covering
              the mirror). On the immediate path Ctrl-D / Ctrl-Z need a second tap; while composing a
              tap just stages the chord for review. */}
          <div>
            <button
              type="button"
              onClick={() => setCtrlOpen((o) => !o)}
              className="flex items-center gap-1 px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              Presets
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
        </>
      ) : (
        /* Pick a numbered option — a phone-dialer 3×3 grid of large, thumb-sized digit keys. Same
           fire() path as everything else, so an armed modifier / a queue built on the Keys tab still
           applies here. */
        <div className="grid grid-cols-3 gap-1.5">
          {DIGITS.map((d) => (
            <Button
              key={d}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => fire([d])}
              className="h-12 font-mono text-lg"
            >
              {d}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
