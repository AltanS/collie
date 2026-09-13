import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HarnessBar, useHarnessBarItems } from "@/components/harness-bar";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { SectionLabel } from "@/components/ui/section-label";
import { STRIP_CAPSULE, STRIP_ROW_PILL, STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import { useLocale } from "@/hooks/use-locale";
import { t as translate } from "@/lib/i18n";
import type { OperatorCommand } from "@/lib/types";
import { cn } from "@/lib/utils";

// ONE ROW OF ACTIONS, DIRECTLY ABOVE THE INPUT. Collie's own controls first — Keys, Type, Quick,
// Agent, the display gear — then the running harness's own commands in a segment of their own. It
// scrolls sideways; nothing wraps and nothing is dropped.
//
// TWO CAPSULES OF ONE GEOMETRY, AND THAT IS THE STRUCTURE. Both halves wear STRIP_CAPSULE: the
// general one is an OUTLINE (a 1px border on the app's border colour, no ground), the harness one is
// a FILL (the brand tint, no visible border). Outline against fill is what keeps them apart on a
// Codex pane, where both are neutral, and one shape is what makes them read as siblings rather than
// as two unrelated things. The gap BETWEEN the capsules (`gap-2.5`, 10px) is wider than the gap
// inside them (`gap-1`, 4px); that ratio is the only separator, because a vertical rule between two
// scrolling groups is a line the eye has to step over on every pan.
//
// It is here because Altan tested the merged row on his phone and said it "lacks some structure":
// five identical grey glyphs at equal spacing, no boundary anywhere, then a tinted blob cut off
// mid-word. Nothing told the eye where one group ended. The behaviour was already right and did not
// change — only how the row is drawn.
//
// It replaced two separate rows. The Controls row and the harness bar sat one above the other, each
// spending a row of a phone's glass on four or five buttons, and the operator read them as one thing
// anyway: "what can I press from here". Merged, the composer gets a row back and the harness
// commands sit at the same height as the keys they were always meant to live beside.
//
// WHY THE GENERAL SEGMENT IS FIRST. It is the half that is ALWAYS there. The harness segment is
// absent on a bare shell, on grok, on opencode, and whenever the operator has the Settings switch
// off — so leading with it would make the row's left edge mean a different thing per pane, and the
// thumb could not learn one position. The left edge is Keys on every pane there is.
//
// EVERY PILL IS AN ICON AND A WORD, IN BOTH CAPSULES, AND THE ROW OVERFLOWS BECAUSE OF IT. The
// general half was icon-only for half a day, and Altan's verdict on it was that it "looks alien to
// what we've added now for harness specific stuff": two capsules that are meant to read as one
// family cannot hold two different kinds of pill. So the words came back, and the cost was paid in
// scroll rather than in shape.
//
// The numbers, measured in the playground at a 382px row, deviceScaleFactor 2:
//
//  * The general capsule with words is 396px — wider than the row on its own, so the harness
//    capsule starts at 418px and neither its mark nor Model is visible at rest on a Claude pane.
//    Icon-only it was 244px and left ~120px of tint showing. That is the trade, made knowingly.
//  * 20px of that came back by tightening STRIP_ROW_PILL to `px-2` (416px → 396px), which is as far
//    as padding goes before the pills stop looking like pills. Nothing else was cut: not a label,
//    not the type size, not the harness mark.
//  * The row is a scroller by design and the edge mask already says "there is more this way", which
//    is the answer it was built to give. One thumb-flick reaches the harness half.
//
// The general pills DRAW a short word and ANNOUNCE the full one (`word` vs `label` below): the row
// has one word of room per pill, and "Type into terminal" and "Display settings" are still what a
// screen reader hears and what a test addresses.

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
  /** ALREADY TRANSLATED. The button's accessible name — what a reader announces and what a test
   *  addresses. It is never shortened for the paint. */
  label: string;
  /** ALREADY TRANSLATED. The word the pill DRAWS, when the accessible name is too long to wear: the
   *  row shows "Type" and announces "Type into terminal". Defaults to {@link label}.
   *
   *  It must be a prefix-or-part of `label` and never a different word — a visible word the
   *  accessible name does not contain is the WCAG 2.5.3 failure, and it also means a person saying
   *  "tap Display" and a reader hearing "Display settings" are no longer talking about one button. */
  word?: string;
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
      {/* OverflowEdges measures this scroller and fades — and chevrons — only the end that still
          hides a capsule. The `px-3` stays on the scroller, paired with the `-mx-3` above: the
          wrapper adds no padding of its own, it only owns the flex sizing the scroller used to
          carry directly.
          gap-2.5 overrides the scroller's own gap-1.5: its children here are the two capsules, and
          this is the wide half of the gap ratio that groups them. */}
      <OverflowEdges>
        {(scrollerRef) => (
          <div ref={scrollerRef} className={cn(STRIP_SCROLLER, "gap-2.5 px-3")}>
            {general.length > 0 && (
              // The word "Controls" is `sr-only` and load-bearing: sighted it labelled a run of
              // self-labelling buttons and earned nothing, but in the accessibility tree it is the only
              // thing that names this group at all. Delete it and a reader enters an unnamed run of
              // buttons. The harness segment names itself, separately, for the same reason.
              <div
                data-slot="composer-controls"
                role="group"
                aria-labelledby="composer-controls-label"
                // The OUTLINED capsule: the shared geometry, coloured by a border alone. The harness's
                // fills the same box instead.
                className={cn(STRIP_CAPSULE, "border-border")}
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
                    className={cn(`${STRIP_ROW_PILL} gap-1.5 text-xs`, action.on === true ? ON : OFF)}
                  >
                    <action.icon className="size-4 shrink-0" />
                    {action.word ?? action.label}
                  </Button>
                ))}
              </div>
            )}
            <HarnessBar agent={agent} mine={mine} onRun={onRun} disabled={disabled} />
          </div>
        )}
      </OverflowEdges>
    </div>
  );
}
