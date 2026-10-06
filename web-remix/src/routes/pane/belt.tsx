// The actions belt, directly above the composer's box. Port of web/src/components/actions-row.tsx and
// harness-bar.tsx; the reasoning there (the ground, the fade, the 45 px band, the pinned Switch block)
// still holds and is not repeated. What is Remix-specific is here.
//
// ONE BAND, TWO PARTS. Collie's own pills stand on the belt's bare ground (`general`, built by the
// caller: Keys, Type, Quick, Agent, Display). The running harness's own commands stand in a SECTION of
// the same band, tinted with the harness brand (`HarnessSection`). A drag upward anywhere on the band
// opens the pane switcher (`pull` mixin on the root); a tap on the pinned Switch mark opens it too.
//
// THE BELT WRITES NOTHING ITSELF. A harness row hands its command text to `onRun` and shows a check
// when that resolves; the caller owns the send path (writeRefusal, bridgeWrite, noteSend), so one gate
// guards every write. `disabled` greys the harness rows in place, as the key rail greys a refused key.
//
// REMIX NOTES
//   - The belt re-renders only from the three stores it draws from (dash prefs, the harness switch,
//     the operator rows in config). The echo and the two-tap confirm live in `HarnessSection`, so a
//     check flashing on one row never re-renders the general pills.
//   - The pinned block's measured width wakes the belt through `scheduleUpdate`, from a
//     ResizeObserver, never `update()`.
//   - The sideways fade is written to the DOM (`data-edge` on the mask wrapper, from `edgeWatch`), not
//     rendered: it changes on every scroll frame, which must not cost a render.
//   - web/index.css defines the `--belt-*` sizes under `[data-slot="composer-actions"]`. This root is
//     `actions-belt`, so it carries the same seven declarations inline (`beltVars`), derived from the
//     one `--belt-scale` exactly as there. If index.css ever keys them on `actions-belt` too, drop it.
import { on, ref, type Handle } from "remix/component";
import { Check, Cpu, Gauge, History, Layers, ListTree, Shrink, Slash, Undo2, X, type IconNode } from "lucide";

import { AGENT_BRANDS } from "@web/components/agent-icon-data";
import { hasResizeObserver } from "@web/lib/env";
import { barFor, type HarnessBarItem } from "@web/lib/harness-bar";
import { t, type MessageKey } from "@web/lib/i18n";
import { canonicalAgent } from "@web/lib/operator-scope";
import type { OperatorCommand } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { config } from "../../lib/data";
import { PULL_EVENT, PULL_MOVE_EVENT, pull } from "../../lib/gestures";
import { useLocale } from "../../lib/i18n-store";
import { createActionEcho, createPendingConfirm, realTimers } from "../../lib/keys-tray";
import { buzz, dashPrefs, harnessBar } from "../../lib/prefs";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { STRIP_SCROLLER, STRIP_TAP_TARGET } from "../../ui/labelled-strip";
import { SectionLabel } from "../../ui/section-label";
import type { SheetPeek } from "../../ui/sheet";
import { AgentIcon } from "../home/agent-icon";

// ── The belt's class strings (web/src/components/ui/labelled-strip.tsx) ───────────────────────────

const STRIP_ROW_PILL = `${STRIP_TAP_TARGET} before:-inset-x-px before:-inset-y-[var(--belt-reach,0px)] h-[var(--belt-pill,2rem)] min-w-11 shrink-0 touch-manipulation px-2 has-[>svg]:px-2 text-[length:var(--belt-text,0.75rem)] select-none`;
const BELT_ICON = "size-[var(--belt-icon,1rem)] shrink-0";
const BELT_SECTION = "flex h-8 shrink-0 items-center gap-1.5 border-x border-transparent px-1.5 py-0";

/** The row's "on" look: an open dock, an armed mode. `hover:` is pinned so an on pill never repaints
 *  itself with the ghost hover and reads as switching off under the cursor. */
const ON = "bg-control-on text-control-on-foreground hover:bg-control-on";
const OFF = "text-muted-foreground";

/** The icon-only pills on the pinned block: square at the belt's scaled pill size, no border, the same
 *  tap feedback on every one (actions-row.tsx, PINNED_PILL, explains each class). */
const PINNED_PILL =
  "relative w-(--belt-pill) min-w-(--belt-pill) border-0 px-0 has-[>svg]:px-0 before:-inset-y-(--belt-pad) hover:bg-foreground/8 active:bg-foreground/15 active:scale-[0.92] motion-reduce:active:scale-100 duration-[120ms]";

/** The band itself: one full-bleed fill closed below by a hairline (see the root in `Belt`). The
 *  stand-in draws the same box, so the two are one height by construction. */
const BELT_ROOT = "relative -mx-3 mb-1 flex items-center border-b border-border bg-foreground/6";

/** Extra air between the last scrolling pill and the pinned block at full scroll-right. */
const BELT_END_AIR = 16;

/** The belt's derived sizes, from `--belt-scale` (web/src/index.css, THE ACTION BELT'S ONE SCALE). */
const BELT_VARS = {
  "--belt-pad": "round(down, calc(0.25rem * var(--belt-scale)), 1px)",
  "--belt-pill": "round(calc(2rem * var(--belt-scale)), 1px)",
  "--belt-band": "calc(var(--belt-pill) + 2 * var(--belt-pad))",
  "--belt-reach": "calc(var(--belt-pad) + 1px)",
  "--belt-icon": "round(calc(1rem * var(--belt-scale)), 1px)",
  "--belt-text": "calc(0.75rem * var(--belt-scale))",
  "--belt-rule": "round(calc(1.25rem * var(--belt-scale)), 1px)",
} as const;

export function beltVars(scale: number) {
  return { "--belt-scale": String(scale), ...BELT_VARS };
}

// ── Pure helpers (belt.test.ts) ───────────────────────────────────────────────────────────────────

/** The first-frame width of the pinned block at scale 1, by how many pills it holds (1 to 3):
 *  32 + the hairline + gaps + `pr-3` + the 64 px fade, and each extra pill adds 32 + 6. */
const SWITCH_PILL_INSETS = [117, 155, 193] as const;

/**
 * The first-frame fallback for the pinned block's width at a belt scale, for `pills` pinned pills.
 * Only the icon-only pills grow with `--belt-scale`; the hairline, gaps, `pr-3` and fade do not, so
 * each 32 becomes `--belt-pill`, the same `round(2rem * scale)` index.css uses. Default scale 1.15:
 * 122 for one pill, 165 for two, 208 for three. The measured width replaces it after the first frame.
 */
export function switchPillInset(scale: number, pills: number): number {
  const count = Math.min(Math.max(Math.round(pills), 1), SWITCH_PILL_INSETS.length);
  const pill = Math.round(32 * scale);
  return SWITCH_PILL_INSETS[count - 1] - count * 32 + count * pill;
}

/** Each pinned pill's answered box by where it stands: 7px out at an end of the block, 3px toward a
 *  neighbour (half the 6px gap), so two reaches never meet. Literal class names, so Tailwind finds them. */
export function pinnedReach(first: boolean, last: boolean): string {
  return cn(first ? "before:-left-[7px]" : "before:-left-[3px]", last ? "before:-right-[7px]" : "before:-right-[3px]");
}

/** A bar label is an i18n key when it starts with `harnessBar.`, literal text (an operator's own
 *  `bar_label`) otherwise. */
export function labelText(label: string): string {
  if (!label.startsWith("harnessBar.")) return label;
  // SAFETY: every `harnessBar.` label in web's lib/harness-bar.ts is a key in its message catalog, and
  // the catalog parity test holds the other locales to the same set.
  return t(label as MessageKey);
}

/** One glyph per bar id, so the same idea wears the same icon on every harness (web's harness-bar.tsx). */
const BAR_ICONS = new Map<string, IconNode>([
  ["model", Cpu],
  ["effort", Gauge],
  ["compact", Shrink],
  ["resume", History],
  ["tree", ListTree],
]);

/** An operator's own row gets the slash: it is their command and nothing else is known about it. */
export function iconFor(id: string): IconNode {
  return BAR_ICONS.get(id) ?? Slash;
}

/** The pane's brand accent, through the catalog's own agent ladder so `claude-code` finds Claude. */
export function accentFor(agent: string | undefined | null): string | undefined {
  if (!agent) return undefined;
  return AGENT_BRANDS.get(canonicalAgent(agent.toLowerCase().trim()))?.accent;
}

/** The harness section's rows: none while the device switch is off, else the table or the operator's. */
export function harnessItems(
  agent: string | undefined,
  mine: readonly OperatorCommand[] | undefined,
  shown: boolean,
): readonly HarnessBarItem[] {
  if (!shown || !agent) return [];
  return barFor(agent, mine);
}

/** Which side of the scroller still hides content: written as `data-edge` on the mask wrapper. */
export type OverflowEdge = "none" | "left" | "right" | "both";

export function edgeOf(left: boolean, right: boolean): OverflowEdge {
  if (left && right) return "both";
  if (left) return "left";
  if (right) return "right";
  return "none";
}

/** The 1px slack is the sub-pixel guard: a scroller at rest often reports a scrollWidth a fraction
 *  over its clientWidth, and an exact test would fade a row that fits. */
export function overflowEdge(scrollLeft: number, clientWidth: number, scrollWidth: number): OverflowEdge {
  return edgeOf(scrollLeft > 1, scrollLeft + clientWidth < scrollWidth - 1);
}

/**
 * Keep `data-edge` on the scroller's parent true to what the scroller hides, until `signal` aborts.
 * Measured on scroll, on any size change of the scroller or its children, and when children arrive
 * (a locale change or the harness section landing changes widths with no scroll). Written to the DOM,
 * not rendered, so a scroll costs no render.
 *
 * NEVER MEASURED IN THE INSERT CALLBACK (REMIX3.md, "Layout in insert callbacks"). This runs from a
 * `ref` while the pane is being inserted; a synchronous read of `scrollWidth` there forced the whole
 * new screen's layout inside the tap's task (13 to 18 ms at 4x CPU, research note 05). The first
 * measure is the ResizeObserver's own first observation, which the browser delivers after its layout
 * of that frame, when the numbers are already known; a scroll event comes after layout too. A child
 * that arrives is only observed, and its observation measures. Without ResizeObserver, one
 * animation frame after insert. The three reads come first and the one write last, and the write is
 * skipped when the edge did not move.
 */
function edgeWatch(node: HTMLElement, signal: AbortSignal): void {
  const wrapper = node.parentElement;
  if (!wrapper) return;
  const measure = (): void => {
    const edge = overflowEdge(node.scrollLeft, node.clientWidth, node.scrollWidth);
    if (wrapper.dataset.edge !== edge) wrapper.dataset.edge = edge;
  };
  node.addEventListener("scroll", measure, { passive: true, signal });
  if (!hasResizeObserver()) {
    const frame = requestAnimationFrame(measure);
    signal.addEventListener("abort", () => cancelAnimationFrame(frame), { once: true });
    return;
  }
  const resize = new ResizeObserver(measure);
  resize.observe(node);
  for (const child of Array.from(node.children)) resize.observe(child);
  const added = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const child of mutation.addedNodes) if (child instanceof Element) resize.observe(child);
    }
  });
  added.observe(node, { childList: true });
  signal.addEventListener(
    "abort",
    () => {
      resize.disconnect();
      added.disconnect();
    },
    { once: true },
  );
}

/** `aria-expanded` and `aria-pressed` are absent unless the control is that kind. */
function ariaBool(value: boolean | undefined): "true" | "false" | undefined {
  return value === undefined ? undefined : value ? "true" : "false";
}

// ── The harness section ───────────────────────────────────────────────────────────────────────────

export interface HarnessSectionProps {
  agent: string;
  items: readonly HarnessBarItem[];
  /** Resolves `false` when the send was refused; anything else shows the check. */
  onRun: (command: string) => void | boolean | Promise<boolean | void>;
  disabled: boolean;
}

/**
 * The running agent's own commands (ADR 0043), one tap each, in a tinted section of the belt. The
 * table is web's lib/harness-bar.ts; nothing here decides what the buttons are. A row marked
 * `confirm` arms on the first tap and fires on the second within 3 s. The check appears only when
 * `onRun` did not resolve false, so a refused tap shows nothing and the label stays put.
 */
export function HarnessSection(handle: Handle<HarnessSectionProps>) {
  useLocale(handle);
  const wake = (): void => scheduleUpdate(handle);
  const echo = createActionEcho(realTimers, wake, { onPress: () => buzz() });
  const confirm = createPendingConfirm(realTimers, wake);
  handle.signal.addEventListener(
    "abort",
    () => {
      echo.dispose();
      confirm.dispose();
    },
    { once: true },
  );

  const fire = (item: HarnessBarItem): void => {
    if (item.confirm === true && !confirm.confirm(item.id)) return; // the first tap arms
    confirm.reset();
    void echo.run(item.id, async () => (await handle.props.onRun(item.command)) !== false);
  };

  return () => {
    const { agent, items, disabled } = handle.props;
    const accent = accentFor(agent);
    return (
      <div
        data-slot="harness-bar"
        role="group"
        aria-label={t("harnessBar.label")}
        // Tinted with the brand at 14% of whatever ground is behind it, so one value reads in both
        // themes. A brand with no legible accent (Codex, pi: officially black) falls back to the muted
        // ground and, alone, colours the reserved left edge so the section still separates in dark.
        class={cn(BELT_SECTION, "h-(--belt-band) -my-(--belt-pad)", accent === undefined && "border-l-border bg-muted")}
        style={accent === undefined ? undefined : { backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)` }}
      >
        {/* The mark is decoration: no hit box, and `aria-hidden` keeps its logo label out of the tree,
            which already names the group once. */}
        <span aria-hidden="true" class="flex shrink-0 items-center">
          <AgentIcon agent={agent} class={BELT_ICON} />
        </span>
        {items.map((item) => {
          const phase = echo.phaseOf(item.id);
          const armed = confirm.pending === item.id;
          const done = phase === "done";
          return (
            <Button
              key={item.id}
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={`harness-${item.id}`}
              aria-label={armed ? t("harnessBar.confirmAria", { command: item.command }) : labelText(item.label)}
              mix={on("click", () => fire(item))}
              class={cn(
                `${STRIP_ROW_PILL} gap-1.5`,
                armed && "border border-destructive/40 bg-destructive/10 text-destructive",
                !armed && phase !== "idle" && (accent === undefined ? "bg-background border-foreground text-foreground" : "bg-white"),
                !armed && phase === "idle" && "text-foreground",
              )}
              style={!armed && phase !== "idle" && accent !== undefined ? { borderColor: accent, color: accent } : undefined}
            >
              {/* The done chip is white with the accent on its border and word and a check where the
                  mark was. The icon takes the brand colour and the word does not: an icon is held to
                  3:1 and clears it, a 12px word in #D97757 would not. */}
              <span class="inline-flex" style={!done && accent !== undefined ? { color: accent } : undefined}>
                <Icon icon={done ? Check : iconFor(item.id)} class={BELT_ICON} />
              </span>
              {labelText(item.label)}
            </Button>
          );
        })}
      </div>
    );
  };
}

// ── The belt ──────────────────────────────────────────────────────────────────────────────────────

export interface BeltPill {
  /** Stable. Keys the pill and names its test id. */
  id: string;
  icon: IconNode;
  /** ALREADY TRANSLATED. The accessible name; never shortened for the paint. */
  label: string;
  /** ALREADY TRANSLATED. The word the pill draws when `label` is too long to wear. A part of `label`,
   *  never a different word (WCAG 2.5.3). */
  word?: string;
  /** The dock this opens is open, or the mode it arms is armed. */
  on?: boolean;
  /** A control that opens a dock: becomes `aria-expanded`. */
  expanded?: boolean;
  /** A control that toggles a mode: becomes `aria-pressed`. */
  pressed?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface BeltProps {
  /** Collie's own pills, built by the caller: Keys, Type, Quick, Agent, Display. */
  general: readonly BeltPill[];
  /** The harness id for the bar and the accent. Undefined or "" is a shell: no harness section. */
  agent: string | undefined;
  /** Harness rows send their command text through this. Resolve `false` for a refused send: the row
   *  then shows no check. A caller returning nothing gets the check on every tap. */
  onRun: (command: string) => void | boolean | Promise<boolean | void>;
  /** The pane takes no write: greys the harness rows in place. */
  disabled: boolean;
  /** The Changes pill, absent when the pane has no folder. */
  changes?: { label: string; onClick: () => void };
  /** The draft's clear X, then Undo in the same box until the next act (M40 spec 04). */
  clear?: {
    mode: "clear" | "undo";
    onClick: () => void;
    /** Undo only: a tap on any OTHER control on the belt ends the Undo window. */
    onOtherPress?: () => void;
    /** Dimmed and ignoring the tap (a send in flight, or Type armed). Not `disabled`: a disabled button
     *  takes no `mousedown`, so a tap on it would blur the field and drop the phone keyboard. */
    inert?: boolean;
  } | null;
  /** The pinned Switch block's mark. Null: no other pane, so no mark and no drag. */
  switcher: { onOpen: () => void; peek: SheetPeek; label: string; needsYou: boolean } | null;
  /** Extra classes on the root, for the caller's gutter (the default `-mx-3` cancels a `px-3` dock). */
  class?: string;
}

/** How many pills the pinned block holds: the clear X, the Changes pill and the Switch mark. */
function pinnedCountOf(props: BeltProps): number {
  return (props.clear ? 1 : 0) + (props.changes ? 1 : 0) + (props.switcher ? 1 : 0);
}

export function Belt(handle: Handle<BeltProps>) {
  useLocale(handle);
  const prefs = useStore(handle, dashPrefs);
  const harnessOn = useStore(handle, harnessBar);
  const cfg = useStore(handle, config);
  const controlsId = `belt-controls-${handle.id}`;

  // The pinned block's border-box width, measured: the trailing spacer must equal it exactly, or the
  // last pill scrolls in under the block. Null until the first observation.
  let blockWidth: number | null = null;
  const watchBlock = (node: HTMLElement, signal: AbortSignal): void => {
    if (!hasResizeObserver()) return;
    const resize = new ResizeObserver((entries) => {
      const entry = entries[0];
      // The BORDER box: the content box leaves out the block's own `pl-16` and `pr-3` (76px).
      const width = entry?.borderBoxSize?.[0]?.inlineSize ?? node.getBoundingClientRect().width;
      if (width === blockWidth) return;
      blockWidth = width;
      scheduleUpdate(handle);
    });
    resize.observe(node);
    signal.addEventListener(
      "abort",
      () => {
        resize.disconnect();
        blockWidth = null;
      },
      { once: true },
    );
  };

  // The bar rows are a pure function of three inputs, derived once per input identity.
  let cached: { agent: string | undefined; mine: readonly OperatorCommand[] | undefined; shown: boolean; items: readonly HarnessBarItem[] } | null =
    null;
  const itemsFor = (agent: string | undefined, mine: readonly OperatorCommand[] | undefined, shown: boolean): readonly HarnessBarItem[] => {
    if (cached && cached.agent === agent && cached.mine === mine && cached.shown === shown) return cached.items;
    const items = harnessItems(agent, mine, shown);
    cached = { agent, mine, shown, items };
    return items;
  };

  return () => {
    const props = handle.props;
    const { general, agent, onRun, disabled, changes, clear, switcher } = props;
    const items = itemsFor(agent || undefined, cfg().data?.operatorCommands, harnessOn());
    // Nothing to draw: render nothing rather than an empty scroller, so the row costs no height.
    if (general.length === 0 && items.length === 0) return null;

    const { beltScale } = prefs();
    const pinnedCount = pinnedCountOf(props);
    const pinned = pinnedCount > 0;
    const inset = blockWidth ?? switchPillInset(beltScale, pinnedCount);

    return (
      <div
        data-slot="actions-belt"
        style={beltVars(beltScale)}
        mix={[
          // The whole band is the drag surface: a vertical pull brings the switcher up under the
          // finger, and a release past the threshold opens it for real (web's use-sheet-pull).
          pull({ disabled: handle.props.switcher === null }),
          on(PULL_MOVE_EVENT, (event) => {
            handle.props.switcher?.peek.move(event.pull, event.anchor);
          }),
          on(PULL_EVENT, (event) => {
            const open = handle.props.switcher;
            if (!open) return;
            if (event.open) {
              buzz();
              open.onOpen();
            }
            open.peek.end();
          }),
          // Capture, so the Undo window ends in the same tap as the pill's own act. The Undo button
          // itself is exempt. A sideways scroll fires no click and keeps Undo.
          on(
            "click",
            (event) => {
              const end = handle.props.clear?.onOtherPress;
              if (end === undefined) return;
              if (event.target instanceof Element && event.target.closest("[data-belt-clear]") !== null) return;
              end();
            },
            true,
          ),
        ]}
        // The belt IS a fill (an operator's call that overrides DESIGN.md §4): one full-bleed band,
        // closed below by a hairline. The block above it already draws the top rule. `touch-pan-x`
        // only with a switcher: the browser keeps the sideways pan and hands vertical to the pull.
        class={cn(
          BELT_ROOT,
          switcher !== null && "touch-pan-x",
          props.class,
        )}
      >
        {/* The mask wrapper. `data-edge` is written by `edgeWatch`; pinned, only the LEFT fade is
            drawn, because the Switch block paints its own constant right fade and a second one would
            shrink visibly when the scroller reaches its end. Literal class strings for Tailwind. */}
        <div
          class={cn(
            "flex min-w-0 flex-1",
            "data-[edge=left]:[mask-image:linear-gradient(to_right,transparent,black_1.5rem)] data-[edge=both]:[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]",
            !pinned &&
              "data-[edge=right]:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] data-[edge=both]:[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
          )}
        >
          <div
            mix={ref(edgeWatch)}
            class={cn(STRIP_SCROLLER, "bg-primary/10 pl-3 py-(--belt-pad) overflow-y-hidden", !pinned && "pr-3")}
          >
            {general.length > 0 ? (
              // The word "Controls" is sr-only and load-bearing: it is the only thing that names this
              // group in the accessibility tree. The group has no box of its own; the harness section
              // is the only thing drawn on this belt.
              <div data-slot="composer-controls" role="group" aria-labelledby={controlsId} class="flex shrink-0 items-center gap-1.5">
                <SectionLabel id={controlsId} class="sr-only">
                  {t("composer.controls.label")}
                </SectionLabel>
                {general.map((action) => (
                  <Button
                    key={action.id}
                    variant="ghost"
                    size="sm"
                    disabled={action.disabled}
                    data-testid={`belt-pill-${action.id}`}
                    aria-label={action.label}
                    aria-expanded={ariaBool(action.expanded)}
                    aria-pressed={ariaBool(action.pressed)}
                    mix={on("click", () => action.onSelect())}
                    class={cn(`${STRIP_ROW_PILL} gap-1.5`, action.on === true ? ON : OFF)}
                  >
                    <Icon icon={action.icon} class={BELT_ICON} />
                    {action.word ?? action.label}
                  </Button>
                ))}
              </div>
            ) : null}
            {items.length > 0 && agent ? <HarnessSection agent={agent} items={items} onRun={onRun} disabled={disabled} /> : null}
            {/* The trailing spacer is a real flex child, not padding: Chrome does not fold a scroller's
                trailing padding into its scrollable overflow when the overflowing element is nested a
                level down (the harness section is itself a flex row). A child counts at any depth. */}
            {pinned ? <span aria-hidden="true" class="h-full shrink-0" style={{ width: `${String(inset + BELT_END_AIR)}px` }} /> : null}
          </div>
        </div>
        {pinned ? (
          // THE PINNED BLOCK: an overlay over the belt's right end, a sibling of the mask wrapper so
          // the scroller's mask does not fade it. It is `absolute`, so the pills coming and going on
          // it move nothing in flow; the spacer above tracks its measured width. The span is
          // `pointer-events-none` so its 64px lead-in never eats a tap meant for a scrolling pill, and
          // events come back on at the cell.
          <span
            mix={ref(watchBlock)}
            class="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center pr-3 pl-16"
          >
            <span
              aria-hidden="true"
              class="pointer-events-none absolute inset-0 bg-chrome [mask-image:linear-gradient(to_right,transparent,black_4rem)]"
            >
              <span class="absolute inset-0 bg-chrome" />
            </span>
            <span class="pointer-events-auto flex items-center gap-1.5 self-stretch">
              <span aria-hidden="true" class="mr-0.5 h-(--belt-rule) w-px bg-border" />
              {clear ? (
                // ONE button in both modes: only the glyph and the name swap, so Undo moves nothing and
                // a screen reader's focus stays put. It refuses its own `mousedown` (the event whose
                // default moves focus) so the field keeps the keyboard; not `pointerdown`, which on
                // WebKit cancels the click as well.
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="belt-clear"
                  data-belt-clear=""
                  aria-label={t(clear.mode === "undo" ? "composer.controls.undoClear" : "composer.controls.clear")}
                  aria-disabled={clear.inert === true ? "true" : undefined}
                  mix={[
                    on("mousedown", (event) => event.preventDefault()),
                    on("click", () => {
                      const now = handle.props.clear;
                      if (now && now.inert !== true) now.onClick();
                    }),
                  ]}
                  class={cn(`${STRIP_ROW_PILL} ${PINNED_PILL}`, pinnedReach(true, pinnedCount === 1), clear.inert === true && "opacity-50")}
                >
                  <Icon icon={clear.mode === "undo" ? Undo2 : X} class={cn(BELT_ICON, "text-primary")} />
                </Button>
              ) : null}
              {changes ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="belt-changes"
                  aria-label={changes.label}
                  mix={on("click", () => handle.props.changes?.onClick())}
                  class={cn(`${STRIP_ROW_PILL} ${PINNED_PILL}`, pinnedReach(!clear, !switcher))}
                >
                  <Icon icon={ListTree} class={cn(BELT_ICON, "text-primary")} />
                </Button>
              ) : null}
              {switcher ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="belt-switch"
                  aria-label={switcher.label}
                  aria-haspopup="dialog"
                  mix={on("click", () => handle.props.switcher?.onOpen())}
                  class={cn(`${STRIP_ROW_PILL} ${PINNED_PILL}`, pinnedReach(!clear && !changes, true))}
                >
                  <Icon icon={Layers} class={cn(BELT_ICON, "text-primary")} />
                  {/* The red dot is always drawn and `invisible` when no other pane needs you: a reserved
                      slot, never a mark that appears. `ring-chrome` cuts it out of the glyph. */}
                  <span
                    aria-hidden="true"
                    data-testid="belt-switch-alert"
                    class={cn(
                      "pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-status-blocked ring-2 ring-chrome",
                      !switcher.needsYou && "invisible",
                    )}
                  />
                </Button>
              ) : null}
            </span>
          </span>
        ) : null}
      </div>
    );
  };
}

// ── The stand-in, for the pane's first frame ──────────────────────────────────────────────────────

/**
 * The belt's band for the frame before the composer mounts (pane.tsx, "the two-step mount"): the same
 * root box at the same `--belt-scale`, and inside it the scroller's own `--belt-pad` around one strut
 * of `--belt-pill`. The harness section's margin box is a pill high too (`h-(--belt-band)` less the
 * pad on both sides), so the belt's height never depends on what it holds and this band is its height
 * to the pixel. No pills, no listeners, no observers. It reads the scale with `get()` and subscribes
 * to nothing: it lives for one frame, and the real belt that replaces it subscribes.
 */
export function BeltStandIn() {
  return () => (
    <div data-slot="actions-belt-standin" aria-hidden="true" style={beltVars(dashPrefs.get().beltScale)} class={BELT_ROOT}>
      <div class="flex min-w-0 flex-1 items-center py-(--belt-pad)">
        <span class="h-(--belt-pill) w-0 shrink-0" />
      </div>
    </div>
  );
}
