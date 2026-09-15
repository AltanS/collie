import { useCallback, useEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HarnessBar, useHarnessBarItems } from "@/components/harness-bar";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { SectionLabel } from "@/components/ui/section-label";
import { STRIP_ROW_PILL, STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import { useLocale } from "@/hooks/use-locale";
import { hasResizeObserver } from "@/lib/env";
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
// rgb 235 light, rgb 23 dark) and BOTH its neighbours are that same ground — the chrome above it
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
// The belt draws no chevron of its own any more (see `cue="none"` below) — the tint and the fade
// carry the scroll cue by themselves, so there is no glyph contrast left to measure here.
//
// THE SCROLLER, WITHIN THAT BAND, NOW CARRIES ITS OWN FAINT BRAND TINT (`bg-primary/10`), and the
// fixed Switch cell takes the composer's own ground, `bg-chrome` — the operator's call from the
// phone, on top of playground round four, option 6 (the `belt-ground` deck, removed from the
// playground on 2026-09-14 once it had served; see git history). The
// band's own ground and its hairline are unchanged; only these two grounds move. The tint marks the
// part of the belt that PANS: it is the one thing on this row that moves under a thumb, so it earns
// the one wash that says "brand" rather than "chrome". The Switch cell sits on the composer's
// chrome for the opposite reason — it never scrolls, it is the one control that LEAVES the pane
// rather than acting on it, and reading as ONE surface with the composer row under the belt is the
// point (see the Switch branch below). In light, `bg-primary/10` over the band is closer to black
// than the other tints tried here, so the wash reads darker than the round's other options
// measured — shipped as picked regardless; see the playground round's own notes.
//
// THE HAIRLINE IS `--border`, NOT `--rule`. The belt's lower neighbour is the same chrome surface it
// stands on, so that is a component edge inside one surface, which is what `--border` is for — the
// same reading the status band above it came to. `border-b` alone: the belt stands flush under the
// mirror and the chrome block's own `border-t border-rule` is the boundary up there, so a second
// rule here would be two lines where the language says one. No rounded ends anywhere either: a belt
// with rounded corners is a capsule again.
//
// It replaced two separate rows. The Controls row and the harness bar sat one above the other, each
// spending a row of a phone's glass on four or five buttons, and the operator read them as one thing
// anyway: "what can I press from here". Merged, the composer gets a row back and the harness
// commands sit at the same height as the keys they were always meant to live beside.
//
// THE BELT'S RIGHT END IS THE SWITCH MARK, AND THE MACHINE IS NOT HERE ANY MORE. The write host was
// pinned at that end for a day. Altan's verdict on the phone, once the pull-up chevron had shipped
// on the rule: the chevron "is now blocking the Quick action, it's a bad spot". So the chevron went,
// the pinned slot became the switcher's own control — a real target, at the pill register, above the
// send button, and now a bare Layers mark behind a hairline rather than a pill with a word on it —
// and the machine moved up to the pane header, onto the end of the path line beside the cache
// reading (agent-chat.tsx draws it). The STATE never moved either: it stays on the pane header's dot
// (named, so a reader still gets it without paint) and on the dashboard.
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
 * The FIRST-PAINT fallback for how much of the belt's right end the pinned Switch block owns, in
 * px — the trailing spacer's width before a `ResizeObserver` has measured the real thing (below).
 * It is the whole pinned span: 32px of control, the 1px hairline on its left, the 8px between the
 * two, the 12px of `pr-3` that keeps it off the screen edge, and the 64px of `pl-16` its own fade
 * leads in over. 32 + 1 + 8 + 12 + 64 = 117.
 *
 * The 32px is the drawn box: `STRIP_ROW_PILL`'s own 44px width floor (`min-w-11`) is overridden on
 * this one pill to `w-8 min-w-8` — the belt's operator-picked shape, "Option 6" of the belt-shade
 * deck (playground, removed 2026-09-14 once it had served; see git history): the fade doubled to
 * 64px and the mark narrowed to 32px, so the longer dissolve gets room without the belt growing any
 * shorter. It was 44px, `STRIP_ROW_PILL`'s unmodified floor, before that pick, and 78px before that
 * while the control was a bordered pill wearing the word "Switch" — Altan, from his phone: "the
 * switch button is taking up too much room for my taste, I'd argue we can just have the icon." What
 * it ANSWERS is unchanged at 46px — `STRIP_ROW_PILL`'s `::before` reaches past the drawn box, the
 * way every pill on this belt does.
 *
 * THIS NUMBER IS NO LONGER THE ANSWER — IT IS THE GUESS BEFORE ONE EXISTS. A constant here drifts
 * the moment the Switch block's own box changes (a locale with a wider glyph, a future word back on
 * the pill) and nothing re-measures it, which is exactly how the last pill ended up hidden under the
 * block: the spacer's width and the block's real width were two numbers that had to be kept equal
 * by hand and quietly stopped agreeing. `useSwitchBlockWidth` below measures the block itself with a
 * `ResizeObserver` and this constant is only its return value's first frame — see there for why the
 * block, not the belt, is what gets measured.
 */
const SWITCH_PILL_INSET = 117;

/**
 * The pinned Switch block's own width, read off its DOM node — the trailing spacer's width must
 * equal this exactly, or the last pill either stops short of the hairline (spacer too wide) or
 * scrolls in UNDER the block and is hidden by it (spacer too narrow, the bug this hook fixes).
 *
 * MEASURES THE BLOCK, NOT A FORMULA. {@link SWITCH_PILL_INSET} was a formula — 53 + 12 + 32 — kept
 * equal to the block's real box by hand, and the two drifted apart in practice (the last pill
 * ended up hidden under the block, which a formula cannot notice going wrong). A `ResizeObserver` on
 * the block's own element cannot drift: whatever the block actually draws, at whatever width a
 * locale or a font gives it, is the number the scroller gets.
 *
 * `null` while there is no `handle` (nothing pinned, nothing to measure) or before the browser's
 * first observation callback — the caller falls back to {@link SWITCH_PILL_INSET} for that one
 * frame, which is the same value this hook would report for today's box, so nothing visibly shifts.
 * Guarded for jsdom, which has no `ResizeObserver` (`hasResizeObserver`, `lib/env.ts`).
 */
interface SwitchBlockWidth {
  /** Lands on the pinned Switch block's own outer element — see that element's comment for why. */
  ref: (node: HTMLSpanElement | null) => void;
  /** The block's measured width in px, or `null` before the first observation (or with no block
   *  to observe at all). The caller falls back to {@link SWITCH_PILL_INSET} for `null`. */
  width: number | null;
}

function useSwitchBlockWidth(active: boolean): SwitchBlockWidth {
  const [width, setWidth] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  // useCallback, keyed on `active`: a bare inline function is a NEW ref every render, and React
  // re-fires a changed ref callback (null, then the node) on every one of those — reconnecting the
  // observer 60 times a second under a re-rendering belt. Keying it on `active` alone means the ref
  // is only reattached when there is something new to observe or stop observing.
  const ref = useCallback(
    (node: HTMLSpanElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || !active || !hasResizeObserver()) return;
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) setWidth(entry.contentRect.width);
      });
      ro.observe(node);
      observerRef.current = ro;
    },
    [active],
  );

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  return { ref, width: active ? width : null };
}

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
  /** The focused pane's agent — picks the harness section and its brand colour. */
  agent: string | undefined | null;
  /** The snapshot's `operatorCommands`; the `bar = true` ones replace the shipped bar (ADR 0043). */
  mine?: readonly OperatorCommand[];
  /** Bound to `(t) => send(t, false)`. Resolving true drives the harness checkmark. */
  onRun: (text: string) => Promise<boolean>;
  /** Bound to the composer's `locked`. Greys the harness buttons in place. */
  disabled?: boolean;
  /**
   * THE PANE SWITCHER, PINNED AT THE BELT'S RIGHT END. Absent by default, and absent is the whole of
   * the old behaviour: nothing renders and no class on this row changes.
   *
   * It used to be a 30px band of its own above the composer, then a small up-chevron centred on this
   * belt's top rule. Altan's verdict on that chevron, from the phone: it "is now blocking the Quick
   * action, it's a bad spot" — a mark centred on the rule stands over whichever pill happens to be
   * in the middle of the band, and on a Claude pane that is Quick. So the mark is gone and the
   * switcher is a PILL now, at the belt's right end, over the same two-layer fade the host tag used:
   * an ordinary belt pill, icon and word like every other, but pinned rather than scrolling, so it
   * never pans away and it covers nothing that scrolls under it.
   *
   * IT SITS DIRECTLY ABOVE SEND, which is the whole of why the right end. The thumb that reaches for
   * the send button is already there, the pill is the one thing on this belt that leaves the
   * composer, and a pinned object at the end of a scroller costs the scroller only its own width.
   *
   * THE TWO HALVES LAND ON TWO DIFFERENT ELEMENTS, AND THAT IS THE DESIGN. `ref` goes on the BELT —
   * the outer element, not the pill — so a drag upward from anywhere on the band opens the switcher:
   * a pill, the harness section, the bare ground, the Switch pill itself. `onClick` is the pill's,
   * which is the thing that LOOKS tappable and is the only thing a tap may hit.
   *
   * The anchor is unchanged by any of this: {@link import("@/hooks/use-sheet-pull")} measures its
   * node's top edge, and its node is still the belt, so the sheet peeks from the same line it always
   * did.
   *
   * The belt wears `touch-pan-x` for it (`touch-action: pan-x`): the browser keeps the scroller's
   * sideways pan and hands vertical movement to the hook, which then decides per gesture which axis
   * a touch belongs to (use-sheet-pull.ts's header holds the arbitration).
   */
  handle?: {
    /** {@link import("@/hooks/use-sheet-pull").useSheetPull}'s ref — the finger-tracked drag. It
     *  lands on the BELT, not on the pill: the whole band is the drag surface. */
    ref: (node: HTMLElement | null) => void;
    /** The tap, on the SWITCH PILL. Opens the same switcher sheet the drag opens. */
    onClick: () => void;
    /** ALREADY TRANSLATED. The button's accessible name — "Switch pane". */
    label: string;
  };
}

export function ActionsRow({ general, agent, mine, onRun, disabled, handle }: ActionsRowProps) {
  useLocale();

  const harnessItems = useHarnessBarItems(agent, mine);
  const switchBlock = useSwitchBlockWidth(!!handle);
  const switchInset = switchBlock.width ?? SWITCH_PILL_INSET;

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
      // NO TOP MARGIN AND NO TOP RULE, and both are the same decision. The belt is the FIRST thing
      // in the chrome block, and the block already closes itself against the mirror with
      // `border-t border-rule` (agent-chat.tsx) — so a `border-t` here painted a second hairline 6px
      // below the first with a strip of empty chrome between them, which is the doubled seam
      // DESIGN.md §4 forbids. Altan, from the phone: "there is now an empty row above the actions
      // belt that we can remove." The 6px was `mt-1.5`, the air the old pull-up grip's upper half
      // hung into; the grip is gone, and nothing hangs there any more. `mb-1` below stands — that
      // one separates the belt from the input, which has no rule of its own. It was `mb-1.5` until
      // the belt itself shrank to pill height (below), at which point 6px of air under a 32px band
      // read wider than the band deserved, so it came down to 4px with the band.
      //
      // `relative` so the pinned span below can be laid over this element's own right end. It is
      // here unconditionally rather than only with a handle: a positioning context changes no pixel,
      // and a class that appears with a prop is a class nobody remembers is conditional.
      //
      // THIS ELEMENT IS THE DRAG SURFACE. `handle.ref` attaches here and not to the pill, so an
      // upward drag anywhere on the band brings the switcher up (`handle` above says why). With it
      // comes `touch-pan-x`: the browser keeps the sideways pan that scrolls the pills and hands
      // vertical movement to the hook, which arbitrates per gesture. Both appear only WITH a handle,
      // and that is not the "conditional class" the paragraph above warns against — `touch-pan-x`
      // with no listener behind it would forbid a vertical page gesture and give nothing back.
      ref={handle?.ref}
      className={cn(
        "relative -mx-3 mb-1 flex items-center border-b border-border bg-foreground/6",
        handle && "touch-pan-x",
      )}
    >
      {/* OverflowEdges measures this scroller and fades only the end that still hides something.
          `cue="none"` is this belt's own pick: a chevron was tried here for one commit, but the
          belt's own tint plus the fade already say the row scrolls, and the chevron sat under the
          fixed Switch pill's own hit box (below) and could not be tapped anyway — so the mark is
          gone and the fade carries the whole of the cue (operator's call, 2026-09-14).
          `edges="left"` is the OTHER half of that call: with a handle pinned, the Switch block below
          paints its OWN 64px fade at the belt's right end, always, whatever the scroll position — so
          a right mask from THIS primitive would stack a second, scroll-dependent fade on top of it.
          At rest the two together read as one wide fade; the moment the scroller reaches its end and
          this primitive's own mask drops out (nothing left to hide), only the Switch block's constant
          64px remains and the fade visibly SHRINKS — Altan, from the phone: "the fade is longer by
          default than when I scroll to the very right." `edges="left"` makes the right fade the
          Switch block's alone, constant in every scroll state, and keeps this primitive's own mask on
          the left, where it still means something once scrolled. A caller with no handle passes no
          `edges` at all — the default `"both"` is unchanged.
          `pl-3` stays fixed (paired with the `-mx-3` above, the route's own gutter); the scroller
          carries no `paddingRight` at all — see the trailing spacer, a sibling of the last pill
          inside this same scroller, for why the room the Switch block needs is bought with a real
          flex child rather than padding.
          The scroller's own `gap-1.5` stands — 6px is the belt's ONE pill gap, between the general
          pills, and between the last of them and the harness section's edge. The old `gap-2.5`
          override is gone with the capsules: a wider gap around a group was the separator when the
          groups were floating boxes, and the section's tint is the separator now.
          `py-1` OVERRIDES `STRIP_SCROLLER`'s OWN `py-1.5` ON THIS SCROLLER ALONE — the operator's
          pick, "Option 6" of the belt-shade deck (playground, removed 2026-09-14 once it had served;
          see git history) shrank it further, to `py-0`, the pill's own height alone, 32px; the phone
          read that as too thin, so it came back up to `py-1`, 40px — the pill's 32px plus 4px above
          and below, still short of the 44px `STRIP_TAP_TARGET` answers for and short of `py-1.5`'s
          44px too. The key rail keeps `STRIP_SCROLLER`'s shipped `py-1.5` unmodified — it is a
          different scroller, not this one, and nothing here touches it.
          `overflow-y-hidden` is the fix for a bug that `py-0` reopened and `py-1` does not retire:
          `STRIP_TAP_TARGET`'s `::before` still reaches its full 46px of hit box, and even a 40px
          scroller has only 4px of padding to spare on each side, not the 6px `py-1.5` used to — so
          the `::before` still overflows the scroller's box, and `overflow-x: auto` forces
          `overflow-y` to compute to `auto` too, which turns that overflow into a real vertical
          scrollbar under a thumb. `STRIP_SCROLLER` keeps forcing `overflow-x-auto`; this belt alone
          forces the other axis shut. */}
      <OverflowEdges edges={handle ? "left" : "both"} cue="none">
        {(scrollerRef) => (
          <div
            ref={scrollerRef}
            className={cn(STRIP_SCROLLER, "bg-primary/10 pl-3 py-1 overflow-y-hidden", !handle && "pr-3")}
          >
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
            {/* THE TRAILING SPACER — a real flex child, not padding. `paddingRight` on this
                scroller was tried first and measured wrong in Chrome: the scroller is a `flex`
                row and the harness section is itself a nested `flex` row (`BELT_SECTION`), so the
                last pill that actually overflows sits two levels down, inside a grandchild of the
                scroller. Chrome does not reliably fold a scroller's own trailing padding into the
                scrollable overflow region when the element whose children overflow is not the
                padded element itself — measured on a Claude pane at 390px: with `paddingRight`
                set to the Switch block's own measured width, the last pill's right edge still
                landed ~5px past the hairline's left edge at `scrollLeft` max, i.e. still under the
                fade. `shrink-0` and an explicit inline width sidestep the whole question — a real
                child always counts toward `scrollWidth`, at any nesting depth. `aria-hidden`
                because it draws nothing and answers nothing; the width tracks
                {@link useSwitchBlockWidth} exactly the way the removed padding used to. */}
            {handle && <span aria-hidden className="h-full shrink-0" style={{ width: switchInset }} />}
          </div>
        )}
      </OverflowEdges>
      {/* THE SWITCH PILL, PINNED AT THE BELT'S RIGHT END — see {@link SWITCH_PILL_INSET} above for
          why the scroll cue steps around it, and `handle` for why it stands here at all.
          It is a SIBLING of the OverflowEdges wrapper, and that is load-bearing: a mask applies to
          its element's whole subtree (overflow-edges.tsx says so at the middle div), so a pill
          inside the wrapper would fade out with the scrolling pills exactly where the belt
          overflows — which is always, once a pill is pinned. `z-10` puts it over the scroller, so a
          pill that pans under the fade cannot take the tap.
          THE FADE IS TWO STACKED LAYERS UNDER ONE MASK, and it has to be two: the scroller it fades
          into carries its own brand tint now (`bg-primary/10`, see the header above), so a single
          `bg-chrome` patch would read as a hole punched in a tinted band. The second layer is the
          Switch cell's OWN ground, `bg-chrome` — the composer's own chrome ground, the same fill the
          reply row and its round Send button sit on below — so the cell reads as ONE surface with the
          composer rather than as a patch cut into the belt (operator's call, from the phone: the
          Switch cell must match the composer row under the belt). The mask fades both layers in over
          the first 64px — twice the drawn box's own old lead-in — which is what lets a scrolling
          pill disappear UNDER this one instead of stopping dead against it. The 64px is the
          operator's pick, "Option 6" of the belt-shade deck (playground, removed 2026-09-14 once it
          had served; see git history): the longest fade offered, taken because the belt reads as a
          strip that keeps going rather than one that stops.
          THIS OUTER SPAN IS `pointer-events-none`, AND NOT JUST THE FADE LAYERS INSIDE IT. A plain
          `<span>` sized by flex still hits-tests over its whole box, padding included — so the 64px
          `pl-16` lead-in, drawn only as a fade, was silently eating taps meant for whatever scrolled
          underneath it, the belt's own right chevron among them (that chevron is gone now, but a
          pill scrolled to the belt's end hits the same wall). Pointer events are switched back on
          one element in, on the actual cell (hairline + button below), so the Switch pill answers a
          tap only from ITS OWN drawn cell outward — its reach stops at the hairline, the cell's own
          left edge, never past it into the scroller.
          `switchBlock.ref` lands HERE, on this outer span — the whole pinned box, `pr-3` and `pl-16`
          included, is exactly the width the scroller's `paddingRight` must match (see
          {@link useSwitchBlockWidth}), so measuring anything narrower (the inner button alone, say)
          would under-report it and the last pill would scroll in under the fade again. */}
      {handle && (
        <span
          ref={switchBlock.ref}
          className="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center pr-3 pl-16"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-chrome [mask-image:linear-gradient(to_right,transparent,black_4rem)]"
          >
            <span className="absolute inset-0 bg-chrome" />
          </span>
          {/* THE MARK ALONE, BEHIND A HAIRLINE. It was a pill for a day: the word "Switch" beside
              the mark, inside a 30% accent border on a 10% accent ground, because this is the one
              control on the belt that does not operate the composer — Keys, Type, Quick, Agent and
              Display all act on the box below, and this one LEAVES the pane. Altan's verdict once it
              shipped: "the switch button is taking up too much room for my taste, I'd argue we can
              just have the icon." So the word, the border and the ground are gone, and what says
              "the scroller ends here" is the hairline on its left — the belt's own rule colour, the
              one it already draws under itself, never a heavy edge. The mark keeps the accent, which
              is now the whole of what sets this control apart from the pills it stands beside.
              THE BOX IS UNCHANGED, and that is the point of keeping `STRIP_ROW_PILL`: 32px drawn,
              46px answered through its `::before`, exactly like every other pill here. A literally
              drawn 44px box would set the belt's height on its own and push the composer down.
              IT DRAWS NOTHING AND ANNOUNCES "Switch pane", so the accessible name is now the only
              name it has — WCAG 2.5.3 has nothing to reconcile once there is no visible word, and a
              test addresses that name rather than a glyph. */}
          <span className="pointer-events-auto flex items-center self-stretch">
            <span aria-hidden className="mr-2 h-5 w-px bg-border" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={handle.label}
              aria-haspopup="dialog"
              onClick={handle.onClick}
              // No padding and no border: what is left of the pill is `STRIP_ROW_PILL`'s own box,
              // narrowed on this one pill alone. `w-8 min-w-8` drops `min-w-11`'s 44px floor — the
              // floor every OTHER pill on this belt still stands on — down to 32px, the operator's
              // pick ("Option 6" of the belt-shade deck; playground, removed 2026-09-14 once it had
              // served, see git history): the Switch mark is a single centred icon with no label, so
              // it alone can go narrower than a pill with a word to hold. Both classes are needed —
              // `min-w-11` would otherwise still win against a bare `w-8`.
              className={cn(`${STRIP_ROW_PILL} relative w-8 min-w-8 border-0 px-0 has-[>svg]:px-0`)}
            >
              <Layers className="size-4 shrink-0 text-primary" />
            </Button>
          </span>
        </span>
      )}
    </div>
  );
}
