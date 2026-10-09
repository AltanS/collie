import { Fragment, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
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
import {
  areaCss,
  BOARD_COLS,
  DEFAULT_BOARD,
  keyLabel,
  needsSecondTap,
  stepsWords,
  usedRows,
  type BoardKey,
  type ChordKey,
  type KeyBoard,
  type ModKey,
} from "@/lib/key-board";

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
// The pad is the KEY BOARD (lib/key-board.ts, ADR 0092): a grid of 7 columns where a key is anchored
// at one cell and spans 1 to 3 columns and 1 or 2 rows, placed by CSS grid (`grid-column: n / span w`)
// so the editor sheet draws the same board. The shipped board, the Default, is the old pad: row 1 is
// Esc/Tab/the three modifiers/Up/quick Ctrl+C, row 2 is Enter, a Space three cells wide, then the
// inverted-T's Left-Down-Right (Down under Up). Enter keeps its distance from the arrows: a miss on
// Enter confirms a prompt, a miss on an arrow is reversible (issue #263), and it carries a
// low-opacity tint of the primary colour at rest so it reads as the commit key before it is pressed.
// A free cell draws nothing but keeps its place, and trailing free rows are not drawn. Space, Shift,
// Tab, Enter and the arrows show icons; every other key shows its face or its own name. Everything
// past the board — the phone-dialer digits, the labelled Ctrl presets, F1–F12 — sits behind a row of
// small chips (123 / Presets / F keys) that opens at most one panel at a time directly under the chip
// row, so the tray's resting height never carries a drawer it doesn't need.
//
// A board key reaches the pane through the SAME `onSend` the fixed keys always used. A chord key with
// several steps hands them over as one ordered array, so a sequence is one call. A key with a step
// that can stop a program (`needsSecondTap`) asks a second tap on the immediate path, like the Ctrl D
// and Ctrl Z presets; while composing, the strip's Send is the review.

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
  /** The key board. Defaults to the shipped one, so a test or a playground needs no store. */
  board?: KeyBoard;
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

// The icon a default-faced key wears, keyed by its step. Everything else shows its text face.
const FACE_ICON = new Map<string, LucideIcon>([
  ["Tab", ArrowRightToLine],
  ["Space", Space],
  ["Enter", CornerDownLeft],
  ["Up", ArrowUp],
  ["Down", ArrowDown],
  ["Left", ArrowLeft],
  ["Right", ArrowRight],
]);

// Hold-to-repeat, WHITELISTED to the arrows (see navBtn). A whitelist rather than a blacklist: Enter,
// Esc, Space, digits and every custom chord structurally must not repeat.
const REPEATS: ReadonlySet<string> = new Set(["Up", "Down", "Left", "Right"]);

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

// A key wider or taller than a cell sits on the grid by its anchor and spans its area, so the dock
// and the editor draw the same board. A two-row key has no fixed 36px to stand on (`h-9` is a
// single row's height), so it stretches to the rows it spans.
const tall = (key: BoardKey) => (key.h === 2 ? "h-auto self-stretch" : undefined);

export function NavTray({
  onSend,
  presets = CONTROL_PRESETS,
  onQueueChange,
  board = DEFAULT_BOARD,
  disabled,
  unsupportedKeys = NO_REFUSED_KEYS,
}: NavTrayProps) {
  useLocale();
  const [open, setOpen] = useState<OpenPanel>(null);
  const togglePanel = (panel: Exclude<OpenPanel, null>) =>
    setOpen((cur) => (cur === panel ? null : panel));
  const { queue, mods, activeMods, composing, arm, press, pushBase, removeAt, clear, take, releaseAbsent } =
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

  // A modifier key that leaves the board (the person removed it in the editor, or a preset replaced
  // the pad) takes its armed state with it.
  useEffect(() => {
    releaseAbsent(board.cells.flatMap((k) => (k?.kind === "mod" ? [k.mod] : [])));
  }, [board, releaseAbsent]);

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
    needsConfirm = false,
    style?: CSSProperties,
  ) => {
    const id = keys.join(" ");
    // A key with a step that can stop a program asks a second tap, but only on the immediate path.
    // While composing, the strip's Send is the review (the same split the Ctrl presets make).
    const armed = needsConfirm && pending === id;
    const tap = () => {
      if (needsConfirm && !composing && !confirm(id)) return; // first tap arms the confirm
      fire(keys, id);
    };
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
        variant={armed ? "destructive" : held || phase !== "idle" ? "default" : "outline"}
        size="sm"
        disabled={disabled || refused}
        style={style}
        {...(bind ?? { onClick: tap })}
        aria-label={armed && aria !== undefined ? t("keys.pad.tapAgain", { key: aria }) : aria}
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
        ) : phase === "done" && !armed ? (
          <Check className="mx-auto size-4" />
        ) : armed ? (
          <span className="truncate text-xs">{t("keys.confirm.short")}</span>
        ) : (
          content
        )}
      </Button>
    );
  };

  // A modifier button reads its own three-state mode from `mods`: outline when off, filled (default)
  // when armed — once OR locked — with a small Lock glyph beside the label to distinguish locked from
  // one-shot. Tapping cycles off → once → locked → off.
  const modBtn = (m: Modifier, label: ReactNode, aria?: string, extraClassName?: string, style?: CSSProperties) => {
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
        style={style}
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

  // The board's keys. A cell is a seventh of a phone wide, so every key gets `min-w-0` and the
  // KEY_TAP_TARGET reach, exactly as the fixed pad's keys had.
  const rows = usedRows(board);

  const modKeyBtn = (key: ModKey, cell: number) => {
    const word = key.mod === "shift" ? "Shift" : key.mod === "ctrl" ? "Ctrl" : "Alt";
    return (
      <Fragment key={cell}>
        {modBtn(
          key.mod,
          key.mod === "shift" ? <ArrowBigUp className="size-4" aria-hidden="true" /> : word,
          word,
          cn("w-full min-w-0", KEY_TAP_TARGET, tall(key)),
          areaCss(cell, key),
        )}
      </Fragment>
    );
  };

  const chordKeyBtn = (key: ChordKey, cell: number) => {
    const only = key.steps.length === 1 ? key.steps[0] : undefined;
    const words = stepsWords(key.steps, t("keys.pad.then"));
    const aria = key.label === undefined ? words : t("keys.pad.sends", { label: key.label, keys: words });
    // An icon stands for a key that wears its own default face. A key the person named shows the name.
    const Icon = key.label === undefined && only !== undefined ? FACE_ICON.get(only) : undefined;
    const content =
      Icon !== undefined ? <Icon className="size-4" aria-hidden="true" /> : textLabel(keyLabel(key));
    const isEnter = only === "Enter";
    return (
      <Fragment key={cell}>
        {navBtn(
          content,
          [...key.steps],
          aria,
          only !== undefined && REPEATS.has(only),
          cn("w-full", KEY_TAP_TARGET, tall(key)),
          isEnter ? "bg-primary/15 border-primary/40" : undefined,
          needsSecondTap(key),
          areaCss(cell, key),
        )}
      </Fragment>
    );
  };

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

      {/* The board: 7 columns, one 36px row per used row. Every key is placed by its anchor and spans
          its width and height; an empty cell draws nothing, so every key keeps its place. */}
      <div
        className="grid grid-cols-7 gap-1"
        style={{ gridTemplateRows: `repeat(${rows}, 36px)` }}
      >
        {board.cells.slice(0, rows * BOARD_COLS).map((key, i) =>
          key === null ? null : key.kind === "mod" ? modKeyBtn(key, i) : chordKeyBtn(key, i),
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
