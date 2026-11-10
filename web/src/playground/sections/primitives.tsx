// Primitives section of the states playground: the shared pieces in `components/ui/` drawn on their own,
// one card per state, each in the light half and in the dark half side by side. For now one card set:
// `MatchText`, the marked letters of a found or matched text (DESIGN.md §1, the theme token `--find`).
//
// Every card mounts the REAL `MatchText`. A row is drawn the way the session switcher draws one: the
// 2px edge cut inside the row for "current" (`--edge-accent` in `--primary`) on `bg-accent`, and in
// `--status-blocked` for a row that needs you. The point of the cards is that a mark repaints and never
// re-lays-out: the plain line and the marked line of a card have the same height and the same width.
//
// DEV-ONLY, unreachable from the app entry.

import type { ReactNode } from "react";

import { MatchText, type MatchRange } from "@/components/ui/match-text";
import { cn } from "@/lib/utils";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "primitives",
  title: "Primitives",
  intent:
    "The shared pieces of components/ui/, one card per state, in the light half and the dark half side by side. " +
    "MatchText marks the matched letters of a text on the theme token --find: plain, one range, three ranges, " +
    "on the current row, on a blocked row, and in a mono line. A mark repaints; it never changes a row's size.",
};

type Scheme = "light" | "dark";

/** One sample in both halves. `color-scheme` is what index.css's light-dark() tokens read, and it inherits. */
function BothHalves({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {(["light", "dark"] as const satisfies readonly Scheme[]).map((scheme) => (
        <div
          key={scheme}
          data-scheme={scheme}
          className={cn(scheme === "dark" && "dark", "min-w-0 rounded-md border border-border bg-background p-3 text-foreground")}
          style={{ colorScheme: scheme }}
        >
          {children}
        </div>
      ))}
    </div>
  );
}

const TEXT = "collie-workspace";

const THREE: readonly MatchRange[] = [
  [0, 1],
  [7, 8],
  [12, 13],
];

/** A switcher-like row: the name on line 1, a muted second line, the edge the row's state cuts. */
function Row({ ranges, state, mono = false }: { ranges?: readonly MatchRange[]; state?: "current" | "blocked"; mono?: boolean }) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-3 py-2.5",
        state === "current" && "bg-accent shadow-[var(--edge-accent)_var(--primary),var(--edge-shadow)]",
        state === "blocked" && "shadow-[var(--edge-accent)_var(--status-blocked),var(--edge-shadow)]",
      )}
    >
      <div className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm font-medium", mono && "font-mono")}>
          <MatchText text={TEXT} ranges={ranges} />
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">Claude, crew host</span>
      </div>
    </div>
  );
}

export function PrimitivesSection() {
  return (
    <Section def={DEF}>
      <Group title="MatchText">
        <Card state="match-text-plain" label="1 plain, no range" note="Draws the bare string: the same DOM as a text with no filter.">
          <BothHalves>
            <Row />
          </BothHalves>
        </Card>
        <Card state="match-text-one-range" label="2 one range">
          <BothHalves>
            <Row ranges={[[0, 6]]} />
          </BothHalves>
        </Card>
        <Card state="match-text-three-ranges" label="3 three ranges">
          <BothHalves>
            <Row ranges={THREE} />
          </BothHalves>
        </Card>
        <Card state="match-text-current-row" label="4 on the current row" note="bg-accent under the mark, the primary edge on the left.">
          <BothHalves>
            <Row ranges={THREE} state="current" />
          </BothHalves>
        </Card>
        <Card state="match-text-blocked-row" label="5 on a blocked row" note="The mark sits beside the blocked edge.">
          <BothHalves>
            <Row ranges={THREE} state="blocked" />
          </BothHalves>
        </Card>
        <Card state="match-text-mono-line" label="6 in a mono line">
          <BothHalves>
            <Row ranges={[[0, 6], [8, 11]]} mono />
          </BothHalves>
        </Card>
      </Group>
    </Section>
  );
}
