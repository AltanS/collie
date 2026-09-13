import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HarnessBar, useHarnessBarItems } from "@/components/harness-bar";
import { SectionLabel } from "@/components/ui/section-label";
import { STRIP_ROW_PILL, STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import { useLocale } from "@/hooks/use-locale";
import { t as translate } from "@/lib/i18n";
import type { OperatorCommand } from "@/lib/types";
import { cn } from "@/lib/utils";

// ONE ROW OF ACTIONS, DIRECTLY ABOVE THE INPUT. Collie's own controls first — Keys, Type, Quick,
// Agent, the display gear — then the running harness's own commands in a segment of their own. It
// scrolls sideways; nothing wraps and nothing is dropped.
//
// It replaced two separate rows. The Controls row and the harness bar sat one above the other, each
// spending a row of a phone's glass on four or five buttons, and the operator read them as one thing
// anyway: "what can I press from here". Merged, the composer gets a row back and the harness
// commands sit at the same height as the keys they were always meant to live beside.
//
// WHY THE GENERAL SEGMENT IS FIRST, AND WHY IT IS ICONS. Two measurements decided both:
//
//  1. **General first**, because it is the half that is ALWAYS there. The harness segment is absent
//     on a bare shell, on grok, on opencode, and whenever the operator has the Settings switch off —
//     so leading with it would make the row's left edge mean a different thing per pane, and the
//     thumb could not learn one position. The left edge is Keys on every pane there is.
//  2. **The general actions are icon-only**, because the words did not fit beside a second segment.
//     Measured at a 366px content width: five labelled pills (icon + word at text-xs) run about
//     385px on their own in English, so the harness segment started off-screen and the colour that
//     identifies it was never seen at rest. Icon-only they run about 244px, which leaves ~120px of
//     tinted segment showing before a finger moves. Their accessible names are unchanged — Keys,
//     Type into terminal, Quick, Agent, Display settings are still what a screen reader announces
//     and still what a test addresses.
//
// The harness segment keeps its words, because its vocabulary is new: Compact and Tree are not ideas
// a glyph can teach on first sight, and there are at most five of them.

/** The row's "on" look — an open dock, an armed mode. `hover:` is pinned to the same tint: without
 *  it, hovering an already-on control repaints it with the ghost variant's hover background and it
 *  reads as switching off under the cursor. */
const ON = "bg-control-on text-control-on-foreground hover:bg-control-on";
const OFF = "text-muted-foreground";

/**
 * One of Collie's own actions. The composer owns every one of these — what it does, whether it is
 * on, whether it is refused — and this file owns only how it is drawn.
 */
export interface GeneralAction {
  /** Stable, for React's key. Never shown. */
  id: string;
  icon: LucideIcon;
  /** ALREADY TRANSLATED. The button's accessible name, and the only name it has. */
  label: string;
  /** Draws the "on" tint: the dock this opens is open, or the mode it arms is armed. */
  on?: boolean;
  /** Set for a control that opens a dock — it becomes `aria-expanded`. */
  expanded?: boolean;
  /** Set for a control that toggles a mode — it becomes `aria-pressed`. */
  pressed?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ActionsRowProps {
  /** Collie's own actions, in the order the thumb should meet them. */
  general: readonly GeneralAction[];
  /** The focused pane's agent — picks the harness segment and its brand colour. */
  agent: string | undefined | null;
  /** The snapshot's `operatorCommands`; the `bar = true` ones replace the shipped bar (ADR 0043). */
  mine?: readonly OperatorCommand[];
  /** Bound to `(t) => send(t, false)`. Resolving true drives the harness checkmark. */
  onRun: (text: string) => Promise<boolean>;
  /** Bound to the composer's `locked`. Greys the harness buttons in place. */
  disabled?: boolean;
}

export function ActionsRow({ general, agent, mine, onRun, disabled }: ActionsRowProps) {
  useLocale();

  const harnessItems = useHarnessBarItems(agent, mine);

  // Nothing to draw at all. Render nothing rather than an empty scroller, so the row costs no
  // height.
  if (general.length === 0 && harnessItems.length === 0) return null;

  return (
    <div
      data-slot="composer-actions"
      className="-mx-3 mt-2 mb-1.5 flex items-center"
    >
      <div className={cn(STRIP_SCROLLER, "px-3")}>
        {general.length > 0 && (
          // The word "Controls" is `sr-only` and load-bearing: sighted it labelled a run of
          // self-labelling buttons and earned nothing, but in the accessibility tree it is the only
          // thing that names this group at all. Delete it and a reader enters an unnamed run of
          // buttons. The harness segment names itself, separately, for the same reason.
          <div
            data-slot="composer-controls"
            role="group"
            aria-labelledby="composer-controls-label"
            className="flex shrink-0 items-center gap-1.5"
          >
            <SectionLabel id="composer-controls-label" className="sr-only">
              {translate("composer.controls.label")}
            </SectionLabel>
            {general.map((action) => (
              <Button
                key={action.id}
                type="button"
                variant="ghost"
                size="sm"
                disabled={action.disabled}
                aria-label={action.label}
                aria-expanded={action.expanded}
                aria-pressed={action.pressed}
                onClick={action.onSelect}
                className={cn(STRIP_ROW_PILL, action.on === true ? ON : OFF)}
              >
                <action.icon className="size-4" />
              </Button>
            ))}
          </div>
        )}
        <HarnessBar agent={agent} mine={mine} onRun={onRun} disabled={disabled} />
      </div>
    </div>
  );
}
