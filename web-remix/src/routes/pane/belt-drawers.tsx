// The belt's drawers: the shared dock chrome, the Quick tray, and the Display dock. Ports of the
// ComposerDock in web/src/components/composer.tsx, quick-actions.tsx and display-prefs.tsx.
//
// The belt only SAYS which drawer is open (`on` and `expanded` on its pills); the caller owns that
// state and mounts the drawer here, in `Collapse` for an in-flow dock, in a `BottomSheet` for Display.
// These components hold no drawer state of their own except what is local to their own rows.
//
// NONE OF THESE WRITES A PANE. QuickTray hands text to `onSend` and shows a check when it resolves;
// the caller owns the send path (writeRefusal, bridgeWrite, noteSend). DisplayDock writes device
// prefs only (`displayPrefs`, `dashPrefs`), which a read-only device may change: they are local view
// state, and the pane's mirror must stay readable there.
import { on, type Handle, type RemixNode } from "remix/component";
import { AArrowDown, AArrowUp, Check, LoaderCircle, X } from "lucide";

import { quickRepliesFor } from "@web/lib/quick-replies";
import { t } from "@web/lib/i18n";
import type { PaneView } from "@web/lib/pane-view";
import { cn } from "@web/lib/utils";

import { HostChip } from "../../chips/host-chip";
import { config } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { createActionEcho, ECHO_DONE_MS, realTimers } from "../../lib/keys-tray";
import { buzz, dashPrefs, displayPrefs, setDashPref, type DisplayPrefs } from "../../lib/prefs";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { CollapseSwap } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { SectionLabel } from "../../ui/section-label";
import { Segmented } from "../../ui/segmented";
import { Switch } from "../../ui/switch";

// ── ComposerDock: the shared drawer chrome ────────────────────────────────────────────────────────

export interface ComposerDockProps {
  /** ALREADY TRANSLATED. Names the drawer, and the close button's accessible name. */
  title: string;
  onClose: () => void;
  children?: RemixNode;
  testId?: string;
  /** The machine a key sent from this dock lands on. Draws nothing on a single-host install. */
  host?: string;
}

/** An in-flow dock above the belt: a title row with a close X, and a body that scrolls past 45dvh.
 *  The caller mounts it in `Collapse`, so it opens and leaves by the one sanctioned motion. */
export function ComposerDock(handle: Handle<ComposerDockProps>) {
  useLocale(handle);
  return () => {
    const { title, children, testId, host } = handle.props;
    return (
      <div data-testid={testId} class="-mx-3 mb-2 flex flex-col border-t border-border bg-background">
        <div class="flex items-center justify-between px-3 pt-2">
          <div class="flex min-w-0 items-center gap-2">
            <SectionLabel>{title}</SectionLabel>
            {/* A key press from the Keys dock IS a write into a terminal: the dock names which one. */}
            <HostChip host={host} variant="target" />
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="size-7 text-muted-foreground"
            aria-label={t("composer.dock.closeAria", { title })}
            mix={on("click", () => handle.props.onClose())}
          >
            <Icon icon={X} class="size-4" />
          </Button>
        </div>
        <div class="max-h-[45dvh] min-h-0 overflow-y-auto">{children}</div>
      </div>
    );
  };
}

// ── QuickTray ─────────────────────────────────────────────────────────────────────────────────────

export interface QuickTrayProps {
  /** The pane's agent, which picks the reply set (web's lib/quick-replies). */
  agent: string | undefined;
  /** A shell gets y/n, not "skip". */
  isShell: boolean;
  disabled: boolean;
  /** Types one reply and submits it. Resolve `false` for a refused send: the tray then stays open with
   *  every button live again. A caller returning nothing gets the check and the close on every tap. */
  onSend: (text: string) => void | boolean | Promise<boolean | void>;
  onClose: () => void;
}

/** `quickRepliesFor`'s group titles are catalog identifiers, not display text: translate them here.
 *  An id this build does not know prints as it stands. */
export function groupTitle(title: string): string {
  if (title === "confirm") return t("quickActions.group.confirm");
  if (title === "common") return t("quickActions.group.common");
  return title;
}

/**
 * The Quick body: the one-tap reply grids, no chrome of its own. It stays up THROUGH the send. The
 * tapped button owns its feedback (spinner, then the check, siblings dimmed), and the tray closes
 * after the check so the operator sees where the tap went. A failed send leaves it open to retry.
 */
export function QuickTray(handle: Handle<QuickTrayProps>) {
  useLocale(handle);
  const cfg = useStore(handle, config);
  const echo = createActionEcho(realTimers, () => scheduleUpdate(handle), { onPress: () => buzz() });
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  handle.signal.addEventListener(
    "abort",
    () => {
      echo.dispose();
      clearTimeout(closeTimer);
    },
    { once: true },
  );

  const groupsNow = () => quickRepliesFor(handle.props.agent, handle.props.isShell, cfg().data?.operatorQuickReplies ?? []);
  const anyPending = (): boolean => groupsNow().some((g) => g.items.some((item) => echo.phaseOf(item) === "pending"));

  const fire = (text: string): void => {
    if (handle.props.disabled || anyPending()) return;
    void echo.run(text, async () => {
      const ok = (await handle.props.onSend(text)) !== false;
      if (handle.signal.aborted) return ok;
      // Let the check land before the tray goes. On failure it stays: the status line carries the
      // reason and the operator is one tap from trying again.
      if (ok) closeTimer = setTimeout(() => handle.props.onClose(), ECHO_DONE_MS);
      return ok;
    });
  };

  return () => {
    const { disabled } = handle.props;
    const busy = anyPending();
    return (
      <div data-testid="quick-tray" class="space-y-4 border-t border-rule bg-muted/30 px-3 py-2.5">
        {groupsNow().map((group) => (
          <div key={group.title}>
            <p class="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{groupTitle(group.title)}</p>
            <div class="grid grid-cols-2 gap-2">
              {group.items.map((text) => {
                const phase = echo.phaseOf(text);
                return (
                  <Button
                    key={text}
                    // The tapped reply goes accent and stays undimmed under `disabled`, so it reads
                    // over its dimmed siblings: the busy language the dialog option rows use.
                    variant={phase === "idle" ? "outline" : "default"}
                    disabled={disabled || busy}
                    mix={on("click", () => fire(text))}
                    // A phrase may be longer than half a phone, so it WRAPS, balanced, on the fixed 48px
                    // the row already has. The height stays fixed, so a long phrase never makes one row
                    // taller than the next.
                    class={cn(
                      "h-12 gap-1.5 whitespace-normal px-2 py-1 text-sm font-medium leading-tight text-balance",
                      phase !== "idle" && "disabled:opacity-100",
                    )}
                  >
                    {phase === "pending" ? <Icon icon={LoaderCircle} class="size-4 animate-spin" /> : null}
                    {phase === "done" ? <Icon icon={Check} class="size-4" /> : null}
                    {text}
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };
}

// ── DisplayDock ───────────────────────────────────────────────────────────────────────────────────

// web/src/hooks/use-display-prefs.ts holds these ranges; that module imports React, so they are copied.
export const MIRROR_FONT = { min: 9, max: 16 } as const;
export const CHAT_FONT = { min: 12, max: 20 } as const;

/** One stepper press: `size + delta`, rounded and held inside the range (web's `clampFont`). */
export function stepSize(size: number, delta: number, range: { min: number; max: number }): number {
  return Math.max(range.min, Math.min(range.max, Math.round(size + delta)));
}

/** web/src/hooks/use-dash-prefs.ts BELT_SCALES, copied for the same reason: Default, Large, Larger. */
export const BELT_SCALES = [1.15, 1.3, 1.5] as const;
export type BeltScale = (typeof BELT_SCALES)[number];

/** A value the segmented control handed back, as one of the three sizes the belt was measured at. */
export function asBeltScale(value: string | number): BeltScale {
  return BELT_SCALES.find((scale) => scale === value) ?? BELT_SCALES[0];
}

const BELT_SCALE_LABELS = {
  1.15: "settings.beltSize.option.default",
  1.3: "settings.beltSize.option.large",
  1.5: "settings.beltSize.option.larger",
} as const;

interface RowProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  control: RemixNode;
}

/** One settings row: the name (and a sentence where it is not self-evident) left, the control right. */
function Row(handle: Handle<RowProps>) {
  return () => {
    const { label, hint, htmlFor, control } = handle.props;
    return (
      <div class="flex items-center justify-between gap-3 py-1.5">
        <div class="min-w-0">
          <label for={htmlFor} class="block text-sm font-medium">
            {label}
          </label>
          {hint === undefined ? null : <p class="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</p>}
        </div>
        <div class="shrink-0">{control}</div>
      </div>
    );
  };
}

interface TextSizeProps {
  size: number;
  range: { min: number; max: number };
  onStep: (delta: number) => void;
}

/** A minus, the number and a plus. The mirror and the stream each want one and differ only in which
 *  number they step and where it stops. */
function TextSizeRow(handle: Handle<TextSizeProps>) {
  return () => {
    const { size, range } = handle.props;
    return (
      <Row
        label={t("settings.display.textSize.label")}
        control={
          <div class="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              class="size-9"
              disabled={size <= range.min}
              aria-label={t("settings.display.textSize.decrease")}
              mix={on("click", () => handle.props.onStep(-1))}
            >
              <Icon icon={AArrowDown} class="size-4" />
            </Button>
            <span class="w-8 text-center text-xs tabular-nums text-muted-foreground">{size}</span>
            <Button
              variant="outline"
              size="icon"
              class="size-9"
              disabled={size >= range.max}
              aria-label={t("settings.display.textSize.increase")}
              mix={on("click", () => handle.props.onStep(1))}
            >
              <Icon icon={AArrowUp} class="size-4" />
            </Button>
          </div>
        }
      />
    );
  };
}

interface SwitchRowProps {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}

function SwitchRow(handle: Handle<SwitchRowProps>) {
  return () => {
    const { id, label, hint, checked } = handle.props;
    return (
      <Row
        label={label}
        hint={hint}
        htmlFor={id}
        control={<Switch id={id} checked={checked} onCheckedChange={(next) => handle.props.onChange(next)} aria-label={label} />}
      />
    );
  };
}

export interface DisplayDockProps {
  /** What the pane is DRAWING: the rows answer for the body on screen, not for the one chosen. */
  chatShown: boolean;
  /** Why THIS pane keeps the terminal (no session log), when it must. Greys the Chat segment and says why. */
  chatNote?: string;
  /** This pane's native-rendering choice (web's mirror-invert, per pane). The row is left out when the
   *  caller passes none: that choice is the pane's own, not a device pref. */
  mirrorNative?: { value: boolean; onChange: (native: boolean) => void };
}

/** Write some display prefs, keeping the rest. */
function setDisplay(change: Partial<DisplayPrefs>): void {
  displayPrefs.update((p) => ({ ...p, ...change }));
}

const VIEW_OPTIONS: readonly PaneView[] = ["terminal", "chat"];

/**
 * The belt's Display dock: how this device draws the pane. The body switch first, then the rows that
 * answer for the body on screen (text size leads in both: it is the one an operator reaches for by
 * eyesight), then the belt's own size. It reads and writes the prefs stores directly (same keys as
 * web/, so the React shell sees the same choice) and carries no state of its own.
 */
export function DisplayDock(handle: Handle<DisplayDockProps>) {
  useLocale(handle);
  const display = useStore(handle, displayPrefs);
  const dash = useStore(handle, dashPrefs);

  return () => {
    const { chatShown, chatNote, mirrorNative } = handle.props;
    const prefs = display();
    const { paneView, showToolCalls, showCompactions, beltScale } = dash();
    const chatRows = (
      <div class="divide-y divide-border">
        <TextSizeRow
          size={prefs.chatFontSize}
          range={CHAT_FONT}
          onStep={(delta) => setDisplay({ chatFontSize: stepSize(display().chatFontSize, delta, CHAT_FONT) })}
        />
        <SwitchRow
          id="pref-tool-calls"
          label={t("settings.tools.title")}
          hint={t("settings.tools.description")}
          checked={showToolCalls}
          onChange={(next) => setDashPref("showToolCalls", next)}
        />
        <SwitchRow
          id="pref-compactions"
          label={t("settings.compactions.title")}
          hint={t("settings.compactions.description")}
          checked={showCompactions}
          onChange={(next) => setDashPref("showCompactions", next)}
        />
      </div>
    );
    const mirrorRows = (
      <div class="divide-y divide-border">
        <TextSizeRow
          size={prefs.fontSize}
          range={MIRROR_FONT}
          onStep={(delta) => setDisplay({ fontSize: stepSize(display().fontSize, delta, MIRROR_FONT) })}
        />
        <SwitchRow
          id="pref-wrap"
          label={t("settings.display.wrap.label")}
          hint={t("settings.display.wrap.hint")}
          checked={prefs.wrap}
          onChange={(wrap) => setDisplay({ wrap })}
        />
        <SwitchRow
          id="pref-tap-to-focus"
          label={t("settings.display.tapToType.label")}
          hint={t("settings.display.tapToType.hint")}
          checked={prefs.tapToFocus}
          onChange={(tapToFocus) => setDisplay({ tapToFocus })}
        />
        <SwitchRow
          id="pref-expand-clipped-reply"
          label={t("settings.display.fullReply.label")}
          hint={t("settings.display.fullReply.hint")}
          checked={prefs.expandClippedReply}
          onChange={(expandClippedReply) => setDisplay({ expandClippedReply })}
        />
        <SwitchRow
          id="pref-raw"
          label={t("settings.display.rawTerminal.label")}
          hint={t("settings.display.rawTerminal.hint")}
          checked={prefs.rawTerminal}
          onChange={(rawTerminal) => setDisplay({ rawTerminal })}
        />
        {mirrorNative === undefined ? null : (
          <SwitchRow
            id="pref-no-invert"
            label={t("settings.display.noInvert.label")}
            hint={t("settings.display.noInvert.hint")}
            checked={mirrorNative.value}
            onChange={(next) => handle.props.mirrorNative?.onChange(next)}
          />
        )}
      </div>
    );
    return (
      <div data-testid="display-dock" class="divide-y divide-border">
        <div class="py-1.5">
          <div class="mb-1.5 text-sm font-medium">{t("chat.mode.view.label")}</div>
          <div role="radiogroup" aria-label={t("chat.mode.view.label")} class="flex gap-1">
            {VIEW_OPTIONS.map((view) => {
              const selected = view === paneView;
              const blocked = view === "chat" && chatNote !== undefined;
              return (
                <button
                  key={view}
                  type="button"
                  role="radio"
                  aria-checked={selected ? "true" : "false"}
                  disabled={blocked}
                  mix={on("click", () => setDashPref("paneView", view))}
                  class={cn(
                    "flex min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    "disabled:opacity-50",
                    selected ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-muted",
                  )}
                >
                  {t(view === "chat" ? "chat.mode.option.chat" : "chat.mode.option.terminal")}
                </button>
              );
            })}
          </div>
          {chatNote === undefined ? null : <p class="mt-1 text-xs leading-snug text-muted-foreground">{chatNote}</p>}
        </div>
        {/* The body rows swap through one height motion: the stream's while Chat is on screen, the
            mirror's otherwise. */}
        <CollapseSwap open={chatShown} standIn={mirrorRows}>
          {chatRows}
        </CollapseSwap>
        <div class="py-1.5">
          <div class="mb-1.5 text-sm font-medium">{t("settings.beltSize.title")}</div>
          <Segmented
            label={t("settings.beltSize.title")}
            value={beltScale}
            options={BELT_SCALES.map((scale) => ({ value: scale, label: t(BELT_SCALE_LABELS[scale]) }))}
            onChange={(scale) => setDashPref("beltScale", asBeltScale(scale))}
          />
        </div>
      </div>
    );
  };
}
