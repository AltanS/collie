// The census, drawn: the count per verdict, the worst twenty, and every element with a filter. All three
// read `data.ts`, which reads the one JSON file the browser run wrote. DEV-ONLY.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { Segmented } from "../layout";
import { REACHED, ROWS, VERDICTS, countByVerdict, filterRows, screensWalked, worst, type Row } from "./data";
import { Fine } from "./report";
import { type Verdict } from "./verdict";

const TONE = {
  ok: "text-status-done",
  small: "text-status-working",
  covered: "text-status-blocked",
  shifts: "text-status-blocked",
  "dead-time": "text-status-idle",
} satisfies Record<Verdict, string>;

const GROUPS = ["Dashboard", "Session", "Hill", "Settings", "Pages", "Sheets"] as const;

function px(size: readonly [number, number] | null): string {
  return size === null ? "none" : `${String(size[0])}x${String(size[1])}`;
}

function Th({ children, end }: { children: string; end?: boolean }) {
  return (
    <th scope="col" className={cn("px-1.5 pb-1 align-bottom font-normal first:pl-0 last:pr-0", end ? "text-right" : "text-left")}>
      {children}
    </th>
  );
}

export function VerdictCounts() {
  const all = countByVerdict(ROWS);
  const screens = screensWalked(REACHED);
  return (
    <>
      <table className="w-full border-collapse text-xs" data-slot="verdict-counts">
        <thead>
          <tr className="border-b border-rule text-muted-foreground">
            <Th>Area</Th>
            {VERDICTS.map((v) => (
              <Th key={v} end>
                {v}
              </Th>
            ))}
            <Th end>all</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border font-mono tabular-nums">
          {GROUPS.map((g) => {
            const rows = ROWS.filter((r) => r.group === g);
            const c = countByVerdict(rows);
            return (
              <tr key={g}>
                <td className="py-1 pr-1.5 font-sans">{g}</td>
                {VERDICTS.map((v) => (
                  <td key={v} className={cn("px-1.5 py-1 text-right", c[v] > 0 && TONE[v])}>
                    {c[v]}
                  </td>
                ))}
                <td className="py-1 pl-1.5 text-right">{rows.length}</td>
              </tr>
            );
          })}
          <tr className="font-medium">
            <td className="py-1 pr-1.5 font-sans">All</td>
            {VERDICTS.map((v) => (
              <td key={v} className="px-1.5 py-1 text-right">
                {all[v]}
              </td>
            ))}
            <td className="py-1 pl-1.5 text-right">{ROWS.length}</td>
          </tr>
        </tbody>
      </table>
      <Fine>
        {String(screens.length)} screens, each at 390x844 and 360x780, so a target that shows at both counts twice. A sheet is scanned alone, because it is all a finger can reach while it is open. A control that is deaf by design at rest (a button that shows on a long press) is left out. The verdict is the worst reason that applies: covered if under 90% of the box answers, small if the reach is under 44px, shifts if it moved 1px or more when a pane arrived (Dashboard only), dead-time if a hold over 450ms is not a tap. Rules in hitbox/verdict.ts.
      </Fine>
    </>
  );
}

function RowLine({ r, withFlag }: { r: Row; withFlag: boolean }) {
  return (
    <tr className="align-top">
      <td className="py-1 pr-1.5 font-mono text-[11px] text-muted-foreground">{r.screen}</td>
      <td className="px-1.5 py-1 break-words">{r.name}</td>
      <td className="px-1.5 py-1 font-mono text-[11px] tabular-nums">{px(r.box)}</td>
      <td className="px-1.5 py-1 font-mono text-[11px] tabular-nums">{px(r.hit)}</td>
      <td className="px-1.5 py-1 font-mono text-[11px] tabular-nums">{r.gap === null ? "n/a" : String(r.gap)}</td>
      <td className={cn("py-1 pl-1.5", TONE[r.verdict])}>
        <span className="font-medium">{r.verdict}</span>
        {withFlag && r.flags[0] !== undefined && <span className="block text-[11px] text-muted-foreground">{r.flags[0]}</span>}
      </td>
    </tr>
  );
}

function RowTable({ rows, withFlag = true }: { rows: readonly Row[]; withFlag?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-xs">
        <thead>
          <tr className="border-b border-rule text-muted-foreground">
            <Th>Screen</Th>
            <Th>Name</Th>
            <Th>Box</Th>
            <Th>Hit</Th>
            <Th>Gap</Th>
            <Th>Verdict</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <RowLine key={`${r.screen}|${r.size}|${r.selector}|${r.name}|${String(i)}`} r={r} withFlag={withFlag} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WorstTwenty() {
  const top = worst(ROWS, 20);
  return (
    <>
      <RowTable rows={top} />
      <Fine>Three rows of session-zoom (Back to the pane, Reset zoom, Zoom in) read covered 100% in the scan, but a direct elementFromPoint at the button centre answers with the button; the scan of that screen is unresolved, so read those three as unconfirmed. Box and Hit are CSS px, width by height. Hit is the area where the browser answers with the control or a child of it. Gap is the distance to the nearest other target, in px. A target on both phone sizes shows once, at the worse reading.</Fine>
    </>
  );
}

const PAGE = 40;

export function CensusExplorer() {
  const [verdict, setVerdict] = useState<Verdict | "all">("all");
  const [size, setSize] = useState("390x844");
  const [shown, setShown] = useState(PAGE);
  const rows = filterRows(ROWS, size, verdict);
  const counts = countByVerdict(ROWS.filter((r) => r.size === size));
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segmented
          name="Verdict"
          value={verdict}
          options={[{ value: "all", label: `all ${String(Object.values(counts).reduce((a, b) => a + b, 0))}` }, ...VERDICTS.map((v) => ({ value: v, label: `${v} ${String(counts[v])}` }))]}
          onChange={(v) => {
            setVerdict(v);
            setShown(PAGE);
          }}
        />
        <Segmented
          name="Size"
          value={size}
          options={[
            { value: "390x844", label: "390" },
            { value: "360x780", label: "360" },
          ]}
          onChange={(v) => {
            setSize(v);
            setShown(PAGE);
          }}
        />
      </div>
      <RowTable rows={rows.slice(0, shown)} />
      <div className="mt-2 flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground" data-slot="census-shown">
          {Math.min(shown, rows.length)} of {rows.length}, worst first
        </span>
        {shown < rows.length && (
          <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setShown((n) => n + PAGE)}>
            Show {PAGE} more
          </Button>
        )}
      </div>
    </>
  );
}
