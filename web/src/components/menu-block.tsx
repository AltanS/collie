import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { MenuModel, StyledLine } from "@/lib/blocks";
import {
  MENU_DOWN_KEYS,
  MENU_LEFT_KEYS,
  MENU_RIGHT_KEYS,
  MENU_UP_KEYS,
} from "@/lib/harness/menu-hints";
import { MIRROR_INVERT, MIRROR_SPACE, styleFor } from "@/components/mirror-space";
import { OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/** What a tap asks for: the keys to send, and whether it is a non-committal arrow (which takes the
 *  weaker identity-only guard in lib/menu-action.ts). */
export interface MenuBlockAction {
  keys: string[];
  nav: boolean;
}

export interface MenuBlockProps {
  /** The detected menu: its title, the keys its footer named, and the nav it advertised. */
  menu: MenuModel;
  /** The region's own styled lines — rendered verbatim above the controls (see below). */
  lines: StyledLine[];
  /**
   * Injected send handler (from AgentChat). Presentational contract: this component NEVER touches
   * the network — the race guard and the send live in lib/menu-action.ts.
   */
  onAction: (action: MenuBlockAction) => void | Promise<void>;
  /** Read-only device or a gone pane: everything renders (for context) but can't be pressed. */
  disabled?: boolean;
}

// Native, tappable rendering of a generic modal menu — the `/model` picker and its kin.
//
// Unlike the other block renderers this one KEEPS the terminal region visible above the controls,
// and that is the whole design: the grammar understands the screen's FOOTER, not its body, so the
// options, their descriptions and the `❯` highlight only exist as terminal text. Replacing them with
// a synthesised list would be inventing structure we did not parse. So the body is mirrored verbatim
// and the buttons below it drive it.
//
// Text is React text nodes only — colour and weight come from the ANSI parse, never markup. Same XSS
// boundary as the mirror, and the same dark colour space (MIRROR_SPACE/MIRROR_INVERT, ADR 0002),
// because these are the agent's own terminal colours.
//
// There are NO digit buttons, and there never will be: in the `/model` picker a digit confirms AND
// persists the choice as the user's default (.adr/0009). Only footer-named keys and arrows ship.
export function MenuBlock({ menu, lines, onAction, disabled }: MenuBlockProps) {
  useLocale();
  const [sending, setSending] = useState<string | null>(null);
  const locked = disabled || sending !== null;

  async function press(id: string, action: MenuBlockAction) {
    if (locked) return;
    setSending(id);
    try {
      await onAction(action);
    } finally {
      setSending(null);
    }
  }

  const spinner = (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />
  );

  const navButton = (id: string, label: string, keys: string[], icon: ReactNode) => (
    <button
      key={id}
      type="button"
      aria-label={label}
      disabled={locked}
      onClick={() => press(id, { keys, nav: true })}
      className="flex h-9 flex-1 items-center justify-center rounded-lg border border-border bg-secondary text-muted-foreground shadow-sm transition-colors active:border-primary/50 active:bg-primary/5 disabled:opacity-60"
    >
      {sending === id ? spinner : icon}
    </button>
  );

  return (
    <PromptPanel ariaLabel={menu.title}>
      <OptionGroupCaption>{menu.title}</OptionGroupCaption>

      {/* The region, mirrored verbatim. Scrolls horizontally on its own so a wide picker never makes
          the page pan (the option/description columns are laid out for a desktop width). */}
      <pre
        className={cn(
          "m-0 overflow-x-auto rounded-lg px-2 py-1.5 font-mono text-[11px] leading-[1.25] whitespace-pre",
          MIRROR_SPACE,
          MIRROR_INVERT,
        )}
      >
        {lines.map((line, li) => (
          <span key={li}>
            {li > 0 ? "\n" : null}
            {line.segments.map((s, si) => (
              <span key={si} style={styleFor(s)}>
                {s.text}
              </span>
            ))}
          </span>
        ))}
      </pre>

      {/* Arrow cluster — only the directions the screen itself advertised (a `❯` row for Up/Down, an
          "←/→ to <verb>" row for Left/Right). Each is one keystroke; they move a highlight and commit
          nothing, so they take the weaker identity guard. */}
      {(menu.nav.upDown || menu.nav.leftRight !== undefined) && (
        <div className="flex items-center gap-1.5">
          {menu.nav.upDown &&
            navButton("up", t("dialog.menu.moveUp"), MENU_UP_KEYS, <ArrowUp className="size-4" />)}
          {menu.nav.upDown &&
            navButton("down", t("dialog.menu.moveDown"), MENU_DOWN_KEYS, <ArrowDown className="size-4" />)}
          {/* The ←/→ pair sits AROUND the value it adjusts ("←  ◐ Medium effort  →"): the arrows are
              meaningless without it, and the row is re-derived every poll, so the label tracks the
              live value. Rendered in app space, not mirror space — no `dark:` question arises. */}
          {menu.nav.leftRight !== undefined && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {navButton(
                "left",
                t("dialog.menu.leftAria", { verb: menu.nav.leftRight.verb, label: menu.nav.leftRight.label }),
                MENU_LEFT_KEYS,
                <ArrowLeft className="size-4" />,
              )}
              <span className="min-w-0 flex-1 truncate text-center font-mono text-[11px] text-muted-foreground">
                {menu.nav.leftRight.label}
              </span>
              {navButton(
                "right",
                t("dialog.menu.rightAria", { verb: menu.nav.leftRight.verb, label: menu.nav.leftRight.label }),
                MENU_RIGHT_KEYS,
                <ArrowRight className="size-4" />,
              )}
            </div>
          )}
        </div>
      )}

      {/* The footer's own actions. Cancel (Esc) is de-emphasised like every other abort affordance in
          the block family — it is not a peer of the things that commit. */}
      <div className="flex flex-col gap-1">
        {menu.actions
          .filter((a) => !a.cancel)
          .map((action, i) => {
            const id = `action-${i}`;
            return (
              <button
                key={id}
                type="button"
                disabled={locked}
                onClick={() => press(id, { keys: action.keys, nav: false })}
                className="font-content flex w-full items-center justify-center gap-2 rounded-lg border border-primary/60 bg-primary/15 px-3 py-2 text-sm font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
              >
                {sending === id ? spinner : null}
                {action.label}
              </button>
            );
          })}
        {menu.actions
          .filter((a) => a.cancel)
          .map((action, i) => {
            const id = `cancel-${i}`;
            return (
              <button
                key={id}
                type="button"
                disabled={locked}
                onClick={() => press(id, { keys: action.keys, nav: false })}
                className="font-content flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
              >
                {sending === id ? spinner : null}
                {action.label}
              </button>
            );
          })}
      </div>
    </PromptPanel>
  );
}
