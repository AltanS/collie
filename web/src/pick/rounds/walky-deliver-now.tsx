// "Deliver now", a design round (deliver-now prototype), on the pick page: /pick.html?round=walky-deliver-now: a message held for a pane with a draft in its box
// may be let in by the person's own act, when the session has the data transport (it is "linked"). Three
// options, ONE Case switch, the real `WalkySheet` and the real held mark (`WalkyHeldStrip`).
//
// 1 and 3 live in the Messages sheet (3 asks first, "Your draft stays."), 2 puts the action on the mark above
// the box when exactly one message waits. A tap on Deliver now runs a fake that answers after 800 ms: the
// message turns delivered and the draft stays. The case "fails" answers with a refusal instead, and "plain"
// is a session that is not linked, to show that nothing changed. Replay (in the bar) starts every option over.
//
// DEV-ONLY, unreachable from the app entry. The pick shell holds the rules: a number and at most five words
// per option, nothing else on the page.

import { useCallback, useMemo, useState, type CSSProperties } from "react";

import { Collapse } from "@/components/ui/collapse";
import { WalkyHeldStrip } from "@/components/walky-composer-strip";
import { WalkyLogProvider, WalkyPanesProvider } from "@/components/walky-log";
import { WalkySheet } from "@/components/walky-sheet";
import type { AgentView } from "@/lib/types";
import { heldForPane, type WalkyRow } from "@/lib/walky";
import { fixtureWalkyAgent, fixtureWalkyOperator, fixtureWalkySelf } from "@/test/handlers";

import type { PickCase, PickOption, PickRoundDef } from "../pick-page";

/** What the fake takes: the call answers after this long. */
const FAKE_MS = 800;

const CASES: readonly PickCase[] = [
  { id: "one", label: "One held" },
  { id: "three", label: "Three held" },
  { id: "plain", label: "Not linked" },
  { id: "long", label: "Long, 360 px" },
  { id: "crew", label: "Crew pane" },
  { id: "fails", label: "Fails" },
  { id: "keyboard", label: "Keyboard up" },
];

const DRAFT = "Also check the retry in sync.ts, and whether the empty list reaches the loader";
const HELD_REASON = "draft present";
const MINUTE = 60_000;

interface Scenario {
  rows: readonly WalkyRow[];
  linked: boolean;
  fails: boolean;
  keyboard: boolean;
  /** The frame's inner width: 360 for the narrow case, else what the phone frame gives. */
  width: number | null;
  live: readonly AgentView[];
}

function held(row: WalkyRow, over: Partial<WalkyRow> & { id: string; minutesAgo: number }): WalkyRow {
  const { minutesAgo, ...rest } = over;
  const at = Date.now() - minutesAgo * MINUTE;
  return { ...row, ...rest, at, receipt: { ...row.receipt, id: over.id, at, state: "accepted", reason: HELD_REASON } };
}

const FIX: WalkyRow = held(fixtureWalkyAgent, { id: "wt_dn0000000001", minutesAgo: 4, body: "Tests are green on fix-465. You can merge." });
const DOCS: WalkyRow = held(fixtureWalkyAgent, {
  id: "wt_dn0000000002",
  minutesAgo: 2,
  from: { memberId: "bluefin", address: "bluefin/w3:p2", harness: "claude", label: "collie-website#docs" },
  body: "The docs page for the new transport is ready for a read.",
});
const OPERATOR: WalkyRow = held(fixtureWalkyOperator, { id: "wt_dn0000000003", minutesAgo: 1, body: "Stop and report what you changed." });

const LONG: WalkyRow = held(fixtureWalkyAgent, {
  id: "wt_dn0000000004",
  minutesAgo: 3,
  from: { memberId: "bluefin", address: "bluefin/w6:p3", harness: "claude", label: "collie-workspace#fix-465-retry-the-final-error-in-the-sync-loader" },
  body:
    "Review of fix-465 is done. The retry in packages/bridge/src/sync/loader/retry-with-backoff.ts swallows the final error, " +
    "rethrow it after the last attempt, and the test for the empty list passes for the wrong reason because it never reaches the loader.",
});

const REMOTE: WalkyRow = held(fixtureWalkyAgent, {
  id: "wt_dn0000000005",
  minutesAgo: 2,
  from: { memberId: "minibuch", address: "minibuch/w11:p4#8h9h", harness: "claude", label: "collie-workspace#fix-465" },
  signer: "minibuch",
  body: "Got it. The standby door answers on minibuch.",
});
const REMOTE_PANE: AgentView = {
  paneId: "w11:p4",
  instance: "8h9h",
  workspaceId: "w11",
  workspaceLabel: "collie-workspace",
  workspaceNumber: 11,
  tabId: "w11:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/altan/collie",
  focused: false,
  kind: "agent",
  host: "minibuch",
  paneLabel: "standby-door",
};

function scenarioOf(caseValue: string): Scenario {
  const base = { linked: true, fails: false, keyboard: false, width: null, live: [] } as const;
  switch (caseValue) {
    case "three":
      return { ...base, rows: [FIX, DOCS, OPERATOR] };
    case "plain":
      return { ...base, linked: false, rows: [FIX] };
    case "long":
      return { ...base, width: 360, rows: [LONG] };
    case "crew":
      return { ...base, rows: [REMOTE], live: [REMOTE_PANE] };
    case "fails":
      return { ...base, fails: true, rows: [FIX] };
    case "keyboard":
      return { ...base, keyboard: true, rows: [FIX] };
    default:
      return { ...base, rows: [FIX] };
  }
}

/** The receipt a delivered message carries: no hold reason any more, as the bridge's next read would say. */
function delivered(row: WalkyRow): WalkyRow {
  const { reason: _reason, ...receipt } = row.receipt;
  return { ...row, receipt: { ...receipt, state: "delivered", at: Date.now() } };
}

/** A message the person dropped or cancelled ends in the inbox, as the clock would end it. */
function inInbox(row: WalkyRow): WalkyRow {
  const { reason: _reason, ...receipt } = row.receipt;
  return { ...row, receipt: { ...receipt, state: "inbox-only", at: Date.now() } };
}

/** Stands in for the soft keyboard: the composer sits on top of it, as it does on a phone. */
function Keyboard() {
  return (
    <div aria-hidden="true" className="h-[260px] shrink-0 bg-muted/60 pt-2 text-center text-[11px] text-muted-foreground">
      keyboard
    </div>
  );
}

/** One pane: some chat above, the held mark and the box with its draft below, the Messages sheet over it. */
function Pane({ option, scenario }: { option: 1 | 2 | 3; scenario: Scenario }) {
  const [rows, setRows] = useState<readonly WalkyRow[]>(scenario.rows);
  const [open, setOpen] = useState(option !== 2 && !scenario.keyboard);
  const heldRows = useMemo(() => heldForPane(rows, fixtureWalkySelf), [rows]);
  const end = useCallback((id: string, to: (row: WalkyRow) => WalkyRow) => setRows((now) => now.map((row) => (row.id === id ? to(row) : row))), []);
  // The fake bridge: answers after 800 ms, with the message delivered or with a refusal.
  const onDeliverNow = useCallback(
    (id: string) =>
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          if (scenario.fails) return reject(new Error("The session did not take it."));
          end(id, delivered);
          resolve();
        }, FAKE_MS);
      }),
    [scenario.fails, end],
  );
  const take = useCallback(
    async (row: WalkyRow) => {
      end(row.id, inInbox);
      return null;
    },
    [end],
  );
  const only = heldRows.length === 1 ? heldRows[0] : undefined;
  // `--app-h` is what a sheet sizes itself to; the frame's height stands in for the viewport's, and `transform` makes the frame the sheet's containing block.
  const frame: CSSProperties & { "--app-h"?: string } = { width: scenario.width ?? "100%", height: 728, transform: "translate(0)", "--app-h": "728px" };
  return (
    <div className="relative flex flex-col overflow-hidden bg-background" style={frame}>
      <p className="flex-1 px-4 pt-3 text-xs text-muted-foreground">Working on fix-465. Waiting for the review.</p>
      <div className="px-4 pb-3">
        <Collapse open={heldRows.length > 0}>
          {heldRows.length > 0 && (
            <WalkyHeldStrip count={heldRows.length} onOpen={() => setOpen(true)} linked={scenario.linked && option === 2} deliverId={only?.id} onDeliverNow={onDeliverNow} />
          )}
        </Collapse>
        <div className="rounded-md border border-border bg-card px-3 py-2 text-sm" data-slot="pg-draft">
          {DRAFT}
        </div>
      </div>
      {scenario.keyboard && <Keyboard />}
      <WalkyLogProvider rows={rows} reads={1}>
        <WalkyPanesProvider value={{ live: { panes: scenario.live, lead: "bluefin" }, open: () => undefined }}>
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
            deliverConfirm={option === 3}
          />
        </WalkyPanesProvider>
      </WalkyLogProvider>
    </div>
  );
}

function Option({ option, caseValue }: { option: 1 | 2 | 3; caseValue: string }) {
  // Keyed by the case: a new case starts every option fresh, with its own list and a closed or open sheet.
  return <Pane key={caseValue} option={option} scenario={scenarioOf(caseValue)} />;
}

const OPTIONS: readonly PickOption[] = [
  { n: 1, label: "Action in the row", render: (caseId) => <Option option={1} caseValue={caseId} /> },
  { n: 2, label: "Action on the mark", render: (caseId) => <Option option={2} caseValue={caseId} /> },
  { n: 3, label: "Row action, confirm line", render: (caseId) => <Option option={3} caseValue={caseId} /> },
];

const ROUND: PickRoundDef = { title: "Deliver now", cases: CASES, options: OPTIONS, frameHeight: 740 };

export default ROUND;
