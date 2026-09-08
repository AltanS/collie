import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, Lock, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Modifier } from "@/lib/key-queue";
import { denseKeyLabel, denseModifierLabel, isDangerKey, joinChord } from "@/lib/key-queue";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useKeyQueue } from "@/hooks/use-key-queue";
import { useActionEcho } from "@/hooks/use-action-echo";
import { useHoldRepeat } from "@/hooks/use-hold-repeat";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { keysSendable } from "@/lib/mux-capability";
import { CONTROL_PRESETS, type CtrlDef } from "@/lib/operator-keys";

// The inline navigation tray: the keys you need to drive an interactive agent prompt (selection
// menus, multi-select forms, numbered choices) WITHOUT covering the terminal mirror — it docks
// above the composer, so you watch the menu update as you press. Keys follow Herdr's verified
// `pane.send_keys` grammar (see HERDR_API.md): special keys bare, modifier chords joined with "+".
//
// Two modes, driven by useKeyQueue. When nothing is armed and the queue is empty, a key press fires
// immediately (the classic path). Arm one or more modifiers (⇧ Shift / Ctrl / Alt) — or once any key
// is queued — and the tray enters compose mode: presses stage a visible key queue (the strip) that
// you review and Send as ONE call. Herdr rejects a bare "Shift"/"Ctrl"/"Alt" keypress, so modifiers
// only exist as part of a chord. Each modifier is a CHECKBOX that cycles off → once → locked → off:
// tap once for a one-shot (composed into the next staged key, then released), tap again to LOCK it
// armed across presses and Sends, tap a third time to clear. Any subset combines — `ctrl+shift+p`.
//
// An immediate press ECHOES on its own button (useActionEcho): accent fill the instant you tap, a ✓
// once the bridge accepts it. Before this the path was silent on success and the mirror — up to ~2s
// behind — was the only acknowledgement, so pressing Enter felt like nothing happened. A STAGED press
// needs no echo: the chip appearing in the strip is already the receipt. Deliberately no sibling
// dimming here (unlike the quick replies): this is a keypad you drum on, and dimming eight keys per
// arrow press would strobe.

export interface NavTrayDenseProps {
  /** Resolves true when the bridge accepted the keys — drives the ✓ echo on the pressed button. */
  onSend: (keys: string[]) => Promise<boolean>;
  /**
   * The labelled preset chords under "Presets" — the operator's own `keys.toml` rows when any of
   * them address this pane, otherwise the shipped six (resolved by `ctrlPresetsFor`). Only this
   * list is configurable; everything else in the tray is the fixed keyboard.
   */
  presets?: readonly CtrlDef[];
  /** How many keys are staged, reported up so the Composer can guard closing the dock on a composed
   *  sequence. Reports 0 on unmount. Must be referentially stable (a setState fn is ideal). */
  onQueueChange?: (staged: number) => void;
  disabled?: boolean;
  /**
   * Neutral key spellings this multiplexer refuses (`/api/config`, M10/06). A button whose chord
   * uses one is greyed — the door is open (`sendKeys`), this key is simply not behind it.
   *
   * Deliberately a prop rather than a hook call in here: the tray is the fixed keyboard and gets
   * everything it renders from its parent, so a test can drive it without a config fetch.
   */
  unsupportedKeys?: readonly string[];
}

// The staging strip above the dense grid: a chip per queued key (tap to remove), a ghost chip +
// one-char input while any modifier is armed, and an explicit Send. Same markup and i18n keys as
// the shared KeyQueueStrip, inlined here instead of imported: the shared strip labels chips with
// the roomy word labels (`keyLabel` — "Ctrl ⇧ P"), which also label dialog buttons and wizard rows
// app-wide and must keep their words. The dense grid is ~40px a key, so this strip uses the dense
// glyph labels (`denseKeyLabel` — "⌃⇧P") and would clip beside the roomy one. Presentational only —
// all state lives in useKeyQueue; every visible string is a plain text node.
interface DenseKeyQueueStripProps {
  queue: string[];
  /** The active modifiers in canonical order (pass activeMods from useKeyQueue). */
  mods: readonly Modifier[];
  onRemove: (i: number) => void;
  onClear: () => void;
  onSend: () => void;
  /** Raw input value forwarded straight through — the model (normalizeBaseChar) takes the last char. */
  onBaseChar: (char: string) => void;
  disabled?: boolean;
}

function DenseKeyQueueStrip({
  queue,
  mods,
  onRemove,
  onClear,
  onSend,
  onBaseChar,
  disabled,
}: DenseKeyQueueStripProps) {
  useLocale();
  // Self-guarding: nothing to show unless a modifier is armed or keys are queued.
  if (mods.length === 0 && queue.length === 0) return null;

  const danger = queue.some(isDangerKey);
  const modsArmed = mods.length > 0;
  const modLabels = joinChord(mods.map(denseModifierLabel));

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 p-1.5">
      {/* Queued keys — tap a chip to drop it from the sequence. */}
      {queue.map((key, i) => {
        const label = denseKeyLabel(key);
        return (
          <button
            key={`${key}-${i}`}
            type="button"
            onClick={() => onRemove(i)}
            aria-label={t("keys.queue.removeAria", { label })}
            className={cn(
              "inline-flex min-h-11 min-w-11 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 text-xs font-medium",
              isDangerKey(key) && "border-destructive/40 text-destructive",
            )}
          >
            <span>{label}</span>
            <X className="size-3 opacity-60" />
          </button>
        );
      })}

      {/* Modifiers armed, no base yet: a ghost chip showing the awaited chord (e.g. "⌃⇧ + …"). */}
      {modsArmed && (
        <span className="inline-flex h-8 items-center rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground">
          {modLabels} + …
        </span>
      )}

      {/* One-char key input — only while a modifier is armed. Controlled to "" so each keystroke
          fires onChange and the field stays empty; the model takes the last char typed. */}
      {modsArmed && (
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t("keys.queue.charPlaceholder")}
          value=""
          disabled={disabled}
          onChange={(e) => onBaseChar(e.target.value)}
          aria-label={t("keys.queue.charAria")}
          className="h-11 w-14 rounded-md border border-input bg-transparent px-2 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
        />
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button
          type="button"
          variant={danger ? "destructive" : "default"}
          size="sm"
          className="min-h-11 min-w-11"
          disabled={disabled || queue.length === 0}
          onClick={onSend}
        >
          {t("keys.queue.send")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 text-muted-foreground"
          disabled={disabled}
          onClick={onClear}
          aria-label={t("keys.queue.clearAria")}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
/** Stable default so an omitted prop never re-renders the pad. */
const NO_REFUSED_KEYS: readonly string[] = [];

// F1–F12 — Herdr's send_keys grammar accepts them bare (HERDR_API.md), and harnesses bind them to
// real actions (tmux windows, CLI hotkeys, agent-extension views like pi's CE Workflow: F7 opens
// its orchestrator). Without buttons for them, a phone-only user has no route to any such keybind.
const FN_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];

// The same transparent ::before technique as STRIP_TAP_TARGET, sized for this grid's 36px
// faces and 1px Button border: -5px reaches 4px vertically; -3px reaches 2px horizontally.
// A 40px-wide face therefore answers a 44×44px target. gap-y-2 / gap-x-1 keep those targets
// disjoint. The scroller's py-1 / px-0.5 retain their reach at the grid's outer edges.
const GRID_TAP_TARGET =
  "relative before:absolute before:-inset-y-[5px] before:-inset-x-[3px] before:content-['']";

// Symbol keys, three full 8-grid rows. Herdr types any literal one-character string
// (HERDR_API.md), so these ride the ordinary navBtn path - no grammar work, and the
// multiplexer refused-key greying applies to them like every other button.

// Quick combos: the chords agent CLIs actually run on - interrupt-adjacent ^D, line kill ^U,
// history search ^R, clear ^L, and the readline word/line quartet ^W ^A ^E ^K. The same chords
// also ship in Presets (same spelling, the ^C precedent - one chord never reads two ways here);
// the grid copies are the one-tap path, the Presets rows the discoverable list. ^D keeps its
// danger two-tap through pressCtrl, matching its Presets classification: at an empty prompt it
// exits the agent. ^Z stays Presets-only - suspending the agent is never a quick-tap want.
const QUICK_COMBOS: readonly { chord: string; danger?: boolean }[] = [
  { chord: "ctrl+d", danger: true },
  { chord: "ctrl+u" },
  { chord: "ctrl+r" },
  { chord: "ctrl+l" },
  { chord: "ctrl+w" },
  { chord: "ctrl+a" },
  { chord: "ctrl+e" },
  { chord: "ctrl+k" },
];

// Symbols split for the two lanes: the numpad owns / * - + ., so they appear nowhere else.
const SYMBOLS_L = ["|", "~", "=", ":", ";", "!", "<", ">"];
const SYMBOLS_R = ["(", ")", "$", "_", "{", "}", "[", "]"];
// The rare tail (? @ % ^) closes the left lane beside nothing else — kept, not loved.
const SYMBOLS_TAIL = ["?", "@", "%", "^"];

// One pad, no tabs: an 8-column grid of every sendable key (plus the collapsible Ctrl
// presets, whose rows are the operator's own and vary in count). Digits used to hide behind a 123
// toggle; on the dense grid they are rows like everything else, so the toggle and its header row
// are gone. The armed modifier, the key queue, and the Ctrl-expand live above the grid and are
// unaffected.

export function NavTrayDense({
  onSend,
  presets = CONTROL_PRESETS,
  onQueueChange,
  disabled,
  unsupportedKeys = NO_REFUSED_KEYS,
}: NavTrayDenseProps) {
  useLocale();
  const [ctrlOpen, setCtrlOpen] = useState(false);
  const { queue, mods, activeMods, composing, arm, press, pushBase, removeAt, clear, take } =
    useKeyQueue();
  const { pending, confirm, reset } = usePendingConfirm(); // danger ctrl two-tap (immediate path only)
  const echo = useActionEcho();
  // Hold-to-repeat, WHITELISTED to the arrows (see navBtn's `repeat` flag). Deliberately a whitelist
  // rather than a blacklist: Enter/Esc/Space/digits/Ctrl-presets structurally must not repeat, and
  // the danger presets' two-tap guard lives on a different code path (pressCtrl) that a future
  // refactor could route around — so repeat capability is opt-in per button, not opt-out.
  // Disabled while composing: a hold must never stage fifteen identical chips into a queue whose
  // entire value is that you can review it before it goes on the wire.
  const repeat = useHoldRepeat(
    (key, n) => onSend(Array<string>(n).fill(key)),
    !disabled && !composing,
  );

  // Report the staged count up. The tray unmounts when the dock closes (which is what discards the
  // queue), so the Composer can't read this state itself — it has to be pushed. The second effect
  // reports 0 on unmount so a stale count can't outlive the tray and arm a phantom confirm.
  useEffect(() => {
    onQueueChange?.(queue.length);
  }, [queue.length, onQueueChange]);
  useEffect(
    () => () => {
      onQueueChange?.(0);
    },
    [onQueueChange],
  );

  // Route a key press through the queue: fire immediately when idle, stage when composing. Only the
  // immediate path echoes — a staged press is already visible as a chip.
  function fire(keys: string[], id: string) {
    if (disabled) return;
    const r = press(keys);
    if (r.mode === "fire") void echo.run(id, () => onSend(r.keys));
  }

  // Ctrl presets. When composing, a tap just stages the chord (the Send review IS the confirm — no
  // two-tap, and the strip's Send shows destructive styling for c/d/z). When firing immediately, the
  // danger chords (d/z) keep the original two-tap confirm.
  function pressCtrl(item: CtrlDef) {
    if (disabled) return;
    if (!composing && item.danger && !confirm(item.label)) return; // first tap arms the confirm
    fire(item.keys, item.label);
  }

  // Send the whole queue as one ordered call, then reset any stray confirm. No echo on the strip's
  // Send, deliberately: `take()` empties the queue synchronously, so the chips vanishing IS the
  // receipt (and the strip itself unmounts unless a locked modifier holds it open) — a spinner there
  // would have nothing left to render on. That sentence is also quoted at `sendKeys` in
  // lib/ack-manifest.ts, which is where a "this control says nothing" claim is now reviewed.
  function sendQueue() {
    if (disabled) return;
    const keys = take();
    reset();
    if (keys.length > 0) void onSend(keys);
  }

  // A key button, echoing its own press. `pending` fills it the instant you tap (no network wait);
  // `done` swaps a ✓ in for the label for ECHO_DONE_MS. Keyed by the wire string, so the same key
  // pressed twice in a row restarts its own cycle rather than inheriting a stale ✓.
  //
  // `repeatable` opts a button into hold-to-repeat. While held, the button shows a live "×N" count
  // instead of running the per-press echo — echo.run per repeat tick would restart the ✓ timer ~11
  // times a second and strobe, the same reason sibling dimming is banned on this pad.
  // Idle keys are borderless muted tiles (ghost + bg-muted), Termius-pad style: 56 outlined
  // buttons read as a wireframe. Pressed/echo states stay filled primary. `span` covers more grid columns (the wide Space is custom; the F9-F12 pairs use this).
  const navBtn = (content: ReactNode, keys: string[], aria?: string, repeatable = false, span = "") => {
    const id = keys.join(" ");
    const phase = echo.phaseOf(id);
    const held = repeatable && repeat.holding === keys[0];
    const bind = repeatable ? repeat.bind(keys[0], () => fire(keys, id)) : undefined;
    // Greyed rather than removed: the pad's geometry IS its usability (Esc top-left, arrows as an
    // inverted-T), and pulling a key out of the grid would move every key after it. A dead button in
    // its own place is the lesser harm here — the opposite call from the action sheets, and for a
    // reason those sheets do not have.
    const refused = !keysSendable(keys, unsupportedKeys);
    return (
      <Button
        type="button"
        variant={held || phase !== "idle" ? "default" : "ghost"}
        size="sm"
        disabled={disabled || refused}
        {...(bind ?? { onClick: () => fire(keys, id) })}
        aria-label={aria}
        // touch-action/select-none: without them a held button on iOS starts a text selection and
        // Android may treat the hold as a scroll gesture, both of which cancel the pointer stream.
        className={`${GRID_TAP_TARGET} h-9 touch-manipulation px-0 text-xs font-medium select-none ${span} ${held || phase !== "idle" ? "" : "bg-muted"}`}
      >
        {held ? (
          <span className="mx-auto flex items-center gap-1">
            {content}
            {repeat.count > 1 && <span className="text-xs tabular-nums">×{repeat.count}</span>}
          </span>
        ) : phase === "done" ? (
          <Check className="mx-auto size-4" />
        ) : (
          content
        )}
      </Button>
    );
  };

  // A digit tile: the old 123 dialer shrunk to grid rows. Same fire() path, same echo, same
  // borderless tile — only the typeface stays mono.
  const digitBtn = (d: string, span = "") => {
    const phase = echo.phaseOf(d);
    const idle = phase === "idle";
    return (
      <Button
        key={d}
        type="button"
        variant={idle ? "ghost" : "default"}
        size="sm"
        disabled={disabled}
        onClick={() => fire([d], d)}
        className={cn(GRID_TAP_TARGET, "h-9 font-mono text-sm", span, idle && "bg-muted")}
      >
        {phase === "done" ? <Check className="size-4" /> : d}
      </Button>
    );
  };

  // A modifier button reads its own three-state mode from `mods`: borderless tile when off, filled (default)
  // when armed — once OR locked — with a small Lock glyph beside the label to distinguish locked from
  // one-shot. Tapping cycles off → once → locked → off.
  const modBtn = (m: Modifier, label: ReactNode, aria: string) => {
    const mode = mods[m];
    return (
      <Button
        type="button"
        variant={mode === "off" ? "ghost" : "default"}
        size="sm"
        disabled={disabled}
        onClick={() => arm(m)}
        aria-pressed={mode !== "off"}
        aria-label={aria}
        className={cn(GRID_TAP_TARGET, "h-9 px-0 text-xs font-medium", mode === "off" && "bg-muted")}
      >
        {mode === "locked" && <Lock className="size-3" />}
        {label}
      </Button>
    );
  };

  // A quick-combo button: the Presets renderer shrunk to grid size. Same spelling as its
  // Presets twin, same danger two-tap (^D), same borderless tile at rest.
  const comboBtn = (c: { chord: string; danger?: boolean }) => {
    const label = denseKeyLabel(c.chord);
    const live = pending === label || echo.phaseOf(label) !== "idle";
    return (
      <Button
        key={c.chord}
        type="button"
        variant={pending === label ? "destructive" : live ? "default" : "ghost"}
        size="sm"
        disabled={disabled || !keysSendable([c.chord], unsupportedKeys)}
        onClick={() => pressCtrl({ label, keys: [c.chord], danger: c.danger })}
        aria-label={"Ctrl+" + c.chord.slice(5).toUpperCase()}
        className={cn(GRID_TAP_TARGET, "h-9 px-0 text-xs font-medium", !live && "bg-muted")}
      >
        {pending === label ? (
          t("keys.confirm.label")
        ) : echo.phaseOf(label) === "done" ? (
          <Check className="size-4" />
        ) : (
          label
        )}
      </Button>
    );
  };

  return (
    // No top rule of its own: the chrome block's seam already draws the panel's top edge,
    // and the bg-muted/30 wash already parts the tray from the dock header — a border-t here
    // doubled the key pane's top line while the agent pane stayed single.
    <div className="space-y-2 bg-muted/30 px-3 py-2.5">
      {/* Staging strip — visible only while composing (a modifier armed or keys queued). One strip
          for the whole pad; the review-and-Send surface replaces the old "⇧ armed" hint line. */}
      <DenseKeyQueueStrip
        queue={queue}
        mods={activeMods}
        onRemove={removeAt}
        onClear={clear}
        onSend={sendQueue}
        onBaseChar={pushBase}
        disabled={disabled}
      />

      <>
          {/* Two lanes, Termius-style: a 4-column terminal lane and a 4-column numpad lane with
              a wider gutter between them (outer gap-3 vs inner gap-x-1). Both lanes run 9 rows, so
              the pairs stay aligned. Left: control block, inline arrows (the inverted-T cost two
              rows for four keys; hold-to-repeat still applies), wide Space, symbols, the
              agent-CLI combos (^D keeps its danger two-tap), the rare-symbol tail. Right: a
              faithful numpad (7-8-9 top row, 0 wide, operators, dot), symbols, F1-F12 in ONE
              lane — never spread across. Deliberately NOT here: Termius's Home/PgUp/PgDn/End/
              Del/Ins block — Herdr answers every one with invalid_key (HERDR_API.md). */}
          {/* Eight 40px faces plus gaps need 356px. Below that, scroll rather than overlap hit
              targets or shrink them. Padding belongs inside this scroller, not on its parent. */}
          <div className="overflow-x-auto overscroll-x-contain px-0.5 py-1">
          <div className="grid min-w-[22.25rem] grid-cols-2 gap-3">
            <div className="grid grid-cols-4 content-start gap-x-1 gap-y-2" data-slot="key-lane-left">
              {navBtn("Esc", ["Escape"])}
              {navBtn("Tab", ["Tab"])}
              {modBtn("shift", "\u21e7", "Shift")}
              {modBtn("ctrl", "\u2303", "Ctrl")}
              {modBtn("alt", "Alt", "Alt")}
              {navBtn(denseKeyLabel("ctrl+c"), ["ctrl+c"], "Ctrl+C")}
              {navBtn("\u232b", ["Backspace"], "Backspace")}
              {navBtn("\u23ce", ["Enter"], "Enter")}
              {navBtn(<ArrowLeft className="size-4" />, ["Left"], "Left", true)}
              {navBtn(<ArrowUp className="size-4" />, ["Up"], "Up", true)}
              {navBtn(<ArrowDown className="size-4" />, ["Down"], "Down", true)}
              {navBtn(<ArrowRight className="size-4" />, ["Right"], "Right", true)}
              <Button
                type="button"
                variant={echo.phaseOf("Space") === "idle" ? "ghost" : "default"}
                size="sm"
                disabled={disabled || !keysSendable(["Space"], unsupportedKeys)}
                onClick={() => fire(["Space"], "Space")}
                className={cn(GRID_TAP_TARGET, "col-span-4 h-9 text-xs font-medium", echo.phaseOf("Space") === "idle" && "bg-muted")}
              >
                {echo.phaseOf("Space") === "done" ? <Check className="size-4" /> : "Space"}
              </Button>
              {SYMBOLS_L.map((sym) => navBtn(sym, [sym]))}
              {QUICK_COMBOS.map(comboBtn)}
              {SYMBOLS_TAIL.map((sym) => navBtn(sym, [sym]))}
            </div>
            <div className="grid grid-cols-4 content-start gap-x-1 gap-y-2" data-slot="key-lane-right">
              {digitBtn("7")}
              {digitBtn("8")}
              {digitBtn("9")}
              {navBtn("/", ["/"])}
              {digitBtn("4")}
              {digitBtn("5")}
              {digitBtn("6")}
              {navBtn("*", ["*"])}
              {digitBtn("1")}
              {digitBtn("2")}
              {digitBtn("3")}
              {navBtn("-", ["-"])}
              {digitBtn("0", "col-span-2")}
              {navBtn(".", ["."])}
              {navBtn("+", ["+"])}
              {SYMBOLS_R.map((sym) => navBtn(sym, [sym]))}
              {FN_KEYS.map((k) => navBtn(k, [k]))}
            </div>
          </div>
          </div>

          {/* Presets (collapsed by default; expanding keeps everything inline, never covering the
              mirror). On the immediate path a danger preset needs a second tap; while composing a
              tap just stages its chords for review. An operator's `keys.toml` rows arrive here as
              the same CtrlDef list, so a multi-chord row sends as one batch and an armed modifier
              stages it — no special-casing. */}
          <div>
            <button
              type="button"
              onClick={() => setCtrlOpen((o) => !o)}
              className="flex min-h-11 items-center gap-1 px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t("keys.presets.label")}
              <ChevronDown className={cn("size-3 transition-transform", ctrlOpen && "rotate-180")} />
            </button>
            {ctrlOpen && (
              <div className="mt-1 grid grid-cols-3 gap-1.5">
                {presets.map((item) => {
                  const isPending = pending === item.label;
                  const phase = echo.phaseOf(item.label);
                  // The armed two-tap confirm outranks the echo — it is the thing you must read.
                  const variant = isPending ? "destructive" : phase === "idle" ? "outline" : "default";
                  return (
                    <Button
                      key={item.label}
                      type="button"
                      variant={variant}
                      size="sm"
                      disabled={disabled || !keysSendable(item.keys, unsupportedKeys)}
                      onClick={() => pressCtrl(item)}
                      className={cn(
                        "min-h-11 text-sm font-medium",
                        item.danger && !isPending && phase === "idle" && "text-destructive",
                      )}
                    >
                      {isPending ? (
                        t("keys.confirm.label")
                      ) : phase === "done" ? (
                        <Check className="size-4" />
                      ) : (
                        item.label
                      )}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        </>
    </div>
  );
}
