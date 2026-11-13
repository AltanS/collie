// "Deliver now", a design round on the pick page: /pick.html?round=walky-deliver-now
//
// A message waits for a pane while its owner has unsent text in the box. When the session has the data
// transport (it is "linked"), the person may let the message in by their own act: it goes to the agent now,
// the person's text stays in the box, unsent, and the agent starts on the message. The round is about what the
// person reads BEFORE the tap and what they see AFTER it.
//
// 1 Line under the buttons: the row always says it, one tap delivers.
// 2 Confirm says it: one tap opens a question in the row, with Deliver and Back.
// 3 On the mark: the mark above the box carries the button and a second line; the sheet row works as in 1.
//
// ONE Case switch drives all three. Every frame draws the composer with the person's text in it (a real,
// editable box, above the sheet so the sheet does not hide it), the mark above the box, and the strip
// that follows a delivery. Delivering waits on the call; Delivered and Failed play the tap for you. In
// Waiting a tap takes 800 ms to answer. Replay starts every option over.
//
// The wording of the waiting row and of the mark is the owner's new wording for EVERY session: Not linked shows
// it without the data path.
//
// DEV-ONLY, unreachable from the app entry. The pick shell holds the rules: a number and at most five words per option.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { ChatInput } from "@/components/ui/chat/chat-input";
import { Collapse } from "@/components/ui/collapse";
import { WalkyHeldStrip, WalkyNoteStrip } from "@/components/walky-composer-strip";
import { WalkyLogProvider } from "@/components/walky-log";
import { WalkySheet } from "@/components/walky-sheet";
import { t } from "@/lib/i18n";
import { heldForPane, type WalkyRow } from "@/lib/walky";
import { fixtureWalkyAgent, fixtureWalkyOperator, fixtureWalkySelf } from "@/test/handlers";

import type { PickCase, PickOption, PickRoundDef } from "../pick-page";

const FAKE_MS = 800;
/** How long the note above the box stays after a delivery, unless the person taps first. */
const NOTE_MS = 6_000;
/** The pause between the taps the autoplay makes (the confirm opens with a short animation). */
const STEP_MS = 400;

const CASES: readonly PickCase[] = [
  { id: "waiting", label: "Waiting" },
  { id: "delivering", label: "Delivering" },
  { id: "delivered", label: "Delivered" },
  { id: "failed", label: "Failed" },
  { id: "three", label: "Three waiting" },
  { id: "plain", label: "Not linked" },
  { id: "long", label: "Long names, 360 px" },
  { id: "keyboard", label: "Keyboard up" },
];

const DRAFT = "Also check the retry in sync.ts, and whether the empty list reaches the loader";
const HELD_REASON = "draft present";
const MINUTE = 60_000;

interface Scenario {
  rows: readonly WalkyRow[];
  linked: boolean;
  keyboard: boolean;
  /** The frame's inner width: 360 for the narrow case, else what the phone frame gives. */
  width: number | null;
  /** The fake's answer: after this long, or never. */
  answer: { kind: "after"; ms: number } | { kind: "never" };
  fails: boolean;
  /** Play the person's taps on mount, so the state after them is on the page without a tap. */
  autoplay: boolean;
  /** Keep the note above the box up: the case shows it, so no timer and no tap takes it away. */
  keepNote: boolean;
}

function waiting(row: WalkyRow, over: Partial<WalkyRow> & { id: string; minutesAgo: number }): WalkyRow {
  const { minutesAgo, ...rest } = over;
  const at = Date.now() - minutesAgo * MINUTE;
  return { ...row, ...rest, at, receipt: { ...row.receipt, id: over.id, at, state: "accepted", reason: HELD_REASON } };
}

const FIX: WalkyRow = waiting(fixtureWalkyAgent, { id: "wt_dn0000000001", minutesAgo: 4, body: "Tests are green on fix-465. You can merge." });
const DOCS: WalkyRow = waiting(fixtureWalkyAgent, {
  id: "wt_dn0000000002",
  minutesAgo: 2,
  from: { memberId: "bluefin", address: "bluefin/w3:p2", harness: "claude", label: "collie-website#docs" },
  body: "The docs page for the new transport is ready for a read.",
});
const OPERATOR: WalkyRow = waiting(fixtureWalkyOperator, { id: "wt_dn0000000003", minutesAgo: 1, body: "Stop and report what you changed." });
const LONG: WalkyRow = waiting(fixtureWalkyAgent, {
  id: "wt_dn0000000004",
  minutesAgo: 3,
  from: { memberId: "bluefin", address: "bluefin/w6:p3", harness: "claude", label: "collie-workspace#fix-465-retry-the-final-error-in-the-sync-loader" },
  body:
    "Review of fix-465 is done. The retry in packages/bridge/src/sync/loader/retry-with-backoff.ts swallows the final error, " +
    "rethrow it after the last attempt, and the test for the empty list passes for the wrong reason because it never reaches the loader.",
});

function scenarioOf(caseId: string): Scenario {
  const base: Scenario = { rows: [FIX], linked: true, keyboard: false, width: null, answer: { kind: "after", ms: FAKE_MS }, fails: false, autoplay: false, keepNote: false };
  switch (caseId) {
    case "delivering":
      return { ...base, answer: { kind: "never" }, autoplay: true };
    case "delivered":
      return { ...base, answer: { kind: "after", ms: 60 }, autoplay: true, keepNote: true };
    case "failed":
      return { ...base, answer: { kind: "after", ms: 60 }, fails: true, autoplay: true };
    case "three":
      return { ...base, rows: [FIX, DOCS, OPERATOR] };
    case "plain":
      return { ...base, linked: false };
    case "long":
      return { ...base, rows: [LONG], width: 360 };
    case "keyboard":
      return { ...base, keyboard: true };
    default:
      return base;
  }
}

/** The receipt a message handed over as data carries: no hold reason any more, and how it went. */
function deliveredAsData(row: WalkyRow): WalkyRow {
  const { reason: _reason, ...receipt } = row.receipt;
  return { ...row, receipt: { ...receipt, state: "delivered", via: "data", at: Date.now() } };
}

/** A message the person dropped or cancelled ends in the inbox, as the clock would end it. */
function inInbox(row: WalkyRow): WalkyRow {
  const { reason: _reason, ...receipt } = row.receipt;
  return { ...row, receipt: { ...receipt, state: "inbox-only", at: Date.now() } };
}

/** Where the person's taps land, for the cases that play them: the row's button, then the question's. */
const TAPS = {
  1: ['[data-slot="walky-list-row"] [data-slot="walky-deliver"]'],
  2: ['[data-slot="walky-list-row"] [data-slot="walky-deliver"]', '[data-slot="walky-deliver-ask"] [data-slot="walky-deliver"]'],
  3: ['[data-slot="notice"] [data-slot="walky-deliver"]'],
} satisfies Record<1 | 2 | 3, readonly string[]>;

/** Stands in for the soft keyboard: the composer sits on top of it, as it does on a phone. */
function Keyboard() {
  return (
    <div aria-hidden="true" className="h-[260px] shrink-0 bg-muted/60 pt-2 text-center text-[11px] text-muted-foreground">
      keyboard
    </div>
  );
}

/**
 * One pane: a little chat, then the composer (the note after a delivery, the mark, the box with the person's
 * text), the Messages sheet over it. The composer stands at the top so the sheet, which takes the bottom of
 * the screen, does not hide the text: the text is what the person worries about. With the keyboard up it
 * stands on the keyboard, as on a phone.
 */
function Pane({ option, scenario }: { option: 1 | 2 | 3; scenario: Scenario }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<readonly WalkyRow[]>(scenario.rows);
  const [open, setOpen] = useState(option !== 3 && !scenario.keyboard);
  const [noted, setNoted] = useState(false);
  const heldRows = useMemo(() => heldForPane(rows, fixtureWalkySelf), [rows]);
  const end = useCallback((id: string, to: (row: WalkyRow) => WalkyRow) => setRows((now) => now.map((row) => (row.id === id ? to(row) : row))), []);

  // The fake bridge: it answers after a time, never, or with a refusal. A delivery turns the message delivered
  // and puts the note above the box; the person's text is not touched.
  const onDeliverNow = useCallback(
    (id: string) =>
      new Promise<void>((resolve, reject) => {
        if (scenario.answer.kind === "never") return;
        setTimeout(() => {
          if (scenario.fails) return reject(new Error("The agent did not take it."));
          end(id, deliveredAsData);
          setNoted(true);
          resolve();
        }, scenario.answer.ms);
      }),
    [scenario, end],
  );
  const take = useCallback(
    async (row: WalkyRow) => {
      end(row.id, inInbox);
      return null;
    },
    [end],
  );

  // The note goes after a few seconds, or at the next tap anywhere in the pane.
  useEffect(() => {
    if (!noted || scenario.keepNote) return;
    const timer = setTimeout(() => setNoted(false), NOTE_MS);
    return () => clearTimeout(timer);
  }, [noted, scenario.keepNote]);

  // The cases that play the taps: each lands one step after the other.
  useEffect(() => {
    if (!scenario.autoplay) return;
    const timers = TAPS[option].map((selector, step) =>
      setTimeout(() => root.current?.querySelector<HTMLButtonElement>(selector)?.click(), STEP_MS * (step + 1)),
    );
    return () => timers.forEach(clearTimeout);
  }, [scenario.autoplay, option]);

  const only = heldRows.length === 1 ? heldRows[0] : undefined;
  // `--app-h` is what a sheet sizes itself to; the frame's height stands in for the viewport's, and `transform` makes the frame the sheet's containing block.
  const frame: CSSProperties & { "--app-h"?: string } = { width: scenario.width ?? "100%", height: 728, transform: "translate(0)", "--app-h": "728px" };
  return (
    <div ref={root} className="relative flex flex-col overflow-hidden bg-background" style={frame} onPointerDownCapture={() => !scenario.keepNote && setNoted(false)}>
      <p className="px-4 pt-3 pb-2 text-xs text-muted-foreground">Working on fix-465. Waiting for the review.</p>
      <div className={scenario.keyboard ? "mt-auto px-4 pb-3" : "px-4 pb-3"}>
        <Collapse open={noted}>
          {noted && <WalkyNoteStrip note={{ tone: "success", text: t("walky.composer.delivered") }} onDismiss={() => setNoted(false)} />}
        </Collapse>
        <Collapse open={heldRows.length > 0}>
          {heldRows.length > 0 && (
            <WalkyHeldStrip count={heldRows.length} onOpen={() => setOpen(true)} linked={scenario.linked && option === 3} deliverId={only?.id} onDeliverNow={onDeliverNow} />
          )}
        </Collapse>
        {/* The person's own text, in a real box: it is never touched by a delivery, and stays editable. */}
        <div className="rounded-md border border-border bg-card px-3 py-2" data-slot="pg-draft">
          <ChatInput aria-label="Your message" defaultValue={DRAFT} rows={2} className="w-full resize-none bg-transparent text-sm outline-none" />
        </div>
      </div>
      {scenario.keyboard && <Keyboard />}
      <WalkyLogProvider rows={rows} reads={1}>
        <WalkySheet
          open={open}
          onClose={() => setOpen(false)}
          onReply={() => setOpen(false)}
          canReply
          self={fixtureWalkySelf}
          onCancel={take}
          onDrop={take}
          linked={scenario.linked}
          onDeliverNow={onDeliverNow}
          deliverAsk={option === 2}
        />
      </WalkyLogProvider>
    </div>
  );
}

function Option({ option, caseId }: { option: 1 | 2 | 3; caseId: string }) {
  // Keyed by the case: a new case starts every option fresh, with its own list and a closed or open sheet.
  return <Pane key={caseId} option={option} scenario={scenarioOf(caseId)} />;
}

const OPTIONS: readonly PickOption[] = [
  { n: 1, label: "Line under the buttons", render: (caseId) => <Option option={1} caseId={caseId} /> },
  { n: 2, label: "Confirm says it", render: (caseId) => <Option option={2} caseId={caseId} /> },
  { n: 3, label: "On the mark", render: (caseId) => <Option option={3} caseId={caseId} /> },
];

const ROUND: PickRoundDef = { title: "Deliver now", cases: CASES, options: OPTIONS, frameHeight: 740 };

export default ROUND;
