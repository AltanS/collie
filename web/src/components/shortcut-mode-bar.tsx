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
// THE KEYS COME FROM THE KEYMAP, so a rebound key shows as rebound. The words are the bar's own short
// forms, because the list's labels ("Move between spaces and tabs") are sentences. They are English
// only until the next translation pass (`PENDING_TRANSLATION`).

export type BarMode = "prefix" | ModeId;

interface Hint {
  /** The actions whose first key shows: two ids make two caps ("h l"). */
  readonly ids: readonly ActionId[];
  readonly labelKey: MessageKey;
}

// In the order of importance, so a row that runs out of room loses the last ones.
const PREFIX_HINTS: readonly Hint[] = [
  { ids: ["open_switcher"], labelKey: "shortcuts.bar.switcher" },
  { ids: ["new_tab"], labelKey: "shortcuts.bar.newTab" },
  { ids: ["previous_tab", "next_tab"], labelKey: "shortcuts.bar.tabs" },
  { ids: ["switch_tab"], labelKey: "shortcuts.bar.tab" },
  { ids: ["focus_pane_left", "focus_pane_right"], labelKey: "shortcuts.bar.panes" },
  { ids: ["next_space", "previous_space"], labelKey: "shortcuts.bar.spaces" },
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
  navigate: [
    { ids: ["navigate_left", "navigate_right"], labelKey: "shortcuts.bar.panes" },
    { ids: ["navigate_down", "navigate_up"], labelKey: "shortcuts.bar.spaces" },
    { ids: ["navigate_tab"], labelKey: "shortcuts.bar.tab" },
  ],
  resize: [{ ids: ["resize_narrower", "resize_wider"], labelKey: "shortcuts.bar.width" }],
} as const satisfies Record<ModeId, readonly Hint[]>;

const HELP_HINT: Hint = { ids: ["help"], labelKey: "shortcuts.bar.help" };

const EXIT_KEY = { esc: "shortcuts.bar.leave", enter: "shortcuts.bar.done" } as const satisfies Record<string, MessageKey>;

/** `Esc` leaves every mode; `Enter` only where the mode names it. */
function exitIds(input: { mode: BarMode; keymap: Keymap }): readonly (keyof typeof EXIT_KEY)[] {
  if (input.mode === "prefix") return ["esc"];
  return input.keymap.modes.get(input.mode)?.exits.has("enter") === true ? ["enter", "esc"] : ["esc"];
}

function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The caps of a hint: the first key of each action that has one in this mode, `[]` when none has. */
function hintCaps(input: { hint: Hint; keymap: Keymap; viaPrefix: boolean }): string[] {
  const { hint, keymap, viaPrefix } = input;
  const caps: string[] = [];
  for (const id of hint.ids) {
    const combo = actionCombos({ keymap, id }).find((candidate) => candidate.viaPrefix === viaPrefix);
    if (combo !== undefined) caps.push(...combo.caps);
  }
  return caps;
}

function HintPair({ caps, label }: { caps: readonly string[]; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <Keycaps caps={caps} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
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

export interface ShortcutModeBarProps {
  mode: BarMode;
  keymap: Keymap;
  className?: string;
}

/**
 * The pill, the keys that work next, and the ways out. `Esc` leaves every mode. In the prefix the last
 * hint is the shortcut list; in a sticky mode it is `Enter`, which the mode names.
 */
export function ShortcutModeBar({ mode, keymap, className }: ShortcutModeBarProps) {
  useLocale();
  const viaPrefix = mode === "prefix";
  const hints = viaPrefix ? PREFIX_HINTS : MODE_HINTS[mode];
  const shown = hints
    .map((hint) => ({ hint, caps: hintCaps({ hint, keymap, viaPrefix }) }))
    .filter((entry) => entry.caps.length > 0);
  const exits = exitIds({ mode, keymap });
  const help = viaPrefix ? hintCaps({ hint: HELP_HINT, keymap, viaPrefix: true }) : [];
  return (
    <div
      role="status"
      data-slot="shortcut-mode-bar"
      data-mode={mode}
      className={cn("flex min-w-0 items-center gap-x-4 text-sm", className)}
    >
      <ModePill mode={mode} />
      <div className="flex min-w-0 flex-1 gap-x-4 overflow-hidden [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
        {shown.map(({ hint, caps }) => (
          <HintPair key={hint.labelKey} caps={caps} label={t(hint.labelKey)} />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-x-4">
        {help.length > 0 && <HintPair caps={help} label={t(HELP_HINT.labelKey)} />}
        {exits.map((id) => (
          <HintPair key={id} caps={[capitalised(id)]} label={t(viaPrefix ? "shortcuts.bar.cancel" : EXIT_KEY[id])} />
        ))}
      </div>
    </div>
  );
}
