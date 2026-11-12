// "Hitbox investigation": why a tap on the Dashboard sometimes does nothing, and the same census for every
// screen. The operator's words, 2026-11-12: "the dashboard hitboxes are kinda fiddly, i sometimes click but
// nothing happens". Six parts, in the order the question asks: what Collie does today, what the Dashboard
// loses and why, the census of every tap target, the live overlays, what a headless run cannot see (and a
// tap lab to see it on a phone), and the proposals.
//
// WHERE THE NUMBERS COME FROM. `web/e2e/hitbox/` holds two Playwright files (not part of `bun run e2e`) that
// drive the real app on the repo's stub bridge and write ONE file, `../fixtures/hitbox-census.json`: the
// census (every screen, two phone sizes) and the Dashboard experiments. The census tables and overlays
// below read it or measure live; the written findings quote the experiments and say when.
//
// Cards 1 to 13 are the investigation, as found at b9262b515; card 14 is the fixes, before and after. DEV-ONLY, unreachable from the
// app entry: see ../app.tsx and web/playground.html.

import type { ReactNode } from "react";

import { Card, Group, Section, type SectionDef } from "../layout";
import { CensusExplorer, VerdictCounts, WorstTwenty } from "../hitbox/census-cards";
import { DashboardOverlay, DecisionOverlay, PaneOverlay, SettingsOverlay } from "../hitbox/live-cards";
import { BeforeAfterTable, CausesTable, FindingsList, MissingTable, ProposalsTable, RulesTable } from "../hitbox/report";
import { TapLab } from "../hitbox/tap-lab";

export const DEF: SectionDef = {
  id: "hitbox",
  title: "Hitbox investigation",
  intent:
    "Why a Dashboard tap sometimes does nothing, measured in a headless Chromium with real touches at 390 and 360 wide, and the same census for every screen. Solid outline: where the control is drawn. Dashed outline: where the browser really answers.",
};

export function HitboxSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="What Collie does today">
        <Card
          state="hitbox-rules"
          label="1 · Tap rules in force today"
          reach="DESIGN.md §6, the ui/ primitives, and the browser cases named in the table."
          span="all"
        >
          <RulesTable />
        </Card>
      </Group>

      <Group title="Dashboard findings">
        <Card state="hitbox-causes" label="2 · Eight causes, measured" reach="the Dashboard on a phone, rows and the three buttons near the foot." span="all">
          <CausesTable />
        </Card>
        <Card state="hitbox-ranked" label="3 · Ranked by taps lost" span="all">
          <FindingsList />
        </Card>
      </Group>

      <Group title="Census of every screen">
        <Card state="hitbox-counts" label="4 · Elements per verdict" span="all">
          <VerdictCounts />
        </Card>
        <Card state="hitbox-worst" label="5 · The worst twenty" span="all">
          <WorstTwenty />
        </Card>
        <Card state="hitbox-all" label="6 · Every element, by verdict" span="all">
          <CensusExplorer />
        </Card>
      </Group>

      <Group title="Live overlays">
        <Card
          state="hitbox-live-dashboard"
          label="7 · Dashboard, drawn and reached"
          reach="the Dashboard. Scroll the list inside the frame, then press Measure now."
          note="The real route table over fixture loaders, so rows, header, tab bar and the floating button are the shipped components. The floating New button is drawn on the page body by a portal, so it is hidden here (card 2 measured it). The outlines are measured in your browser with a mouse-sized probe, not a finger: a mouse sees no touch slop and no pressed scale."
          span={2}
        >
          <DashboardOverlay />
        </Card>
        <Card state="hitbox-live-pane" label="8 · Pane, belt and composer" reach="open any pane: the header, the belt, the composer." span={2}>
          <PaneOverlay />
        </Card>
        <Card state="hitbox-live-settings" label="9 · Settings, drawn and reached" reach="Settings, from the gear." span={2}>
          <SettingsOverlay />
        </Card>
        <Card state="hitbox-live-decision" label="10 · A Hill decision card" reach="the Hill tab, with a decision open." span={2}>
          <DecisionOverlay />
        </Card>
      </Group>

      <Group title="Try it on a phone">
        <Card
          state="hitbox-tap-lab"
          label="11 · Tap lab for a real phone"
          reach="open this page on a phone over the tailnet and tap each square the way you tap in the app."
          note="It counts clicks, cancelled touches, the largest move of a tap, the longest hold, the contact patch the browser reports and how far from the centre each tap landed. It sends nothing anywhere."
        >
          <TapLab />
        </Card>
      </Group>

      <Group title="What might be missing">
        <Card state="hitbox-missing" label="12 · What a headless run misses" span="all">
          <MissingTable />
        </Card>
      </Group>

      <Group title="Proposals">
        <Card state="hitbox-proposals" label="13 · Eight proposals, cost, risk" span="all">
          <ProposalsTable />
        </Card>
        <Card state="hitbox-before-after" label="14 · Before and after" reach="the Dashboard, the pane header and the floating button." span="all">
          <BeforeAfterTable />
        </Card>
      </Group>
    </Section>
  );
}
