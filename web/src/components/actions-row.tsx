import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HarnessBar, useHarnessBarItems } from "@/components/harness-bar";
import { HostChip } from "@/components/host-chip";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { SectionLabel } from "@/components/ui/section-label";
import { STRIP_ROW_PILL, STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import { useLocale } from "@/hooks/use-locale";
import { t as translate } from "@/lib/i18n";
import type { OperatorCommand } from "@/lib/types";
import { cn } from "@/lib/utils";

// ONE ROW OF ACTIONS, DIRECTLY ABOVE THE INPUT. Collie's own controls first — Keys, Type, Quick,
// Agent, the display gear — then the running harness's own commands in a section of their own. It
// scrolls sideways; nothing wraps and nothing is dropped.
//
// IT IS A BELT: ONE FULL-BLEED BAND, NOT TWO FLOATING CAPSULES. The row is a continuous strip that
// runs edge to edge, closed above and below by a hairline, with a quiet ground of its own. Collie's
// controls stand DIRECTLY on that ground with no outline at all; the harness's commands stand in a
// SECTION of the same band — a square-cornered rectangle spanning the belt's full inner height,
// tinted with the harness's brand. One belt, two parts, and the tint boundary is what separates
// them. There is no divider and no thick left border: a rule between two groups in one scroller is a
// line the eye steps over on every pan, and a thick left border is a house rule we do not break.
//
// It is here because Altan tested the two-capsule row on his phone and asked for "a ribbon or belt
// like visual for this menu". The capsules read as two objects dropped onto the chrome; the belt
// reads as one strip with two parts, which is what the row actually is. Nothing about the behaviour
// changed — only how the row is drawn.
//
// THE GROUND IS AN OPERATOR'S CALL THAT OVERRIDES DESIGN.md §4, AND IT SAYS SO HERE ON PURPOSE.
// §4 is "chrome separates with a rule, not a fill", and the status band one row above used to carry
// the measurement that argued a fill down. A belt IS a fill, Altan asked for one by name, and this
// row alone takes it — §4 still governs every other strip of chrome in the app.
//
// WHICH fill was measured, not chosen. The belt sits on the composer's chrome block (`--chrome`:
// rgb 235 light, rgb 23 dark) and BOTH its neighbours are that same ground — the dock/handle above
// and the input below, which is `bg-transparent` over it. So the ground had to separate from
// `--chrome` in both themes, and no single token does: `--muted` IS `--chrome` in light (1.00:1,
// invisible) and `--card` IS `--chrome` in dark (1.00:1, invisible). `bg-muted/40`, the first thing
// tried, therefore measured 1.00:1 light / 1.06:1 dark — nothing at all in light. An alpha wash of
// the FOREGROUND is the one recipe that is symmetric by construction, because the foreground flips
// with the theme: black at 6% darkens the light ground, white at 6% lightens the dark one. Measured
// against `--chrome`:
//
//    bg-foreground/6   1.13:1 light (rgb 221)  ·  1.16:1 dark (rgb 37)
//    bg-accent         1.06:1 light            ·  1.19:1 dark   (asymmetric, near-nothing in light)
//    bg-background     1.09:1 light            ·  1.11:1 dark   (but rgb 10 in dark IS the terminal
//                                                                mirror's fill — a hole, not a band)
//
// The chevrons keep reading over it: `text-muted-foreground` measures 4.84:1 light and 5.93:1 dark
// on the belt's ground, against 5.48 / 5.83 on the bare chrome — the belt costs them nothing that
// matters, and both clear 4.5:1.
//
// THE HAIRLINES ARE `--border`, NOT `--rule`. The belt's neighbours are the same chrome surface it
// stands on, so these are component edges inside one surface, which is what `--border` is for —
// the same reading the status band above it came to. `border-y` and no rounded ends anywhere: a
// belt with rounded corners is a capsule again.
//
// It replaced two separate rows. The Controls row and the harness bar sat one above the other, each
// spending a row of a phone's glass on four or five buttons, and the operator read them as one thing
// anyway: "what can I press from here". Merged, the composer gets a row back and the harness
// commands sit at the same height as the keys they were always meant to live beside.
//
// THE MACHINE OPENS THE BELT, AND THE STATUS WORD IS GONE. There was a 14px status band above this
// row naming the write host and the pane's state. Altan's verdict: "the server is still necessary
// somewhere, but the status is unnecessary at this place." So the band went, and the host moved
// here — the belt is the surface every one of these buttons writes from, which is what made the
// band's sentence worth saying in the first place. The STATE did not move anywhere: it stays on the
// pane header's dot (named, so a reader still gets it without paint) and on the dashboard.
//
// WHY IT SITS BEFORE THE CONTROLS GROUP RATHER THAN INSIDE IT. `role="group"` here is named
// "Controls"; the machine is not one of Collie's controls, it is where all of them land. It is also
// not a button and must never become one — `host-chip.tsx` says why at length.
//
// WHY THE GENERAL PART IS FIRST. It is the part that is ALWAYS there. The harness section is
// absent on a bare shell, on grok, on opencode, and whenever the operator has the Settings switch
// off — so leading with it would make the row's left edge mean a different thing per pane, and the
// thumb could not learn one position. The left edge is Keys on every pane there is.
//
// EVERY PILL IS AN ICON AND A WORD, IN BOTH PARTS, AND THE ROW OVERFLOWS BECAUSE OF IT. The
// general part was icon-only for half a day, and Altan's verdict on it was that it "looks alien to
// what we've added now for harness specific stuff": two parts that are meant to read as one belt
// cannot hold two different kinds of pill. So the words came back, and the cost was paid in
// scroll rather than in shape.
//
// The numbers, measured in the playground at a 382px row, deviceScaleFactor 2:
//
//  * The general run with words was 396px as an outlined capsule — wider than the row on its own,
//    so the harness half started at 418px and neither its mark nor Model was visible at rest on a
//    Claude pane. Icon-only it was 244px and left ~120px of tint showing. That is the trade, made
//    knowingly.
//  * The belt gave a little of it back without touching a label: the capsule's own `px-1` and its
//    2px of reserved border are gone (−10px), and the wide 10px gap that used to separate the two
//    capsules is now the belt's ordinary 6px pill gap (−4px). The general pills' own gap went the
//    other way, 4px → 6px, because without a capsule around them a 4px run reads as one smear.
//  * 20px came back earlier by tightening STRIP_ROW_PILL to `px-2` (416px → 396px), which is as far
//    as padding goes before the pills stop looking like pills. Nothing else was cut: not a label,
//    not the type size, not the harness mark.
//  * The row is a scroller by design and the edge mask already says "there is more this way", which
//    is the answer it was built to give. One thumb-flick reaches the harness section.
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
  /**
   * The machine every button on this belt — and the field below it — writes to. It opens the belt,
   * as a `HostChip`, and it is not a control: {@link HostChip} is deliberately not one.
   *
   * It SELF-HIDES on a solo install, which is every install that exists today, so passing it costs
   * a solo phone nothing and nothing appears there. On a crew the belt opens with the machine's
   * name and the general pills start after it — so the pills sit at a different x on a crew than on
   * a solo install. That is an INSTALL-WIDE difference, not a per-state shift: the chip's answer is
   * fixed for the life of the install, so no state a pane can enter moves it, and DESIGN.md §2 is
   * about the second thing, not the first.
   *
   * Absent, rather than flagged off, where there is no crew to name.
   */
  writeHost?: string;
  /** The focused pane's agent — picks the harness section and its brand colour. */
  agent: string | undefined | null;
  /** The snapshot's `operatorCommands`; the `bar = true` ones replace the shipped bar (ADR 0043). */
  mine?: readonly OperatorCommand[];
  /** Bound to `(t) => send(t, false)`. Resolving true drives the harness checkmark. */
  onRun: (text: string) => Promise<boolean>;
  /** Bound to the composer's `locked`. Greys the harness buttons in place. */
  disabled?: boolean;
}

export function ActionsRow({
  general,
  writeHost,
  agent,
  mine,
  onRun,
  disabled,
}: ActionsRowProps) {
  useLocale();

  const harnessItems = useHarnessBarItems(agent, mine);

  // Nothing to draw at all. Render nothing rather than an empty scroller, so the row costs no
  // height.
  if (general.length === 0 && harnessItems.length === 0) return null;

  return (
    <div
      data-slot="composer-actions"
      // THE BELT ITSELF, and the ground and the rules go HERE rather than on the scroller inside it:
      // this is the element carrying the `-mx-3` that cancels the dock's `px-3`, so a fill or a rule
      // drawn here runs edge to edge. Drawn one level in, the band would stop 12px short of both
      // screen edges and read as a wide capsule — the shape this row just stopped being.
      // `mt-1.5` and not `mt-2`, and the 2px is a re-measurement rather than a shave: the 8px was
      // the air between the status band and these buttons, and that band is gone (composer.tsx says
      // where it went). What the number separates now is the chrome block's swipe handle from the
      // belt's own top rule, and a rule needs less air than a line of type did.
      className="-mx-3 mt-1.5 mb-1.5 flex items-center border-y border-border bg-foreground/6"
    >
      {/* OverflowEdges measures this scroller and fades — and chevrons — only the end that still
          hides something. The `px-3` stays on the scroller, paired with the `-mx-3` above: the
          wrapper adds no padding of its own, it only owns the flex sizing the scroller used to
          carry directly.
          The scroller's own `gap-1.5` stands — 6px is the belt's ONE pill gap, between the general
          pills, and between the last of them and the harness section's edge. The old `gap-2.5`
          override is gone with the capsules: a wider gap around a group was the separator when the
          groups were floating boxes, and the section's tint is the separator now. */}
      <OverflowEdges>
        {(scrollerRef) => (
          <div ref={scrollerRef} className={cn(STRIP_SCROLLER, "px-3")}>
            {/* THE MACHINE OPENS THE BELT. It is a sibling of the controls group and not a member of
                it, on purpose: the group is named "Controls" and a machine's name is not one of
                Collie's controls — it names where every one of them lands. `variant="tag"` and never
                `caption`: the 10px uppercase caption was sized for the 14px status band this row
                absorbed, and a 10px run of chrome type sitting among 32px pills reads as a word that
                fell off something. `sends` because that is what this surface does: the chip must
                announce "sends to workshop", never "host: workshop", a thumb's width from the box.
                Renders null on a solo install, by its own hide rule. */}
            <HostChip host={writeHost} variant="tag" sends />
            {general.length > 0 && (
              // The word "Controls" is `sr-only` and load-bearing: sighted it labelled a run of
              // self-labelling buttons and earned nothing, but in the accessibility tree it is the only
              // thing that names this group at all. Delete it and a reader enters an unnamed run of
              // buttons. The harness section names itself, separately, for the same reason.
              <div
                data-slot="composer-controls"
                role="group"
                aria-labelledby="composer-controls-label"
                // NO BOX OF ITS OWN. Collie's controls stand directly on the belt's ground: no
                // outline, no ground, no padding — a group in the accessibility tree and a flex run
                // in the paint. The harness section is the only thing on this belt that is drawn.
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
