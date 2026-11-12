// THE WRITTEN PART of the "Hitbox investigation" section: what Collie does today, the Dashboard's eight
// causes with the numbers the browser run measured, what a headless run cannot see, and the proposals.
//
// The numbers here are copied from `fixtures/hitbox-census.json` (key `part1`), which
// `web/e2e/hitbox/dashboard.run.ts` writes, on the day named at the foot of each card. A rerun of that
// file may move them; the tables are prose and do not follow it, the census tables (`census-cards.tsx`) do.
// DEV-ONLY, like the rest of `src/playground/`.

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import fixes from "../fixtures/hitbox-fixes.json";

const mono = "font-mono text-[11px]";

interface Column {
  label: string;
}

type Cell = string;

function cells(...texts: string[]): Cell[] {
  return texts;
}

/**
 * A table whose cells are sentences. The shared MiniTable clamps a cell to two lines, which is right for
 * a figure and wrong for a finding, so this one lets every cell wrap in full. The first column is the
 * row's name and stays narrow.
 */
function ProseTable({ columns, rows, className }: { columns: readonly Column[]; rows: readonly (readonly Cell[])[]; className?: string }) {
  return (
    <table className={cn("w-full border-collapse text-xs leading-relaxed", className)}>
      <thead>
        <tr className="border-b border-rule text-left text-muted-foreground">
          {columns.map((c) => (
            <th key={c.label} scope="col" className="px-1.5 pb-1 align-bottom font-normal first:pl-0 last:pr-0">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => (
          <tr key={row.join("|")} className="align-top">
            {row.map((cell, i) => (
              <td key={i} className={cn("px-1.5 py-1.5 first:pl-0 last:pr-0", i === 0 ? "w-[22%] font-medium text-foreground" : "text-muted-foreground")}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A line of small print under a card's table. */
export function Fine({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{children}</p>;
}

/** A code reference, in the card's small type. */
function Ref({ children }: { children: ReactNode }) {
  return <code className={cn(mono, "break-all")}>{children}</code>;
}

// ── 1. What Collie does today ─────────────────────────────────────────────────────────────────

const RULE_COLUMNS: Column[] = [
  { label: "Rule" },
  { label: "Written in" },
  { label: "Checked by" },
];

const RULES: Cell[][] = [
  cells("44px is the floor for anything tappable, in both axes.", "DESIGN.md §6, first line", "Only the cases below, each for one screen. No lint rule, no test over every control."),
  cells("A control may measure less if a transparent ::before buys the reach back.", "ui/labelled-strip.tsx:32 and :42, ui/tap-target.ts:17, workspace-new-tab.tsx:27", "The constants carry the arithmetic. Only pane-top-bar.spec.ts measures a reach (its width)."),
  cells("A row states its floor with min-h, never h.", "DESIGN.md §6, app-header.tsx min-h-15", "Reading the code. Two named exceptions: the composer status band and update mode."),
  cells("One exception: the pane header's two 30px lines.", "DESIGN.md §6, agent-chat.tsx pane-identity-taps", "pane-top-bar.spec.ts"),
  cells("A known violation: the Authentication card's inline links, about 22px.", "DESIGN.md, known violation 7", "Nothing. It is written down and left."),
  cells("A hold of 450ms is a long press, a move past 16px cancels it, 8px is the tap tolerance of onTap.", "hooks/use-long-press.ts:8, :13, :20", "use-long-press.test.ts, in jsdom, with no real finger."),
  cells("No tap highlight; pressed state is a scale.", "index.css:1360, ui/button.tsx:18 (0.98), ui/fab.tsx:69 (0.95), session-switcher.tsx:92 (0.95)", "Nothing. The scale also shrinks the hit area (card 2, cause 2)."),
];

const FLOOR_SPECS: Cell[][] = [
  cells("dashboard-top.spec.ts", "workspace filter and pane order are 44px or more, at 360 and 390 wide"),
  cells("dashboard-footer.spec.ts", "the needs-you switch is 44px or more"),
  cells("new-tab-sheet.spec.ts, changes.spec.ts, changes-files.spec.ts", "the sheet's rows, the changes rows, the files chips"),
  cells("pane-top-bar.spec.ts, wide-layout.spec.ts", "the pane header taps, the tablet sidebar's buttons"),
];

export function RulesTable() {
  return (
    <>
      <ProseTable columns={RULE_COLUMNS} rows={RULES} />
      <p className="mt-3 text-[11px] font-medium text-foreground">The browser cases that measure a floor</p>
      <ProseTable columns={[{ label: "Case" }, { label: "What it measures" }]} rows={FLOOR_SPECS} className="mt-1" />
      <Fine>
        Read from the repo on 2026-11-12. The shipped primitives sit under the floor by default: Button is h-9 (36px), size sm h-8 (32px), icon size-9 (36px), and the sheet's close button is size-8 (32px, ui/sheet.tsx:379). Only size lg is 44px.
      </Fine>
    </>
  );
}

// ── 3. Eight causes, measured ─────────────────────────────────────────────────────────────────

const CAUSE_COLUMNS: Column[] = [
  { label: "#  Cause" },
  { label: "Lost taps?" },
  { label: "Measured" },
];

const CAUSES: Cell[][] = [
  cells("1  Small target", "A little", "The Dashboard holds 36 targets. 5 reach under 44px: the session pill (81x26), the summary line (314x32), the spaces heading (289x36), New space (36x36) and the space filter (304x36). Rows are 356x45 with 0px between them. The + buttons and the hint close draw 28px and 24px and reach 44px and 46px."),
  cells("2  Drawn bigger than the handler", "Yes, 2px at the edge", "Pressing scales the element (pill and FAB 0.95, Button 0.98, row 0.99). A finger that lands within 2px of the pill's right edge, or 2.4px of the FAB's, ends outside the shrunk box. Taps at 2px from the right edge: 0 of 4 delivered on both, 4 of 4 at 3px. A row loses its last 1px the same way (0 of 4 at 1px). A lost FAB tap clicks the row under it."),
  cells("3  Something lies over it", "Yes, one place", "Grid of points over each of 16 targets, and over every row with the list scrolled to 6 positions. The FAB (96x48 at rest, 48x48 once the list scrolls, at the right foot) lies over the right end of the row that passes under it: 80% of that row's points answered at rest, 90% at scroll 120 and 240. The tab bar covers nothing a scroll cannot clear. No transparent layer, toast or sticky bar lay over a target."),
  cells("4  Node replaced by a poll", "No", "8 cells, 200 taps each, the poll answer landing 90ms into a 150ms press: the pressed node was never replaced (0 of 1600) and no tap vanished (0 lost). A poll that left the list as it was, or changed only a pane's status, lost nothing (200 of 200). Every miss was a click on a different row, which is cause 8."),
  cells("5  A gesture eats the tap", "Yes, three ways", "Drift of 0, 3, 6, 8, 10 and 15px: 5 of 5 clicks, both axes, on 4 targets. Drift of 20px: 0 of 5, it was a scroll. A press held 300ms clicks 5 of 5. From 440ms: 0 clicks, 5 of 5 open the actions sheet. A tap within 350ms of lifting from a fling: 0 of 6 clicks, 6 of 6 times the list was still moving, so the tap stopped it. From 450ms: 6 of 6 clicks."),
  cells("6  Deliberate dead time", "Yes, two", "The pane open waits for the network read: 929ms after the lift at a 1000ms read, 5329ms at 3000ms, with a 2px bar after 120ms as the only sign. Tapping again does not help: three taps over a 1500ms read sent 6 reads and the pane opened 3.9s after the first tap. After 30 minutes without a touch, a tap on a row did nothing in 4 of 4 runs and the cover was still up 9.5s later: it needs Resume."),
  cells("7  Wrong event", "No", "Every Dashboard target answers click (React onClick). Rows add pointerdown for the prefetch and the hold timer. No touchstart handler calls preventDefault upstream of the Dashboard (grep over components, routes, hooks)."),
  cells("8  Layout shift at tap time", "Yes, the biggest", "A needs-you pane arriving moves 13 of 36 targets by 45px (one row), and one space heading by 258px as its section moves up. Forced on every try, with the poll landing 90ms into the press: a pane arriving above the pressed row delivered 21 of 200 taps to it and sent 179 to a neighbour (90 to claude needs you, 89 to codex working); a pane leaving delivered 18 and sent 182. Lifting later does not recover it: 2 of 15, 0 of 13, 10 of 20 and 3 of 18 taps reached the row at 150, 250, 350 and 400ms. How often a real herd changes above a pressed row is not measured. On first load nothing moves after the first paint at 0.5 to 0.6s; before it, a tap reaches no row. After Back the row answers from the first frame."),
];

export function CausesTable() {
  return (
    <>
      <ProseTable columns={CAUSE_COLUMNS} rows={CAUSES} />
      <Fine>
        Measured 2026-11-12 with Playwright (Chromium) on the repo's own stub bridge, at 390x844 and 360x780, touch on, device scale 3, real touches through the DevTools touch protocol, a contact radius of 8px. Raw numbers are in fixtures/hitbox-census.json under the keys part1:grid, part1:poll and so on. The same cases ran at 360x780 (keys part1-360:grid and so on, 60 tries per poll cell) with the same results: rows 326px wide, 0 of 4 taps at 2px from the pill's and the FAB's edge, 0 of 5 at 20px of drift, a hold from 440ms opens the sheet, 0 of 6 clicks within 350ms of a fling, 930ms and 5349ms for the pane read, 7 of 60 taps reaching a row that a pane arrived above, 13 of 36 targets moving. The browser's own touch slop is the emulated one (about 15px); a phone's is not measured here (card 12).
      </Fine>
    </>
  );
}

// ── 4. Ranked by taps lost ───────────────────────────────────────────────────────────────────

interface Finding {
  readonly title: string;
  readonly lost: string;
  readonly why: string;
  readonly where: readonly string[];
}

const FINDINGS: readonly Finding[] = [
  {
    title: "A row moves between finger down and finger up",
    lost: "179 of 200 taps went to a neighbour when a pane arrived, 182 when one left",
    why: "The browser sends the click to whatever stands under the finger when it lifts. A pane that arrives or leaves above the pressed row moves the list by one row (45px), at once, and the click opens a different pane. The test forces the change on every try, so the rate in use depends on how often a herd changes above the row you press, which is not measured here.",
    where: ["agent-list.tsx:369 (ranks are held only for the chosen order)", "hooks/use-polling.ts:42-59 (a poll every 1.5s to 6s)", "agent-card.tsx:254"],
  },
  {
    title: "A slow press is a long press",
    lost: "0 of 5 clicks from 440ms; 5 of 5 at 300ms",
    why: "From 450ms the row opens its actions sheet and the click that follows is thrown away. A careful, slow tap, or a thumb that rests, never opens the pane. The sheet does open, so it reads as a wrong result rather than as nothing.",
    where: ["hooks/use-long-press.ts:8 (450ms), :203 (the click is stopped)", "agent-card.tsx:258-262"],
  },
  {
    title: "A tap while the list coasts only stops the list",
    lost: "0 of 6 clicks within 350ms of a fling; 6 of 6 from 450ms",
    why: "After a quick swipe the list keeps moving for about 400ms. A touch in that time stops the scroll, which is the browser's own rule, and sends no click. The row under the finger is moving, so it also reads as a miss. The hand cannot tell the moments apart.",
    where: ["browser behaviour; rows set no touch-action", "agent-list.tsx (the list scrolls in one container)"],
  },
  {
    title: "The pane open shows nothing while it reads",
    lost: "no click lost, but 929ms to 5329ms with only a 2px bar",
    why: "The tap waits 120ms for the data and then navigates the plain way, which holds the old screen until the read ends. The row gives no sign of its own. A second tap does not help: it sent its own reads and the pane opened later, 3.9s after the first tap over a 1500ms read.",
    where: ["lib/glide.ts:356 (READY_WAIT_MS = 120)", "hooks/use-pane-open.ts:43", "components/busy-bar.tsx, index.css:1497 (2px, after 120ms)"],
  },
  {
    title: "A press shrinks the target away from the finger's edge",
    lost: "0 of 4 delivered at 2px from the pill's or the FAB's right edge",
    why: "active:scale shrinks the element while the finger is down, so the lift point falls outside it. On the FAB the click then reaches the row beneath, which opens a pane.",
    where: ["ui/button.tsx:18 (0.98)", "ui/fab.tsx:69 (0.95)", "session-switcher.tsx:92 (0.95)", "agent-card.tsx:265 (0.99)"],
  },
  {
    title: "The floating button lies over the foot of the list",
    lost: "20% of the points of the rows at the foot, at rest",
    why: "The FAB (96x48 at rest, 48x48 after a scroll) covers the right end of the row that passes beneath it. The row's tap there goes to the FAB. It collapses on scroll, so it sits over rows while the list rests.",
    where: ["ui/fab.tsx:56-69", "routes/home.tsx:542"],
  },
  {
    title: "The idle cover takes the first taps",
    lost: "0 of 4 taps worked; the cover stayed 9.5s",
    why: "After 30 minutes without a touch, an open page shows Collie paused. Taps on rows reach the cover and only its Resume button ends it. The cover shows, so it is a surprise only for a person who looks away.",
    where: ["hooks/use-idle-lock.ts:20 (30 min)", "components/idle-lock.tsx:84 (Resume)", "lib/idle.ts:16 (catch-up cap 8s)"],
  },
  {
    title: "Five Dashboard targets are under 44px",
    lost: "not measured as lost taps; the gap is 0px to 17px",
    why: "The session pill is 26px tall, the summary line 32px, the spaces heading 36px, New space 36px, the space filter 36px. The finger is wider than any of them, and the pill sits next to Settings.",
    where: ["session-switcher.tsx:80-92", "strips-summary.tsx:67", "dash-selects.tsx:162", "routes/home.tsx:542"],
  },
  {
    title: "A drift of 20px is a scroll",
    lost: "0 of 5 at 20px; 5 of 5 up to 15px",
    why: "The slop here is Chromium's emulated one. Android reads its own from the phone (card 12), and a thumb tap on a tall row drifts more than a finger tap.",
    where: ["browser behaviour; no touch-action on rows", "index.css:1380 (overscroll-behavior-y)"],
  },
];

export function FindingsList() {
  return (
    <ol className="space-y-3">
      {FINDINGS.map((f, i) => (
        <li key={f.title} className="rounded-lg border border-border p-3">
          <p className="text-sm font-medium text-foreground">
            <span className={cn(mono, "mr-2 text-muted-foreground")}>{i + 1}</span>
            {f.title}
          </p>
          <p className={cn(mono, "mt-1 text-status-blocked")}>{f.lost}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.why}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {f.where.map((w) => (
              <Ref key={w}>{w}</Ref>
            ))}
          </p>
        </li>
      ))}
    </ol>
  );
}

// ── 13. What might be missing ─────────────────────────────────────────────────────────────────

const MISSING: Cell[][] = [
  cells("Real finger size", "The run sends a 16px contact patch at the point you name. A thumb is 10 to 14mm and lands off-centre. Open the tap lab (card 11) on the phone. It prints the patch the browser reports and how far from the centre each tap landed."),
  cells("Android touch slop", "Chromium's emulation allows about 15px. Android's own slop is a few dp and the browser also reads it from the phone. The tap lab counts a touch the browser cancelled, and prints the largest move of a tap that still clicked."),
  cells("Palm and edge contact", "Not simulated. A palm on the lower rows reaches the tab bar and the FAB first. Hold the phone as you do in the tram, tap the 28px and 36px squares and read the cancelled column."),
  cells("The installed PWA", "The run opens a tab. In standalone mode there is no browser bar, the safe areas change and the system gesture edge sits near the tab bar. Install Collie, open the tap lab there and compare the max off column to the tab."),
  cells("120 Hz and a busy phone", "The run does not stress frames. A press that spans a slow frame can lift after a layout change. On a 120 Hz phone, open Collie with 11 or more panes and watch the Dashboard while an agent changes state."),
];

export function MissingTable() {
  return (
    <>
      <ProseTable columns={[{ label: "Not checked" }, { label: "How to test it on a phone" }]} rows={MISSING} />
      <Fine>Also not checked: a screen reader's double tap, a mouse and a stylus, other Android browsers, iOS Safari (the repo has a WebKit lane for layout only), a real Tailscale link's delay, and tapping while the keyboard is open.</Fine>
    </>
  );
}

// ── 14. Proposals ─────────────────────────────────────────────────────────────────────────────

const PROPOSALS: Cell[][] = [
  cells("1  Open the row that was pressed", "On pointerdown remember the pane. On click, if the row under the finger has another pane, open the remembered one. About 20 lines in agent-card.tsx and a test.", "Low. A row that was removed while pressed opens a pane that is gone, which the pane route already handles."),
  cells("2  Hold the list still during a press", "While a finger is down on the list and 300ms after, hold the new rows and apply them after. Reuse use-frozen-ranks.ts. About a day.", "Medium. A status can show 300ms late. The ranks hook has the same trade already (ADR 0071)."),
  cells("3  Show the long press coming", "At 250ms, scale and tint the row, so a slow press is seen turning into a hold. Move the hold to 500ms. A small change in use-long-press.ts.", "Low. Operators who like the sheet wait 50ms longer."),
  cells("4  Answer the tap at once", "When the read is not in at 120ms, mark the pressed row as opening (a thin bar inside the row, no layout change) and ignore a second tap on it. About a day.", "Low to medium. A second tap now restarts nothing, so the duplicate guard needs a test."),
  cells("5  Stop the press scale shrinking the hit", "Keep active:scale but paint it on an inner span, or add a ::before the size of the unscaled box. Starts with the pill, the FAB and Button.", "Medium. Button is used in 137 places, and a ::before can cover a neighbour."),
  cells("6  Buy the floor for the five small targets", "Add a ::before reach (the STRIP_TAP_TARGET pattern) to the pill, summary line, spaces heading, New space and space filter. A day with a browser case.", "Low. The gap between the pill and Settings is 0px, so the reach must be measured."),
  cells("7  Guard the floor with the census", "Run e2e/hitbox/census.run.ts in CI on the Dashboard and Session screens and fail on a new small or covered target. A written list holds the known ones. Two days.", "Medium. It needs the stub world to stay current, and the browser leg is slow."),
  cells("8  Count missed taps on the phone", "A local counter: a pointerdown and pointerup with no click within 400ms, by control name, shown in Settings, System. Never sent anywhere. Two days.", "Low. It adds a global listener, so it must stay off the hot path and be off by default."),
];

export function ProposalsTable() {
  return (
    <>
      <ProseTable columns={[{ label: "Proposal" }, { label: "Cost" }, { label: "Risk" }]} rows={PROPOSALS} />
      <Fine>
        Order is by taps won per day of work: 1 and 2 address the biggest loss, 3 and 4 the next two. Seven of the eight are built on the fix branch, one commit each (the missed-tap counter, 8, is not); card 14 holds the numbers before and after. Cards 1 to 13 describe the build as it was found.
      </Fine>
    </>
  );
}

// ── 15. Before and after the fixes ────────────────────────────────────────────────────────────

/**
 * The seven fixes of the fix branch, each with what was measured before it (the investigation's build,
 * b9262b515) and after it, in the same engine with the same scripts. The numbers are read from
 * `fixtures/hitbox-fixes.json`, which is written by hand from the runs named in `REGRESSIONS.md`; the census
 * rows themselves are in `hitbox-census.json` and follow the browser run.
 */
export function BeforeAfterTable() {
  const rows: Cell[][] = fixes.rows.map((r) => cells(r.fix, r.measured, r.before, r.after));
  return (
    <>
      <ProseTable columns={[{ label: "Fix" }, { label: "Measured" }, { label: "Before" }, { label: "After" }]} rows={rows} />
      <Fine>{fixes.note}</Fine>
    </>
  );
}
