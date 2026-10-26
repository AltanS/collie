// Report a problem section of the states playground (ADR 0123): the card after three failed sends, and
// the sheet it opens in each of its states. Every card mounts the REAL component (`ReportCard`,
// `ReportSheetView`) with fixture receipts and a fixture setup block; the sheet's buttons build the real
// link. Cards are numbered so a worker can be briefed by number.

import type { ReactNode } from "react";

import { ReportCard } from "@/components/report-card";
import { ReportSheetView } from "@/components/report-sheet";
import type { ReportContext } from "@/lib/report/context";
import type { Episode } from "@/lib/report/store";
import type { SendReceiptRow } from "@/lib/surface/send";

import { Card, Group, Section, Stage, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "report",
  title: "Report a problem",
  intent:
    "After three sends in a row on one pane fail for a reason that points at Collie, a card floats above the composer. " +
    "Report opens the sheet, which shows every word of the issue before anything leaves. Open on GitHub opens GitHub's own form, " +
    "filled in, in the person's browser. Card 1 is the offer; cards 2 to 6 are the sheet: sends only, with a kept line, " +
    "with the screen switch, a screen too long for the link, and the Settings door with no pane.",
};

const CONTEXT: ReportContext = { collie: "1.24.1", line: "edge", os: "linux", arch: "x64", mux: "acme-mux", harness: "claude", screenable: true };
const AT = Date.parse("2026-10-25T18:03:00Z");

function row(n: number, extra: Partial<SendReceiptRow> = {}): SendReceiptRow {
  return {
    requestId: `pg-report-${String(n).padStart(4, "0")}`,
    at: AT + n * 40_000,
    mode: "send",
    outcome: "refused",
    reason: "probe_failed",
    keys: ["probe", "Backspace"],
    gapsMs: { s0: 18, probe: 120 },
    harness: "claude",
    version: "2.1.291",
    profileId: "claude@2.1",
    profileStatus: "verified",
    detail: "The probe character changed more than the box.",
    saw: { turn: "idle", modal: "none", composer: "empty" },
    ...extra,
  };
}

// Newest first, as the receipts route answers.
const SENDS: readonly SendReceiptRow[] = [row(3), row(2, { outcome: "typed_not_submitted", reason: "mismatch", keys: [] }), row(1)];
const WITH_LINES: readonly SendReceiptRow[] = SENDS.map((r, i) => (i === 1 ? r : { ...r, line: "run the tests again please" }));
const SCREEN = [
  "● I'll run the tests now.",
  "",
  "  ⎿  bun test ./bridge",
  "     1204 pass, 0 fail",
  "",
  "╭──────────────────────────────────────────────╮",
  "│ >                                            │",
  "╰──────────────────────────────────────────────╯",
  "  ? for shortcuts                 OPENROUTER_API_KEY=sk-or-v1-••••••••••••",
].join("\n");
const LONG_SCREEN = Array.from({ length: 40 }, (_, n) => `row ${String(n).padStart(2, "0")} ${"x".repeat(150)}`).join("\n");
const EPISODES: readonly Episode[] = [
  { at: AT - 86_400_000, paneId: "w1:p2", sends: [{ requestId: "pg-ep-00001", outcome: "unknown", reason: "no_evidence" }, { requestId: "pg-ep-00002", outcome: "unknown", reason: "no_evidence" }, { requestId: "pg-ep-00003", outcome: "refused", reason: "not_free" }] },
];

function SheetCard({ state, n, label, reach, children }: { state: string; n: number; label: string; reach: string; children: ReactNode }) {
  return (
    <Card state={state} label={`${String(n)}. ${label}`} reach={reach}>
      <Stage>
        <div className="max-h-[640px] overflow-y-auto p-4">{children}</div>
      </Stage>
    </Card>
  );
}

export function ReportSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The offer">
        <Card state="report-card" label="1. the card, above the composer" reach="fail three sends in a row on one pane (a screen Collie cannot read)">
          <Stage>
            <div className="relative flex h-40 flex-col justify-end p-3">
              <ReportCard count={3} onReport={() => {}} onClose={() => {}} />
              <div className="mt-2 h-11 rounded-lg border border-border bg-background" />
            </div>
          </Stage>
        </Card>
      </Group>
      <Group title="The sheet">
        <SheetCard state="report-sheet-sends" n={2} label="sends only, the default" reach="tap Report on the card">
          <ReportSheetView context={CONTEXT} contextError={null} rows={SENDS} episodes={[]} fromSettings={false} loadScreen={async () => SCREEN} />
        </SheetCard>
        <SheetCard state="report-sheet-typed" n={3} label="with a kept line: Include what I typed" reach="fail sends whose text Sent would keep">
          <ReportSheetView context={CONTEXT} contextError={null} rows={WITH_LINES} episodes={[]} fromSettings={false} loadScreen={async () => SCREEN} />
        </SheetCard>
        <SheetCard state="report-sheet-screen" n={4} label="the screen switch (turn it on)" reach="Include the screen on a pane with a screen">
          <ReportSheetView context={CONTEXT} contextError={null} rows={SENDS} episodes={[]} fromSettings={false} loadScreen={async () => SCREEN} />
        </SheetCard>
        <SheetCard state="report-sheet-cut" n={5} label="a screen too long for the link (turn it on)" reach="Include the screen on a wide, full pane">
          <ReportSheetView context={CONTEXT} contextError={null} rows={SENDS} episodes={[]} fromSettings={false} loadScreen={async () => LONG_SCREEN} />
        </SheetCard>
        <SheetCard state="report-sheet-settings" n={6} label="from Settings, no pane" reach="Settings, System, Report a problem">
          <ReportSheetView context={{ ...CONTEXT, harness: null, screenable: false }} contextError={null} rows={[]} episodes={EPISODES} fromSettings loadScreen={async () => ""} />
        </SheetCard>
      </Group>
    </Section>
  );
}
