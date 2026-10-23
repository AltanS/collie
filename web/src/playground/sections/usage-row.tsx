// Usage row section of the states playground: the model tag above the belt, extended with the
// session's context use and the subscription's 5-hour and 7-day windows. A DESIGN ROUND, so the three
// shapes below are proposals drawn here and nowhere else: the shipped tag is `ModelTag`
// (components/model-tag.tsx), and the one Altan picks is built there, with its own test. See app.tsx's
// header for the page's own rules.
//
// Every shape keeps the tag's contract: absolute on the mirror's bottom-right corner, 10px caption on
// a 12px line box, `pointer-events-none`, on the translucent page ground, absent rather than a
// placeholder. A gauge Claude Code did not report is not drawn, and with none the tag is the model
// alone, exactly as today. Nothing here takes a touch.
//
// The first phone of each card mounts the REAL composer under the mirror, so the corner can be judged
// against the belt it floats over; the smaller mirrors under it are the other states of the same shape.
//
// DEV-ONLY, unreachable from the app entry.

import { useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Composer } from "@/components/composer";
import { ModelTag } from "@/components/model-tag";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import type { Surface } from "@/lib/surface/surface";
import type { PaneUsage } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Card, CardControls, Group, Section, type SectionDef } from "../layout";

import { ChromeBlock, PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "usage-row",
  title: "Usage row",
  intent:
    "The model tag above the belt, with the session's context use and the 5-hour and 7-day subscription windows beside it. Three shapes: small bars, dots, and short text on a second line. Pick one by its number. Each card shows the same four states: a working session, one near every limit, an API-key session with no subscription windows, and a pane whose own statusline already names the model.",
};

/** One reading, as Claude Code's statusLine input reports it. A gauge it did not send is absent. */
interface Usage {
  model?: string;
  ctx?: number;
  fiveHour?: number;
  sevenDay?: number;
}

interface StateDef {
  key: string;
  title: string;
  usage: Usage;
}

const STATES: readonly StateDef[] = [
  { key: "mid", title: "Working session", usage: { model: "Opus 5.5 · high", ctx: 42, fiveHour: 58, sevenDay: 36 } },
  { key: "high", title: "Near every limit (80% and up turns amber)", usage: { model: "Opus 5.5 · high", ctx: 86, fiveHour: 93, sevenDay: 81 } },
  { key: "api", title: "API key: no subscription windows", usage: { model: "Sonnet 5.5", ctx: 23 } },
  { key: "named", title: "The statusline names the model: gauges only", usage: { ctx: 7, fiveHour: 8, sevenDay: 36 } },
];

/** At or above this, a gauge takes the waiting colour. Not red: red marks harm (DESIGN.md §4). */
const WARN_AT = 80;

const GAUGES = [
  { id: "ctx", word: "ctx", spoken: "Context" },
  { id: "fiveHour", word: "5h", spoken: "5-hour limit" },
  { id: "sevenDay", word: "7d", spoken: "7-day limit" },
] as const;

type GaugeId = (typeof GAUGES)[number]["id"];

function present(usage: Usage): { id: GaugeId; word: string; spoken: string; value: number }[] {
  return GAUGES.flatMap((g) => {
    const value = usage[g.id];
    return value === undefined ? [] : [{ ...g, value }];
  });
}

/** The one sentence a screen reader gets for every shape, so the shapes differ in paint only. */
function spokenOf(usage: Usage): string {
  const parts = present(usage).map((g) => `${g.spoken} ${Math.round(g.value)}% used`);
  return [usage.model === undefined ? null : `Model: ${usage.model}`, ...parts].filter((p) => p !== null).join(". ");
}

/** The tag's own box, copied from model-tag.tsx, with the width the shape needs. */
function TagBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="model-tag"
      className={cn(
        "pointer-events-none absolute right-3 bottom-1 z-10 rounded-[2px] bg-background/90 px-1 text-[10px]/3 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── Shape 1: small bars ───────────────────────────────────────────────────────────────────────────

/** A 16 by 3px bar, 2px corners, on the muted track. The fill is a width: a new value repaints. */
function MiniBar({ value }: { value: number }) {
  const warn = value >= WARN_AT;
  return (
    <span className="relative inline-block h-[3px] w-4 overflow-hidden rounded-[1px] bg-muted-foreground/25 align-middle">
      <span
        className={cn("absolute inset-y-0 left-0", warn ? "bg-status-working" : "bg-muted-foreground")}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </span>
  );
}

function BarsTag({ usage }: { usage: Usage }) {
  const gauges = present(usage);
  return (
    <TagBox className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className="flex items-center gap-1.5">
        {usage.model !== undefined && <span className="truncate">{usage.model}</span>}
        {gauges.map((g) => (
          <span key={g.id} className="flex items-center gap-[3px]">
            <span>{g.word}</span>
            <MiniBar value={g.value} />
          </span>
        ))}
      </span>
      <span className="sr-only">{spokenOf(usage)}</span>
    </TagBox>
  );
}

// ── Shape 2: dots (PICKED 2026-10-23, shipped as the real ModelTag) ───────────────────────────────

/** The fixture's model label, back in the harness's own words the real tag reads. */
const MODEL_IDS = new Map<string, { model: string; effort?: string }>([
  ["Opus 5.5 · high", { model: "claude-opus-5-5", effort: "high" }],
  ["Sonnet 5.5", { model: "claude-sonnet-5-5" }],
]);

/** Card 2 mounts the REAL tag, so this card shows what ships, not a copy of it. */
function DotsTag({ usage }: { usage: Usage }) {
  const named = usage.model === undefined ? undefined : MODEL_IDS.get(usage.model);
  const limits = [
    ...(usage.fiveHour === undefined ? [] : [{ window: "5h" as const, used: usage.fiveHour }]),
    ...(usage.sevenDay === undefined ? [] : [{ window: "7d" as const, used: usage.sevenDay }]),
  ];
  const pane: PaneUsage = {};
  if (usage.ctx !== undefined) pane.context = usage.ctx;
  if (limits.length > 0) pane.limits = limits;
  return <ModelTag model={named?.model} effort={named?.effort} usage={pane} />;
}

// ── Shape 3: short text, on a line of its own ─────────────────────────────────────────────────────

function TextTag({ usage }: { usage: Usage }) {
  const gauges = present(usage);
  return (
    <TagBox className="flex flex-col items-end whitespace-nowrap">
      <span aria-hidden className="flex flex-col items-end">
        {gauges.length > 0 && (
          <span className="flex gap-1.5 tabular-nums">
            {gauges.map((g) => (
              <span key={g.id}>
                {g.word} <span className={cn(g.value >= WARN_AT && "text-status-working")}>{Math.round(g.value)}%</span>
              </span>
            ))}
          </span>
        )}
        {usage.model !== undefined && <span>{usage.model}</span>}
      </span>
      <span className="sr-only">{spokenOf(usage)}</span>
    </TagBox>
  );
}

// ── The cards ─────────────────────────────────────────────────────────────────────────────────────

interface VariantDef {
  n: 1 | 2 | 3;
  title: string;
  line: string;
  Tag: (props: { usage: Usage }) => ReactNode;
}

const VARIANTS: readonly VariantDef[] = [
  {
    n: 1,
    title: "Small bars",
    line: "One line. The model, then ctx, 5h and 7d, each a 16px bar with no number. The quietest shape: a glance tells empty, half or full, not the figure.",
    Tag: BarsTag,
  },
  {
    n: 2,
    title: "Dots (picked)",
    line: "Picked 2026-10-23 and shipped: this card mounts the real ModelTag. One line. The same three gauges as five dots each, one dot per fifth. Easier to count than a bar at this size; a step is 20%, so 41% and 59% look alike.",
    Tag: DotsTag,
  },
  {
    n: 3,
    title: "Short text, second line",
    line: "Two lines, right aligned: ctx 42% · 5h 58% · 7d 36% above the model. Exact figures. Taller, so it covers one more mirror row at the corner.",
    Tag: TextTag,
  },
];

const FREE_SURFACE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };

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

/** The last rows of a terminal, so the tag's ground can be judged over text, not over nothing. */
const MIRROR_ROWS = [
  "  ⎿  Updated web/src/components/model-tag.tsx with 14 additions",
  "",
  "● The tag now carries the context and limit gauges. Running the",
  "  web checks next: typecheck, lint, then the full vitest suite.",
  "  The playground scene has three numbered option cards to pick",
];

function Mirror({ children, rows = MIRROR_ROWS }: { children: ReactNode; rows?: readonly string[] }) {
  return (
    <div className="relative border-t border-rule">
      <pre className={cn(MIRROR_SPACE, MIRROR_INVERT, "overflow-hidden px-3 pt-2 pb-1 font-mono text-[11px]/[15px] whitespace-pre")}>
        {rows.join("\n")}
      </pre>
      {children}
    </div>
  );
}

function WithBelt({ n, children }: { n: number; children: ReactNode }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <ChromeBlock>
              <Composer
                paneId={`usage:${n}`}
                agent="claude"
                isShell={false}
                gone={false}
                readOnly={false}
                surface={FREE_SURFACE}
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
  return (
    <PhoneMock>
      {children}
      <RouterProvider router={router} />
    </PhoneMock>
  );
}

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

function OptionCard({ def, state }: { def: VariantDef; state: string }) {
  const { Tag } = def;
  const [first, ...rest] = STATES;
  return (
    <Card state={state} label={`${def.n}: ${def.title}`} reach="Not built yet: a design round. Today's tag is the model alone." note={def.line}>
      <CardControls className="flex items-center gap-3">
        <NumberBadge n={def.n} />
        <p className="text-sm font-semibold text-foreground">
          {def.n}: {def.title}
        </p>
      </CardControls>
      <div className="flex flex-col gap-3">
        {first !== undefined && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{first.title}, over the real belt</p>
            <WithBelt n={def.n}>
              <Mirror>
                <Tag usage={first.usage} />
              </Mirror>
            </WithBelt>
          </div>
        )}
        {rest.map((s) => (
          <div key={s.key}>
            <p className="mb-1 text-xs text-muted-foreground">{s.title}</p>
            <PhoneMock>
              <Mirror rows={MIRROR_ROWS.slice(-3)}>
                <Tag usage={s.usage} />
              </Mirror>
            </PhoneMock>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function UsageRowSection() {
  return (
    <Section def={DEF}>
      <Group title="Three shapes for the usage gauges">
        {/* Literal handles, written out: the e2e roll call reads the state props from source. */}
        <OptionCard state="usage-row-1" def={VARIANTS[0]!} />
        <OptionCard state="usage-row-2" def={VARIANTS[1]!} />
        <OptionCard state="usage-row-3" def={VARIANTS[2]!} />
      </Group>
    </Section>
  );
}
