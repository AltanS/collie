// The app itself, walked. DEV-ONLY, like the rest of `src/playground/`.
//
// WHY THIS REPLACED A PLACEHOLDER CARD. What sat here before was the real shell (`StripHost`,
// `AppHeaderHost`, `ScreenTransition`) around two placeholder screens, and it moved beautifully:
// nothing to load, nothing to portal, nothing to poll. The app does not move like that, so the card
// answered a question nobody asks. This one mounts the real route table (harness.tsx's
// `createFullAppRouter`) so a move here costs what a move costs: the loader, the route component,
// its header portal, and the 240ms slide over the top of all of it.
//
// The buttons are shortcuts, not the subject. Tapping an agent row, a space, the header's back
// arrow or a strip navigates the same router, and those are the moves worth watching.

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  crewPath,
  historyPath,
  homePath,
  panePath,
  settingsPath,
  spacePath,
  updatesPath,
} from "@/lib/nav";
import { ALL_PARAM, HOST_PARAM, SESSION_PARAM } from "@/lib/scope";
import { clearStatus } from "@/lib/status";
import { clearUpdateStarted } from "@/lib/update-ribbon";
import { __resetReloadGuard } from "@/lib/reload-guard";
import { __resetSelfUpdate } from "@/lib/self-update";

import { Card, FullAppRouter, PhoneFrame, createFullAppRouter } from "../harness";
import { censusTrio, devicesPaired } from "../fixtures";
import { SlowStage } from "./motion-harness";
import {
  WALKTHROUGH_HOST,
  WALKTHROUGH_PANE_ID,
  WALKTHROUGH_SESSION,
  WALKTHROUGH_SPACE_ID,
  walkthroughHistory,
  walkthroughHome,
  walkthroughScreen,
} from "./walkthrough-fixtures";

/** How long after a move the meter samples frames. Long enough to cover the 240ms slide and the
 *  paint that follows it, short enough that the next tap starts a fresh reading. */
const METER_WINDOW_MS = 600;
/** A frame slower than this is counted. Two 60Hz frames plus a little: a gap a hand can feel. */
const JANK_MS = 32;

interface Meter {
  frames: number;
  longestMs: number;
  overBudget: number;
}

interface Trail {
  /** Where the router is now, path and query together. */
  path: string;
  /** Where it came from, or null before the first move. */
  from: string | null;
  /** Why a move that landed on the dashboard landed there, when the query says why. */
  reason: string | null;
  meter: Meter | null;
}

/** A router location as one readable address. `search` carries the machine and the session. */
function addressFrom(location: { pathname: string; search: string }): string {
  return `${location.pathname}${location.search}`;
}

/** One address, split the way the app reads it: a path, a machine, a session, a breadth. */
interface Address {
  pathname: string;
  host: string;
  session: string;
  all: boolean;
}

function addressOf(location: string): Address {
  const [pathname = "/", search = ""] = location.split("?", 2);
  const params = new URLSearchParams(search);
  return {
    // An absent `?h=` IS the lead, and an absent `?s=` IS the primary session (lib/scope.ts), so the
    // defaults are filled in here rather than compared as blanks. Otherwise the first switch would
    // read as "host  → workshop" and the switch back would read as no change at all.
    pathname,
    host: params.get(HOST_PARAM) ?? WALKTHROUGH_HOST,
    session: params.get(SESSION_PARAM) ?? WALKTHROUGH_SESSION,
    all: params.get(ALL_PARAM) === "1",
  };
}

/**
 * Why a move landed on the dashboard, when the query answers it.
 *
 * Some moves out of a pane or a space go to `/` BY DESIGN, and the app is right to do it: switching
 * machine or session changes the address the whole page is read at, and a pane id belongs to one
 * machine and one session, so there is nothing to carry across. Read as a bare route line that looks
 * like the app throwing you out. This line is the difference, and it changes no app behaviour: it
 * only says out loud what the query already said.
 */
function moveReason(from: string, to: string): string | null {
  const before = addressOf(from);
  const after = addressOf(to);
  if (after.pathname !== "/") return null;
  if (before.host !== after.host) {
    return `scope change: host ${before.host} → ${after.host}, lands on that host's dashboard`;
  }
  if (before.session !== after.session) {
    return `scope change: session ${before.session} → ${after.session}, lands on that session's dashboard`;
  }
  if (before.all !== after.all) {
    const breadth = after.all ? "every session" : "this session only";
    return `breadth change: ${breadth}, lands on the dashboard`;
  }
  return null;
}

/**
 * The router's location, the one before it, and a frame reading for the move between them.
 *
 * WHAT THE METER MEASURES, exactly: `requestAnimationFrame` deltas on THIS tab's main thread for
 * `METER_WINDOW_MS` after a navigation starts. Every other card on this page is mounted in the same
 * tab, so the number is the playground's main thread and not a phone's. It is useful as a
 * comparison between two moves made a second apart, and it is not a benchmark.
 */
function useWalkthroughTrail(router: ReturnType<typeof createFullAppRouter>): Trail {
  const [trail, setTrail] = useState<Trail>(() => ({
    path: addressFrom(router.state.location),
    from: null,
    reason: null,
    meter: null,
  }));
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let lastKey = router.state.location.key;
    let lastPath = addressFrom(router.state.location);

    const sample = (): void => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      const start = performance.now();
      let previous = start;
      let frames = 0;
      let longestMs = 0;
      let overBudget = 0;
      const step = (now: number): void => {
        const delta = now - previous;
        previous = now;
        frames += 1;
        if (delta > longestMs) longestMs = delta;
        if (delta > JANK_MS) overBudget += 1;
        if (now - start < METER_WINDOW_MS) {
          frameRef.current = requestAnimationFrame(step);
          return;
        }
        frameRef.current = null;
        if (cancelled) return;
        setTrail((prev) => ({ ...prev, meter: { frames, longestMs, overBudget } }));
      };
      frameRef.current = requestAnimationFrame(step);
    };

    const unsubscribe = router.subscribe((state) => {
      // A revalidation (the poll loop RootLayout drives) re-runs the loaders at the same location
      // and keeps the same key. Only a real move resets the readout and the meter.
      if (state.location.key === lastKey) return;
      lastKey = state.location.key;
      const from = lastPath;
      lastPath = addressFrom(state.location);
      setTrail({ path: lastPath, from, reason: moveReason(from, lastPath), meter: null });
      sample();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [router]);

  return trail;
}

/**
 * Leave every module store the routes write behind them clean.
 *
 * The routes below publish a status line (a pane closing under you, a failed action), stamp the
 * update ribbon's "started at", and take reload holds while a composer has text in it. All three
 * outlive an unmount by design, so switching tabs would carry this card's leavings onto every other
 * card on the page. The shared connection clock is deliberately NOT reset: it is the page's own
 * top-bar control, and this card is one of its readers, not its owner.
 */
function useWalkthroughCleanup(): void {
  useEffect(() => {
    return () => {
      clearStatus();
      clearUpdateStarted();
      __resetReloadGuard();
      __resetSelfUpdate();
    };
  }, []);
}

interface Move {
  label: string;
  to: string;
}

// Built by `lib/nav`, not typed out: those helpers encode the pane id (`w1:p2` becomes `w1%3Ap2`)
// and carry the scope, so a button that spelled its own path would move the router to a URL no tap
// in the app can produce, and the readout would disagree with itself between the two.
const MOVES: readonly Move[] = [
  { label: "Dashboard", to: homePath() },
  { label: "Space", to: spacePath(WALKTHROUGH_SPACE_ID) },
  { label: "Pane", to: panePath(WALKTHROUGH_PANE_ID) },
  { label: "History", to: historyPath(WALKTHROUGH_PANE_ID) },
  { label: "Crew", to: crewPath() },
  { label: "Settings", to: settingsPath() },
  { label: "Updates", to: updatesPath() },
];

function meterLine(meter: Meter | null): string {
  if (!meter) return "last move: not measured yet";
  return `last move: ${meter.frames} frames, longest gap ${Math.round(meter.longestMs)} ms, ${meter.overBudget} frames over ${JANK_MS} ms`;
}

export function AppWalkthroughCard() {
  const [router] = useState(() =>
    createFullAppRouter({
      home: walkthroughHome,
      screenFor: walkthroughScreen,
      crew: { status: censusTrio, error: false },
      devices: devicesPaired,
      history: walkthroughHistory,
    }),
  );
  const trail = useWalkthroughTrail(router);
  useWalkthroughCleanup();

  return (
    <Card
      state="app-walkthrough"
      label="the app, walked (dashboard, space, pane, history, crew, settings)"
      reach="the app itself. Any tap that changes the screen: an agent row, a space, the header's back arrow, a strip chip, the crew link in the footer."
      note={`Real: every route component, the shell around them (the band, the one header, the 240ms ScreenTransition), the route ids the app reads its data by, the loaders' result shapes, the address in the query, and the poll loop the root layout runs. Not real: the loaders themselves, which return fixtures instead of fetching. Every pane in this snapshot lives on ${WALKTHROUGH_HOST}, the lead, so the space and tab strips are complete: the space navigator is lead-local by design, and the two peers in the roster hold no panes here. Switching host or session is a change of address, so it lands on that machine's dashboard, and the line above says so when it happens. /api answers 503 in the playground, so the connection state you see is the page's own top-bar clock control, and there is no service worker here. The frame meter samples this tab's main thread, not a phone's, and every other card on this page shares that thread.`}
      span={2}
    >
      <div className="mb-2 flex flex-col gap-2">
        {/* `data-slot`, the same handle `ui/collapse.tsx` carries and the same one the vitest case
            reads: the label and the reach line above are also plain <p>s, so "the route readout" has
            to be addressable as itself. It wraps the CURRENT path only, so a case asking what is on
            screen never matches the dimmed one behind it. */}
        <p className="font-mono text-[11px] text-foreground">
          <span data-slot="walkthrough-route">route: {trail.path}</span>
          {trail.from !== null && (
            <span className="ml-2 text-muted-foreground">from {trail.from}</span>
          )}
        </p>
        {trail.reason !== null && (
          <p data-slot="walkthrough-reason" className="font-mono text-[11px] text-status-working">
            {trail.reason}
          </p>
        )}
        <p className="font-mono text-[11px] text-muted-foreground">{meterLine(trail.meter)}</p>
        <div className="flex flex-wrap gap-2">
          {MOVES.map((move) => (
            <Button
              key={move.to}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => void router.navigate(move.to)}
            >
              {move.label}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => void router.navigate(-1)}
          >
            Back
          </Button>
        </div>
      </div>
      <SlowStage>
        <PhoneFrame height={720}>
          <FullAppRouter router={router} />
        </PhoneFrame>
      </SlowStage>
    </Card>
  );
}
