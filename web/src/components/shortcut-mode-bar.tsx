import { Keycaps, actionCombos } from "@/components/shortcut-list";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { MODES, type ActionId, type ModeId } from "@/lib/shortcuts/actions";
import type { Keymap } from "@/lib/shortcuts/types";
import { cn } from "@/lib/utils";

// THE MODE BAR (M108). While the prefix or a sticky mode is active it names the mode and the keys
// that work next, as key caps and a word each. Presentational: it reads the built keymap and draws;
// it holds no listener and decides nothing about where it sits or when it shows. The caller places it
// (components/shortcut-bar-host.tsx keeps it out of the flow: DESIGN.md §2).
//
// THE BAR FOLLOWS THE SCREEN. It names only the actions that do something here (`available`, from
// `useAvailableShortcutActions`): on the dashboard no tab or pane key shows. The ways out and the hint
// that opens the list always show. A key with no target here puts the notice in the hints' place for a
// moment (lib/shortcuts/state.ts).
//
// THE KEYS COME FROM THE KEYMAP, so a rebound key shows as rebound. The words are the bar's own short
// forms, because the list's labels ("Navigate the spaces, tabs and panes") are sentences. They are English
// only until the next translation pass (`PENDING_TRANSLATION`).

export type BarMode = "prefix" | ModeId;

interface Hint {
  /** The actions whose first key shows: two ids make two caps ("h l"). */
  readonly ids: readonly ActionId[];
  readonly labelKey: MessageKey;
}

// In the order of importance, so a window that wraps the hints puts the last ones on the second line.
const PREFIX_HINTS: readonly Hint[] = [
  { ids: ["open_actions"], labelKey: "shortcuts.bar.actions" },
  // Unbound by default since the Actions palette; it shows here once a person binds it.
  { ids: ["switch_pane"], labelKey: "shortcuts.bar.switchPane" },
  { ids: ["new_tab"], labelKey: "shortcuts.bar.newTab" },
  { ids: ["previous_tab", "next_tab"], labelKey: "shortcuts.bar.tabs" },
  { ids: ["switch_tab"], labelKey: "shortcuts.bar.tab" },
  { ids: ["focus_pane_left", "focus_pane_right"], labelKey: "shortcuts.bar.panes" },
  { ids: ["previous_space", "next_space"], labelKey: "shortcuts.bar.spaces" },
  { ids: ["navigate_mode"], labelKey: "shortcuts.bar.navigate" },
  { ids: ["resize_mode"], labelKey: "shortcuts.bar.resize" },
  { ids: ["zen_mode"], labelKey: "shortcuts.bar.zen" },
  { ids: ["toggle_sidebar"], labelKey: "shortcuts.bar.sidebar" },
  { ids: ["toggle_chat_terminal"], labelKey: "shortcuts.bar.view" },
  { ids: ["focus_composer"], labelKey: "shortcuts.bar.composer" },
  { ids: ["find"], labelKey: "shortcuts.bar.find" },
  { ids: ["settings"], labelKey: "shortcuts.bar.settings" },
  { ids: ["open_dashboard"], labelKey: "shortcuts.bar.dashboard" },
];

const MODE_HINTS = {
  // Navigate has its own line (`NavigateHints`): the word leads, as the sidebar's ring is a place to be.
  navigate: [],
  resize: [{ ids: ["resize_narrower", "resize_wider"], labelKey: "shortcuts.bar.width" }],
} as const satisfies Record<ModeId, readonly Hint[]>;

const HELP_HINT: Hint = { ids: ["help"], labelKey: "shortcuts.bar.help" };
// The way to the list is not about the screen: it shows wherever the person is.
const HELP_ALWAYS: ReadonlySet<ActionId> = new Set<ActionId>(["help"]);

const EXIT_KEY = { esc: "shortcuts.bar.leave", enter: "shortcuts.bar.done" } as const satisfies Record<string, MessageKey>;

/** `Esc` leaves every mode; `Enter` only where the mode names it. */
function exitIds(input: { mode: BarMode; keymap: Keymap }): readonly (keyof typeof EXIT_KEY)[] {
  if (input.mode === "prefix") return ["esc"];
  return input.keymap.modes.get(input.mode)?.exits.has("enter") === true ? ["enter", "esc"] : ["esc"];
}

function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The caps of a hint: the first key of each available action that has one in this mode, `[]` when none has. */
function hintCaps(input: { hint: Hint; keymap: Keymap; viaPrefix: boolean; available: ReadonlySet<ActionId> }): string[] {
  const { hint, keymap, viaPrefix, available } = input;
  const caps: string[] = [];
  for (const id of hint.ids) {
    if (!available.has(id)) continue;
    const combo = actionCombos({ keymap, id }).find((candidate) => candidate.viaPrefix === viaPrefix);
    if (combo !== undefined) caps.push(...combo.caps);
  }
  return caps;
}

function HintPair({ caps, label, isLabelFirst = false }: { caps: readonly string[]; label: string; isLabelFirst?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      {isLabelFirst && <span className="text-xs text-muted-foreground">{label}</span>}
      <Keycaps caps={caps} />
      {!isLabelFirst && <span className="text-xs text-muted-foreground">{label}</span>}
    </span>
  );
}

/** The arrow keys as the arrows they are, on the bar only: the list keeps the key's name. */
const ARROW_GLYPHS: ReadonlyMap<string, string> = new Map([
  ["Up", "↑"],
  ["Down", "↓"],
]);

/** The caps of each binding of one action, in the keymap's order. */
function capsByBinding(input: { keymap: Keymap; id: ActionId }): string[][] {
  return actionCombos({ keymap: input.keymap, id: input.id }).map((combo) => combo.caps.map((cap) => ARROW_GLYPHS.get(cap) ?? cap));
}

/**
 * The keys that move the ring, letters first and then the arrows as they sit on a keyboard, up before
 * down: `j k ↑ ↓` for the defaults. Read from the keymap, so a rebound key shows as rebound.
 */
function moveCaps(keymap: Keymap): string[] {
  const down = capsByBinding({ keymap, id: "navigate_down" });
  const up = capsByBinding({ keymap, id: "navigate_up" });
  const [firstDown = [], ...otherDown] = down;
  const [firstUp = [], ...otherUp] = up;
  return [...firstDown, ...firstUp, ...otherUp.flat(), ...otherDown.flat()];
}

/** Navigate mode's line: `Move: j k ↑ ↓   Open: Enter   Leave: Esc`. Move and Open show where the sidebar answers them. */
function NavigateHints({ keymap, available }: { keymap: Keymap; available: ReadonlySet<ActionId> }) {
  const move = available.has("navigate_down") || available.has("navigate_up") ? moveCaps(keymap) : [];
  const open = available.has("navigate_open") ? capsByBinding({ keymap, id: "navigate_open" }).flat() : [];
  return (
    <>
      {move.length > 0 && <HintPair isLabelFirst caps={move} label={t("shortcuts.bar.move")} />}
      {open.length > 0 && <HintPair isLabelFirst caps={open} label={t("shortcuts.bar.open")} />}
    </>
  );
}

/** The mode's name as a pill. Primary ground, the 2px corner, in the theme's label case. */
export function ModePill({ mode }: { mode: BarMode }) {
  useLocale();
  const word = mode === "prefix" ? t("shortcuts.bar.prefix") : t(MODES.find((candidate) => candidate.id === mode)?.labelKey ?? "shortcuts.mode.navigate");
  return (
    <span data-slot="mode-pill" className="label-caps inline-flex h-6 shrink-0 items-center rounded-md bg-primary px-2 text-[11px] font-semibold text-primary-foreground">
      {word}
    </span>
  );
}

/** The line a key with no target here leaves behind. */
export function ShortcutNoticeText() {
  useLocale();
  return (
    <span data-slot="shortcut-notice" className="text-xs text-muted-foreground">
      {t("shortcuts.bar.notHere")}
    </span>
  );
}

export interface ShortcutModeBarProps {
  mode: BarMode;
  keymap: Keymap;
  /** The actions that do something on this screen now. */
  available: ReadonlySet<ActionId>;
  /** A key had no target here: say so where the hints stand. */
  isNoticeShown?: boolean;
  className?: string;
}

/**
 * The pill, the keys that work next, and the ways out. `Esc` leaves every mode. In the prefix the last
 * hint is the shortcut list; in a sticky mode it is `Enter`, which the mode names.
 */
export function ShortcutModeBar({ mode, keymap, available, isNoticeShown = false, className }: ShortcutModeBarProps) {
  useLocale();
  const viaPrefix = mode === "prefix";
  const isNavigate = mode === "navigate";
  const hints: readonly Hint[] = viaPrefix ? PREFIX_HINTS : MODE_HINTS[mode];
  const shown = hints
    .map((hint) => ({ hint, caps: hintCaps({ hint, keymap, viaPrefix, available }) }))
    .filter((entry) => entry.caps.length > 0);
  const exits = exitIds({ mode, keymap });
  const help = viaPrefix ? hintCaps({ hint: HELP_HINT, keymap, viaPrefix: true, available: HELP_ALWAYS }) : [];
  return (
    <div
      role="status"
      data-slot="shortcut-mode-bar"
      data-mode={mode}
      className={cn("flex min-w-0 items-center gap-x-4 text-sm", className)}
    >
      <ModePill mode={mode} />
      {/* The hints WRAP to a second line when the window is narrow, and never cut a word: no clip, no fade. */}
      <div data-slot="shortcut-hints" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5">
        {isNoticeShown ? (
          <ShortcutNoticeText />
        ) : (
          <>
            {isNavigate && <NavigateHints keymap={keymap} available={available} />}
            {shown.map(({ hint, caps }) => (
              <HintPair key={hint.labelKey} caps={caps} label={t(hint.labelKey)} />
            ))}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-x-4">
        {help.length > 0 && <HintPair caps={help} label={t(HELP_HINT.labelKey)} />}
        {exits.map((id) =>
          isNavigate ? (
            <HintPair key={id} isLabelFirst caps={[capitalised(id)]} label={t("shortcuts.bar.leaveNavigate")} />
          ) : (
            <HintPair key={id} caps={[capitalised(id)]} label={t(viaPrefix ? "shortcuts.bar.cancel" : EXIT_KEY[id])} />
          ),
        )}
      </div>
    </div>
  );
}
