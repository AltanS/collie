// "Session filter", the round for the look (M97 spec 05): the four LOOK decisions of the filter, side
// by side, on the real components and the fourteen-row crew of two machines (`switcherCrew`).
//
// One Case switch sets the typed query in every option: the options render the real `ThreadSidebar`
// (1 to 6, the Switch pane sheet's list) and the real `AgentList` (7 and 8, the Dashboard's top)
// through the optional props the filter's own switches already are (`filterLevel`, `filterOrder`,
// `filterHidden`, `filterEntry`). Each option changes ONE switch and leaves the others at the shipped
// defaults (`PANE_FILTER`, `DASH_FILTER_ENTRY`), so a pair differs in the one thing it is about.
//
// 1 and 2 Match: anchored (a substring, or letters that each start a word) or loose (any letters in order).
// 3 and 4 Order: the list keeps its place, or one flat list with the best match first.
// 5 and 6 Hidden field: a match in a field the row does not draw shows on line 2, or is not searched.
// 7 and 8 Dashboard entry: a magnifier in the control bar, or the field always under the bar.
//
// DEV-ONLY, unreachable from the app entry. A page rule applies (app.tsx): a number and at most five
// words per option, nothing else on the page.

import { useState, type ReactNode } from "react";

import { AgentList } from "@/components/agent-list";
import { PANE_FILTER, type PaneFilterSettings } from "@/lib/pane-filter";
import type { PaneOrder } from "@/lib/pane-order";
import type { DashFilterEntry } from "@/lib/dash-filter";
import type { HomeData } from "@/lib/loaders";

import { homeSolo, switcherCrew } from "../fixtures";
import { PackedRootRouter } from "../harness";
import { Section, type SectionDef } from "../layout";
import { Round, type RoundCase, type RoundOption } from "../round";
import { SwitcherList } from "./switcher";
import { useCardFilter } from "./shared";

export const DEF: SectionDef = { id: "filter", title: "Session filter" };

/** The typed query of each case. `none` is the empty field, where the two Dashboard entries differ most. */
const CASES: readonly RoundCase[] = [
  { value: "cw", label: "cw" },
  { value: "fix 7", label: "fix 7" },
  { value: "claude", label: "claude" },
  { value: "minibuch", label: "minibuch" },
  { value: "zzz", label: "zzz" },
  { value: "none", label: "none" },
];

function queryOf(caseValue: string): string {
  return caseValue === "none" ? "" : caseValue;
}

/** The switcher sheet's body: the panel's fill and gutter inside the phone frame's own scroller. */
function Sheet({ children }: { children: ReactNode }) {
  return <div className="min-h-full bg-card px-4 py-3">{children}</div>;
}

function SwitcherOption({ caseValue, settings }: { caseValue: string; settings: PaneFilterSettings }) {
  return (
    <Sheet>
      <SwitcherList key={caseValue} here={switcherCrew.agents[2]!} settings={settings} initialQuery={queryOf(caseValue)} />
    </Sheet>
  );
}

const DASH_DATA: HomeData = {
  ...homeSolo,
  agents: switcherCrew.agents,
  shellPanes: switcherCrew.shellPanes,
  workspaces: switcherCrew.workspaces,
  tabs: [],
  servers: switcherCrew.servers,
  sessions: switcherCrew.sessions,
};

/** The Dashboard's list with its whole control bar live; the filter's state is the option's own. */
function DashList({ query, entry }: { query: string; entry: DashFilterEntry }) {
  const filter = useCardFilter({ query, open: query !== "" });
  const [order, setOrder] = useState<PaneOrder>("place");
  const [needsYou, setNeedsYou] = useState(false);
  const [isolated, setIsolated] = useState<string[]>([]);
  return (
    <AgentList
      filter={filter}
      filterEntry={entry}
      agents={DASH_DATA.agents}
      shellPanes={DASH_DATA.shellPanes}
      bridge="connected"
      onOpen={() => {}}
      servers={DASH_DATA.servers}
      workspaces={DASH_DATA.workspaces}
      order={order}
      onOrderChange={setOrder}
      isolated={isolated}
      onIsolate={setIsolated}
      needsYouOnly={needsYou}
      onNeedsYouOnlyChange={setNeedsYou}
    />
  );
}

/** The router freezes its children, so a new case remounts the router itself. */
function DashOption({ caseValue, entry }: { caseValue: string; entry: DashFilterEntry }) {
  return (
    <PackedRootRouter key={caseValue} data={DASH_DATA}>
      <DashList query={queryOf(caseValue)} entry={entry} />
    </PackedRootRouter>
  );
}

const OPTIONS: readonly RoundOption[] = [
  { n: 1, title: "Match: anchored", render: ({ caseValue }) => <SwitcherOption caseValue={caseValue} settings={{ ...PANE_FILTER, level: "anchored" }} /> },
  { n: 2, title: "Match: loose", render: ({ caseValue }) => <SwitcherOption caseValue={caseValue} settings={{ ...PANE_FILTER, level: "loose" }} /> },
  { n: 3, title: "Order: keep place", render: ({ caseValue }) => <SwitcherOption caseValue={caseValue} settings={{ ...PANE_FILTER, order: "place" }} /> },
  { n: 4, title: "Order: best first", render: ({ caseValue }) => <SwitcherOption caseValue={caseValue} settings={{ ...PANE_FILTER, order: "best" }} /> },
  { n: 5, title: "Hidden: second line", render: ({ caseValue }) => <SwitcherOption caseValue={caseValue} settings={{ ...PANE_FILTER, hidden: "second-line" }} /> },
  { n: 6, title: "Hidden: drawn only", render: ({ caseValue }) => <SwitcherOption caseValue={caseValue} settings={{ ...PANE_FILTER, hidden: "drawn-only" }} /> },
  { n: 7, title: "Entry: magnifier button", render: ({ caseValue }) => <DashOption caseValue={caseValue} entry="button" /> },
  { n: 8, title: "Entry: always visible", render: ({ caseValue }) => <DashOption caseValue={caseValue} entry="always" /> },
];

export function FilterRoundSection() {
  return (
    <Section def={DEF}>
      <Round id="filter" cases={CASES} options={OPTIONS} frame={{ kind: "phone", height: 720 }} />
    </Section>
  );
}
