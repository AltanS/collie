// "Deliver now", the picked design (option 3, "On the mark"), kept as a round for one more look at the timing:
// registered as `walky-deliver-now` in ../rounds.ts and built by the design app. Its one option names the mark,
// `data-state="walky-deliver-mark"` (the root of `WalkyHeldStrip`).
//
// A message waits for a pane while its owner has unsent text in the box (or while the agent runs a turn). The
// mark above the box tells the owner only after the OLDEST waiting message has waited WALKY_MARK_GRACE_MS (20 s),
// so a person who sends their line in time never sees it. "Just arrived" starts a message that began to wait
// now: watch the mark come at 20 s. For a linked session, a wait on the person's text adds "Deliver now" and
// "Your text stays in the box." to the mark; the Messages sheet lists a waiting message at once and carries the
// same action under the row. Delivering waits on the call; Delivered and Failed play the tap for you.
//
// HANDOVER, what the bridge must provide (the web half is built and reads exactly these):
//  1. `linked: true` on the pane read (`AgentView`), for a session that has the data transport. Absent otherwise.
//     The web passes it as `walkyLinked` to the Composer and `linked` to the WalkySheet (agent-chat.tsx).
//  2. The held-since time per message: `receipt.at` of the `accepted` receipt that carries the reason, in ms, the
//     bridge's clock, written when the message BEGAN to wait (rewritten if the reason changes). The 20 s grace
//     counts from it (`waitingSince`, lib/walky.ts), so a reload or a sleeping tab does not restart it. If the
//     bridge writes `at` on every read, the grace never ends: it must be the time the hold began.
//  3. The reason of the wait, `receipt.reason`: "draft present" (the person's text) or "turn running" (a running
//     turn). Any other reason reads as a plain count on the mark and gets no Deliver now.
//  4. A "deliver now" call: for one waiting message id of a linked pane, hand it to the agent as data, leave the
//     box untouched, and answer delivered, or failed with a reason (the web shows the reason). Afterwards the
//     receipt reads `state: "delivered"` with `via: "data"` (lib/walky.ts, `WalkyReceipt.via`). The web calls it
//     through `DeliverNow` (lib/walky.ts) from `onDeliverNow`, to be written beside `dropWalky` in lib/api.ts.
//
// DEV-ONLY, unreachable from the app entry. The round contract (../types.ts) holds the rules: a number and at most five words per option.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { ChatInput } from "@/components/ui/chat/chat-input";
import { Collapse } from "@/components/ui/collapse";
import { WalkyHeldStrip, WalkyNoteStrip } from "@/components/walky-composer-strip";
import { WalkyLogProvider } from "@/components/walky-log";
import { WalkySheet } from "@/components/walky-sheet";
import { t } from "@/lib/i18n";
import { useWalkyMarkGrace } from "@/hooks/use-walky-mark-grace";
import { heldForPane, waitKindOf, WALKY_MARK_GRACE_MS, type WalkyRow } from "@/lib/walky";
import { fixtureWalkyAgent, fixtureWalkyOperator, fixtureWalkySelf } from "@/test/handlers";

import type { PickCase, PickOption, PickRoundDef } from "../types";

const FAKE_MS = 800;
/** How long the note above the box stays after a delivery, unless the person taps first. */
const NOTE_MS = 6_000;
/** The pause between the taps the autoplay makes (the confirm opens with a short animation). */
const STEP_MS = 400;

const CASES: readonly PickCase[] = [
  { id: "arrived", label: "Just arrived" },
  { id: "after", label: "After 20 s" },
  { id: "delivering", label: "Delivering" },
  { id: "delivered", label: "Delivered" },
  { id: "failed", label: "Failed" },
  { id: "three", label: "Three waiting" },
  { id: "busy", label: "Busy agent" },
  { id: "plain", label: "Not linked" },
  { id: "long", label: "Long names, 360 px" },
  { id: "keyboard", label: "Keyboard up" },
];

const DRAFT = "Also check the retry in sync.ts, and whether the empty list reaches the loader";
/** Older than the grace: the mark shows. */
const PAST_GRACE_S = WALKY_MARK_GRACE_MS / 1000 + 5;

interface Scenario {
  rows: readonly WalkyRow[];
  linked: boolean;
  keyboard: boolean;
  /** The frame's inner width: 360 for the narrow case, else what the phone frame gives. */
  width: number | null;
  /** The fake's answer: after this long, or never. */
  answer: { kind: "after"; ms: number } | { kind: "never" };
  fails: boolean;
  /** Play the person's tap on mount, so the state after it is on the page without a tap. */
  autoplay: boolean;
  /** Keep the note above the box up: the case shows it, so no timer takes it away. */
  keepNote: boolean;
}

/** A message that began to wait `secondsAgo` seconds ago, for `reason`: the bridge's held receipt, with its time. */
function waiting(row: WalkyRow, over: Partial<WalkyRow> & { id: string }, secondsAgo: number, reason = "draft present"): WalkyRow {
  const at = Date.now() - secondsAgo * 1000;
  return { ...row, ...over, at, receipt: { ...row.receipt, id: over.id, at, state: "accepted", reason } };
}

function scenarioOf(caseId: string): Scenario {
  const fix = (secondsAgo: number, reason?: string) =>
    waiting(fixtureWalkyAgent, { id: "wt_dn0000000001", body: "Tests are green on fix-465. You can merge." }, secondsAgo, reason);
  const base: Scenario = { rows: [fix(PAST_GRACE_S)], linked: true, keyboard: false, width: null, answer: { kind: "after", ms: FAKE_MS }, fails: false, autoplay: false, keepNote: false };
  switch (caseId) {
    case "arrived":
      return { ...base, rows: [fix(0)] };
    case "delivering":
      return { ...base, answer: { kind: "never" }, autoplay: true };
    case "delivered":
      return { ...base, answer: { kind: "after", ms: 60 }, autoplay: true, keepNote: true };
    case "failed":
      return { ...base, answer: { kind: "after", ms: 60 }, fails: true, autoplay: true };
    case "three":
      return {
        ...base,
        rows: [
          fix(PAST_GRACE_S + 30),
          waiting(fixtureWalkyAgent, { id: "wt_dn0000000002", from: { memberId: "bluefin", address: "bluefin/w3:p2", harness: "claude", label: "collie-website#docs" }, body: "The docs page for the new transport is ready for a read." }, PAST_GRACE_S + 10),
          waiting(fixtureWalkyOperator, { id: "wt_dn0000000003", body: "Stop and report what you changed." }, PAST_GRACE_S),
        ],
      };
    case "busy":
      return { ...base, rows: [fix(PAST_GRACE_S, "turn running")] };
    case "plain":
      return { ...base, linked: false };
    case "long":
      return {
        ...base,
        width: 360,
        rows: [
          waiting(
            fixtureWalkyAgent,
            {
              id: "wt_dn0000000004",
              from: { memberId: "bluefin", address: "bluefin/w6:p3", harness: "claude", label: "collie-workspace#fix-465-retry-the-final-error-in-the-sync-loader" },
              body:
                "Review of fix-465 is done. The retry in packages/bridge/src/sync/loader/retry-with-backoff.ts swallows the final error, " +
                "rethrow it after the last attempt, and the test for the empty list passes for the wrong reason because it never reaches the loader.",
            },
            PAST_GRACE_S,
          ),
        ],
      };
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

/** The person's tap, for the cases that play it: the button on the mark. */
const TAP = '[data-slot="notice"] [data-slot="walky-deliver"]';

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
 * the screen, does not hide the text. With the keyboard up it stands on the keyboard, as on a phone. The mark
 * is drawn by the same rule as the composer's: only after the oldest message has waited its grace.
 */
function Pane({ scenario }: { scenario: Scenario }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<readonly WalkyRow[]>(scenario.rows);
  const [open, setOpen] = useState(false);
  const [noted, setNoted] = useState(false);
  const waitingRows = useMemo(() => heldForPane(rows, fixtureWalkySelf), [rows]);
  const graced = useWalkyMarkGrace(waitingRows);
  const kind = waitKindOf(waitingRows);
  const only = waitingRows.length === 1 && kind === "text" ? waitingRows[0] : undefined;
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

  // The note goes after a few seconds (the composer's rule), unless the case shows it.
  useEffect(() => {
    if (!noted || scenario.keepNote) return;
    const timer = setTimeout(() => setNoted(false), NOTE_MS);
    return () => clearTimeout(timer);
  }, [noted, scenario.keepNote]);

  // The cases that play the tap: it lands once the mark is there.
  useEffect(() => {
    if (!scenario.autoplay) return;
    const timer = setTimeout(() => root.current?.querySelector<HTMLButtonElement>(TAP)?.click(), STEP_MS);
    return () => clearTimeout(timer);
  }, [scenario.autoplay]);

  // `--app-h` is what a sheet sizes itself to; the frame's height stands in for the viewport's, and `transform` makes the frame the sheet's containing block.
  const frame: CSSProperties & { "--app-h"?: string } = { width: scenario.width ?? "100%", height: 728, transform: "translate(0)", "--app-h": "728px" };
  return (
    <div ref={root} className="relative flex flex-col overflow-hidden bg-background" style={frame}>
      <p className="px-4 pt-3 pb-2 text-xs text-muted-foreground">Working on fix-465. Waiting for the review.</p>
      <div className={scenario.keyboard ? "mt-auto px-4 pb-3" : "px-4 pb-3"}>
        <Collapse open={noted}>
          {noted && <WalkyNoteStrip note={{ tone: "success", text: t("walky.composer.delivered") }} onDismiss={() => setNoted(false)} />}
        </Collapse>
        <Collapse open={graced}>
          {graced && (
            <WalkyHeldStrip count={waitingRows.length} kind={kind} onOpen={() => setOpen(true)} linked={scenario.linked} deliverId={only?.id} onDeliverNow={onDeliverNow} />
          )}
        </Collapse>
        {/* The person's own text, in a real box: it is never touched by a delivery, and stays editable. */}
        <div className="rounded-md border border-border bg-card px-3 py-2" data-slot="pg-draft">
          <ChatInput aria-label="Your message" defaultValue={DRAFT} rows={2} className="w-full resize-none bg-transparent text-sm outline-none" />
        </div>
      </div>
      {scenario.keyboard && <Keyboard />}
      {/* The sheet lists a waiting message at once, grace or not. */}
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
        />
      </WalkyLogProvider>
    </div>
  );
}

function Option({ caseId }: { caseId: string }) {
  // Keyed by the case: a new case starts fresh, with its own list and a closed sheet.
  return <Pane key={caseId} scenario={scenarioOf(caseId)} />;
}

const OPTIONS: readonly PickOption[] = [{ n: 1, label: "On the mark", state: "walky-deliver-mark", render: (caseId) => <Option caseId={caseId} /> }];

const ROUND: PickRoundDef = { title: "Deliver now", cases: CASES, options: OPTIONS, frameHeight: 740 };

export default ROUND;
