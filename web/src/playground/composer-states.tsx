// The composer's thirteen states of the way out (M56 spec 07), one numbered card each, the five
// states of the held-send card (14 to 18, ADR 0061 amended 2026-10-18), and the belt's Agents pill
// at 2, its sheet, at 0, and right of the X with a draft in the box (19 to 22); the section that shows them is
// sections/composer-states.tsx. See app.tsx's header for the page's own rules, and test/way-out-states.ts for the table every way-out card is drawn from:
// the same table the way-out tests read, so a card, a test and a placeholder talk about one state.
//
// Every card mounts the REAL `Composer` on a Claude pane with the Surface and the three facts of its
// state. Nothing here redraws the composer. Writes go nowhere (there is no bridge behind this page), so
// a Send tap answers "No answer" at the thumb, which is itself a state worth seeing; the Keys dock and
// the Screen pill are real and answer in one tap.
//
// Cards 26 to 32 are the stop cards (M102 spec 02): the real notice and its real buttons, read from a
// refusal by the phone's own reader, one card per kind of step.
//
// Cards are numbered, 1 to 32, so a worker can be briefed by number ("card 4 is modal unreadable").
//
// DEV-ONLY, unreachable from the app entry.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CannotTellCard } from "@/components/cannot-tell-card";
import { Composer } from "@/components/composer";
import { ReceiptQueueCards, SessionStream } from "@/components/session-stream";
import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { EMPTY_CHAT_WINDOW } from "@/lib/chat-window";
import { addPending, dropPending } from "@/lib/durable-pending";
import { readingRefusal, RefusalActions, SendRefusalNotice, stepLabel } from "@/components/send-notice";
import { readSend, type SendReply } from "@/lib/send-protocol";
import { SecretField } from "@/components/secret-field";
import { UnreadDialogBlock } from "@/components/unread-dialog-block";
import { parseAnsi } from "@/lib/ansi";
import { splitLines, type UnreadDialogModel } from "@/lib/blocks";
import { SubagentSheet } from "@/components/subagent-sheet";
import { t } from "@/lib/i18n";
import type { PaneSubagent, PaneTodo, QueuedSendRow } from "@/lib/types";
import { markLive } from "@/lib/liveness";
import { saveDraft } from "@/lib/drafts";
import { forgetUnknownSend } from "@/lib/send-again";
import { clearIntent } from "@/lib/send-intent";
import { ANOTHER_SEND, offersFor, type HeldRow, type SendOutcome, type SendReason } from "@/lib/surface/send";
import type { Surface } from "@/lib/surface/surface";
import type { Scope } from "@/lib/scope";
import { wayOutCase, type WayOutCase } from "@/test/way-out-states";
import type { WayOutState } from "@/lib/way-out";

import { cn } from "@/lib/utils";

import { Card, CardControls, Group } from "./layout";
import { fakeSendBridge, playSendConfirm, type SendConfirmKind } from "./send-confirm-play";
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

// ── THE HELD-SEND CARD (14 to 19) ───────────────────────────────────────────────────────────────────
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
/** A row that waited two minutes in the hold (M102 spec 12): the bridge marks it `heldLong`. */
const LONG_HELD = [heldRow(1, "held", "Run the full test suite when you are done, then fix whatever fails.", { heldLong: true, heldAt: NOW - 120_000, cause: "turn_running" })];
const MIXED = [
  heldRow(1, "ended", "Run the full test suite when you are done, then fix whatever fails.", { outcome: "expired" }),
  heldRow(2, "held", "Then update the changelog line for the queue card."),
  heldRow(3, "held", "After that, open the pull request with a short description of the change."),
];

/** A crew member's pane (issue 740): a send that ran out its 30 minutes, and one still held. */
const MEMBER = [
  heldRow(1, "ended", "Run the full test suite when you are done, then fix whatever fails.", { outcome: "expired" }),
  heldRow(2, "held", "Then update the changelog line for the queue card."),
];
/** The crew member these cards stand on. */
const MEMBER_SCOPE: Scope = { host: "badger" };

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
const HeldStageContext = createContext<{ slot: HTMLElement | null; held: readonly HeldRow[]; screen: boolean }>({ slot: null, held: [], screen: false });

/** The pane's screen as the composer is handed it, for a long row's screen box. */
const HELD_SCREEN = { lines: splitLines(parseAnsi(["● Bash(bun run build)", "  ⎿  Running…", "", "✻ Working (3m 12s · esc to interrupt)"].join("\n"))), wrap: false };

function HeldComposer({ paneId, draft, scope }: { paneId: string; draft?: string; scope?: Scope }) {
  const { slot, held, screen } = useContext(HeldStageContext);
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
        {...(screen ? { heldScreen: HELD_SCREEN } : {})}
        draftNoticeSlot={slot}
        {...(scope === undefined ? {} : { scope })}
      />
    </ChromeBlock>
  );
}

function HeldPhone({ paneId, held, draft, scope, showAll = false, screen = false }: { paneId: string; held: readonly HeldRow[]; draft?: string; scope?: Scope; showAll?: boolean; screen?: boolean }) {
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
  const stage = useMemo(() => ({ slot, held, screen }), [slot, held, screen]);
  const [router] = useState(() =>
    createMemoryRouter([{ path: "/", element: <HeldComposer paneId={paneId} {...(draft === undefined ? {} : { draft })} {...(scope === undefined ? {} : { scope })} /> }], { initialEntries: ["/"] }),
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

function HeldCardCase({ n, state, title, reach, note, paneId, held, draft, scope, showAll, screen }: { n: number; state: string; title: string; reach: string; note?: string; paneId: string; held: readonly HeldRow[]; draft?: string; scope?: Scope; showAll?: boolean; screen?: boolean }) {
  return (
    <Card state={state} label={`${String(n)}: ${title}`} reach={reach} {...(note === undefined ? {} : { note })}>
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={n} />
        <p className="text-sm font-semibold text-foreground">
          {n}: {title}
        </p>
      </CardControls>
      <HeldPhone paneId={paneId} held={held} {...(draft === undefined ? {} : { draft })} {...(scope === undefined ? {} : { scope })} {...(showAll === undefined ? {} : { showAll })} {...(screen === undefined ? {} : { screen })} />
    </Card>
  );
}

// ── THE BELT'S LISTS (20 to 23) ─────────────────────────────────────────────────────────────────────
// The agents mark: the count of the pane's subagents that have not finished yet, above a small Bot
// glyph in the belt's fixed block, right of the X and left of Files and the Switch mark. Tasks stays on
// the scrolling run. Card 22 is the same belt with no subagent running, so the mark is absent and
// nothing else moves; card 23 has a draft in the box, so the X stands left of the mark. Card 20 has a
// toggle that takes the subagents away and brings them back, to watch the mark ease out and in. Card
// 21 is the tap on the mark: the Agents sheet over the page, with nothing in flow moving. The real
// Composer inside the real subagent sheet's provider, so a row tap opens the same sheet an Agent card
// in Chat opens, over the list. There is no bridge behind this page, so the sheet answers that it cannot read
// the transcript; that is the sheet's own state for an unreadable log.

const BELT_TODOS: PaneTodo[] = [
  { id: "1", text: "Read the todo tracker", status: "completed" },
  { id: "2", text: "Wire the subagent tracker", status: "in_progress" },
  { id: "3", text: "Run the gates", status: "pending" },
];

const BELT_SUBAGENTS: PaneSubagent[] = [
  { agentId: "acc7972eef92651f4", agentType: "general-purpose", model: "opus", description: "Agents pill on the belt", startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), spawnDepth: 1 },
  { agentId: "a71a608a981ceee4a", agentType: "Explore", model: "inherit", description: "Find every caller of the todo tracker and say which ones read it at serialise time", startedAt: new Date(Date.now() - 40_000).toISOString(), spawnDepth: 1 },
];

/** Whether a belt card's subagents are running; card 19's toggle flips it, through this context. */
const BeltAgentsContext = createContext(true);

function BeltListsComposer({ paneId }: { paneId: string }) {
  const agents = useContext(BeltAgentsContext);
  return (
    <SubagentSheet paneId={paneId}>
      <ChromeBlock>
        <Composer
          paneId={paneId}
          agent="claude"
          isShell={false}
          gone={false}
          readOnly={false}
          surface={{ revision: 1, turn: "running", modal: "none", composer: "empty" }}
          text="pane output"
          terminalDraft={null}
          rawTerminalDraft={null}
          prefs={PREFS}
          display={{ open: false, onToggle: () => {} }}
          onSent={() => {}}
          todos={BELT_TODOS}
          subagents={agents ? BELT_SUBAGENTS : undefined}
          // The fixed block's two neighbours, as the pane view passes them; taps go nowhere here.
          changesPill={{ onClick: () => {}, label: t("chat.changes.label") }}
          pullHandle={{ ref: () => {}, onClick: () => {}, label: t("chat.switcher.aria") }}
          screen={{ on: false, onToggle: () => {} }}
        />
      </ChromeBlock>
    </SubagentSheet>
  );
}

function BeltListsPhone({ paneId, agents = true, draft }: { paneId: string; agents?: boolean; draft?: string }) {

  useEffect(() => {
    const stamp = () => markLive(paneId);
    stamp();
    const timer = setInterval(stamp, RENEW_MS);
    return () => clearInterval(timer);
  }, [paneId]);
  const [router] = useState(() => {
    // A draft in the box is what puts the X on the fixed block. Saved before the composer mounts, so
    // it loads it as a draft the operator left there.
    if (draft !== undefined) saveDraft(undefined, paneId, draft);
    return createMemoryRouter([{ path: "/", element: <BeltListsComposer paneId={paneId} /> }], { initialEntries: ["/"] });
  });
  return (
    <PhoneMock>
      <div>
        <div className="h-16 bg-background px-3 pt-2 font-mono text-[11px] text-muted-foreground">terminal output above the belt</div>
        <BeltAgentsContext.Provider value={agents}>
          <RouterProvider router={router} />
        </BeltAgentsContext.Provider>
      </div>
    </PhoneMock>
  );
}

function BeltListsCase({ n, state, title, reach, note, paneId, agents = true, draft, toggle = false }: { n: number; state: string; title: string; reach: string; note?: string; paneId: string; agents?: boolean; draft?: string; toggle?: boolean }) {
  const [running, setRunning] = useState(agents);
  return (
    <Card state={state} label={`${String(n)}: ${title}`} reach={reach} {...(note === undefined ? {} : { note })}>
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={n} />
        <p className="text-sm font-semibold text-foreground">
          {n}: {title}
        </p>
        {toggle && (
          <button type="button" className="ml-auto min-h-11 rounded-sm border border-border px-3 text-sm" onClick={() => setRunning((on) => !on)}>
            {running ? "Finish them" : "Start them"}
          </button>
        )}
      </CardControls>
      <BeltListsPhone paneId={paneId} agents={running} {...(draft === undefined ? {} : { draft })} />
    </Card>
  );
}

// ── THE SEND QUESTIONS (24 and 25) ──────────────────────────────────────────────────────────────────
// The word that replaces Send for one more tap: "Really send?" on a destructive line, and "Send it again?" for
// the same text after a send that ended unknown (M100 spec 06, approved by Altan 2026-11-13). Arming moves
// nothing: the word is drawn over the field, at the Send button's own spot, with a cover that fades the draft's
// line ends under it. The real Composer, the keyboard stood up under it. A fake bridge answers `/api/send`
// (`unknown` the first time for card 25), and the taps that arm the question are played through the composer's
// own buttons. In the product the question stays 3 seconds; here the card taps again when it has run out,
// so it is always on screen. A tap of your own on the word sends, and the box empties.

const SEND_CONFIRM_TEXT = {
  really: "rm -rf build && bun install, then run the full test suite",
  again: "Run the full test suite, then fix whatever fails.",
} satisfies Record<SendConfirmKind, string>;

/** The prefs of these cards: the composer's own, with the report offer off (each reload of a card sends once). */
const SEND_CONFIRM_PREFS = { ...PREFS, reportOffer: false } as const;

export function SendConfirmPhone({ kind }: { kind: SendConfirmKind }) {
  const paneId = `send-confirm:${kind}`;
  const text = SEND_CONFIRM_TEXT[kind];
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [router] = useState(() => {
    // The draft is stored before the composer mounts, so it opens holding the text; nothing is left of an earlier visit.
    forgetUnknownSend(undefined, paneId);
    clearIntent(undefined, paneId);
    saveDraft(undefined, paneId, text);
    return createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <ChromeBlock>
              <Composer
                paneId={paneId}
                agent="claude"
                isShell={false}
                gone={false}
                readOnly={false}
                surface={{ revision: 1, turn: "idle", modal: "none", composer: "empty" }}
                text="pane output"
                terminalDraft={null}
                rawTerminalDraft={null}
                prefs={SEND_CONFIRM_PREFS}
                display={{ open: false, onToggle: () => {} }}
                onSent={() => {}}
              />
            </ChromeBlock>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
  });
  useEffect(() => {
    const stamp = () => markLive(paneId);
    stamp();
    const timer = setInterval(stamp, RENEW_MS);
    return () => clearInterval(timer);
  }, [paneId]);
  useEffect(() => fakeSendBridge(paneId, kind === "again"), [paneId, kind]);
  useEffect(() => {
    if (root === null) return;
    let stop = false;
    void playSendConfirm(root, kind, text, () => stop);
    return () => {
      stop = true;
    };
  }, [root, kind, text]);
  return (
    <PhoneMock>
      <div ref={setRoot}>
        <div className="h-10 bg-background px-3 pt-2 font-mono text-[11px] text-muted-foreground">terminal output above the belt</div>
        <RouterProvider router={router} />
        <div aria-hidden="true" className="flex h-24 items-center justify-center bg-muted/60 text-[11px] text-muted-foreground">
          keyboard
        </div>
      </div>
    </PhoneMock>
  );
}

function SendConfirmCase({ n, state, title, reach, note, kind }: { n: number; state: string; title: string; reach: string; note: string; kind: SendConfirmKind }) {
  return (
    <Card state={state} label={`${String(n)}: ${title}`} reach={reach} note={note}>
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={n} />
        <p className="text-sm font-semibold text-foreground">
          {n}: {title}
        </p>
      </CardControls>
      <SendConfirmPhone kind={kind} />
    </Card>
  );
}

/** One stop card (M102 spec 02): a refusal as the bridge would answer it, read by the phone's own reader. */
interface StopCase {
  readonly outcome: SendOutcome;
  readonly reason: SendReason;
  readonly surface: Surface | null;
  readonly detail?: string;
  /** The Send again of a refusal for another running send: off, or turned on after the box went free. */
  readonly wait?: "waits" | "ready";
  /** Whether the pane has a card to go to (an ask or an overlay on the screen). */
  readonly card?: boolean;
}

const STOP_FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
/** A button on a stop card goes nowhere: there is no bridge behind this page. */
const none = () => {};

/** The real notice and its real buttons, from the same reader the composer uses; nothing is redrawn. */
function StopCardPhone({ c }: { c: StopCase }) {
  const reply: SendReply = {
    outcome: c.outcome,
    reason: c.reason,
    offers: offersFor(c.outcome, c.reason, true),
    rowsHash: null,
    replayed: false,
    surface: c.surface,
    detail: c.detail ?? null,
    cap: null,
    queued: false,
    cause: null,
  };
  const refusal = readingRefusal(readSend(reply));
  const word = stepLabel(refusal.step);
  return (
    <PhoneMock>
      <div className="bg-background px-3 pt-3 pb-2">
        <SendRefusalNotice
          refusal={refusal}
          onDismiss={none}
          action={
            <RefusalActions
              step={word === null ? null : { word, disabled: c.wait === "waits", onPress: none }}
              wait={c.wait ?? null}
              onCard={c.card === true ? none : null}
              onScreen={refusal.screen && c.card !== true && refusal.step !== "screen" ? none : null}
              onKeys={none}
            />
          }
        />
      </div>
    </PhoneMock>
  );
}

/** The sign-in field's Surface: the screen asks for a code (M102 spec 06). */
const SIGN_IN: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty", field: "secret" };
/** An invented code: clearly not real. */
const SAMPLE_CODE = "EXAMPLE-CODE-1234";
const nothing = () => Promise.resolve(false);
const stay = () => {};

/** The real composer on a pane whose screen asks for a sign-in code: the framed field stands in the box's place. */
function SignInPhone() {
  const paneId = "sign-in:empty";
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
                gone={false}
                readOnly={false}
                surface={SIGN_IN}
                text="pane output"
                terminalDraft={null}
                rawTerminalDraft={null}
                prefs={PREFS}
                display={{ open: false, onToggle: () => {} }}
                onSent={() => {}}
              />
            </ChromeBlock>
          ),
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
  useEffect(() => {
    const stamp = () => markLive(paneId);
    stamp();
    const timer = setInterval(stamp, RENEW_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <PhoneMock>
      <RouterProvider router={router} />
    </PhoneMock>
  );
}

function StopCardCase({ n, state, title, reach, c }: { n: number; state: string; title: string; reach: string; c: StopCase }) {
  return (
    <Card state={state} label={`${String(n)}: ${title}`} reach={reach}>
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={n} />
        <p className="text-sm font-semibold text-foreground">
          {n}: {title}
        </p>
      </CardControls>
      <StopCardPhone c={c} />
    </Card>
  );
}

/** An invented screen Collie cannot read (M102 spec 03): a picker with no grammar of its own. */
const UNREAD_LINES = splitLines(parseAnsi("  Pick a colour theme\n\n  > Dusk\n    Dawn\n    Paper\n\n  Arrows move, return picks"));
const UNREAD_CANCEL: UnreadDialogModel = { key: "Escape", agent: "demo", signature: "demo-picker" };

/** The card itself, the real component: the screen's rows, Esc when the agent declared it, Send anyway. */
function UnreadCardPhone({ cancel, secret = false }: { cancel: UnreadDialogModel | null; secret?: boolean }) {
  return (
    <PhoneMock>
      <ChromeBlock>
        <div className="px-3 pb-3">
          <UnreadDialogBlock cancel={cancel} lines={UNREAD_LINES} onAction={none} onPadKeys={nothing} onTypeAnyway={none} secret={secret} />
        </div>
      </ChromeBlock>
    </PhoneMock>
  );
}

/** An invented permission screen whose answer did not go (M102 spec 10): no real command, path or name. */
const EXIT_LINES = splitLines(parseAnsi("  Run this command?\n\n    ls sample-dir\n\n  > 1. Yes\n    2. No\n\n  Esc to cancel"));

/** The exit of an answer that cannot go, the real card in the dock's place: its line, the live screen, the cross. */
function AnswerExitPhone({ caption }: { caption: string }) {
  return (
    <PhoneMock>
      <div className="border-t border-border bg-background px-3 pt-2 pb-2">
        <UnreadDialogBlock cancel={null} lines={EXIT_LINES} caption={caption} onClose={none} onAction={none} onPadKeys={nothing} />
      </div>
    </PhoneMock>
  );
}

/** An invented screen after a send Collie cannot tell about (M102 spec 04): the agent's own words, nothing of anyone's. */
const CANNOT_TELL_LINES = splitLines(
  parseAnsi("  I found three notes in the sample list.\n  The first is about the weekly plan.\n\n  What should I do with them?\n\n  > run the sample check, tell me what fails\n\n  Working on it. One moment."),
);
const CANNOT_TELL_SIGN_IN_LINES = splitLines(parseAnsi("  Sign in to continue\n\n  Open the link in your browser, then paste\n  the code it shows below.\n\n  Code:"));

/** The wait of card 45 stays on screen for ten minutes, long enough to look at. */
const WAIT_MS = 600_000;

/** The real "cannot tell" card in the card dock's place: the dock's own rule and padding. Its taps change nothing on this page. */
function CannotTellPhone({
  secret = false,
  readOnly = false,
  waits = false,
  interrupted = false,
  lines,
}: {
  secret?: boolean;
  readOnly?: boolean;
  waits?: boolean;
  interrupted?: boolean;
  lines: typeof CANNOT_TELL_LINES;
}) {
  const [awaitingUntil] = useState(() => (waits ? Date.now() + WAIT_MS : null));
  return (
    <PhoneMock>
      <div className="border-t border-border bg-background px-3 pt-2 pb-2">
        <CannotTellCard
          facts={{ requestId: "cannot-tell-demo", secret, readOnly, awaitingUntil, interrupted }}
          lines={lines}
          wrap
          onArrived={() => Promise.resolve("recorded")}
          onClose={() => undefined}
          onAgain={none}
        />
      </div>
    </PhoneMock>
  );
}

/** A queued card that turned unconfirmed: Collie cannot tell where the message went. Invented text. */
const LOST_CARD: QueuedSendRow = { requestId: "queued-demo-0001", state: "unconfirmed", text: "After this turn, summarise the three sample notes in two lines each." };

/** The queued card's unconfirmed state, the real cards: Discard, and Send again on its right. */
function UnconfirmedQueuedPhone() {
  return (
    <PhoneMock>
      <ChromeBlock>
        <div className="px-3 pb-3">
          <ReceiptQueueCards rows={[LOST_CARD]} act={() => Promise.resolve(true)} />
        </div>
      </ChromeBlock>
    </PhoneMock>
  );
}

/** The thread of a terminal pane a moment after Send (M104): an earlier turn, then the person's line as it stands from the tap. Invented text. */
const CALM_ADDRESS = "pg-calm:p1";
const CALM_FEED: ChatFeed = {
  window: {
    ...EMPTY_CHAT_WINDOW,
    status: { kind: "live" },
    entries: [
      { uuid: "pg-calm-u1", seq: 1, ts: new Date().toISOString(), role: "user", parts: [{ kind: "text", text: "Which of the sample tests is slowest?" }] },
      { uuid: "pg-calm-a1", seq: 2, ts: new Date().toISOString(), role: "assistant", parts: [{ kind: "text", text: "The parser test, at about four seconds. The others finish under one." }] },
    ],
  },
  loadOlder: () => undefined,
  loadingOlder: false,
  asked: 1,
  answered: 1,
  tried: true,
};

/** The real thread with the person's line in it, put there the way the composer puts it at the tap (lib/durable-pending.ts). */
function CalmSendPhone() {
  const listRef = useRef<ChatMessageListHandle>(null);
  useEffect(() => {
    addPending(CALM_ADDRESS, { requestId: "pg-calm-1", text: "Make the parser test faster, then run it again.", at: Date.now(), state: "sending", seen: new Set(["pg-calm-u1", "pg-calm-a1"]) });
    return () => dropPending(CALM_ADDRESS, ["pg-calm-1"]);
  }, []);
  return (
    <PhoneMock>
      <div className="h-72">
        <SessionStream feed={CALM_FEED} address={CALM_ADDRESS} working={false} showToolCalls showCompactions={false} fontSize={14} listRef={listRef} agent="claude" />
      </div>
    </PhoneMock>
  );
}

/** The field itself with a code in it, shown or masked: the real component, started where a paste leaves it. */
function SignInTyped({ shown }: { shown: boolean }) {
  return (
    <PhoneMock>
      <ChromeBlock>
        <div className="px-3 pb-3">
          <SecretField onSend={nothing} onClose={stay} disabled={false} start={{ value: SAMPLE_CODE, shown }} />
        </div>
      </ChromeBlock>
    </PhoneMock>
  );
}

function SignInCase({ n, state, title, reach, children }: { n: number; state: string; title: string; reach: string; children: ReactNode }) {
  return (
    <Card state={state} label={`${String(n)}: ${title}`} reach={reach}>
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={n} />
        <p className="text-sm font-semibold text-foreground">
          {n}: {title}
        </p>
      </CardControls>
      {children}
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
      <HeldCardCase
        n={19}
        state="held-crew-member"
        title="On a crew member"
        reach="A held send on a member's pane ran out its 30 minutes, a second still waits. Cancel and Dismiss show; Resend, Submit and Discard do not."
        paneId="held:member"
        held={MEMBER}
        scope={MEMBER_SCOPE}
        showAll
      />
      <HeldCardCase
        n={50}
        state="held-long"
        title="Held for two minutes"
        reach="A send waits two minutes in the hold. The card shows the screen, Send it now sends the words once past the hold, and Cancel gives them back."
        paneId="held:long"
        held={LONG_HELD}
        screen
      />
    </Group>,
    <Group key="belt-lists" title="The belt's lists">
      <BeltListsCase
        n={20}
        state="belt-agents-mark"
        title="Agents mark at 2"
        reach="A Claude Code session with two subagents still running. A small Bot mark with the count above it stands in the belt's fixed block, left of Files and the Switch mark; Tasks stays on the scrolling run."
        paneId="belt:agents-mark"
        note="Finish them and Start them take the subagents away and bring them back, so the mark eases out and in."
        toggle
      />
      <BeltListsCase
        n={21}
        state="belt-agents-sheet"
        title="Agents sheet"
        reach="Tap the agents mark. A sheet titled Agents 2 opens over the page and the belt does not move. Each row is the label an Agent card uses, the task, and how long it has run. A tap on a row opens the subagent transcript over the list, and sends nothing; closing it comes back to the list."
        note="With no bridge behind this page, a row opens the transcript sheet in its unreadable state."
        paneId="belt:agents-sheet"
      />
      <BeltListsCase
        n={22}
        state="belt-agents-none"
        title="Agents mark at 0"
        reach="No subagent running. The mark is not drawn; Files and the Switch mark stand alone, and the scrolling run is the same as on card 19."
        paneId="belt:agents-none"
        agents={false}
      />
      <BeltListsCase
        n={23}
        state="belt-agents-with-clear"
        title="Agents mark right of the X"
        reach="Type in the box while two subagents run. The fixed block reads X, the agents mark, Files, the Switch mark."
        paneId="belt:agents-clear"
        draft="Check the belt at 390px"
      />
    </Group>,
    <Group key="send-questions" title="The send questions">
      <SendConfirmCase
        n={24}
        state="send-confirm-really"
        title="Really send?"
        reach="Type a destructive line (rm -rf, a force-push) and tap Send. The Send button's spot reads Really send? in red for 3 seconds; a second tap sends."
        note="The product keeps the word 3 seconds. This card taps Send again when it runs out, so the word is always on screen. A tap of your own on the word sends to a fake bridge."
        kind="really"
      />
      <SendConfirmCase
        n={25}
        state="send-confirm-again"
        title="Send it again?"
        reach="Send a text whose result is unknown (Collie cannot tell if it was sent), then tap Send on the same text within two minutes. The Send button's spot reads Send it again? in red for 3 seconds; a second tap sends."
        note="The card sends once to a fake bridge that answers unknown, then arms the question and taps again whenever the 3 seconds run out. A tap of your own on the word sends, and the fake bridge answers sent."
        kind="again"
      />
    </Group>,
    <Group key="stop-cards" title="Stop cards">
      <StopCardCase
        n={26}
        state="stop-send-again"
        title="Send again"
        reach="A send the terminal did not take. The notice says nothing was typed and offers Send again first, then Open Keys."
        c={{ outcome: "refused", reason: "write_failed", surface: STOP_FREE }}
      />
      <StopCardCase
        n={27}
        state="stop-send-again-waits"
        title="Send again waits"
        reach="Send while another send to the same pane still runs. Send again is off, and the line under it says it turns on when the other send ends."
        c={{ outcome: "refused", reason: "busy", surface: STOP_FREE, detail: ANOTHER_SEND, wait: "waits" }}
      />
      <StopCardCase
        n={28}
        state="stop-send-again-ready"
        title="Send again turned on"
        reach="The other send ended: Send again is on, and a screen reader hears the line under it. Nothing is sent until the tap."
        c={{ outcome: "refused", reason: "busy", surface: STOP_FREE, detail: ANOTHER_SEND, wait: "ready" }}
      />
      <StopCardCase
        n={29}
        state="stop-stop-turn"
        title="Stop the turn"
        reach="Send to an agent that takes no message while it works. The step is Stop the turn."
        c={{ outcome: "refused", reason: "turn_running", surface: { ...STOP_FREE, turn: "running" } }}
      />
      <StopCardCase
        n={30}
        state="stop-empty-box"
        title="Empty the box"
        reach="Send onto a draft too long for Collie to read whole. Empty the box is the Clear: it deletes that draft in checked rounds."
        c={{ outcome: "refused", reason: "draft_present", surface: { ...STOP_FREE, composer: "draft" } }}
      />
      <StopCardCase
        n={31}
        state="stop-answer-card"
        title="Answer the card first"
        reach="Send while a dialog Collie cannot read is open. The card is the step; Open Keys follows."
        c={{ outcome: "refused", reason: "not_free", surface: { ...STOP_FREE, modal: "unreadable" }, card: true }}
      />
      <StopCardCase
        n={32}
        state="stop-read-screen"
        title="Read the screen"
        reach="Send where Collie finds no input box. The step is the Screen, then the Keys pad."
        c={{ outcome: "refused", reason: "not_free", surface: { ...STOP_FREE, modal: "unknown", composer: "unknown" } }}
      />
    </Group>,
    <Group key="sign-in-field" title="Sign-in field">
      <SignInCase n={33} state="secret-framed-field" title="Sign-in code, empty" reach="Start a sign-in from the Profiles page. When the agent asks for the code, the box becomes this frame: Paste, Send, and the cross that closes it.">
        <SignInPhone />
      </SignInCase>
      <SignInCase n={34} state="secret-framed-field-shown" title="Code pasted, shown" reach="Tap Paste or paste a code. A code is shown so you can check it; Show and Hide take Paste's place.">
        <SignInTyped shown />
      </SignInCase>
      <SignInCase n={35} state="secret-framed-field-masked" title="Code hidden" reach="Tap Hide: the code is masked. Tap Show to see it again.">
        <SignInTyped shown={false} />
      </SignInCase>
      <SignInCase n={41} state="secret-framed-field-waits" title="Sign-in field waits" reach="The sign-in field on a pane this device may only read. The frame stays, and the line under it says why it waits.">
        <PhoneMock>
          <ChromeBlock>
            <div className="px-3 pb-3">
              <SecretField onSend={nothing} onClose={stay} disabled reason={t("composer.placeholder.readOnly")} />
            </div>
          </ChromeBlock>
        </PhoneMock>
      </SignInCase>
    </Group>,
    <Group key="unread-card" title="Unread card">
      <SignInCase n={36} state="unread-card" title="Screen Collie cannot read" reach="A screen Collie has no grammar for. The card shows its rows and the agent's own Esc; the Keys pad opens once under it, and Send anyway arms one send past the card.">
        <UnreadCardPhone cancel={UNREAD_CANCEL} />
      </SignInCase>
      <SignInCase n={37} state="unread-card-fallback" title="Card from a refused send" reach="A send refused on a screen Collie cannot read, from an agent that declared no cancel key. The same card opens from the notice, with the pad and Send anyway.">
        <UnreadCardPhone cancel={null} />
      </SignInCase>
      <SignInCase n={38} state="unread-card-secret" title="Unread screen asks a secret" reach="The unread screen asks for a password or a code. Send anyway is gone, and the card says to use Type, one key at a time.">
        <UnreadCardPhone cancel={UNREAD_CANCEL} secret />
      </SignInCase>
      <StopCardCase
        n={39}
        state="unread-menu-open"
        title="Menu in the way"
        reach="Send anyway on a screen that shows a menu or a yes/no prompt. Nothing is typed, and the Keys pad opens."
        c={{ outcome: "refused", reason: "menu_open", surface: { ...STOP_FREE, modal: "unknown", composer: "unknown" } }}
      />
      <StopCardCase
        n={40}
        state="unread-override-typed"
        title="Text waits for Enter"
        reach="Send anyway on a screen Collie cannot read. The text is in the agent's box, no Enter was pressed, and the person presses Enter on the Keys pad."
        c={{ outcome: "typed_not_submitted", reason: "override", surface: { ...STOP_FREE, modal: "unknown", composer: "unknown" } }}
      />
      <SignInCase n={47} state="answer-exit-no-plan" title="Answer with no plan" reach="Tap an answer on a permission card that Collie cannot carry out from here. The card gives way to this exit: one line, the live screen, and the Keys pad under it. The cross brings the card back.">
        <AnswerExitPhone caption={t("answerExit.noPlan")} />
      </SignInCase>
      <SignInCase n={48} state="answer-exit-no-reply" title="Answer with no reply" reach="Tap an answer and let the bridge give no word in time. The same exit says so; the person checks the screen and presses keys on the pad.">
        <AnswerExitPhone caption={t("answerExit.error")} />
      </SignInCase>
      <SignInCase n={49} state="answer-exit-no-card" title="Dialog with no card" reach="Send while the agent asks something the phone draws no card for, such as a sign-in code. The exit opens with the screen and the Keys pad; Type is the way to enter text.">
        <AnswerExitPhone caption={t("answerExit.unseen")} />
      </SignInCase>
    </Group>,
    <Group key="cannot-tell" title="Cannot tell">
      <SignInCase n={42} state="cannot-tell-short" title="A short message" reach="A send ended unknown: Collie typed the text and could not see it land. The card shows the screen as it is. It arrived clears the draft with Undo clear; Send again sends it as a new message.">
        <CannotTellPhone lines={CANNOT_TELL_LINES} />
      </SignInCase>
      <SignInCase n={43} state="cannot-tell-secret" title="A sign-in code" reach="The send was a sign-in code, which is never kept. The buttons are It arrived and Enter it again; the second opens the sign-in field empty.">
        <CannotTellPhone secret lines={CANNOT_TELL_SIGN_IN_LINES} />
      </SignInCase>
      <SignInCase n={44} state="cannot-tell-read-only" title="A read-only device" reach="This device may look and may not answer: the card shows the sentence and the screen with no buttons.">
        <CannotTellPhone readOnly lines={CANNOT_TELL_LINES} />
      </SignInCase>
      <SignInCase n={45} state="cannot-tell-waiting" title="Waiting for the agent's word" reach="The receipt says the agent's own word may still come. Send again is off, a tap says why in a line under the buttons, and it turns on by itself when the wait ends. It arrived stays on.">
        <CannotTellPhone waits lines={CANNOT_TELL_LINES} />
      </SignInCase>
      <SignInCase n={51} state="cannot-tell-interrupted" title="Bridge stopped mid-send" reach="The bridge stopped after the first key and before Enter. The text may be in the box; Send again on the same send types nothing.">
        <CannotTellPhone interrupted lines={CANNOT_TELL_LINES} />
      </SignInCase>
      <SignInCase n={46} state="cannot-tell-queued" title="Queued card, not confirmed" reach="A queued message Collie cannot place. Discard drops the card and sends nothing; Send again, on its right, drops the card and then sends the text as a new message.">
        <UnconfirmedQueuedPhone />
      </SignInCase>
    </Group>,
    <Group key="calm-send" title="A calm send">
      <SignInCase n={52} state="calm-send-pending-terminal" title="Your line at the tap, on a terminal pane" reach="Send a line from Chat on a pane with a screen. It stands in the thread at once, in the user well at a lower weight with a small clock, the same line a durable pane draws; the agent's own copy takes its place at the same height. Under it, unseen, the room Still working will take.">
        <CalmSendPhone />
      </SignInCase>
    </Group>,
  ];
}
