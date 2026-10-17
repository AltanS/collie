// The composer's thirteen states of the way out (M56 spec 07), one numbered card each; the section that
// shows them is sections/composer-states.tsx. See app.tsx's header for the page's own rules, and test/way-out-states.ts for the table every card is drawn from:
// the same table the way-out tests read, so a card, a test and a placeholder talk about one state.
//
// Every card mounts the REAL `Composer` on a Claude pane with the Surface and the three facts of its
// state. Nothing here redraws the composer. Writes go nowhere (there is no bridge behind this page), so
// a Send tap answers "No answer" at the thumb, which is itself a state worth seeing; the Keys dock and
// the Screen pill are real and answer in one tap.
//
// Cards are numbered, 1 to 13, so a worker can be briefed by number ("card 4 is modal unreadable").
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect, useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Composer } from "@/components/composer";
import { markLive } from "@/lib/liveness";
import { wayOutCase, type WayOutCase } from "@/test/way-out-states";
import type { WayOutState } from "@/lib/way-out";

import { Card, CardControls, Group } from "./layout";
import { ChromeBlock, PhoneMock } from "./sections/shared";

/** The same prefs `composer.test.tsx` mounts the real composer with. */
const PREFS = {
  wrap: true,
  fontSize: 11,
  draftFontSize: 14,
  chatFontSize: 14,
  fontFamily: "system",
  rawTerminal: false,
  tapToFocus: true,
  expandClippedReply: true,
  stretchText: false,
} as const;

function NumberBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-lg font-bold leading-none text-background"
    >
      {n}
    </span>
  );
}

/** How often a live pane's stamp is renewed, so a card left open does not lapse into "offline" (the cap is 90 s). */
const RENEW_MS = 5_000;

/** One card's phone: a strip of fake terminal, then the chrome block with the belt and the box. */
function WayOutPhone({ c }: { c: WayOutCase }) {
  const paneId = `way-out:${c.state}`;
  const [screenOn, setScreenOn] = useState(false);
  const [answered, setAnswered] = useState(false);
  // The stamp the composer reads for "live" and for the age of a read. An offline card never gets one.
  useEffect(() => {
    if (c.offline) return;
    const stamp = () => markLive(paneId, Date.now() - c.readAgeMs);
    stamp();
    const timer = setInterval(stamp, RENEW_MS);
    return () => clearInterval(timer);
  }, [c.offline, c.readAgeMs, paneId]);
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <ChromeBlock>
              <Composer
                paneId={paneId}
                agent="claude"
                isShell={false}
                gone={c.gone}
                readOnly={c.readOnly}
                surface={c.surface}
                unreachableNote={c.unreachableNote}
                stale={c.offline}
                text="pane output"
                terminalDraft={null}
                rawTerminalDraft={null}
                prefs={PREFS}
                display={{ open: false, onToggle: () => {} }}
                onSent={() => {}}
                onAnswerDialog={() => setAnswered(true)}
                screen={{ on: screenOn, onToggle: () => setScreenOn((on) => !on) }}
              />
            </ChromeBlock>
          ),
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return (
    <div>
      <PhoneMock>
        <div className="h-16 bg-background px-3 pt-2 font-mono text-[11px] text-muted-foreground">
          {screenOn ? "raw rows, no cards (the Screen pill is on)" : "terminal output above the belt"}
        </div>
        <RouterProvider router={router} />
      </PhoneMock>
      {answered && <p className="mt-1 font-mono text-[11px] text-muted-foreground">Answer the dialog scrolled to the card.</p>}
    </div>
  );
}

function WayOutCard({ state, c }: { state: string; c: WayOutCase }) {
  return (
    <Card
      state={state}
      label={`${c.n}: ${c.title}`}
      reach={c.reach}
      note="Real <Composer/>, Surface and facts from test/way-out-states.ts. Writes go nowhere on this page."
    >
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={c.n} />
        <p className="text-sm font-semibold text-foreground">
          {c.n}: {c.title}
        </p>
      </CardControls>
      <WayOutPhone c={c} />
    </Card>
  );
}

const of = (state: WayOutState): WayOutCase => wayOutCase(state);

/**
 * The section's groups, as elements for `Section` to take as direct children (a group is a sub-page of
 * its section, and the bar reads them off the children). The section itself is `sections/composer-states.tsx`
 * so the registry's one-file-per-section rule holds; the cards live here.
 */
export function wayOutGroups(): ReactNode[] {
  return [
    <Group key="surface" title="The Surface">
      {/* Literal handles, written out: the e2e roll call reads the state props from source. */}
      <WayOutCard state="way-out-free" c={of("free")} />
      <WayOutCard state="way-out-draft" c={of("draft")} />
      <WayOutCard state="way-out-ask" c={of("ask")} />
      <WayOutCard state="way-out-unreadable" c={of("unreadable")} />
      <WayOutCard state="way-out-running" c={of("running")} />
      <WayOutCard state="way-out-no-match" c={of("no-match")} />
      <WayOutCard state="way-out-contested" c={of("contested")} />
      <WayOutCard state="way-out-stale" c={of("stale")} />
      <WayOutCard state="way-out-torn" c={of("torn")} />
      <WayOutCard state="way-out-unreachable" c={of("unreachable")} />
    </Group>,
    <Group key="facts" title="The facts the phone keeps">
      <WayOutCard state="way-out-gone" c={of("gone")} />
      <WayOutCard state="way-out-read-only" c={of("readOnly")} />
      <WayOutCard state="way-out-offline" c={of("offline")} />
    </Group>,
  ];
}
