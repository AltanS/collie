import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { CollieMark } from "@/components/collie-mark";
import { t } from "@/lib/i18n";
import { useStatus } from "@/lib/status";
import { useLocale } from "@/hooks/use-locale";

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
  /** Show the "Collie" wordmark beside the mark (dashboard header). Omit inside a pane to save space. */
  wordmark?: boolean;
  className?: string;
}

// The single, shared Collie mark: brand + home button + connection loader in one, so the top-left of
// every screen means the same thing. ONE element in all three states — <CollieMark/>, which is a
// still drawing while live, starts turning (the "bloom") once the connection has been not-live for a
// sustained beat (`trouble`), and goes still again, muted, once the outage escalates (`lost`). That
// is why this no longer swaps a sprite for a still image: the old sprite had no rest frame (frame 0
// is a full-stretch mid-stride pose that reads as frozen mid-run), so rest had to be a different
// picture. This mark rests by not animating at all, so nothing is ever swapped and nothing can
// resize as the connection settles.
// The mark is now the app's ONLY animal: the boot splash and the idle cover bloom this same mark, so
// "Collie is fetching" looks the same wherever it appears. <DogGallop/> is untouched but no longer
// mounted anywhere in the app (see components/dog-gallop.tsx).
//
// Tapping it returns to the dashboard. The dashboard shows the "Collie" wordmark too; inside a pane
// the mark stands alone (the breadcrumb carries the context). Both headers render THIS component —
// the consistency is structural, not a convention two files have to keep agreeing on.
// One full round of the orbit at the mark's LOADING rate, in milliseconds. <CollieMark/> owns that
// rate (`TURN.live`, collie-mark.tsx) and does not export it, so this number is a copy and has to
// stay in step with it: shorter cuts the round off part way, longer starts a second one. The rate
// is set in the collie-brand repo (`SPRINT` in src/geometry.ts) — a change there has to be walked
// over to here by hand, and this is the only thing on this side that knows the number.
const ORBIT_TURN_MS = 1800;

/**
 * The round's SHAPE, as a multiplier on the mark's own live rate: `1 - cos(2πt/T)`.
 *
 * The round used to be a square wave — the orbit went from its 48s drift to its 1.8s sprint in one
 * frame, held, and dropped back just as hard. That reads as a film starting, not as a thing being
 * spun. The operator asked for it to "behave kinda as if a human spun a wheel", which is a statement
 * about the DERIVATIVE: a wheel leaves your hand accelerating and comes back to rest slowing down.
 *
 * A raised cosine is the one curve that gives that for free AND keeps the round honest:
 *
 *   • `rate(0) = 0` and `rate(T) = 0` — it starts and ends at a standstill, so the join with the
 *     resting drift has no velocity STEP at either end. That is strictly smoother than what it
 *     replaces, where the orbit jumped to 27x and back in a frame.
 *   • peak `2` at the halfway mark — twice the sprint at the middle of the throw.
 *   • **mean exactly 1**, because ∫₀ᵀ(1 − cos(2πt/T))dt = T. So the round still covers EXACTLY one
 *     turn in exactly `ORBIT_TURN_MS`, which is the property the whole round rests on: shorter cuts
 *     it off part way, longer starts a second one. The easing is therefore FREE — it redistributes
 *     the turn in time without spending or saving any of it. Change the curve and you must re-derive
 *     that integral, or the round stops landing where it started.
 *
 * Pure, exported and tested, because it is the only half of this that can be checked without eyes.
 */
export function spinRate(elapsedMs: number, totalMs = ORBIT_TURN_MS): number {
  if (totalMs <= 0) return 1;
  const at = Math.min(Math.max(elapsedMs, 0), totalMs);
  return 1 - Math.cos((2 * Math.PI * at) / totalMs);
}

export function CollieHome({ onHome, trouble, lost = false, wordmark = false, className }: CollieHomeProps) {
  useLocale();
  const bloom = trouble && !lost;

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
  // It is the ORBIT that turns, not the mark. The whole SVG was rotated first and that was wrong:
  // the head span round with it, which is not a thing the drawing does. So this uses the mark's own
  // `loading` input instead — the same beads on the same path, at 27x the resting drift. The mark
  // carries the phase across the rate change by hand (collie-mark.tsx says how), so the round joins
  // the drift where it left it and rejoins it where it lands. Nothing jumps at either end.
  //
  // The accents come up to full chroma for the round as well. That is the mark's own coupling, not
  // an extra: under `prefers-reduced-motion` the turning stops and the colour is the only thing
  // left saying anything happened.
  //
  // It never fights the connection state. `bloom` is already the loading input and outranks this —
  // a round would tell the reader nothing there — and while `lost` the mark stays still and muted,
  // which is a state a passing event must not overwrite.
  //
  // ONE round per burst, not one per status. A single action often publishes more than one, and a
  // herd finishing together publishes several within a poll; each one restarting the timer would run
  // the orbit on and on, which is a STATE again and the exact thing the round must not look like. A
  // status that lands while a round is already turning is dropped: the round it would have started
  // is already on screen, saying the same thing.
  const status = useStatus();
  const roundId = status?.id ?? 0;
  const [round, setRound] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── THE THROW: the round's rate is ramped, not switched ──────────────────────
  //
  // Everything above decides WHETHER the orbit turns. This decides HOW. `spinRate` is the curve and
  // states why it is that curve; this is the machinery that applies it, and there are three reasons
  // it is done HERE, in JavaScript, rather than as an easing in the stylesheet.
  //
  //  1. **The stylesheet is not ours to edit.** components/collie-mark.tsx is GENERATED and
  //     hash-sealed — a test recomputes the digest and fails on any hand-edit; changes belong in the
  //     collie-brand repo's scripts/logo-ship.ts. The `linear` on the bead animations is emitted
  //     there.
  //  2. **An `animation-timing-function` would tear the mark in two.** Each bead runs TWO animations
  //     off one clock: `cm-tN` moves it, and `cm-nN`/`cm-fN` are `step-end` switches that swap it
  //     between the near group (drawn over the head, with a knockout) and the far group. Easing the
  //     first and not the second makes the bead cross in front of the head at the wrong angle. They
  //     have to stay on ONE timeline, which is exactly what a playback rate is and a timing function
  //     is not.
  //  3. **It would fight the phase carry.** collie-mark.tsx hand-corrects every animation's
  //     `currentTime` across a rate change, because a running CSS animation keeps its elapsed time
  //     and not its progress. That correction preserves the FRACTION, and under a non-linear timing
  //     function the fraction and the rendered position stop being the same thing — so the round
  //     would begin and end with the beads jumping up to ~35°, which is the exact glitch that code
  //     exists to prevent. `updatePlaybackRate` has no such problem: it is specified to hold the
  //     current time and change only the rate from here on, so progress and time stay identified and
  //     the `step-end` switches keep landing where the beads actually are.
  //
  // It costs one `requestAnimationFrame` loop for 1.8 seconds per round and nothing at all between
  // rounds. That is not the "never per frame" the mark's own phase-carry comment rules out — that
  // rule is about the RESTING mark, where a per-frame cost would be permanent.
  //
  // ONLY THE ROUND IS RAMPED, never the bloom. `bloom` is a sustained connection state and must turn
  // steadily; a wheel-throw there would read as an event that keeps happening. So the ramp is
  // declined whenever the bloom is what is driving the mark, and the round below still runs — it is
  // simply invisible under a bloom that is already turning, which was already true.
  const mark = useRef<HTMLSpanElement>(null);
  const frame = useRef<number | null>(null);
  const ramp = useRef<((rate: number) => void) | null>(null);

  // Every `cm-*` CSS animation under the mark, or null where the ramp cannot run: no element yet, no
  // `getAnimations` (jsdom under test, older engines), or reduced motion — where the stylesheet has
  // already switched every animation off and there is nothing to rate. In each case the round falls
  // back to exactly the square wave it has always been, which is why none of them is an error.
  function collect(): Animation[] | null {
    const el = mark.current;
    // `in`, not a `typeof` probe: the question is whether this DOM implementation HAS the method at
    // all — jsdom under test does not, and neither do older engines — which is a fact about the
    // object, not about the shape of a value we were handed.
    if (el === null || !("getAnimations" in el)) return null;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) return null;
    return el.getAnimations({ subtree: true }).filter((a) => {
      // SAFETY: `getAnimations` returns transitions as well as animations, and only a CSSAnimation
      // carries `animationName`. The `in` check IS the discriminator — anything without the property
      // is filtered out before the cast is read, so the cast can only ever see a CSSAnimation. The
      // name prefix then keeps this to the mark's own animations, never a caller's `className`.
      const named = "animationName" in a ? (a as CSSAnimation).animationName : "";
      return named.startsWith("cm-");
    });
  }

  useEffect(() => {
    if (roundId === 0 || timer.current !== null) return;
    setRound(true);
    // Started in the NEXT frame, not this one: `loading` has only just flipped, so the mark has not
    // yet re-rendered with its sprint rate and collie-mark.tsx's phase-carry effect has not yet run.
    // Collecting now would rate a set of animations that is about to be re-timed underneath us.
    const started = performance.now();
    let collected = false;
    const step = () => {
      // Collected ONCE, on the first frame, and never re-attempted — `collected` flips whether or not
      // there was anything to collect. Retrying would walk the subtree 108 times a round on exactly
      // the environments that already told us they cannot answer (no `getAnimations`, reduced
      // motion), which are the ones least able to afford it.
      if (!collected) {
        collected = true;
        const anims = collect();
        ramp.current = anims === null ? () => {} : (rate) => {
          for (const a of anims) a.updatePlaybackRate(rate);
        };
      }
      const elapsed = performance.now() - started;
      ramp.current?.(spinRate(elapsed, ORBIT_TURN_MS));
      frame.current = elapsed >= ORBIT_TURN_MS ? null : requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    timer.current = setTimeout(() => {
      timer.current = null;
      // Rate restored BEFORE the state flips, and in this order deliberately. Dropping `round`
      // re-renders the mark with `loading` false, which runs its phase carry — and that correction
      // is written for animations playing at rate 1. Handing it a set still playing at the curve's
      // final rate (0) would leave the orbit stopped on the resting drift. The loop is cancelled
      // first so it cannot write a rate back after this.
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
  return (
    <button
      type="button"
      onClick={onHome}
      // The bloom conveys connection state visually; fold it into the button's accessible name too,
      // so screen-reader users get it (inside a pane there's no other cue).
      aria-label={
        !trouble
          ? t("nav.home.aria.default")
          : lost
            ? t("nav.home.aria.lost")
            : t("nav.home.aria.reconnecting")
      }
      className={cn(
        "-mx-1 flex items-center gap-2 rounded px-1 transition-opacity active:opacity-70",
        className,
      )}
    >
      {/* No ring, no disc: the badge existed because the old sprite was a transparent cut-out that
          floated on the bar. This mark carries its own ring — the orbit IS the frame — and a
          40px circle with `overflow-hidden` would clip the beads that pass widest.

          The DRAWING is 40px; the BOX around it is `size-11` (44px), the same tap floor every other
          icon control in the header carries (SettingsGear, the Settings/Pack back button). This is a
          real button — it navigates home — so 40px was simply under the target, and it was also what
          made the header row 4px shorter inside a pane, where no 44px gear was there to set the
          height. The row now states its own floor (`min-h-15` in app-header.tsx), so this box no longer
          SIZES the header; it just stops being the short child. Keep the two numbers apart: 40 is the
          mark, 44 is the touchable box it is centred in.

          `paper` is the header's own ground, which is `bg-background` (app-header.tsx — chrome is
          the page colour, separated by a rule, not a fill). It is the colour of the knockout that
          makes a near-side bead read as being IN FRONT of the head; anything else shows up as a
          halo around those beads, so this value tracks the ground and is not a taste choice. The
          two are COUPLED and the coupling is easy to forget, so app-header.test.tsx fails if the
          header's background utility and this prop ever name different tokens.

          Muted while lost — grayscale + dimmed, to read asleep/inactive — and the orbit stops
          turning again. Mirrors the boot splash's not-connected state. */}
      {/* The ramp's scope, and the reason this wrapper carries a ref at all: `getAnimations` is
          collected from HERE and not from the button, so the button's own `transition-opacity` — and
          anything a caller's `className` animates — is never handed a playback rate. */}
      <span ref={mark} className="grid size-11 shrink-0 place-items-center">
        <CollieMark
          size={40}
          weight="header"
          loading={bloom || (round && !lost)}
          paper="var(--background)"
          className={cn("transition-opacity", lost && "opacity-40 grayscale")}
        />
      </span>
      {wordmark && <span className="text-lg font-semibold tracking-tight">Collie</span>}
    </button>
  );
}
