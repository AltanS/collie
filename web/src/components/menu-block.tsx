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
import { OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { RawMirror } from "@/components/raw-mirror";
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
  /** The region's own styled lines — rendered verbatim above the controls, but only for a card that
   *  has no parsed scale to show instead (see below). */
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
// TWO CARDS SHARE THIS COMPONENT (ADR 0054, amended 2026-09-22; ADR 0056). A card that reads the
// body replaces it: once the grammar has parsed a full scale (`nav.leftRight` carries a non-empty
// `values` array and a `label` that is one of them — Claude's `/effort` slider), the mirrored rows
// are wrapped fragments at 40 and 60 columns, so the card drops the mirror and commits to the title,
// the chips and the footer buttons instead — PromptPanel's own Terminal toggle (ADR 0056) is the one
// way back to it, via the shared RawMirror over `lines`. A card that reads only the footer shows the
// body BY DEFAULT, unchanged: the generic menu (`/model`, `/tasks`, `/resume`) parses no scale, so
// its options, their descriptions and the `❯` highlight only exist as terminal text — replacing them
// with a synthesised list would be inventing structure we did not parse — and the mirror stays, with
// the buttons below it driving it. The SAME Terminal toggle still applies to that shape too, for a
// decluttered view with the buttons put away.
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

  // THE PRINTED SCALE (.adr/0054). When the screen printed the whole scale the arrows move along,
  // the card shows every value instead of the current one between two arrows: on a wide pane the
  // mirror above is cut off on a phone, so the arrows named a level and hid the rest. A tap is the
  // DELTA in arrow presses — the same Left/Right the footer advertised, repeated — so nothing is
  // emitted that the screen did not name. An unreadable scale (fewer than two values, or a label
  // that is not one of them) falls back to the plain arrows rather than guessing a position.
  const leftRight = menu.nav.leftRight;
  const scale = leftRight?.values ?? [];
  const current = leftRight === undefined ? -1 : scale.indexOf(leftRight.label);
  // READS THE BODY (ADR 0054, amended 2026-09-22): a fully parsed scale — a non-empty `values` array
  // and a `label` that is one of them — is everything the mirror could show, so this card does not
  // render it. One predicate, two uses below: it also decides the chip row, because a card with
  // chips to show is exactly a card that no longer needs the mirror.
  const readsBody = scale.length >= 2 && current >= 0;

  /** The arrow presses that walk the marker from `current` to `target`, in order. */
  const stepKeys = (target: number): string[] => {
    const key = target > current ? MENU_RIGHT_KEYS[0]! : MENU_LEFT_KEYS[0]!;
    return Array.from({ length: Math.abs(target - current) }, () => key);
  };

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
    // rawMode (ADR 0056 counsel fix): !readsBody is exactly the branch below that still renders
    // the RawMirror in children, so the control there only puts the buttons away, never a swap.
    <PromptPanel ariaLabel={menu.title} raw={lines} rawMode={readsBody ? "reveal" : "declutter"}>
      <OptionGroupCaption>{menu.title}</OptionGroupCaption>

      {/* The region, mirrored verbatim by default — ONLY for a card that reads just the footer. A
          card that reads the body (readsBody, above) has already parsed everything the mirror could
          show, so rendering both would repeat the same scale twice, wrapped fragments and all; its
          way back to these rows is the Terminal toggle above instead (ADR 0056). */}
      {!readsBody && <RawMirror lines={lines} />}

      {/* Arrow cluster — only the directions the screen itself advertised (a `❯` row for Up/Down, an
          "←/→ to <verb>" row for Left/Right). Each is one keystroke; they move a highlight and commit
          nothing, so they take the weaker identity guard. */}
      {(menu.nav.upDown || (leftRight !== undefined && !readsBody)) && (
        <div className="flex items-center gap-1.5">
          {menu.nav.upDown &&
            navButton("up", t("dialog.menu.moveUp"), MENU_UP_KEYS, <ArrowUp className="size-4" />)}
          {menu.nav.upDown &&
            navButton("down", t("dialog.menu.moveDown"), MENU_DOWN_KEYS, <ArrowDown className="size-4" />)}
          {/* The ←/→ pair sits AROUND the value it adjusts ("←  ◐ Medium effort  →"): the arrows are
              meaningless without it, and the row is re-derived every poll, so the label tracks the
              live value. Rendered in app space, not mirror space — no `dark:` question arises. */}
          {leftRight !== undefined && !readsBody && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {navButton(
                "left",
                t("dialog.menu.leftAria", { verb: leftRight.verb, label: leftRight.label }),
                MENU_LEFT_KEYS,
                <ArrowLeft className="size-4" />,
              )}
              <span className="min-w-0 flex-1 truncate text-center font-mono text-[11px] text-muted-foreground">
                {leftRight.label}
              </span>
              {navButton(
                "right",
                t("dialog.menu.rightAria", { verb: leftRight.verb, label: leftRight.label }),
                MENU_RIGHT_KEYS,
                <ArrowRight className="size-4" />,
              )}
            </div>
          )}
        </div>
      )}

      {/* The printed scale, one chip per value, in the order the screen printed them. It wraps onto a
          second line rather than scrolling: six levels at the 44px floor do not fit one phone row,
          and a row the operator has to scroll hides exactly what this card exists to show.

          The current chip is marked by colour and `aria-current`, and it is disabled, because moving
          the marker to where it already is sends nothing. Nothing about a chip's box changes with
          that state — no weight, no padding, no border width, only paint (DESIGN.md §2) — so the
          marker moving never slides the chip under a thumb already on its way down. */}
      {readsBody && leftRight !== undefined && (
        <div className="flex flex-wrap gap-1.5">
          {scale.map((value, i) => {
            const isCurrent = i === current;
            return (
              <button
                key={value}
                type="button"
                aria-current={isCurrent ? "true" : undefined}
                aria-label={
                  isCurrent
                    ? t("dialog.menu.levelCurrentAria", { label: value })
                    : t("dialog.menu.levelAria", { verb: leftRight.verb, label: value })
                }
                disabled={locked || isCurrent}
                onClick={() => press(`level-${i}`, { keys: stepKeys(i), nav: true })}
                className={cn(
                  "flex min-h-11 min-w-11 grow items-center justify-center rounded-lg border border-transparent px-3 text-center font-mono text-xs transition-colors",
                  isCurrent
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-border bg-secondary text-muted-foreground active:bg-primary/5",
                  locked && "opacity-60",
                )}
              >
                {value}
              </button>
            );
          })}
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
