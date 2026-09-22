import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowBigUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  Check,
  CornerDownLeft,
  Lock,
  Space,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Modifier } from "@/lib/key-queue";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useKeyQueue } from "@/hooks/use-key-queue";
import { useActionEcho } from "@/hooks/use-action-echo";
import { useHoldRepeat } from "@/hooks/use-hold-repeat";
import { KeyQueueStrip } from "@/components/key-queue-strip";
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
//
// The pad is a fixed 7-column, 2-row grid — row 1 is Esc/Tab/the three modifiers/Up/quick Ctrl+C,
// row 2 is a 4-wide Space then the inverted-T's Left-Down-Right (Down sits under Up, same column) —
// plus a 12px gap and a tall Enter set apart on its own column at the right edge, spanning both
// rows. Enter carries a low-opacity tint of the primary colour at rest, so it reads as the commit
// key even before it's pressed, and never sits beside the arrows: a miss on Enter confirms a
// prompt, a miss on an arrow is reversible (issue #263). Space, Shift, Tab, Enter and the arrows
// show icons; Esc, Ctrl, Alt and the quick Ctrl+C stay short text. Everything past that — the
// phone-dialer digits, the labelled Ctrl presets, F1–F12 — sits behind a row of small chips
// (123 / Presets / F keys) that opens at most one panel at a time directly under the chip row, so
// the tray's resting height never carries a drawer it doesn't need.

interface NavTrayProps {
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

/** Stable default so an omitted prop never re-renders the pad. */
const NO_REFUSED_KEYS: readonly string[] = [];

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

// F1–F12 — Herdr's send_keys grammar accepts them bare (HERDR_API.md), and harnesses bind them to
// real actions (tmux windows, CLI hotkeys, agent-extension views like pi's CE Workflow: F7 opens
// its orchestrator). Without buttons for them, a phone-only user has no route to any such keybind.
const FN_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];

/** The one panel the chip row can have open at a time — tapping the open chip closes it (accordion). */
type OpenPanel = "123" | "presets" | "fkeys" | null;

// Every plain-text key label (Esc, the quick ^C, a digit, an F key) goes through this rather than a
// bare string, so a long label or a narrow column ellipsizes instead of spilling into a neighbour —
// the fault "Ctrl C" shipped with on a 390px phone. `min-w-0` on the button (`navBtn`'s className) is
// what lets the button itself shrink small enough for this to ever engage.
function textLabel(s: string) {
  return <span className="truncate">{s}</span>;
}

export function NavTray({
  onSend,
  presets = CONTROL_PRESETS,
  onQueueChange,
  disabled,
  unsupportedKeys = NO_REFUSED_KEYS,
}: NavTrayProps) {
  useLocale();
  const [open, setOpen] = useState<OpenPanel>(null);
  const togglePanel = (panel: Exclude<OpenPanel, null>) =>
    setOpen((cur) => (cur === panel ? null : panel));
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
  //
  // `restingClassName` applies only while the button is neither held nor mid-echo (`resting`) — it's
  // for Enter's low-opacity tint, which must vanish the instant the button's own variant goes solid
  // (`bg-primary`) for a press or a ✓, never stack on top of it via a class-merge accident.
  const navBtn = (
    content: ReactNode,
    keys: string[],
    aria?: string,
    repeatable = false,
    extraClassName?: string,
    restingClassName?: string,
  ) => {
    const id = keys.join(" ");
    const phase = echo.phaseOf(id);
    const held = repeatable && repeat.holding === keys[0];
    const resting = !held && phase === "idle";
    const bind = repeatable ? repeat.bind(keys[0], () => fire(keys, id)) : undefined;
    // Greyed rather than removed: the pad's geometry IS its usability (Esc top-left, arrows as an
    // inverted-T), and pulling a key out of the grid would move every key after it. A dead button in
    // its own place is the lesser harm here — the opposite call from the action sheets, and for a
    // reason those sheets do not have.
    const refused = !keysSendable(keys, unsupportedKeys);
    return (
      <Button
        type="button"
        variant={held || phase !== "idle" ? "default" : "outline"}
        size="sm"
        disabled={disabled || refused}
        {...(bind ?? { onClick: () => fire(keys, id) })}
        aria-label={aria}
        // A hover title for the icon keys — an icon-only button gives a desktop pointer nothing to
        // read until it commits to a tap. Harmless on the text keys that also pass `aria`.
        title={aria}
        // touch-action/select-none: without them a held button on iOS starts a text selection and
        // Android may treat the hold as a scroll gesture, both of which cancel the pointer stream.
        // min-w-0/overflow-hidden: a grid item's default min-width is `auto` (its content's own
        // width), which can push a key wider than its column instead of letting it shrink — this is
        // what let "Ctrl C" spill past a 1/7 column on a 390px phone. `overflow-hidden` is the floor
        // under `truncate` on the label itself.
        className={cn(
          "h-9 min-w-0 overflow-hidden touch-manipulation select-none px-0 text-sm font-medium",
          extraClassName,
          resting && restingClassName,
        )}
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

  // A modifier button reads its own three-state mode from `mods`: outline when off, filled (default)
  // when armed — once OR locked — with a small Lock glyph beside the label to distinguish locked from
  // one-shot. Tapping cycles off → once → locked → off.
  const modBtn = (m: Modifier, label: ReactNode, aria?: string, extraClassName?: string) => {
    const mode = mods[m];
    return (
      <Button
        type="button"
        variant={mode === "off" ? "outline" : "default"}
        size="sm"
        disabled={disabled}
        onClick={() => arm(m)}
        aria-pressed={mode !== "off"}
        aria-label={aria}
        title={aria}
        className={cn("h-9 px-0 text-sm font-medium", extraClassName)}
      >
        {mode === "locked" && <Lock className="size-3" />}
        {label}
      </Button>
    );
  };

  // A chip in the accordion row: ghost when its panel is closed, secondary (and pressed) when open.
  // Tapping the already-open chip closes it — the accordion's one explicit way to collapse.
  const chip = (panel: Exclude<OpenPanel, null>, label: ReactNode) => (
    <button
      type="button"
      onClick={() => togglePanel(panel)}
      aria-pressed={open === panel}
      className={cn(
        "h-7 rounded-md px-2 text-[11px] font-medium uppercase tracking-wide transition-colors",
        open === panel
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-background/60",
      )}
    >
      {label}
    </button>
  );

  // Tap-target idiom (DESIGN.md §6, the same move as `STRIP_TAP_TARGET` in ui/labelled-strip.tsx): a
  // transparent `::before` extends a button's clickable box without adding drawn height. 2px top +
  // 2px bottom exactly fills this grid's 4px row gap (`gap-1`), so a normal key's extended hit area
  // meets its neighbour's at the gap's midpoint and never reaches into a sibling's own drawn box.
  // 36px drawn (`h-9`) + 2 + 2 = 40px, the tap floor — Enter needs none of this, its own row-span
  // already clears 40px on its own.
  const KEY_TAP_TARGET =
    "relative before:absolute before:inset-x-0 before:-inset-y-[2px] before:content-['']";
  const gridPos = (position: string) => cn(position, KEY_TAP_TARGET);

  return (
    <div className="space-y-0.5 border-t border-rule bg-muted/30 px-2 py-1.5">
      {/* Staging strip — visible only while composing (a modifier armed or keys queued). */}
      <KeyQueueStrip
        queue={queue}
        mods={activeMods}
        onRemove={removeAt}
        onClear={clear}
        onSend={sendQueue}
        onBaseChar={pushBase}
        disabled={disabled}
      />

      {/* Row 1: Esc, Tab, the three modifiers, Up, a quick Ctrl+C. Row 2: a 4-wide Space, then the
          inverted-T's Left-Down-Right (Down sits under Up, same column 6). A 12px empty column (a
          spacer, never a button) separates that 7-column block from Enter, which sits apart on its
          own column at the right edge and spans both rows.

          Enter never sits beside the arrows (issue #263): rapid arrow taps build a thumb habit
          around columns 5–7, and an arrow that lands wrong is reversible where an Enter that lands
          wrong confirms a prompt. Set apart and tinted (`bg-primary/15` at rest — see `navBtn`'s
          `restingClassName`), it reads as the commit key on sight, not just by position. */}
      <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_12px_1.5fr] grid-rows-[36px_36px] gap-1">
        {navBtn(textLabel("Esc"), ["Escape"], undefined, false, gridPos("col-start-1 row-start-1"))}
        {navBtn(
          <ArrowRightToLine className="size-4" aria-hidden="true" />,
          ["Tab"],
          "Tab",
          false,
          gridPos("col-start-2 row-start-1"),
        )}
        {modBtn(
          "shift",
          <ArrowBigUp className="size-4" aria-hidden="true" />,
          "Shift",
          gridPos("col-start-3 row-start-1"),
        )}
        {modBtn("ctrl", "Ctrl", undefined, gridPos("col-start-4 row-start-1"))}
        {modBtn("alt", "Alt", undefined, gridPos("col-start-5 row-start-1"))}
        {navBtn(
          <ArrowUp className="size-4" aria-hidden="true" />,
          ["Up"],
          "Up",
          true,
          gridPos("col-start-6 row-start-1"),
        )}
        {/* Visible label is "^C", not "Ctrl C" — "Ctrl C" is wider than a 1/7 column on a 390px
            phone and used to spill past its key. The chord it sends and its aria-label are
            unchanged: screen readers still hear "Ctrl+C". */}
        {navBtn(textLabel("^C"), ["ctrl+c"], "Ctrl+C", false, gridPos("col-start-7 row-start-1"))}

        {navBtn(
          <Space className="size-4" aria-hidden="true" />,
          ["Space"],
          "Space",
          false,
          gridPos("col-start-1 col-span-4 row-start-2"),
        )}
        {navBtn(
          <ArrowLeft className="size-4" aria-hidden="true" />,
          ["Left"],
          "Left",
          true,
          gridPos("col-start-5 row-start-2"),
        )}
        {navBtn(
          <ArrowDown className="size-4" aria-hidden="true" />,
          ["Down"],
          "Down",
          true,
          gridPos("col-start-6 row-start-2"),
        )}
        {navBtn(
          <ArrowRight className="size-4" aria-hidden="true" />,
          ["Right"],
          "Right",
          true,
          gridPos("col-start-7 row-start-2"),
        )}

        {navBtn(
          <span className="flex flex-col items-center gap-0.5">
            <CornerDownLeft className="size-4" aria-hidden="true" />
            <span className="text-[9px] font-sans font-medium uppercase tracking-wide opacity-75">
              Enter
            </span>
          </span>,
          ["Enter"],
          "Enter",
          false,
          // h-auto + self-stretch OVERRIDE the shared `h-9` every other key gets (twMerge drops
          // `h-9` because these are listed after it) — without this, `h-9` capped Enter to a single
          // 36px row despite `row-span-2`, and the grid's own explicit `grid-rows-[36px_36px]`
          // (above) is what gives that stretch a real 76px (36+4+36) to fill.
          "col-start-9 row-start-1 row-span-2 h-auto self-stretch flex-col gap-0.5",
          "bg-primary/15 border-primary/40",
        )}
      </div>

      {/* The accordion row: 123 / Presets / F keys. At most one panel open at a time, rendered
          directly below this row so the tray's default height never carries a drawer it doesn't
          need. */}
      <div className="flex items-center gap-1">
        {chip("123", "123")}
        {chip("presets", t("keys.presets.label"))}
        {chip("fkeys", t("keys.fkeys.label"))}
      </div>

      {open === "123" && (
        <div className="grid grid-cols-5 gap-1">{DIGITS.map((d) => navBtn(textLabel(d), [d]))}</div>
      )}

      {open === "presets" && (
        <div className="grid grid-cols-3 gap-1">
          {presets.map((item) => {
            const isPending = pending === item.label;
            const phase = echo.phaseOf(item.label);
            // The armed two-tap confirm outranks the echo — it's the thing you must read.
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
                  "h-9 text-sm font-medium",
                  item.danger && !isPending && phase === "idle" && "text-destructive",
                )}
              >
                {isPending ? t("keys.confirm.label") : phase === "done" ? <Check className="size-4" /> : item.label}
              </Button>
            );
          })}
        </div>
      )}

      {open === "fkeys" && (
        <div className="grid grid-cols-6 gap-1">{FN_KEYS.map((k) => navBtn(textLabel(k), [k]))}</div>
      )}
    </div>
  );
}
