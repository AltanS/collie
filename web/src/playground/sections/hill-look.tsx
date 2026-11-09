// The "Hill look" section of the states playground (M96 design round, 2026-11-09): numbered options
// for the look of the Dashboard strip (A), the Decision card (B) and the Hill view (C), each beside
// today's (A0, B0, C0). One case switch at the top drives every option, so all of them show the same
// data. Explanation goes in the report, not on the page.
//
// Two query words make shots and phone checks easy: `?case=busy` picks the case on load, and
// `?solo=B2` draws that one option over the whole screen (the option's number links there; Back
// returns). `&shot=1` hides the solo close button.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useState, type CSSProperties, type ReactNode } from "react";

import { Mountain } from "lucide-react";

import { CardControls, Card, Group, Section, Segmented, type SectionDef } from "../layout";
import { LookCard, type CardId } from "../hill-look/cards";
import { CASE_DATA, CASES, isCaseId, type CaseId, type HillCase } from "../hill-look/fixtures";
import { StripDashboard, type StripId } from "../hill-look/strip";
import { HillLookView, type ViewId } from "../hill-look/view";

export const DEF: SectionDef = {
  id: "hill-look",
  title: "Hill look",
  intent: "Options for the Dashboard strip, the Decision card and the Hill view, one case for all.",
};

type OptionId = StripId | CardId | ViewId;

const OPTIONS: readonly { id: OptionId; label: string }[] = [
  { id: "A0", label: "today's row" },
  { id: "A1", label: "tiles under header" },
  { id: "A2", label: "icons in summary line" },
  { id: "A3", label: "sticky pills, title peek" },
  { id: "A4", label: "bottom bar carries it all" },
  { id: "A5", label: "Hill tab, tricks on top" },
  { id: "A6", label: "bottom bar, tricks sheet" },
  { id: "B0", label: "today's card" },
  { id: "B1", label: "calm, typographic" },
  { id: "B2", label: "the sender carries it" },
  { id: "B3", label: "a ticket from the agent" },
  { id: "C0", label: "today's view" },
  { id: "C1", label: "calm, by priority" },
  { id: "C2", label: "by sender, summit flag" },
];

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function isOptionId(word: string | null): word is OptionId {
  return OPTIONS.some((o) => o.id === word);
}

/** The cards an option of part B shows: the case's open Decisions, or a quiet mountain with none. */
function CardList({ option, c }: { option: CardId; c: HillCase }) {
  if (c.open.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Mountain aria-hidden className="size-10 text-rule" strokeWidth={1.5} />
      </div>
    );
  }
  return (
    <div data-pg-scroll className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 [&>*]:shrink-0">
      {c.open.map((d) => (
        <LookCard key={`${option}:${d.id}`} option={option} decision={d} />
      ))}
    </div>
  );
}

/** One option's screen, whatever part it belongs to. */
function OptionScreen({ id, c }: { id: OptionId; c: HillCase }) {
  if (isStrip(id)) return <StripDashboard option={id} c={c} />;
  if (isCard(id)) return <CardList option={id} c={c} />;
  return <HillLookView option={id} c={c} />;
}

function isStrip(id: OptionId): id is StripId {
  return id.startsWith("A");
}

function isCard(id: OptionId): id is CardId {
  return id.startsWith("B");
}

/** A phone-wide frame on the page colour, its own height and scroll. */
function Phone({ height, children }: { height: number; children: ReactNode }) {
  const box: CSSProperties & { "--app-h"?: string } = { width: 390, height, transform: "translate(0)", "--app-h": `${height}px` };
  return (
    <div data-pg-frame="" className="relative isolate flex max-w-full flex-col overflow-hidden rounded-sm bg-background ring-1 ring-rule" style={box}>
      {children}
    </div>
  );
}

function Head({ id, label, caseId }: { id: OptionId; label: string; caseId: CaseId }) {
  return (
    <CardControls className="flex items-center gap-3">
      <a
        href={`?case=${caseId}&solo=${id}#hill-look`}
        aria-label={`${id} full screen`}
        className="flex h-9 min-w-11 shrink-0 items-center justify-center rounded-sm bg-foreground px-2 text-base font-bold leading-none text-background"
      >
        {id}
      </a>
      <p className="text-sm font-semibold text-foreground">{label}</p>
    </CardControls>
  );
}

function OptionCard({ id, caseId }: { id: OptionId; caseId: CaseId }) {
  const label = OPTIONS.find((o) => o.id === id)?.label ?? id;
  return (
    <Card state={`hill-look-${id.toLowerCase()}`} label={`${id}: ${label}`}>
      <Head id={id} label={label} caseId={caseId} />
      <Phone height={760}>
        {/* Keyed by the case: a new case starts every option fresh (no draft or arm carried over). */}
        <OptionScreen key={caseId} id={id} c={CASE_DATA[caseId]} />
      </Phone>
    </Card>
  );
}

/** One option over the whole screen, for a phone and for the shots. */
function Solo({ id, caseId }: { id: OptionId; caseId: CaseId }) {
  const shot = param("shot") === "1";
  const style: CSSProperties & { "--app-h"?: string } = { "--app-h": "100dvh" };
  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background text-foreground" style={style}>
      <OptionScreen id={id} c={CASE_DATA[caseId]} />
      {!shot && (
        <a
          href={`?case=${caseId}#hill-look`}
          aria-label="Close"
          className="fixed bottom-4 left-4 z-[61] flex h-11 min-w-11 items-center justify-center rounded-sm border border-border bg-card px-2 text-sm font-semibold shadow-md"
        >
          {id} ×
        </a>
      )}
    </div>
  );
}

export function HillLookSection() {
  const asked = param("case");
  const [caseId, setCaseId] = useState<CaseId>(isCaseId(asked) ? asked : "busy");
  const solo = param("solo");
  if (isOptionId(solo)) return <Solo id={solo} caseId={caseId} />;
  return (
    <Section def={DEF}>
      <div className="sticky top-0 z-40 -mx-4 bg-background/95 px-4 py-2 backdrop-blur-sm">
        <Segmented name="Case" value={caseId} options={CASES} onChange={setCaseId} />
      </div>
      <Group title="A Dashboard strip">
        {(["A0", "A1", "A2", "A3", "A4", "A5", "A6"] as const).map((id) => (
          <OptionCard key={id} id={id} caseId={caseId} />
        ))}
      </Group>
      <Group title="B Decision card">
        {(["B0", "B1", "B2", "B3"] as const).map((id) => (
          <OptionCard key={id} id={id} caseId={caseId} />
        ))}
      </Group>
      <Group title="C Hill view">
        {(["C0", "C1", "C2"] as const).map((id) => (
          <OptionCard key={id} id={id} caseId={caseId} />
        ))}
      </Group>
    </Section>
  );
}
