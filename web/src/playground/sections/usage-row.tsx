// Usage row section of the states playground: the model tag above the belt, extended with the
// session's context use and the subscription's windows as the agent reports them (5-hour and 7-day, a
// weekly window scoped to a model, or just one window): the REAL `ModelTag`
// (components/model-tag.tsx) in both modes of the Usage row setting. The design round of 2026-10-23
// (bars, dots, text) is decided: dots shipped, then percentages became the default (2026-11-13).
//
// The tag keeps its contract: absolute on the mirror's bottom-right corner, 10px caption on
// a 12px line box, `pointer-events-none`, on the translucent page ground, absent rather than a
// placeholder. A gauge Claude Code did not report is not drawn, and with none the tag is the model
// alone, exactly as today. Nothing here takes a touch.
//
// The first phone of each card mounts the REAL composer under the mirror, so the corner can be judged
// against the belt it floats over; the smaller mirrors under it are the other states of the same mode.
//
// DEV-ONLY, unreachable from the app entry.

import { useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { Composer } from "@/components/composer";
import { ModelTag } from "@/components/model-tag";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import type { Surface } from "@/lib/surface/surface";
import type { PaneUsage } from "@/lib/types";
import type { UsageRow } from "@/lib/usage-row";
import { cn } from "@/lib/utils";

import { Card, CardControls, Group, Section, type SectionDef } from "../layout";

import { ChromeBlock, PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "usage-row",
  title: "Usage row",
  intent:
    "The model tag above the belt, with the session's context use and the subscription windows the agent reports beside it. The real tag as a percentage (the default) and as dots, the Usage row setting. Each card shows the same six states: a working session, one near every limit, a plan that reports one window, a weekly window scoped to a model, an API-key session with no subscription windows, and a pane whose own statusline already names the model.",
};

/** One reading, as Claude Code's statusLine input reports it. A gauge it did not send is absent. */
interface Usage {
  model?: string;
  ctx?: number;
  fiveHour?: number;
  sevenDay?: number;
  /** A weekly window scoped to a model, as `7d:<scope>` with the harness's label. */
  scoped?: { label: string; used: number };
}

interface StateDef {
  key: string;
  title: string;
  usage: Usage;
}

const STATES: readonly StateDef[] = [
  { key: "mid", title: "Working session", usage: { model: "Opus 5.5 · high", ctx: 42, fiveHour: 58, sevenDay: 36 } },
  { key: "high", title: "Near every limit (80% and up turns red)", usage: { model: "Opus 5.5 · high", ctx: 86, fiveHour: 93, sevenDay: 81 } },
  { key: "one", title: "A plan that reports one window", usage: { model: "Opus 5.5 · high", ctx: 42, sevenDay: 36 } },
  { key: "scoped", title: "A weekly window scoped to a model", usage: { model: "Opus 5.5 · high", ctx: 42, fiveHour: 58, sevenDay: 36, scoped: { label: "Opus", used: 22 } } },
  { key: "api", title: "API key: no subscription windows", usage: { model: "Sonnet 5.5", ctx: 23 } },
  { key: "named", title: "The statusline names the model: gauges only", usage: { ctx: 7, fiveHour: 8, sevenDay: 36 } },
];


// ── The real tag ──────────────────────────────────────────────────────────────────────────────────

/** The fixture's model label, back in the harness's own words the real tag reads. */
const MODEL_IDS = new Map<string, { model: string; effort?: string }>([
  ["Opus 5.5 · high", { model: "claude-opus-5-5", effort: "high" }],
  ["Sonnet 5.5", { model: "claude-sonnet-5-5" }],
]);

/** Card 2 mounts the REAL tag, so this card shows what ships, not a copy of it. Dots, whatever the device chose. */
function DotsTag({ usage }: { usage: Usage }) {
  return <RealTag usage={usage} mode="dots" />;
}

/** The same real tag, as the percentage the Usage row setting defaults to. */
function PercentTag({ usage }: { usage: Usage }) {
  return <RealTag usage={usage} mode="percent" />;
}

/** The real tag drawing one mode, whatever the device chose (the setting is Settings, Appearance, Usage row). */
function RealTag({ usage, mode }: { usage: Usage; mode: UsageRow }) {
  const named = usage.model === undefined ? undefined : MODEL_IDS.get(usage.model);
  const limits = [
    ...(usage.fiveHour === undefined ? [] : [{ window: "5h", used: usage.fiveHour }]),
    ...(usage.sevenDay === undefined ? [] : [{ window: "7d", used: usage.sevenDay }]),
    ...(usage.scoped === undefined ? [] : [{ window: `7d:${usage.scoped.label.toLowerCase()}`, label: usage.scoped.label, used: usage.scoped.used }]),
  ];
  const pane: PaneUsage = {};
  if (usage.ctx !== undefined) pane.context = usage.ctx;
  if (limits.length > 0) pane.limits = limits;
  return <ModelTag model={named?.model} effort={named?.effort} usage={pane} usageRow={mode} />;
}

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

/** One card of the shipped row: the real tag in one mode, over the same four states. */
function ModeCard({ state, mode, title, line }: { state: string; mode: UsageRow; title: string; line: string }) {
  const [first, ...rest] = STATES;
  const Tag = mode === "percent" ? PercentTag : DotsTag;
  return (
    <Card state={state} label={title} reach="Settings, Appearance, Usage row. Percent is the default." note={line}>
      <CardControls className="flex items-center gap-3">
        <p className="text-sm font-semibold text-foreground">{title}</p>
      </CardControls>
      <div className="flex flex-col gap-3">
        {first !== undefined && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{first.title}, over the real belt</p>
            <WithBelt n={mode === "percent" ? 4 : 5}>
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
      <Group title="The shipped row, both modes (the Usage row setting)">
        <ModeCard
          state="usage-row-percent"
          mode="percent"
          title="Percent (the default)"
          line="The share used, as a whole number: ctx 42%. Exact, and the number turns red from 80%. Tabular digits, so the row does not jitter."
        />
        <ModeCard
          state="usage-row-dots"
          mode="dots"
          title="Dots"
          line="The same share as five dots, one per full fifth, red from 80%. Chosen in Settings, Appearance, Usage row."
        />
      </Group>
    </Section>
  );
}
