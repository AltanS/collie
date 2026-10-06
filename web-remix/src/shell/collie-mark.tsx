// The Collie mark in the header: brand, home or up button, and connection loader in one
// (web/src/components/collie-home.tsx over web/src/components/collie-mark.tsx).
//
// THE DRAWING IS NOT HAND-PORTED. web/'s `collie-mark.tsx` is generated in the collie-brand repo and
// hash-sealed. Its stylesheet, bodies, view boxes and turn rates are read out of that file at build
// time by the `collie-mark-data` Vite plugin (vite.config.ts) as `virtual:collie-mark`, so a
// regenerated mark reaches this shell with no edit here. The keyframes keep their generated names
// (`cm-t0`…`cm-wobble`) and live in the SVG's own <style>, exactly as web/ ships them.
//
// IT NEVER RESTARTS (REMIX3.md rule 6). The mark is 37 CSS animations; a remount or a rewrite of its
// markup restarts all of them at zero. So the drawing is painted ONCE, imperatively, into a span with
// no vdom children (REMIX3.md, "When to bypass render"), and every later change (loading, lost, the
// orbit's rate) is a class, a custom property or `updatePlaybackRate` on that same DOM. The
// component re-renders only for the button's accessible name, which never touches the drawing.
//
// FOUR INPUTS, as web/ has them (web/src/components/collie-home.tsx `loading={bloom || ((round || busy) && !lost)}`):
//   - bloom: not live for TROUBLE_MS (4 s), a stalled load (2.5 s) counting as not live; the orbit
//     turns steadily. The reading is `shell/connection-state.ts`, shared with the strip and splash.
//   - lost: not live for CONNECTION_LOST_MS (15 s), latched until a live poll; still, muted.
//   - busy: operator-started work (lib/busy.ts): the first read of a tapped screen, a send, an
//     upload, a transcription. The fast orbit starts on the first frame, with no threshold.
//   - the round: every `setStatus` publish turns the orbit ONE round of ORBIT_TURN_MS, ramped by
//     `spinRate` (a raised cosine on a warped clock), one round per burst, never over bloom or lost.
// Under reduced motion the generated stylesheet stops the turning and the round is colour only.
//
// `CollieMark` below is the same drawing as a plain, sized mark for the boot splash, the idle cover
// and the tour (web's `<CollieMark size={64} weight="header" />`): painted once, `loading` and `lost`
// switch the same classes on the same DOM.
import { on, ref, type Handle } from "remix/component";
import { BODY, STYLE, TURN, VIEW } from "virtual:collie-mark";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { busy } from "../lib/busy";
import { useLocale } from "../lib/i18n-store";
import { reducedMotion } from "../lib/motion";
import { status } from "../lib/status";
import { scheduleUpdate } from "../lib/store";
import { connection } from "./connection-state";

/** One round at the loading rate, in ms: `TURN.live` seconds (web/'s ORBIT_TURN_MS copy). */
export const ORBIT_TURN_MS = TURN.live * 1000;
const SPIN_SKEW = 0.5;

/**
 * The round's shape as a multiplier on the live rate (web/src/components/collie-home.tsx `spinRate`,
 * ported because that file is a React component): `(1 − cos 2πu(θ)) · u′(θ)` with
 * `u(θ) = θ + s·θ(1−θ)`. Its mean over the round is exactly 1, so one round is exactly one turn.
 */
export function spinRate(elapsedMs: number, totalMs = ORBIT_TURN_MS): number {
  if (totalMs <= 0) return 1;
  const theta = Math.min(Math.max(elapsedMs, 0), totalMs) / totalMs;
  const u = theta + SPIN_SKEW * theta * (1 - theta);
  const du = 1 + SPIN_SKEW * (1 - 2 * theta);
  return (1 - Math.cos(2 * Math.PI * u)) * du;
}

let instances = 0;

/** The SVG markup for one instance: its own gradient and mask ids, the resting class on the body. */
function markup(size: number): string {
  const uid = `cm${String(++instances)}-`;
  return (
    `<svg width="${String(size)}" height="${String(size)}" viewBox="${VIEW.header}" role="presentation" ` +
    `style="display:block;flex:none" class="transition-opacity">` +
    `<style>${STYLE}</style><g class="cm-drift">${BODY.header.replaceAll("__cmid__", uid)}</g></svg>`
  );
}

/** The live handle on one painted mark. Everything here writes the DOM; nothing re-renders. */
interface Painted {
  setLoading(on: boolean): void;
  setLost(on: boolean): void;
  /** The mark's own CSS animations, or null where a ramp cannot run (no API, reduced motion). */
  animations(): Animation[] | null;
}

function paint(host: HTMLElement, size = 40, paper = "var(--background)"): Painted {
  host.innerHTML = markup(size);
  const svg = host.querySelector("svg");
  const body = svg?.querySelector("g");
  if (!svg || !body) throw new Error("collie-mark: the generated markup has no <svg><g>");
  let loading = false;
  const vars = (live: boolean): void => {
    svg.style.setProperty("--cm-turn", `${String(live ? TURN.live : TURN.rest)}s`);
    svg.style.setProperty("--cm-a1", live ? "oklch(0.74 0.16 295)" : "oklch(0.698 0.127 295)");
    svg.style.setProperty("--cm-a2", live ? "oklch(0.75 0.17 340)" : "oklch(0.711 0.134 340)");
    svg.style.setProperty("--cm-paper", paper);
  };
  vars(false);
  return {
    setLoading(live) {
      if (live === loading) return;
      const ratio = (loading ? TURN.live : TURN.rest) / (live ? TURN.live : TURN.rest);
      loading = live;
      svg.classList.toggle("cm-live", live);
      body.classList.toggle("cm-drift", !live);
      vars(live);
      // KEEP THE PHASE (web/'s CollieMark effect): a running CSS animation keeps its elapsed time,
      // not its progress, when the duration changes; carry the progress across by hand, once.
      if (!("getAnimations" in svg)) return;
      for (const a of svg.getAnimations({ subtree: true })) {
        const timing = a.effect?.getTiming();
        if (timing === undefined || a.currentTime === null) continue;
        const now = Number(a.currentTime);
        const delay = timing.delay ?? 0;
        const span = Number(timing.duration ?? 0);
        if (!(span > 0)) continue;
        const before = (now - delay * ratio) / (span * ratio);
        a.currentTime = delay + (before - Math.floor(before)) * span;
      }
    },
    setLost(muted) {
      svg.classList.toggle("opacity-40", muted);
      svg.classList.toggle("grayscale", muted);
    },
    animations() {
      if (!("getAnimations" in svg) || reducedMotion()) return null;
      return svg.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation && a.animationName.startsWith("cm-"));
    },
  };
}

export interface CollieHomeProps {
  /** The tap. Read at click time, so a route's callback never re-renders the mark. */
  onActivate: () => void;
  /** The accessible name when the mark goes up rather than home ("Back to the dashboard"). */
  label?: string;
}

export function CollieHome(handle: Handle<CollieHomeProps>) {
  useLocale(handle);
  let trouble = false;
  let lost = false;
  let painted: Painted | null = null;
  let round = false;
  let working = false;
  let frame = 0;

  const sync = (): void => {
    painted?.setLost(lost);
    painted?.setLoading(!lost && (trouble || round || working));
  };

  // The fast orbit starts on the FIRST frame after a tap, with no threshold (web: `useBusyWhile`). A
  // reading that comes and goes inside one frame (an instant navigation) is folded into that frame
  // and never reaches the DOM, so the mark does not flick. A hidden page has no frames: apply now.
  const syncSoon = (): void => {
    if (document.visibilityState !== "visible") {
      sync();
      return;
    }
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  };
  handle.signal.addEventListener("abort", () => cancelAnimationFrame(frame), { once: true });

  // ── Connection: bloom at 4 s not live, lost at 15 s (latched until a live poll) ────────────────
  const readConnection = (): void => {
    const next = connection.state;
    if (next.trouble === trouble && next.lost === lost) return;
    trouble = next.trouble;
    lost = next.lost;
    sync();
    scheduleUpdate(handle); // the button's accessible name
  };
  const readBusy = (): void => {
    if (busy.view.orbit === working) return;
    working = busy.view.orbit;
    syncSoon();
  };

  // ── The round: one per burst of `setStatus` ─────────────────────────────────────────────────
  const startRound = (signal: AbortSignal): void => {
    if (round) return; // a status during a round is the same news; the round already says it
    round = true;
    sync();
    const started = performance.now();
    let ramp: ((rate: number) => void) | null = null;
    let roundFrame = 0; // this round's own frame, not the busy sync's
    // Collected on the first frame, after the loading switch has re-timed the animations.
    const step = (): void => {
      if (signal.aborted) return;
      if (ramp === null) {
        const anims = painted?.animations() ?? null;
        ramp = anims === null ? () => {} : (rate) => anims.forEach((a) => a.updatePlaybackRate(rate));
      }
      const elapsed = performance.now() - started;
      ramp(spinRate(elapsed));
      if (elapsed < ORBIT_TURN_MS) roundFrame = requestAnimationFrame(step);
    };
    roundFrame = requestAnimationFrame(step);
    const timer = setTimeout(() => {
      cancelAnimationFrame(roundFrame);
      ramp?.(1); // back to rate 1 BEFORE the switch back, which carries the phase at rate 1
      round = false;
      sync();
    }, ORBIT_TURN_MS);
    signal.addEventListener(
      "abort",
      () => {
        cancelAnimationFrame(roundFrame);
        clearTimeout(timer);
      },
      { once: true },
    );
  };

  const mount = (host: HTMLSpanElement, signal: AbortSignal): void => {
    painted = paint(host);
    trouble = connection.state.trouble;
    lost = connection.state.lost;
    working = busy.view.orbit;
    sync();
    connection.subscribe(readConnection, signal);
    busy.addEventListener("change", readBusy, { signal });
    let seen = status.get()?.id ?? 0;
    status.subscribe(() => {
      const id = status.get()?.id ?? 0;
      if (id === 0 || id === seen) return;
      seen = id;
      startRound(signal);
    }, signal);
  };

  return () => {
    const label = !trouble
      ? (handle.props.label ?? t("nav.home.aria.default"))
      : lost
        ? t("nav.home.aria.lost")
        : t("nav.home.aria.reconnecting");
    return (
      <button
        type="button"
        data-testid="header-home"
        aria-label={label}
        class={cn("-mx-1 flex items-center rounded px-1 transition-opacity active:opacity-70")}
        mix={on("click", () => handle.props.onActivate())}
      >
        <span data-slot="collie-mark" class="grid size-11 shrink-0 place-items-center" mix={ref(mount)} />
      </button>
    );
  };
}

export interface CollieMarkProps {
  /** Width and height in px. Read once, when the drawing is painted. */
  size?: number;
  /** While something is fetching: the orbit turns fast and the accents come to full chroma. */
  loading?: boolean;
  /** Not connected: still, dimmed and grey. Wins over `loading`. */
  lost?: boolean;
  /** The ground the mark sits on: the knockout colour that puts a near bead in front of the head. */
  paper?: string;
  class?: string;
}

/**
 * The mark as a sized picture (web's `<CollieMark size weight="header" paper />`): the boot splash,
 * the idle cover and the tour. Painted ONCE into a host with no vdom children, so a re-render never
 * restarts its animations; `loading` and `lost` are classes on that same DOM, set after each commit.
 */
export function CollieMark(handle: Handle<CollieMarkProps>) {
  let painted: Painted | null = null;
  const apply = (): void => {
    const { loading = false, lost = false } = handle.props;
    painted?.setLost(lost);
    painted?.setLoading(loading && !lost);
  };
  const mount = (host: HTMLSpanElement, signal: AbortSignal): void => {
    painted = paint(host, handle.props.size ?? 64, handle.props.paper ?? "var(--background)");
    apply();
    signal.addEventListener("abort", () => (painted = null), { once: true });
  };
  return () => {
    handle.queueTask(apply);
    const size = handle.props.size ?? 64;
    return (
      <span
        data-slot="collie-mark"
        aria-hidden="true"
        class={cn("grid shrink-0 place-items-center", handle.props.class)}
        style={{ width: `${String(size)}px`, height: `${String(size)}px` }}
        mix={ref(mount)}
      />
    );
  };
}
