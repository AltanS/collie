// Session switcher section of the states playground (M97 spec 03): the "Switch pane" sheet's list,
// which had no card before the session filter came to it. The card mounts the REAL `ThreadSidebar`
// under the real `CrewProvider`, on a crew of two machines with fourteen session rows (`switcherCrew`
// in ../fixtures.ts), inside a box drawn as the sheet's body is: the card's fill, its 16px gutter and
// its own scroller, so the filter block sticks and bleeds as it does in the sheet. The order toggle and
// the Shells fold are wired to local state, so they behave; nothing is stored.

import { useState, type ReactNode } from "react";

import { ThreadSidebar } from "@/components/agent-sidebar";
import { CrewProvider } from "@/components/crew-provider";
import { paneRowKey } from "@/lib/hosts";
import { PANE_FILTER, type PaneFilterSettings } from "@/lib/pane-filter";
import type { PaneOrder } from "@/lib/pane-order";
import { panePlaceParts } from "@/lib/pane-name";
import type { AgentView } from "@/lib/types";

import { switcherCrew, TS } from "../fixtures";
import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "switcher",
  title: "Session switcher",
  intent:
    "The list in the Switch pane sheet and in the large screen's sidebar: Pinned, a section per space, " +
    "Shells and Launch. Above five session rows a filter field leads it; typing narrows the rows and " +
    "marks the matched letters.",
};

const PINS = [{ row: paneRowKey(switcherCrew.pinned), space: panePlaceParts(switcherCrew.pinned).space, at: TS }];

/** The sheet's body, without the sheet: its fill, its gutter and its own scroller, at a phone's width. */
function SheetBody({ children }: { children: ReactNode }) {
  return (
    <div data-pg-frame="" className="w-[390px] max-w-full overflow-hidden rounded-md border border-rule bg-card">
      <div className="max-h-[640px] overflow-y-auto overscroll-contain">
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  );
}

/**
 * The real `ThreadSidebar` on the crew of two machines, its order toggle and its Shells fold wired to
 * local state. `settings` and `initialQuery` are the filter's switches (the round's options, spec 05);
 * the card passes none and gets the shipped defaults.
 */
export function SwitcherList({
  here,
  settings = PANE_FILTER,
  initialQuery = "",
}: {
  here: AgentView;
  settings?: PaneFilterSettings;
  initialQuery?: string;
}) {
  const [order, setOrder] = useState<PaneOrder>("place");
  const [shellsOpen, setShellsOpen] = useState(true);
  return (
    <CrewProvider servers={switcherCrew.servers} sessions={switcherCrew.sessions} ts={TS} pollMs={3_000}>
      <ThreadSidebar
        agents={switcherCrew.agents}
        shellPanes={switcherCrew.shellPanes}
        currentPaneKey={paneRowKey(here)}
        onSelect={() => {}}
        servers={switcherCrew.servers}
        workspaces={switcherCrew.workspaces}
        sessions={switcherCrew.sessions}
        pins={PINS}
        shellsOpen={shellsOpen}
        onShellsOpenChange={setShellsOpen}
        order={order}
        onOrderChange={setOrder}
        className="px-0 py-1"
        // The sheet's own head is not drawn here, so the block sticks at the top of the box.
        filterClassName="top-0 -mx-4 px-4"
        filterLevel={settings.level}
        filterOrder={settings.order}
        filterHidden={settings.hidden}
        initialQuery={initialQuery}
      />
    </CrewProvider>
  );
}

function SwitcherCard({ here }: { here: AgentView }) {
  return (
    <SheetBody>
      <SwitcherList here={here} />
    </SheetBody>
  );
}

export function SwitcherSection() {
  return (
    <Section def={DEF}>
      <Group title="The list">
        <Card
          state="switcher-crew-fourteen"
          label="1: Crew, fourteen rows"
          reach="Swipe up on a pane's handle on a crew with more than five sessions, or open a pane on a large screen."
          note="Type into the field: cw, f7, workshop, omp. The card has no sheet head, so the field sticks at the box's top."
        >
          <SwitcherCard here={switcherCrew.agents[2]!} />
        </Card>
      </Group>
    </Section>
  );
}
