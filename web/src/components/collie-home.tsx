import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { savedAtLabel } from "@/lib/format";
import { BrandMark } from "@/components/brand-mark";
import { ORBIT_TURN_MS, type MarkHandle, type MarkState } from "@/components/mark-contract";
import { t } from "@/lib/i18n";
import { useStatus } from "@/lib/status";
import { useOperatorBusy } from "@/lib/busy";
import { useLocale } from "@/hooks/use-locale";
import { Icon } from "@/components/icons/icon";

interface CollieHomeProps {
  /** Return to the dashboard. */
  onHome?: () => void;
  /** The connection has been not-live for a sustained beat (useConnectionTrouble, ≥4s) — bloom the
   *  mark. Below that (healthy, or a single slow poll) it stays still: the 4s delay is the flicker
   *  fix, so a normal polling hiccup never sets the orbit turning. */
  trouble: boolean;
  /** The outage has passed the escalation threshold (useConnectionLost, ≥15s). The bloom stops and
   *  the mark goes still again, muted — a mark that blooms forever reads as "still trying" when
   *  we've in fact given up; muted says "not connected" at a glance, matching the boot splash. */
  lost?: boolean;
  /** A new app build is being applied on this phone: downloading, or waiting to reload onto
   *  (`lib/bundle-apply.ts`). The orbit turns at the loading rate and every bead draws in the update
   *  colour, which is the band's old download row moved onto the mark (2026-11-06). Outranks the
   *  bloom, a round and busy work; `lost` outranks it. */
  applying?: boolean;
  /** The link just came back after a bar the operator saw (`lib/reconnected.ts`). For exactly one
   *  turn of the orbit at the loading rate, every bead draws in the done colour, which is the band's
   *  old green "Connected" strip moved onto the mark (2026-11-07). `lost` and `applying` outrank it;
   *  it outranks the bloom, a round and busy work. */
  reconnected?: boolean;
  /** `navigator.onLine`, read by the host (the mark never calls the hook). Only picks which icon the
   *  lost badge wears, the same two the connection strip uses so the two agree: false is the phone's
   *  own fact (WifiOff), anything else is a bridge that does not answer (CloudOff). */
  online?: boolean;
  /** When the data on screen was last read live, if anyone knows. Only ever SPOKEN, never drawn:
   *  while `lost`, it puts the age of the copy into the button's name, which is what remains of the
   *  strip's "Showing what was saved at <time>" once the operator has dismissed it. The strip under
   *  the header carries the date for sighted readers; the bar itself stays free of it. */
  lastSeenAt?: number;
  /** The ground the mark stands on, for its knockout: the header's `--band-ground` by default, and
   *  `--card` where a large screen draws the mark in its sidebar (ADR 0120). */
  paper?: string;
  /** How large the drawing is, in px (40, the header's). The 44px box around it does not change. */
  markSize?: number;
  className?: string;
}

// The single, shared Collie mark: brand + home button + connection loader in one, so the top-left of
// every screen means the same thing. ONE element for every connection state: it drifts at rest, turns
// (the "bloom") once the connection has been not-live for a sustained beat (`trouble`), and goes still
// again, dimmed, once the outage escalates (`lost`). Nothing is ever swapped, so nothing can resize as
// the connection settles.
// The mark is now the app's ONLY animal: the boot splash and the idle cover bloom this same mark, so
// "Collie is fetching" looks the same wherever it appears. The old gallop sprite and its component
// were removed in 1.20.0.
//
// Tapping it returns to the dashboard, and the MARK IS THE WHOLE BUTTON. The brand word used to sit
// inside it on the dashboard; it moved out when the header's identity became two stacked lines —
// "Collie" over "on <mux>" — because the mux line has always had to stay OUTSIDE this button (the
// aria-label below would replace it for a screen reader) and the two lines cannot be stacked beside
// the mark with one of them trapped in here. See app-header.tsx, which now owns both lines. What is
// left is exactly the 44px tap box DESIGN.md §6 asks for, and every header renders THIS component —
// the consistency is structural, not a convention two files have to keep agreeing on.
// The header says WHAT through the mark contract (`mark-contract.ts`): ONE `state` computed below, and
// a `MarkHandle` for the spin round. It never names a part of a mark. One full round of the orbit is
// `ORBIT_TURN_MS`, the contract's number, so the round and the reconnection's turn mean the same on
// every mark; it is re-exported because the connection banner times its strip by it.
export { ORBIT_TURN_MS };

/**
 * The round's SHAPE, as a multiplier on the mark's own live rate: a raised cosine on a WARPED clock.
 *
 * The round used to be a square wave — the orbit went from its 48s drift to its 1.8s sprint in one
 * frame, held, and dropped back just as hard. That reads as a film starting, not as a thing being
 * spun. The operator asked for it to "behave kinda as if a human spun a wheel", which is a statement
 * about the DERIVATIVE: a wheel leaves your hand accelerating and comes back to rest slowing down.
 *
 * A raised cosine `1 − cos(2πθ)` gave that, and it is still the curve underneath. What it got wrong
 * is that it is SYMMETRIC: it decelerates exactly as hard as it accelerates, and a thrown wheel does
 * not. The hand is on it for a moment and gone; friction then takes it down over a long tail. The
 * operator's follow-up — "the slowdown can be even smoother" — is that asymmetry, named.
 *
 * ── THE WARP, AND WHY IT COSTS NOTHING ───────────────────────────────────────
 * The fix is not a different curve, it is the same curve on a clock that does not run evenly:
 *
 *     rate(θ) = (1 − cos(2π·u(θ))) · u′(θ)      u(θ) = θ + s·θ(1−θ)      s = {@link SPIN_SKEW}
 *
 * `u` is a smooth increasing bijection of [0,1] onto itself, so this is a substitution — and by the
 * substitution rule ∫₀¹ (1−cos 2πu) u′ dθ = ∫₀¹ (1−cos 2πu) du = 1, **for ANY such `u`**. That is
 * the whole reason the warp is expressed this way rather than by hand-shaping a tail: the mean is 1
 * BY CONSTRUCTION, not by a constant somebody re-derived. Skew it further, or swap `u` entirely, and
 * the round still covers exactly one turn in exactly `ORBIT_TURN_MS` — which is the property
 * everything else rests on (shorter cuts the turn off part way, longer starts a second one).
 *
 * Every property the symmetric version was chosen for survives the warp, and two improve:
 *
 *   • `rate(0) = rate(T) = 0` — both factors' zeros are at the ends of `u`, and `u′` never vanishes,
 *     so the standstill at each join is untouched by any `s`.
 *   • `rate′(0) = rate′(T) = 0` — likewise. No velocity step at either join, same as before.
 *   • **mean exactly 1**, as above. Unchanged, and now structural rather than incidental.
 *   • **the stop is 8× less abrupt.** `rate″(T) = 4π²(1−s)³`, so at s = 0.5 the curvature the round
 *     ends on is an eighth of the symmetric curve's. Measured on the rate itself: 90% of the way
 *     through, the orbit is at 0.036 of the sprint rather than 0.191 — a five-fold gentler tail.
 *   • **the throw is sharper**, which is the same fact: `rate″(0) = 4π²(1+s)³`, 3.4× steeper. The
 *     turn is conserved, so a longer coast has to be paid for by a quicker throw. That is not a
 *     side effect to apologise for — it is what a hand does.
 *
 * The peak moves with it: 2.27 at 35% of the round, rather than 2.00 at 50%. So the deceleration now
 * owns 65% of the round and the acceleration 35%.
 *
 * Pure, exported and tested, because it is the only half of this that can be checked without eyes.
 */

/**
 * How far the clock is warped, in [0,1). `0` is the plain symmetric raised cosine this replaced, so
 * the change is a strict generalisation and the old behaviour is one constant away.
 *
 * It may not reach 1: `u′(θ) = 1 + s(1−2θ)` falls to `1 − s` at the end of the round, so at s = 1
 * the clock stops dead and the tail is infinitely long; past it `u′` goes negative and the orbit
 * would run BACKWARDS through the last of the round. 0.5 is half the available skew and the number
 * the tail figures in the header were measured at.
 */
const SPIN_SKEW = 0.5;

export function spinRate(elapsedMs: number, totalMs = ORBIT_TURN_MS): number {
  if (totalMs <= 0) return 1;
  const at = Math.min(Math.max(elapsedMs, 0), totalMs);
  const theta = at / totalMs;
  // The warped clock and its speed. Both are needed: the substitution that keeps the mean at 1 is
  // exactly `(curve ∘ u) · u′`, and dropping the `u′` factor would skew the shape AND spend part of
  // the turn — the round would land short of where it started.
  const u = theta + SPIN_SKEW * theta * (1 - theta);
  const du = 1 + SPIN_SKEW * (1 - 2 * theta);
  return (1 - Math.cos(2 * Math.PI * u)) * du;
}

/**
 * ONE state for the mark, by precedence: a dead link outranks everything (dimmed, no turning), then
 * the app updating, then the link coming back, then any loading input, else rest.
 */
function markStateOf(input: { lost: boolean; applies: boolean; greets: boolean; loading: boolean }): MarkState {
  if (input.lost) return "idle";
  if (input.applies) return "applying";
  if (input.greets) return "reconnected";
  return input.loading ? "loading" : "rest";
}

export function CollieHome({
  onHome,
  trouble,
  lost = false,
  applying = false,
  reconnected = false,
  online = true,
  lastSeenAt,
  paper = "var(--band-ground)",
  markSize = 40,
  className,
}: CollieHomeProps) {
  useLocale();
  const bloom = trouble && !lost;
  // A dead link must not look like an update in flight, so `lost` outranks this as it outranks
  // everything else the mark can say.
  const applies = applying && !lost;
  // The green turn, below both. The strip already declines to fire it while the app updates, and this
  // guard covers an update that starts inside the turn: the update colour takes over at once.
  const greets = reconnected && !lost && !applies;
  const lostIcon = online ? "bridge-unreachable" : "offline";

  // ONE FULL ROUND OF THE ORBIT whenever the app publishes a status — a send landing, an agent
  // finishing somewhere in the herd, a refusal, the pane closing under you.
  //
  // UNATTENDED-ONLY WAS BUILT AND REVERTED, and the argument is worth keeping because it is a good
  // argument that lost to the operator's own eye. It ran: a tap is already answered where the tap
  // happened — a ✓ on the send button, a spinner on the option, the draft leaving the box — and the
  // eye that would read the mark is on the thumb at the bottom of the screen, not on the header at
  // the top; so spend the round only on things that arrive from elsewhere, where nothing else can
  // fetch the eye. A `lib/status.ts` flag carried that distinction and four call sites set it.
  //
  // The operator used it and asked for the round back on their own sends. Reported plainly: the send
  // is the moment they look UP, because the reply is what they are waiting for — the thumb leaves
  // the box and the whole screen becomes the thing being watched. The theory put the eye where the
  // last touch was; in use it goes where the next change will be. The flag is gone rather than left
  // unread: a boolean nothing branches on is a lie the next reader has to disprove.
  //
  // So the rule is the simple one, and `lib/status.ts` is its whole definition: if it was worth a
  // notice, it is worth a round. That also keeps the two from ever disagreeing about what happened.
  //
  // It is the ORBIT that turns, not the whole SVG (the head would span round with it). The round
  // sets `state="loading"`: the same beads on the same path, at 27x the resting drift. Every mark
  // carries the phase across that change (the contract's `useMark`), so the round joins the drift where
  // it left it and rejoins it where it lands. Every state differs from `rest` by colour too, so under
  // `prefers-reduced-motion`, when the turning stops, the colour still says something happened.
  //
  // It never fights the connection state. `bloom` is already `loading` and outranks this, since a
  // round would tell the reader nothing there, and while `lost` the mark stays dimmed, which is a
  // state a passing event must not overwrite.
  //
  // ONE round per burst, not one per status. A single action often publishes more than one, and a
  // herd finishing together publishes several within a poll; each one restarting the timer would run
  // the orbit on and on, which is a STATE again and the exact thing the round must not look like. A
  // status that lands while a round is already turning is dropped: the round it would have started
  // is already on screen, saying the same thing.
  // ── THE THIRD LOADING INPUT: work the operator started and is waiting on ─────────────────────
  //
  // A round is an EVENT (something happened, once). The bloom is a CONNECTION STATE. This is the
  // third kind and it was missing: a job with a real duration — a send in flight, an image
  // uploading, a clip being transcribed, a route waiting on its loader — where the honest thing to
  // show is "still going", starting when it starts and stopping when it stops. lib/busy.ts owns the
  // counter and states what feeds it and, more importantly, what deliberately does not: the 1.5s
  // background poll is excluded, because an orbit fed from it would never come to rest and a mark
  // that always spins says nothing at all. Hung polls stay the stall detector's job — that is
  // `trouble` below, which is already wired.
  //
  // It joins `bloom` as a loading input rather than replacing it, and it does NOT outrank `lost`:
  // while the connection is given up on, the mark stays still and muted (see `lost` on the props),
  // and a send the operator fires into a dead link must not make it look like the app is trying
  // again. Same guard the round already carries, for the same reason.
  //
  // No debounce, and none is wanted: the mark carries the orbit's phase across the state change
  // (the contract's `useMark`), so a 200ms spin joins the drift where it left it and rejoins it where
  // it lands. Short work reads as a brief accelerate/decelerate, never as a flicker — which is what
  // lets the spin last exactly as long as the work and not one frame more.
  //
  // ── THE FOURTH: THE APP ITSELF BEING UPDATED (2026-11-06) ────────────────────────────────────
  //
  // `applying` is a state, like the bloom, and it outranks the other three: while a new app build
  // downloads or waits to load, the mark turns at the loading rate and every bead takes the update
  // colour (`state="applying"`). Not the round's curve, a steady turn, for the bloom's reason. It
  // does not outrank `lost`.
  //
  // ── THE FIFTH: THE LINK COMING BACK (2026-11-07) ─────────────────────────────────────────────
  //
  // `reconnected` is an EVENT with a fixed length, one turn, and it is drawn as a steady turn rather
  // than the round's thrown wheel: the operator asked for exactly one full turn at the loading speed.
  // A turn at that rate for ORBIT_TURN_MS brings every bead back to where it started, so the drift
  // picks up where it left off. The word "Reconnected" is a status publish, which would start a round
  // of its own over the same time; `steady` below keeps that round from ramping, so the two are one
  // turn. Under reduced motion nothing turns and the colour alone holds for the same time.
  const busy = useOperatorBusy();

  const status = useStatus();
  const roundId = status?.id ?? 0;
  const [round, setRound] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── THE THROW: the round's rate is ramped, not switched ──────────────────────
  //
  // Everything above decides WHETHER the orbit turns. This decides HOW: `spinRate` is the curve, and
  // the mark's handle applies it, `setRate(r)`, a playback rate on top of the turn. It is a rate and
  // not a timing function or a per-frame `turn`, for three reasons that belong to the contract:
  // the beads' animations must stay on ONE timeline (an easing would tear the near and far groups
  // apart), a rate keeps the phase by definition (so it cannot fight the phase carry), and a `turn`
  // changed every frame would recompute style every frame. It costs one `requestAnimationFrame`
  // loop for 1.8 seconds per round and nothing between rounds.
  //
  // ONLY THE ROUND IS RAMPED, never the bloom. `bloom` is a sustained connection state and must turn
  // steadily; a wheel-throw there would read as an event that keeps happening. So the ramp is
  // declined whenever a state is already turning the mark, and the round below still runs, simply
  // invisible under a bloom that is already turning.
  const markHandle = useRef<MarkHandle>(null);
  const frame = useRef<number | null>(null);
  const ramp = useRef<((rate: number) => void) | null>(null);
  // Whether a STATE is turning the mark right now, read by the ramp at the round's first frame. A ref
  // and not a dependency, because the round's effect must not re-run when it changes.
  const steady = useRef(false);
  steady.current = bloom || applies || greets;

  // The handle to ramp, or null where the ramp must not run. A state already turns the mark steadily
  // (the bloom, the app updating, the link coming back): a wheel-throw over it would read as an event
  // that keeps happening, and the round runs on, unseen. Under reduced motion nothing turns, so there
  // is nothing to rate. In each case the round is simply the state change it always was.
  function rampTarget(): MarkHandle | null {
    if (steady.current) return null;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) return null;
    return markHandle.current;
  }

  useEffect(() => {
    if (roundId === 0 || timer.current !== null) return;
    setRound(true);
    // Started in the NEXT frame, not this one: `state` has only just flipped, so the mark has not yet
    // re-rendered at its live pace and its phase carry has not yet run. Rating now would rate
    // animations that are about to be re-timed underneath us.
    const started = performance.now();
    let collected = false;
    const step = () => {
      // Decided ONCE, on the first frame, and never re-attempted: retrying would ask again 108 times
      // a round on exactly the environments that already declined (reduced motion).
      if (!collected) {
        collected = true;
        const handle = rampTarget();
        ramp.current = handle === null ? () => {} : (rate) => handle.setRate(rate);
      }
      const elapsed = performance.now() - started;
      ramp.current?.(spinRate(elapsed, ORBIT_TURN_MS));
      frame.current = elapsed >= ORBIT_TURN_MS ? null : requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    timer.current = setTimeout(() => {
      timer.current = null;
      // Rate restored BEFORE the state flips, and in this order deliberately. Dropping `round`
      // re-renders the mark at `rest`, which runs its phase carry, and that correction is written for
      // animations playing at rate 1. Handing it animations still at the curve's final rate (0)
      // would leave the orbit stopped on the resting drift. The loop is cancelled first so it cannot
      // write a rate back after this.
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      ramp.current?.(1);
      ramp.current = null;
      setRound(false);
    }, ORBIT_TURN_MS);
    // NO CLEANUP HERE, deliberately. React runs an effect's cleanup on every dependency change,
    // before the next run — so a cleanup that cleared the timer would clear the very thing the
    // guard above reads, and the second event of a burst would find the coast clear and restart
    // the round. That is the bug this guard exists to stop. The timer is torn down on UNMOUNT
    // instead, by the effect below.
  }, [roundId]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const state = markStateOf({ lost, applies, greets, loading: bloom || round || busy });
  return (
    <button
      type="button"
      onClick={onHome}
      // The bloom conveys connection state visually; fold it into the button's accessible name too,
      // so screen-reader users get it (inside a pane there's no other cue).
      aria-label={homeLabel({ trouble, lost, applying: applies, reconnected: greets, lastSeenAt })}
      className={cn(
        "-mx-1 flex items-center rounded px-1 transition-opacity active:opacity-70",
        className,
      )}
    >
      {/* No ring, no disc: the badge existed because the old sprite was a transparent cut-out that
          floated on the bar. This mark carries its own ring — the orbit IS the frame — and a
          40px circle with `overflow-hidden` would clip the beads that pass widest.

          The DRAWING is 40px; the BOX around it is `size-11` (44px), the same tap floor every other
          icon control in the header carries (SettingsGear, the Settings/Crew back button). This is a
          real button — it navigates home — so 40px was simply under the target, and it was also what
          made the header row 4px shorter inside a pane, where no 44px gear was there to set the
          height. The row now states its own floor (`min-h-15` in app-header.tsx), so this box no longer
          SIZES the header; it just stops being the short child. Keep the two numbers apart: 40 is the
          mark, 44 is the touchable box it is centred in.

          `paper` is the header's own ground, which is `bg-band-ground` (app-header.tsx: chrome is
          the page colour, separated by a rule, not a fill, unless a theme says `chrome: band`). It is the colour of the knockout that
          makes a near-side bead read as being IN FRONT of the head; anything else shows up as a
          halo around those beads, so this value tracks the ground and is not a taste choice. The
          two are COUPLED and the coupling is easy to forget, so app-header.test.tsx fails if the
          header's background utility and this prop ever name different tokens.

          Muted while lost — grayscale + dimmed, to read asleep/inactive — and the orbit stops
          turning again. Mirrors the boot splash's not-connected state. */}
      {/* `data-slot` is a HANDLE FOR MEASUREMENT. The agent-start handoff flies a second mark out of
          this one, so it needs this box on screen; it reads the `<svg>` inside for the true size. */}
      <span data-slot="collie-mark" className="relative grid size-11 shrink-0 place-items-center">
        <BrandMark
          size={markSize}
          weight="header"
          ref={markHandle}
          state={state}
          paper={paper}
          className="transition-opacity"
        />
        {/* THE LOST BADGE. The strip under the header says the connection is gone, and the operator can
            hide it; this is what stays after that, so the state is never only a dimmed dog. It sits in
            the corner of the 44px box (inside it, so the tap target does not grow) on the header's own
            ground (`band-ground`, the page colour unless a theme says `chrome: band`) with a `ring-2`
            cut of that ground, like the one the status dot in agent-chat wears, which keeps
            it legible over the orbit. The same two icons as the strip, picked by the host's `online`
            flag. Decorative: the button's own label already says "not connected". `text-status-blocked`
            is the danger token the red strip uses. It is a sibling of the mark, so the
            ramp never touches it. */}
        {lost ? (
          <Icon
            name={lostIcon}
            data-slot="collie-lost-badge"
            aria-hidden
            className="absolute bottom-0.5 right-0.5 size-3.5 rounded-full bg-band-ground p-px text-status-blocked ring-2 ring-band-ground"
          />
        ) : null}
      </span>
    </button>
  );
}

/**
 * The button's accessible name: what the mark is showing, folded into the name, because inside a pane
 * there is no other cue for a screen reader. `lost` first, then the app updating, then the link
 * coming back, then the bloom.
 */
function homeLabel({
  trouble,
  lost,
  applying,
  reconnected,
  lastSeenAt,
}: {
  trouble: boolean;
  lost: boolean;
  applying: boolean;
  reconnected: boolean;
  lastSeenAt: number | undefined;
}): string {
  // `trouble` as well, exactly as before: the lost names were only ever reached through it.
  if (trouble && lost) {
    return lastSeenAt === undefined
      ? t("nav.home.aria.lost")
      : t("nav.home.aria.lostAt", { time: savedAtLabel(lastSeenAt) });
  }
  if (applying) return t("nav.home.aria.updating");
  if (reconnected) return t("nav.home.aria.reconnected");
  if (trouble) return t("nav.home.aria.reconnecting");
  return t("nav.home.aria.default");
}
