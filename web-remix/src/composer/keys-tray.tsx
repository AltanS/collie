// The composer's Keys tray (ADR 0005), a port of web/src/components/nav-tray.tsx and
// key-queue-strip.tsx. It docks above the composer so you watch the menu update as you press.
// Keys follow Herdr's verified `pane.send_keys` grammar: special keys bare, chords joined with "+".
//
// Two modes, driven by `KeyQueue` (lib/keys-tray.ts). Idle, a press fires at once. Arm a modifier
// (Shift, Ctrl, Alt: each cycles off, once, locked, off) or queue a key, and the tray composes:
// presses stage a visible queue (the strip) that you review and Send as ONE call.
//
// An immediate press echoes on its own key: accent fill the instant you tap, a check once the bridge
// accepts it. A staged press needs no echo: the chip appearing is the receipt. No sibling dimming:
// this is a keypad you drum on, and dimming eight keys per arrow press would strobe.
//
// The pad is a fixed 7-column, 2-row grid. Row 1: Esc, Tab, the three modifiers, Up, a quick Ctrl+C.
// Row 2: a 4-wide Space, then Left, Down, Right (Down under Up). A 12px gap and a tall Enter, set
// apart on its own column at the right edge, spanning both rows: a miss on Enter confirms a prompt,
// a miss on an arrow is reversible (issue #263). Everything past that, the digits, the labelled Ctrl
// presets and F1 to F12, sits behind three chips that open at most one panel at a time.
//
// Remix rules met here: state objects live in setup and wake the tray through `scheduleUpdate`
// (rule 1); props are read from `handle.props` at call time (rule 2); every timer ends on
// `handle.signal` (rule 5); the staging strip, its modifier row and each panel come and go through
// `Collapse` (rule 7).
import { on, type Handle, type RemixNode } from "remix/component";
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
  X,
} from "lucide";

import { t } from "@web/lib/i18n";
import { isDangerKey, keyLabel, modifierLabel } from "@web/lib/key-queue";
import { keysSendable } from "@web/lib/mux-capability";
import type { CtrlDef } from "@web/lib/operator-keys";
import { cn } from "@web/lib/utils";

import { useLocale } from "../lib/i18n-store";
import {
  KeyQueue,
  createActionEcho,
  createHoldRepeat,
  createPendingConfirm,
  pressPreset,
  realTimers,
  takeForSend,
  type Modifier,
} from "../lib/keys-tray";
import { buzz } from "../lib/prefs";
import { scheduleUpdate } from "../lib/store";
import { Button } from "../ui/button";
import { Collapse } from "../ui/collapse";
import { Icon } from "../ui/icon";

export interface KeysTrayProps {
  /** Resolves true when the bridge accepted the keys: drives the check on the pressed key. */
  onSend: (keys: string[]) => Promise<boolean>;
  /**
   * The labelled chords under "Presets": the operator's own `keys.toml` rows when any address this
   * pane, else the shipped six (`ctrlPresetsFor`). Only this list is configurable.
   */
  presets: readonly CtrlDef[];
  disabled: boolean;
  /** Neutral key spellings this multiplexer refuses. A key whose chord uses one is greyed, in place. */
  unsupportedKeys: readonly string[];
  /** How many keys are staged, so the composer can guard closing the dock on a composed sequence.
   *  Reports 0 when the tray leaves. Called from handlers and timers: route it to `scheduleUpdate`. */
  onQueueChange?: (staged: number) => void;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
// F1 to F12: Herdr's grammar takes them bare, and harnesses bind them to real actions (tmux windows,
// CLI hotkeys, agent views). Without buttons a phone-only user has no route to any such keybind.
const FN_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];

/** The one panel the chip row can have open at a time. Tapping the open chip closes it. */
type OpenPanel = "123" | "presets" | "fkeys" | null;

// A plain-text label goes through this so a long label or a narrow column ellipsizes instead of
// spilling into a neighbour (the fault "Ctrl C" shipped with on a 390 px phone).
const textLabel = (s: string): RemixNode => <span class="truncate">{s}</span>;

// Tap-target idiom (DESIGN.md §6): a transparent `::before` extends a key's hit box without drawing
// height. 2 px top and bottom exactly fills the grid's 4 px row gap, so extended boxes meet at the
// gap's midpoint and never reach into a neighbour's drawn box. 36 + 2 + 2 = 40 px, the tap floor.
const KEY_TAP_TARGET = "relative before:absolute before:inset-x-0 before:-inset-y-[2px] before:content-['']";
const gridPos = (position: string): string => cn(position, KEY_TAP_TARGET);

export function KeysTray(handle: Handle<KeysTrayProps>) {
  useLocale(handle);
  const wake = (): void => scheduleUpdate(handle);

  let open: OpenPanel = null;
  let reported = 0;
  const report = (): void => {
    const staged = queue.queue.length;
    if (staged === reported) return;
    reported = staged;
    handle.props.onQueueChange?.(staged);
  };

  const queue = new KeyQueue(() => {
    report();
    wake();
  });
  const confirm = createPendingConfirm(realTimers, wake);
  const echo = createActionEcho(realTimers, wake, { onPress: () => buzz() });
  // Hold-to-repeat is a WHITELIST: only the arrows opt in (`repeatable` below). Enter, Esc, Space,
  // digits and presets must never repeat, and the danger presets' two-tap lives on another path.
  // Off while composing: a hold must never stage fifteen identical chips into a queue whose value
  // is that you can review it before it goes on the wire.
  const repeat = createHoldRepeat((keys) => handle.props.onSend(keys), realTimers, {
    enabled: () => !handle.props.disabled && !queue.composing,
    onChange: wake,
    onEngage: () => buzz(),
  });

  handle.signal.addEventListener(
    "abort",
    () => {
      echo.dispose();
      confirm.dispose();
      repeat.dispose();
      // The tray leaving is what discards the queue: a stale count must not outlive it and arm a
      // phantom confirm in the composer.
      if (reported !== 0) handle.props.onQueueChange?.(0);
    },
    { once: true },
  );

  // A send that fails reports its own error (the composer's status line). A rejection here would be
  // swallowed by the runtime, so catch it.
  const sendNow = (keys: string[]): Promise<boolean> =>
    Promise.resolve(handle.props.onSend(keys)).catch(() => false);

  // Route a press through the queue. Only the immediate path echoes.
  const fire = (keys: readonly string[], id: string): void => {
    if (handle.props.disabled) return;
    const r = queue.press(keys);
    if (r.mode === "fire") void echo.run(id, () => sendNow(r.keys));
  };

  const pressCtrl = (item: CtrlDef): void => {
    if (handle.props.disabled) return;
    const r = pressPreset(queue, confirm, item);
    if (r.mode === "fire") void echo.run(item.label, () => sendNow(r.keys));
  };

  // The whole queue as one ordered call. No echo on the strip's Send: `take()` empties the queue
  // at once, so the chips leaving IS the receipt (lib/ack-manifest.ts quotes this sentence).
  const sendQueue = (): void => {
    if (handle.props.disabled) return;
    const keys = takeForSend(queue, confirm);
    if (keys.length > 0) void sendNow(keys);
  };

  const togglePanel = (panel: Exclude<OpenPanel, null>): void => {
    open = open === panel ? null : panel;
    wake();
  };

  // ── One key ────────────────────────────────────────────────────────────────────────────────────

  // A key button, echoing its own press. `pending` fills it the instant you tap (no network wait),
  // `done` swaps a check in for ECHO_DONE_MS. Keyed by the wire string, so the same key twice in a
  // row restarts its own cycle. While held, a live "xN" replaces the echo: a per-tick echo would
  // restart the check about eleven times a second and strobe.
  const navBtn = (
    content: RemixNode,
    keys: readonly string[],
    options: { aria?: string; repeatable?: boolean; className?: string; resting?: string } = {},
  ): RemixNode => {
    const { aria, repeatable = false, className, resting: restingClass } = options;
    const wire = keys[0] ?? "";
    const id = keys.join(" ");
    const phase = echo.phaseOf(id);
    const held = repeatable && repeat.holding === wire;
    const resting = !held && phase === "idle";
    // Greyed, not removed: the pad's geometry IS its usability, and pulling a key out of the grid
    // would move every key after it.
    const refused = !keysSendable(keys, handle.props.unsupportedKeys);
    const mix = repeatable
      ? [
          on<HTMLButtonElement, "pointerdown">("pointerdown", (event) => {
            if (handle.props.disabled || queue.composing) return;
            // Capture, so a thumb sliding off the key still delivers its pointerup here: an
            // uncaptured pointer that leaves strands the timers (the dead-man is the real backstop).
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // best effort
            }
            repeat.pointerDown(wire);
          }),
          on<HTMLButtonElement, "pointerup">("pointerup", () => repeat.pointerUp()),
          on<HTMLButtonElement, "pointercancel">("pointercancel", () => repeat.pointerCancel()),
          // iOS raises a selection callout over a held button without this.
          on<HTMLButtonElement, "contextmenu">("contextmenu", (event) => event.preventDefault()),
          on<HTMLButtonElement, "click">("click", (event) => {
            // A hold already sent everything through the pump; the release's click must not add one.
            if (repeat.consumeClick()) {
              event.preventDefault();
              return;
            }
            fire(keys, id);
          }),
        ]
      : on<HTMLButtonElement, "click">("click", () => fire(keys, id));
    return (
      <Button
        key={id}
        variant={held || phase !== "idle" ? "default" : "outline"}
        size="sm"
        disabled={handle.props.disabled || refused}
        data-testid={`key-${wire}`}
        aria-label={aria}
        // An icon-only key gives a desktop pointer nothing to read until it commits to a tap.
        title={aria}
        mix={mix}
        // touch-action and select-none: without them a held key on iOS starts a text selection and
        // Android may read the hold as a scroll, both of which cancel the pointer stream. min-w-0 and
        // overflow-hidden: a grid item's min-width is its content, which would let a key spill past
        // its column; `truncate` on the label is the other half.
        class={cn(
          "h-9 min-w-0 overflow-hidden touch-manipulation select-none px-0 text-sm font-medium",
          className,
          resting && restingClass,
        )}
      >
        {held ? (
          <span class="mx-auto flex items-center gap-1">
            {content}
            {repeat.count > 1 ? <span class="text-xs tabular-nums">×{repeat.count}</span> : null}
          </span>
        ) : phase === "done" ? (
          <Icon icon={Check} class="mx-auto size-4" />
        ) : (
          content
        )}
      </Button>
    );
  };

  // A modifier reads its own three-state mode: outline when off, filled when armed (once OR locked),
  // with a small lock beside the label to tell locked from one-shot.
  const modBtn = (m: Modifier, label: RemixNode, aria: string | undefined, className: string): RemixNode => {
    const mode = queue.mods[m];
    return (
      <Button
        key={m}
        variant={mode === "off" ? "outline" : "default"}
        size="sm"
        disabled={handle.props.disabled}
        data-testid={`key-mod-${m}`}
        data-mode={mode}
        aria-pressed={mode !== "off"}
        aria-label={aria}
        title={aria}
        mix={on("click", () => queue.arm(m))}
        class={cn("h-9 px-0 text-sm font-medium", className)}
      >
        {mode === "locked" ? <Icon icon={Lock} class="size-3" /> : null}
        {label}
      </Button>
    );
  };

  const chip = (panel: Exclude<OpenPanel, null>, label: string): RemixNode => (
    <button
      type="button"
      data-testid={`keys-panel-${panel}`}
      aria-pressed={open === panel}
      mix={on("click", () => togglePanel(panel))}
      class={cn(
        "h-7 rounded-md px-2 text-[11px] font-medium uppercase tracking-wide transition-colors",
        open === panel ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-background/60",
      )}
    >
      {label}
    </button>
  );

  // ── The staging strip ──────────────────────────────────────────────────────────────────────────

  // Chips for the queued keys (tap to drop one), a ghost chip plus a one-char input while a modifier
  // is armed, and an explicit Send. The ghost and the input sit in their own `Collapse` row.
  const strip = (): RemixNode => {
    const staged = queue.queue;
    const mods = queue.activeMods;
    const danger = staged.some(isDangerKey);
    const disabled = handle.props.disabled;
    return (
      <div class="pb-0.5">
        <div data-testid="key-queue" class="rounded-lg border border-border/60 bg-background/60 p-1.5">
          <div class="flex flex-wrap items-center gap-1.5">
            {staged.map((key, i) => {
              const label = keyLabel(key);
              return (
                <button
                  key={`${key}-${String(i)}`}
                  type="button"
                  data-testid="key-queue-chip"
                  aria-label={t("keys.queue.removeAria", { label })}
                  mix={on("click", () => queue.removeAt(i))}
                  class={cn(
                    "inline-flex h-8 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 text-xs font-medium",
                    isDangerKey(key) && "border-destructive/40 text-destructive",
                  )}
                >
                  <span>{label}</span>
                  <Icon icon={X} class="size-3 opacity-60" />
                </button>
              );
            })}
            <div class="ml-auto flex items-center gap-1">
              <Button
                variant={danger ? "destructive" : "default"}
                size="sm"
                class="h-8"
                data-testid="key-queue-send"
                disabled={disabled || staged.length === 0}
                mix={on("click", sendQueue)}
              >
                {t("keys.queue.send")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="size-8 text-muted-foreground"
                data-testid="key-queue-clear"
                disabled={disabled}
                aria-label={t("keys.queue.clearAria")}
                mix={on("click", () => queue.clear())}
              >
                <Icon icon={X} class="size-4" />
              </Button>
            </div>
          </div>
          {/* Modifiers armed, no base yet: the awaited chord (e.g. "Ctrl ⇧ + …") and the one-char
              key input. The input stays uncontrolled: it is emptied after each stage, and the model
              takes the last printable char typed. */}
          <Collapse open={mods.length > 0}>
            <div class="flex items-center gap-1.5 pt-1.5">
              <span class="inline-flex h-8 items-center rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground">
                {mods.map(modifierLabel).join(" ")} + …
              </span>
              <input
                type="text"
                inputMode="text"
                autocomplete="off"
                autoCapitalize="none"
                autocorrect="off"
                spellcheck={false}
                placeholder={t("keys.queue.charPlaceholder")}
                aria-label={t("keys.queue.charAria")}
                data-testid="key-queue-char"
                disabled={disabled}
                mix={on("input", (event) => {
                  queue.pushBase(event.currentTarget.value);
                  event.currentTarget.value = "";
                })}
                class="h-8 w-14 rounded-md border border-input bg-transparent px-2 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              />
            </div>
          </Collapse>
        </div>
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────────────────────────

  return () => {
    const { presets, unsupportedKeys, disabled } = handle.props;
    return (
      <div data-testid="keys-tray" class="border-t border-rule bg-muted/30 px-2 py-1.5">
        {/* Visible only while composing (a modifier armed or keys queued). */}
        <Collapse open={queue.composing}>{strip()}</Collapse>

        <div class="grid grid-cols-[repeat(7,minmax(0,1fr))_12px_1.5fr] grid-rows-[36px_36px] gap-1">
          {navBtn(textLabel("Esc"), ["Escape"], { className: gridPos("col-start-1 row-start-1") })}
          {navBtn(<Icon icon={ArrowRightToLine} class="size-4" />, ["Tab"], {
            aria: "Tab",
            className: gridPos("col-start-2 row-start-1"),
          })}
          {modBtn("shift", <Icon icon={ArrowBigUp} class="size-4" />, "Shift", gridPos("col-start-3 row-start-1"))}
          {modBtn("ctrl", "Ctrl", undefined, gridPos("col-start-4 row-start-1"))}
          {modBtn("alt", "Alt", undefined, gridPos("col-start-5 row-start-1"))}
          {navBtn(<Icon icon={ArrowUp} class="size-4" />, ["Up"], {
            aria: "Up",
            repeatable: true,
            className: gridPos("col-start-6 row-start-1"),
          })}
          {/* The visible label is "^C", not "Ctrl C": the long form is wider than a 1/7 column on a
              390 px phone. The chord and the aria-label are unchanged. */}
          {navBtn(textLabel("^C"), ["ctrl+c"], { aria: "Ctrl+C", className: gridPos("col-start-7 row-start-1") })}

          {navBtn(<Icon icon={Space} class="size-4" />, ["Space"], {
            aria: "Space",
            className: gridPos("col-start-1 col-span-4 row-start-2"),
          })}
          {navBtn(<Icon icon={ArrowLeft} class="size-4" />, ["Left"], {
            aria: "Left",
            repeatable: true,
            className: gridPos("col-start-5 row-start-2"),
          })}
          {navBtn(<Icon icon={ArrowDown} class="size-4" />, ["Down"], {
            aria: "Down",
            repeatable: true,
            className: gridPos("col-start-6 row-start-2"),
          })}
          {navBtn(<Icon icon={ArrowRight} class="size-4" />, ["Right"], {
            aria: "Right",
            repeatable: true,
            className: gridPos("col-start-7 row-start-2"),
          })}

          {navBtn(
            <span class="flex flex-col items-center gap-0.5">
              <Icon icon={CornerDownLeft} class="size-4" />
              <span class="text-[9px] font-sans font-medium uppercase tracking-wide opacity-75">Enter</span>
            </span>,
            ["Enter"],
            {
              aria: "Enter",
              // h-auto and self-stretch override the shared `h-9` (twMerge keeps the later class):
              // the grid's explicit 36px rows give the stretch a real 76px (36+4+36) to fill. The
              // resting tint vanishes the instant the key goes solid for a press or a check.
              className: "col-start-9 row-start-1 row-span-2 h-auto self-stretch flex-col gap-0.5",
              resting: "bg-primary/15 border-primary/40",
            },
          )}
        </div>

        {/* The accordion row: 123, Presets, F keys. At most one panel open, directly under it. */}
        <div class="flex items-center gap-1 pt-0.5">
          {chip("123", "123")}
          {chip("presets", t("keys.presets.label"))}
          {chip("fkeys", t("keys.fkeys.label"))}
        </div>

        <Collapse open={open === "123"}>
          <div class="grid grid-cols-5 gap-1 pt-0.5">{DIGITS.map((d) => navBtn(textLabel(d), [d]))}</div>
        </Collapse>

        <Collapse open={open === "presets"}>
          <div class="grid grid-cols-3 gap-1 pt-0.5">
            {presets.map((item) => {
              const isPending = confirm.pending === item.label;
              const phase = echo.phaseOf(item.label);
              // The armed two-tap confirm outranks the echo: it is the thing you must read.
              const variant = isPending ? "destructive" : phase === "idle" ? "outline" : "default";
              return (
                <Button
                  key={item.label}
                  variant={variant}
                  size="sm"
                  data-testid={`preset-${item.label}`}
                  disabled={disabled || !keysSendable(item.keys, unsupportedKeys)}
                  mix={on("click", () => pressCtrl(item))}
                  class={cn(
                    "h-9 text-sm font-medium",
                    item.danger === true && !isPending && phase === "idle" && "text-destructive",
                  )}
                >
                  {isPending ? (
                    t("keys.confirm.label")
                  ) : phase === "done" ? (
                    <Icon icon={Check} class="size-4" />
                  ) : (
                    item.label
                  )}
                </Button>
              );
            })}
          </div>
        </Collapse>

        <Collapse open={open === "fkeys"}>
          <div class="grid grid-cols-6 gap-1 pt-0.5">{FN_KEYS.map((k) => navBtn(textLabel(k), [k]))}</div>
        </Collapse>
      </div>
    );
  };
}
