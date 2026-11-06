// Pinned messages section of the states playground (M90 spec 04): the way in on a block, the mark a pinned
// block wears, the Pins mark in the belt, the Pins sheet and the detail layer, and the belt with all three
// marks at two-digit counts. Every card mounts the REAL component (`StreamBlock`, `BlockActionsSheet`,
// `Composer`, `PinsSheet`) with the props the pane view hands it; there is no bridge behind this page, so the
// one request the detail layer makes (`GET pins?pin=<id>`) is answered by the section for as long as it is
// on screen, and a tap on Unpin takes the row out of the list, as the pane view's hook does.
//
// Cards are numbered 1 to 7 (6 is drawn twice: at 360 and at 390 px).

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { BlockActionsSheet } from "@/components/block-actions-sheet";
import { ItemView } from "@/components/chat-cards";
import { Composer } from "@/components/composer";
import { PinsSheet } from "@/components/pins-sheet";
import { StreamBlock } from "@/components/stream-block";
import { SubagentSheet } from "@/components/subagent-sheet";
import type { ChatItem } from "@/lib/chat-items";
import { t } from "@/lib/i18n";
import { markLive } from "@/lib/liveness";
import type { PinFull, PinRow } from "@/lib/types";

import { manyMessagePins, manyRunningJobs, manySubagents, messagePinRows, messagePins } from "../fixtures";
import { Card, CardControls, Group, Section, type SectionDef } from "../layout";
import { ChromeBlock } from "./shared";

export const DEF: SectionDef = {
  id: "pins",
  title: "Pinned messages",
  intent:
    "A Chat block can be pinned. The bridge that owns the pane keeps a copy of its text, and the phone " +
    "shows a mark on the block, a Pins mark with the count in the belt, a sheet of the pins and a detail " +
    "layer with the whole text. Every card mounts the real component. With no bridge behind this page the " +
    "detail layer's one request is answered here, and Unpin takes a row out of the list.",
};

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

// The stream's own block class (components/session-stream.tsx `STREAM_BLOCK`), without the containment that
// only matters for a long list: a 12px padding pulled back by a matching margin, so the marks sit in it.
const BLOCK = "flex min-w-0 flex-col -m-3 p-3";

const USER_ITEM: ChatItem = { id: "pg-user-1:0", kind: "user", ts: new Date().toISOString(), text: "Review fix-465 before I merge it, and tell me what you would change." };
const REPLY_ITEM: ChatItem = {
  id: "pg-reply-1:0",
  kind: "reply",
  ts: new Date().toISOString(),
  text: "The retry in `sync.ts` swallows the final error. Rethrow after the last attempt, and give the empty-list test a loader that throws.",
};

/** A phone-wide box that is a containing block for the sheets it holds, so a sheet opens inside the card. */
function Phone({ width = 390, height, children }: { width?: number; height?: string; children: ReactNode }) {
  // The sheets size themselves on `--app-h` (the page's height), so a box shorter than the page says its own.
  const box: CSSProperties & { "--app-h"?: string } = { width, height, transform: "translate(0)" };
  if (height !== undefined) box["--app-h"] = height;
  return (
    <div
      data-pg-frame=""
      className="relative isolate max-w-full overflow-hidden rounded-xl border border-border bg-background"
      style={box}
    >
      {children}
    </div>
  );
}

function CardHead({ n, title }: { n: number; title: string }) {
  return (
    <CardControls className="flex items-center gap-3">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-lg font-bold leading-none text-background">
        {n}
      </span>
      <p className="text-sm font-semibold text-foreground">
        {n}: {title}
      </p>
    </CardControls>
  );
}

/** The Chat blocks of a card. The `⋯` is the real button; its tap opens whatever `onActions` opens. */
function Blocks({ pinned, onActions }: { pinned: ReadonlySet<string>; onActions: (item: ChatItem) => void }) {
  return (
    <div className="flex flex-col gap-6 p-6">
      {[USER_ITEM, REPLY_ITEM].map((item) => (
        <StreamBlock key={item.id} n={1} item={item} pinned={pinned.has(item.id)} onActions={onActions} className={BLOCK}>
          <ItemView item={item} />
        </StreamBlock>
      ))}
    </div>
  );
}

/** Card 1: a block with its ⋯, and the sheet the ⋯ opens. A tap on Pin or Unpin flips the block's mark. */
function ActionsSheetCard() {
  const [open, setOpen] = useState<ChatItem | null>(REPLY_ITEM);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const flip = (item: ChatItem, on: boolean) => setPinned((now) => (on ? new Set(now).add(item.id) : new Set([...now].filter((id) => id !== item.id))));
  return (
    <Phone height="520px">
      <Blocks pinned={pinned} onActions={setOpen} />
      <BlockActionsSheet item={open} pinned={open !== null && pinned.has(open.id)} onClose={() => setOpen(null)} onPin={(item) => flip(item, true)} onUnpin={(item) => flip(item, false)} />
    </Phone>
  );
}

/** Card 2: the same blocks with the reply pinned, so its mark shows in the block's corner. */
function PinnedBlockCard() {
  const [open, setOpen] = useState<ChatItem | null>(null);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set([REPLY_ITEM.id]));
  const flip = (item: ChatItem, on: boolean) => setPinned((now) => (on ? new Set(now).add(item.id) : new Set([...now].filter((id) => id !== item.id))));
  return (
    <Phone height="520px">
      <Blocks pinned={pinned} onActions={setOpen} />
      <BlockActionsSheet item={open} pinned={open !== null && pinned.has(open.id)} onClose={() => setOpen(null)} onPin={(item) => flip(item, true)} onUnpin={(item) => flip(item, false)} />
    </Phone>
  );
}

// ── THE BELT ─────────────────────────────────────────────────────────────────────────────────────
// The real Composer with the pins mark, and, where a card asks, the agents and jobs marks beside it. The same
// frame the belt's other cards use (composer-states.tsx): a strip of fake terminal, then the chrome block.

/** How often a card's live stamp is renewed, so a card left open does not lapse into "offline" (the cap is 90 s). */
const RENEW_MS = 5_000;

interface BeltProps {
  paneId: string;
  rows: readonly PinRow[];
  onUnpin: (pinId: string) => void;
  agents: number;
  jobs: number;
}

function BeltComposer({ paneId, rows, onUnpin, agents, jobs }: BeltProps) {
  return (
    <SubagentSheet paneId={paneId}>
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
          prefs={PREFS}
          display={{ open: false, onToggle: () => {} }}
          onSent={() => {}}
          subagents={agents > 0 ? manySubagents(agents) : undefined}
          jobs={jobs > 0 ? manyRunningJobs(jobs) : undefined}
          pins={{ count: rows.length, rows, onUnpin, onOpened: () => {}, onShow: () => false }}
          changesPill={{ onClick: () => {}, label: t("chat.changes.label") }}
          pullHandle={{ ref: () => {}, onClick: () => {}, label: t("chat.switcher.aria") }}
          screen={{ on: false, onToggle: () => {} }}
        />
      </ChromeBlock>
    </SubagentSheet>
  );
}

/** What the belt's one Composer reads: the rows and counts of the card, which change while it stays mounted. */
const BeltContext = createContext<Omit<BeltProps, "paneId"> | null>(null);

function BeltFromContext({ paneId }: { paneId: string }) {
  const belt = useContext(BeltContext);
  if (belt === null) return null;
  return <BeltComposer paneId={paneId} {...belt} />;
}

function BeltPhone({ paneId, width = 390, rows: start, agents = 0, jobs = 0 }: { paneId: string; width?: number; rows: readonly PinRow[]; agents?: number; jobs?: number }) {
  const [rows, setRows] = useState(start);
  useEffect(() => {
    const stamp = () => markLive(paneId);
    stamp();
    const timer = setInterval(stamp, RENEW_MS);
    return () => clearInterval(timer);
  }, [paneId]);
  // One router for the card's life: a router made per render would remount the composer and close its sheet.
  const [router] = useState(() => createMemoryRouter([{ path: "/", element: <BeltFromContext paneId={paneId} /> }], { initialEntries: ["/"] }));
  const belt = useMemo(() => ({ rows, onUnpin: (id: string) => setRows((now) => now.filter((row) => row.id !== id)), agents, jobs }), [rows, agents, jobs]);
  return (
    <Phone width={width}>
      <div className="h-16 bg-background px-3 pt-2 font-mono text-[11px] text-muted-foreground">terminal output above the belt</div>
      <BeltContext.Provider value={belt}>
        <RouterProvider router={router} />
      </BeltContext.Provider>
    </Phone>
  );
}

// ── THE SHEET AND THE DETAIL ─────────────────────────────────────────────────────────────────────

/**
 * Answers `GET /api/pane/<id>/pins?pin=<id>` with the fixture's whole pin while the card is on screen, and
 * hands every other request to the page's own fetch. Installed before the detail layer asks.
 */
function useStagedPinText(pins: readonly PinFull[]): void {
  useEffect(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const wanted = url.pathname.endsWith("/pins") ? url.searchParams.get("pin") : null;
      const found = wanted === null ? undefined : pins.find((pin) => pin.id === wanted);
      if (found === undefined) return real(input, init);
      return Promise.resolve(new Response(JSON.stringify({ pin: found }), { status: 200, headers: { "content-type": "application/json" } }));
    };
    return () => {
      window.fetch = real;
    };
  }, [pins]);
}

/** The real Pins sheet over a phone-sized stage. `detail` taps the row at the given place, as a finger would. */
function SheetCard({ detail }: { detail?: number }) {
  const [rows, setRows] = useState(() => messagePinRows(messagePins));
  const root = useRef<HTMLDivElement>(null);
  useStagedPinText(messagePins);
  useEffect(() => {
    if (detail === undefined) return;
    // The list is newest first: row 0 is the tool card, row 1 the long reply. The tap is the real one.
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>('[data-slot="pin-row"] > button:first-child');
    buttons?.[detail]?.click();
  }, [detail]);
  return (
    <div ref={root}>
      <Phone height="100dvh">
        <PinsSheet
          open
          onClose={() => {}}
          scope={undefined}
          paneId="pins:card"
          rows={rows}
          onUnpin={(id) => setRows((now) => now.filter((row) => row.id !== id))}
          onOpened={() => {}}
          onShow={() => true}
        />
      </Phone>
    </div>
  );
}

export function PinsSection() {
  return (
    <Section def={DEF}>
      <Group title="In Chat">
        <Card
          state="pins-block-actions"
          label="1: block ⋯ and sheet"
          reach="Open a pane in Chat and tap the small ⋯ at the top right of a message, a reply or a tool card. A hold on the block, or a right click on a desk, opens the same sheet. The title says what the block is; Pin becomes Unpin on a pinned block."
          note="A tap on Pin or Unpin flips the mark, as the pane view's hook does. Nothing is sent."
        >
          <CardHead n={1} title="Block ⋯ and sheet" />
          <ActionsSheetCard />
        </Card>

        <Card
          state="pins-pinned-block"
          label="2: pinned block mark"
          reach="Pin a reply. A small pin mark stands in the block's top right corner, above the ⋯, and nothing in the stream moves."
          note="The ⋯ opens the sheet; on this block it reads Unpin."
        >
          <CardHead n={2} title="Pinned block mark" />
          <PinnedBlockCard />
        </Card>

      </Group>

      <Group title="Belt and sheets">
        <Card
          state="pins-belt-mark"
          label="3: belt Pins mark"
          reach="Pin three blocks of one session. A pin with the count 3 stands in the belt's fixed block, right of the jobs mark and left of Changes. The mark is not drawn at zero."
          note="Tap the mark for the sheet; Unpin there counts down to zero, and the mark leaves."
        >
          <CardHead n={3} title="Belt Pins mark" />
          <BeltPhone paneId="pins:belt" rows={messagePinRows(messagePins)} />
        </Card>

        <Card
          state="pins-sheet"
          label="4: Pins sheet, three rows"
          reach="Tap the Pins mark. A tall sheet titled Pinned messages lists the pins newest first: who spoke, the first lines, how long ago, and an Unpin on each row. A tap on a row opens its detail."
          note="Unpin takes the row out of the list. With the last one gone the sheet closes in the app."
        >
          <CardHead n={4} title="Pins sheet, three rows" />
          <SheetCard />
        </Card>

        <Card
          state="pins-detail"
          label="5: detail layer"
          reach="Tap a row of the Pins sheet. A second sheet over the list holds the whole pinned text, scrollable, with Unpin and Show in Chat at the foot."
          note="The row's tap is taken for you once the card has mounted; this page answers the one request the layer makes. Show in Chat scrolls the pane's Chat to the block, which this card has none of."
        >
          <CardHead n={5} title="Detail layer" />
          <SheetCard detail={1} />
        </Card>

        <Card
          state="pins-belt-all-360"
          label="6: three marks, 360 px"
          reach="A session with eleven running subagents, twelve running jobs and twelve pins at once, on the narrowest phone. The three marks and their two-digit badges stand left of Changes and the Switch mark, with the same gap, and the belt scrolls when it must."
        >
          <CardHead n={6} title="Three marks, 360 px" />
          <BeltPhone paneId="pins:all-360" width={360} rows={manyMessagePins(12)} agents={11} jobs={12} />
        </Card>

        <Card
          state="pins-belt-all-390"
          label="7: three marks, 390 px"
          reach="The same belt at 390 px, the width of an iPhone 14."
        >
          <CardHead n={7} title="Three marks, 390 px" />
          <BeltPhone paneId="pins:all-390" width={390} rows={manyMessagePins(12)} agents={11} jobs={12} />
        </Card>
      </Group>
    </Section>
  );
}

