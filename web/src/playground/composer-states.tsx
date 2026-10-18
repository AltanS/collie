// The composer's thirteen states of the way out (M56 spec 07), one numbered card each, and the five
// states of the held-send card (14 to 18, ADR 0061 amended 2026-10-18); the section that shows them is
// sections/composer-states.tsx. See app.tsx's header for the page's own rules, and test/way-out-states.ts for the table every way-out card is drawn from:
// the same table the way-out tests read, so a card, a test and a placeholder talk about one state.
//
// Every card mounts the REAL `Composer` on a Claude pane with the Surface and the three facts of its
// state. Nothing here redraws the composer. Writes go nowhere (there is no bridge behind this page), so
// a Send tap answers "No answer" at the thumb, which is itself a state worth seeing; the Keys dock and
// the Screen pill are real and answer in one tap.
//
// Cards are numbered, 1 to 18, so a worker can be briefed by number ("card 4 is modal unreadable").
//
// DEV-ONLY, unreachable from the app entry.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Composer } from "@/components/composer";
import { markLive } from "@/lib/liveness";
import type { HeldRow } from "@/lib/surface/send";
import { wayOutCase, type WayOutCase } from "@/test/way-out-states";
import type { WayOutState } from "@/lib/way-out";

import { cn } from "@/lib/utils";

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

// ── THE HELD-SEND CARD (14 to 18) ───────────────────────────────────────────────────────────────────
// A send the bridge holds while the agent's turn runs floats over the mirror's bottom edge as ONE card.
// These cards mount the real Composer on a Claude pane with the rows the snapshot would carry, inside a
// mirror box that keeps the same absolute notice slot the pane view keeps (agent-chat.tsx), so the card
// covers fake terminal text and holds no space. Writes go nowhere on this page: Cancel, Resend and the
// rest reach no bridge, but Show all and Show less are real.

const NOW = 1_700_000_000_000;
function heldRow(n: number, state: HeldRow["state"], text: string, extra: Partial<HeldRow> = {}): HeldRow {
  return { requestId: `held-${String(n)}`, mode: "send", text, heldAt: NOW, expiresAt: NOW + 30 * 60_000, state, ...extra };
}

const ONE_HELD = [heldRow(1, "held", "Run the full test suite when you are done, then fix whatever fails.")];
const THREE_HELD = [
  heldRow(1, "held", "Run the full test suite when you are done, then fix whatever fails."),
  heldRow(2, "held", "Then update the changelog line for the queue card."),
  heldRow(3, "held", "After that, open the pull request with a short description of the change and the gates you ran."),
];
const MIXED = [
  heldRow(1, "ended", "Run the full test suite when you are done, then fix whatever fails.", { outcome: "expired" }),
  heldRow(2, "held", "Then update the changelog line for the queue card."),
  heldRow(3, "held", "After that, open the pull request with a short description of the change."),
];

const MIRROR_LINES = [
  "● Read(web/src/components/composer-held.tsx)",
  "  ⎿  Read 143 lines",
  "",
  "● Read(web/src/components/queued-block.ts)",
  "  ⎿  Read 27 lines",
  "",
  "● Update(web/src/components/composer.tsx)",
  "  ⎿  Updated web/src/components/composer.tsx with 14 additions",
  "     and 3 removals",
  "",
  "● Bash(cd web && bun run typecheck)",
  "  ⎿  Found 0 errors",
  "",
  "● Bash(bunx vitest run src/components)",
  "  ⎿  Test Files  41 passed (41)",
  "     Tests  1132 passed (1132)",
  "",
  "● The held rows now float over the mirror, so a",
  "  queued send moves nothing. Running the rest of",
  "  the gates before I report.",
];

/**
 * What the router's element needs and cannot be given as props: the router is built once, so the slot
 * (known after the mirror box mounts) and the rows reach the composer through this context.
 */
const HeldStageContext = createContext<{ slot: HTMLElement | null; held: readonly HeldRow[] }>({ slot: null, held: [] });

function HeldComposer({ paneId, draft }: { paneId: string; draft?: string }) {
  const { slot, held } = useContext(HeldStageContext);
  return (
    <ChromeBlock>
      <Composer
        paneId={paneId}
        agent="claude"
        isShell={false}
        gone={false}
        readOnly={false}
        surface={{ revision: 1, turn: "running", modal: "none", composer: "empty" }}
        text="pane output"
        terminalDraft={draft ?? null}
        rawTerminalDraft={draft ?? null}
        prefs={PREFS}
        display={{ open: false, onToggle: () => {} }}
        onSent={() => {}}
        held={held}
        draftNoticeSlot={slot}
      />
    </ChromeBlock>
  );
}

function HeldPhone({ paneId, held, draft, showAll = false }: { paneId: string; held: readonly HeldRow[]; draft?: string; showAll?: boolean }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // A live stamp, renewed, so the card is not drawn over an "offline" composer.
  useEffect(() => {
    const stamp = () => markLive(paneId);
    stamp();
    const timer = setInterval(stamp, RENEW_MS);
    return () => clearInterval(timer);
  }, [paneId]);
  // The expanded card is the real Show all tap, taken once for you when the card has mounted.
  useEffect(() => {
    if (!showAll || slot === null) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const toggle = slot.querySelector<HTMLButtonElement>('[data-slot="held-card"] button[aria-expanded="false"]');
      if (toggle !== null) toggle.click();
      if (toggle !== null || tries >= 100) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [showAll, slot]);
  const stage = useMemo(() => ({ slot, held }), [slot, held]);
  const [router] = useState(() =>
    createMemoryRouter([{ path: "/", element: <HeldComposer paneId={paneId} {...(draft === undefined ? {} : { draft })} /> }], { initialEntries: ["/"] }),
  );
  return (
    <PhoneMock>
      {/* Tall enough for the open list, which is the card that needs the most room. */}
      <div className={cn("relative overflow-hidden bg-background px-3 pt-2 font-mono text-[11px] leading-snug text-muted-foreground", showAll ? "h-[26rem]" : "h-72")}>
        <div className="whitespace-pre">{MIRROR_LINES.join("\n")}</div>
        <div ref={setSlot} data-slot="draft-notice-slot" className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-2" />
      </div>
      <HeldStageContext.Provider value={stage}>
        <RouterProvider router={router} />
      </HeldStageContext.Provider>
    </PhoneMock>
  );
}

function HeldCardCase({ n, state, title, reach, note, paneId, held, draft, showAll }: { n: number; state: string; title: string; reach: string; note?: string; paneId: string; held: readonly HeldRow[]; draft?: string; showAll?: boolean }) {
  return (
    <Card state={state} label={`${String(n)}: ${title}`} reach={reach} {...(note === undefined ? {} : { note })}>
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={n} />
        <p className="text-sm font-semibold text-foreground">
          {n}: {title}
        </p>
      </CardControls>
      <HeldPhone paneId={paneId} held={held} {...(draft === undefined ? {} : { draft })} {...(showAll === undefined ? {} : { showAll })} />
    </Card>
  );
}

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
    <Group key="held" title="The held sends">
      <HeldCardCase
        n={14}
        state="held-one-row"
        title="One held row"
        reach="Send to an agent that is still working. The bridge holds the send and the card floats over the mirror's bottom edge."
        paneId="held:one"
        held={ONE_HELD}
      />
      <HeldCardCase
        n={15}
        state="held-three-collapsed"
        title="Three held, collapsed"
        reach="Send twice more while the first is held. Two or more fold into a count, the first text and a Show all toggle."
        paneId="held:collapsed"
        held={THREE_HELD}
      />
      <HeldCardCase
        n={16}
        state="held-three-expanded"
        title="Three held, expanded"
        reach="Tap Show all on a queue of three or more. Each row has its own Cancel; a long queue scrolls inside the card."
        note="The Show all tap is taken for you once the card has mounted. Tap Show less to fold it."
        paneId="held:expanded"
        held={THREE_HELD}
        showAll
      />
      <HeldCardCase
        n={17}
        state="held-mixed"
        title="Mixed: one ended, two held"
        reach="A held send ran out its 30 minutes while two later ones still wait. The head wears the first row's own label, not a count."
        paneId="held:mixed"
        held={MIXED}
      />
      <HeldCardCase
        n={18}
        state="held-with-draft-notice"
        title="Held card over the terminal-draft notice"
        reach="Type on the terminal's own input line while a send is held. Both float in one column: the held card on top, the draft notice nearest the belt."
        paneId="held:draft"
        held={ONE_HELD}
        draft="bun run build -- --watch"
      />
    </Group>,
  ];
}
