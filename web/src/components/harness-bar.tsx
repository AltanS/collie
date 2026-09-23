import { Check, Cpu, Gauge, History, ListTree, Shrink, Slash } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { AGENT_BRANDS } from "@/components/agent-icon-data";
import { Button } from "@/components/ui/button";
import { BELT_ICON, BELT_SECTION, STRIP_ROW_PILL } from "@/components/ui/labelled-strip";
import { useActionEcho } from "@/hooks/use-action-echo";
import { useLocale } from "@/hooks/use-locale";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { t as translate, type MessageKey } from "@/lib/i18n";
import { barFor, type HarnessBarItem } from "@/lib/harness-bar";
import { useHarnessBarEnabled } from "@/lib/harness-bar-pref";
import { canonicalAgent } from "@/lib/operator-scope";
import type { OperatorCommand } from "@/lib/types";
import { cn } from "@/lib/utils";

// The harness section of the actions belt: the running agent's own slash commands, sitting inside
// the one scrolling row above the input (components/actions-row.tsx). Model, Effort, Compact and
// Resume on a Claude Code pane; Codex, pi and omp get their own. The table is lib/harness-bar.ts —
// nothing here decides what the buttons are.
//
// It exists because Altan drives Claude Code from the phone and wants those four under the thumb
// rather than three taps down inside the Agent palette.
//
// IT IS THE ONE DRAWN SECTION OF THE BELT. These buttons do not do what their neighbours do: a
// general action opens one of Collie's own docks, and one of these types into somebody else's
// program. So this run sits in a SECTION of the band (BELT_SECTION) — square corners, spanning the
// belt's full inner height, tinted with the harness's brand and drawing its icons in that colour.
// Collie's own controls stand on the belt's bare ground beside it, so the tint boundary alone is
// what tells the two apart. No divider, and never a thick left border.
//
// THE BLACK-BRANDED FALLBACK IS THE ONE CASE THAT NEEDS A HAIRLINE, AND IT IS MEASURED. A brand
// with no legible accent (Codex, pi — both officially black) falls back to the app's muted ground;
// see `accent` in agent-icon-data.ts for why absent is a real answer there. On the belt's own
// ground that fallback stops separating in dark: `--muted` is rgb 38 there and the belt is rgb 37,
// which is 1.02:1 — the section would simply vanish. (Light is 1.13:1, which reads.) So the muted
// section, and only it, colours BELT_SECTION's reserved left edge with `border-l-border`. The
// tinted sections take no border at all: Claude's 14% wash measures 1.12:1 light and 1.22:1 dark
// against the belt, which is the boundary doing its own job.
//
// IT OPENS WITH THE HARNESS'S OWN MARK. The first thing inside the section is the agent's icon, and
// it is decoration: no hit box, no name in the accessibility tree, which already names the group.
// The tint alone said "not Collie's"; the mark says WHOSE, at a glance and before a word is read.
// Altan asked for exactly that after the two rows were merged into one — the row he tested "lacks
// some structure", five identical glyphs and then a coloured blob with no owner on it.
//
// IT ADDS NO REFUSAL OF ITS OWN. `disabled` (the composer's `locked`) greys every button in place,
// the way the key rail greys a key the multiplexer refuses rather than removing it. Everything else
// is refused inside `send()`: a dialog on screen is refused there with the existing status line, and
// a WORKING pane is not refused at all, because the Agent palette does not refuse one either. One
// gate, one place. The checkmark is the honest signal — it appears only when `send()` resolved true,
// so a tap that was refused shows nothing and the label stays put.
//
// It does not collapse or animate. A section that appeared and disappeared would move the input
// under the thumb, and DESIGN.md §2 says reserve, never reflow — so its presence is decided by the
// pane's agent, which does not change while the pane is on screen.

/**
 * A bar label is either an i18n key or literal text, and the prefix is the discriminator:
 * `harnessBar.…` is translated, anything else is printed as it stands. That covers the one thing we
 * must not reword, an operator's own `bar_label`, without the table having to carry a second flag.
 */
function labelText(label: string): string {
  if (!label.startsWith("harnessBar.")) return label;
  // SAFETY: every `harnessBar.` label in lib/harness-bar.ts is a key present in messages/en.ts, and
  // the i18n parity test holds the other six catalogs to the same set. A label that is not a key
  // would not start with this prefix.
  return translate(label as MessageKey);
}

/**
 * One glyph per bar ID, so the same idea wears the same icon on every harness: Compact is the same
 * button on Claude Code and on omp, and the thumb learns it once.
 *
 * Keyed on the ID rather than declared in the table, because lib/harness-bar.ts is pure by design —
 * no React import, no `t()`, no DOM — and a lucide component is all three.
 *
 * A Map, not an object literal, for the reason the table itself gives: an operator row's id is
 * `op:/whatever`, which an object lookup would answer for inherited names.
 */
const ICONS = new Map<string, LucideIcon>([
  ["model", Cpu], // which brain is answering
  ["effort", Gauge], // how hard it is told to think
  ["compact", Shrink], // fold the context up
  ["resume", History], // go back to an earlier session
  ["tree", ListTree], // the session tree
]);

/** An operator's own row gets the slash — it is their command, and we know nothing else about it. */
function iconFor(id: string): LucideIcon {
  return ICONS.get(id) ?? Slash;
}

export interface HarnessBarProps {
  /** The focused pane's agent — the same value the composer threads into the command palettes. */
  agent: string | undefined | null;
  /** The snapshot's `operatorCommands`; the `bar = true` ones replace the shipped bar (ADR 0043). */
  mine?: readonly OperatorCommand[];
  /** Bound to `(t) => send(t, false)`. Resolving true drives the checkmark. */
  onRun: (text: string) => Promise<boolean>;
  /** Bound to the composer's `locked`. Greys every button in place. */
  disabled?: boolean;
}

/**
 * The segment's items, or none — the Settings switch and the table, asked as one question.
 *
 * Exported because the ACTIONS ROW has to know whether this segment will draw anything before it
 * decides to draw itself at all (a row with no general actions and no harness must cost no
 * height). One gate, one place: the row asks this, it does not re-read the switch.
 */
export function useHarnessBarItems(
  agent: string | undefined | null,
  mine?: readonly OperatorCommand[],
): readonly HarnessBarItem[] {
  const shown = useHarnessBarEnabled();
  return shown ? barFor(agent, mine) : [];
}

export function HarnessBar({ agent, mine, onRun, disabled }: HarnessBarProps) {
  useLocale();
  const echo = useActionEcho();
  const { pending, confirm, reset } = usePendingConfirm();
  const items = useHarnessBarItems(agent, mine);

  // Off, or no items for this agent, and it renders nothing and costs no width.
  if (items.length === 0) return null;

  const accent = accentFor(agent);

  function fire(item: HarnessBarItem) {
    if (item.confirm === true && !confirm(item.id)) return; // first tap arms the confirm
    reset();
    void echo.run(item.id, () => onRun(item.command));
  }

  return (
    <div
      data-slot="harness-bar"
      role="group"
      aria-label={translate("harnessBar.label")}
      // A tinted section of the belt. The geometry is BELT_SECTION's and nothing here changes it;
      // this adds the paint alone. The `border-l-border` rides with `bg-muted` and only with it —
      // see the measurement above — and it colours the width BELT_SECTION already reserved, so the
      // tinted and the muted section are the same box to the pixel (DESIGN.md §2).
      //
      // `h-10 -my-1` is the ONE override past BELT_SECTION's own box, and it exists only because the
      // scroller around this section stands at `py-1` now (actions-row.tsx), not the `py-0` BELT_SECTION's
      // own comment was written against. BELT_SECTION's `h-8` is a FIXED border-box height — padding
      // added beside it (`py-*`) cannot grow it, that is the whole point of the fixed-box recipe — so
      // this overrides the height itself, to `h-10` (40px, the scroller's new total), rather than
      // reach for padding that would do nothing. `-my-1` then pulls the box's FLOW contribution back
      // down by 4px on each side (40px border box, 32px margin box) so it still centres and gaps like
      // every other 32px pill on the belt; the border box itself does not shrink, so the visible paint
      // stays 40px tall and lands exactly on the scroller's own `py-1` padding box, top rule to bottom
      // rule, with no untinted band. This is the pre-"Option 6" recipe BELT_SECTION's own comment
      // describes (`-my-1.5` paired with a padding-grown box, landing on the scroller's old `py-1.5`)
      // brought back at the belt's new numbers, and it is safe for the same reason that one was: the
      // scroller has real padding to land on again, so nothing overflows `clientHeight`.
      // SCALED since 2026-09-23: the 40px and the 4px are the belt's `--belt-band` and `--belt-pad`
      // now (index.css, from the one `--belt-scale`), 45px and 4px at the default scale, so the
      // section still spans the band top rule to bottom rule at every size the Settings row offers.
      className={cn(
        BELT_SECTION,
        "h-(--belt-band) -my-(--belt-pad)",
        accent === undefined && "border-l-border bg-muted",
      )}
      style={
        accent === undefined
          ? undefined
          : // 14% of the brand on whatever ground is behind it, so the one value reads in both
            // themes instead of one tint fighting the dark one.
            { backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)` }
      }
    >
      {/* The mark, not a button: `aria-hidden` on the wrapper drops AgentIcon's own `role="img"`
          and its label out of the tree, so a reader hears the group's name once and not a logo
          before every command. It carries no tap area either — it is the section's tag.
          No `pl-0.5` any more: the capsule's own padding was 4px and the mark needed the extra 2px
          to clear the rounded end. BELT_SECTION is square and pads 6px, so the mark already sits on
          the belt's own pill gap and a nudge would only push it off it. */}
      <span aria-hidden="true" className="flex shrink-0 items-center">
        <AgentIcon agent={agent} className={BELT_ICON} />
      </span>
      {items.map((item) => {
        const phase = echo.phaseOf(item.id);
        const armed = pending === item.id;
        const Icon = iconFor(item.id);
        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => fire(item)}
            aria-label={
              armed
                ? translate("harnessBar.confirmAria", { command: item.command })
                : labelText(item.label)
            }
            className={cn(
              `${STRIP_ROW_PILL} gap-1.5`,
              armed && "border border-destructive/40 bg-destructive/10 text-destructive",
              !armed &&
                phase !== "idle" &&
                (accent === undefined
                  ? "bg-background border-foreground text-foreground"
                  : "bg-white"),
              !armed && phase === "idle" && "text-foreground",
            )}
            style={
              !armed && phase !== "idle" && accent !== undefined
                ? { borderColor: accent, color: accent }
                : undefined
            }
          >
            {/* "Done" is the white chip with the harness colour on its border and its word, and a
                check where its mark was. The resting chip is a ghost in the app's own text colour
                and the armed one is red, so neither shows that pairing. The accent word on white
                is a 700ms echo, not a resting label — that is why the icon's 3:1/4.5:1 contrast
                note below does not gate it (the operator chose this on 2026-09-21). */}
            {phase === "done" ? (
              <Check className={BELT_ICON} />
            ) : (
              /* The icon takes the brand colour and the word does not. An icon is held to 3:1
                 (non-text contrast) and clears it on both themes; a 12px word in #D97757 would
                 not, so the label keeps the app's own text colour and stays readable. */
              <Icon className={BELT_ICON} style={accent ? { color: accent } : undefined} />
            )}
            {labelText(item.label)}
          </Button>
        );
      })}
    </div>
  );
}

/** The pane's brand accent, through the catalog's own agent ladder so `claude-code` finds Claude. */
export function accentFor(agent: string | undefined | null): string | undefined {
  if (!agent) return undefined;
  return AGENT_BRANDS.get(canonicalAgent(agent.toLowerCase().trim()))?.accent;
}
