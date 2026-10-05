// Machines section of the states playground. Split out of app.tsx; see that file's header comment for
// the whole page's rules.
//
// The fixtures are the unit suite's and the browser tier's (`@/test/machine-fixtures`), so a card here
// shows exactly what a test asserts. Nothing is stubbed: the list and the detail take the census the way
// the loader hands it in, and the detail takes its history as the one prop that exists for that.

import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewTabSkeleton, CrewTabView } from "@/components/crew-tab";
import type { MachineCensusState } from "@/hooks/use-machine-census";
import type { MachineHistoryState } from "@/hooks/use-machine-history";
import type { MachinesData } from "@/lib/loaders";
import type { MachinesResponse } from "@/lib/types";
import {
  FIXTURE_MACHINES_TS,
  fixtureMachineHistory,
  fixtureMachineRows,
  fixtureMachines,
  fixtureMachinesSolo,
  withSpark,
} from "@/test/machine-fixtures";
import { homeCrew, homeSolo } from "../fixtures";
import { Card, Group, MachinesRouter, Section, type SectionDef } from "../harness";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "machines",
  title: "Machines",
  intent:
    "What every machine is doing now, and the last hour and day of it. The list at the phone's width with each machine's last half hour, a card whose alert is firing, a machine whose reading stopped, the detail page with its three charts and its alert rules, an older machine that does not report load yet, and the dashboard's Crew tab, which draws the same cards.",
};

// The list asks for each card's last half hour (`?spark=30`), so its fixtures carry it too.
const crew: MachinesData = { census: withSpark(fixtureMachines), error: false };
const solo: MachinesData = { census: withSpark(fixtureMachinesSolo), error: false };

/** A history the detail page is handed, so the charts draw without a bridge. */
const day: MachineHistoryState = { history: fixtureMachineHistory(), failed: false };
const calm: MachineHistoryState = { history: fixtureMachineHistory({ cpuLevel: 0.12 }), failed: false };
const hot: MachineHistoryState = { history: fixtureMachineHistory({ cpuLevel: 0.85 }), failed: false };
const noCounters: MachineHistoryState = { history: fixtureMachineHistory({ network: false }), failed: false };
const empty: MachineHistoryState = {
  history: { ts: fixtureMachines.ts, stepMs: 60_000, points: [] },
  failed: false,
};
const failed: MachineHistoryState = { history: null, failed: true };

/** One machine per census, so a card shows just that state. */
const only = (...rows: (typeof fixtureMachineRows)[number][]): MachinesData => ({
  census: withSpark({ ts: FIXTURE_MACHINES_TS, machines: rows }),
  error: false,
});
const firingOnly = only(fixtureMachineRows[1]!);
// The older machine is the fixture's own `pantry` row: reachable, and no `sample` at all.
const olderOnly = only(fixtureMachineRows[3]!);
/** The lead, but its last reading is five minutes old while the link is fine: a sampler that hung. */
const stuckRow = { ...fixtureMachineRows[0]!, sampledAt: FIXTURE_MACHINES_TS - 5 * 60_000 };
const staleOnly = only(stuckRow);

/** The Crew tab's states, handed in: the tab itself reads its own census, and the playground has no bridge. */
const tabCrew: MachineCensusState = { kind: "census", census: withSpark(fixtureMachines), failed: false };
const tabFailed: MachineCensusState = { kind: "census", census: withSpark(fixtureMachines), failed: true };
// A lead that just started: no complete minute yet, so each spark is its floor and the reading now.
const fresh: MachinesResponse = {
  ts: FIXTURE_MACHINES_TS,
  machines: [{ ...fixtureMachineRows[0]!, spark: { stepMs: 60_000, cpu: [], mem: [] } }],
};
const tabFresh: MachineCensusState = { kind: "census", census: fresh, failed: false };

/** The Crew tab body on a memory router, in the dashboard's 16px gutter, the way the tab bar mounts it. */
function CrewTabFrame({ state }: { state: MachineCensusState | "loading" }) {
  const [router] = useState(() =>
    createMemoryRouter(
      [
        {
          path: "/",
          element: <div className="p-4">{state === "loading" ? <CrewTabSkeleton /> : <CrewTabView state={state} />}</div>,
        },
        { path: "/machines/:id", element: <div className="p-4 text-sm text-muted-foreground">a machine's page</div> },
      ],
      { initialEntries: ["/"] },
    ),
  );
  return <RouterProvider router={router} />;
}

export function MachinesSection() {
  return (
    <Section def={DEF}>
      <Group title="The list">
        <Card
          state="machines-list-crew"
          label="machines, a crew of four"
          reach="Settings → Machines on the lead of a crew. The lead first; a quiet machine shows its health and the age of its last reading and no numbers; an older machine says it needs an update."
          note="Every age is measured against the lead's clock, so 'Last reading 25m ago' is the same on every phone."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machines-list-solo"
          label="machines, a collie on its own"
          reach="Settings → Machines on a collie that leads no crew. One card, no role badge: a solo collie is one machine with a load worth watching."
        >
          <PhoneFrameCard height={420}>
            <MachinesRouter home={homeSolo} machines={solo} start="/machines" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machines-list-firing"
          label="machines, an alert is firing"
          reach="a peer's CPU stays at or above its alert rule's threshold for the rule's minutes. The number and the spark turn the blocked colour, the dashed line is the rule, and the card says so in words."
          note="Colour alone is not a state: the line 'Alert firing: CPU' is what a screen reader and a colour-blind operator get."
        >
          <PhoneFrameCard height={420}>
            <MachinesRouter home={homeCrew} machines={firingOnly} start="/machines" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machines-list-older-machine"
          label="machines, an older machine"
          reach="a crew member that still runs a Collie from before 1.17. It answers, so it is reachable, but it sends no load: no numbers, no spark, one line saying to update it."
        >
          <PhoneFrameCard height={300}>
            <MachinesRouter home={homeCrew} machines={olderOnly} start="/machines" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machines-list-stale"
          label="machines, a reading that stopped"
          reach="a member that answers the lead but whose sampler hung: the lead skips a reading equal to the last one, so its age grows while the link is fine. After two minutes the card quiets its numbers and says the age, with a clock."
        >
          <PhoneFrameCard height={360}>
            <MachinesRouter home={homeCrew} machines={staleOnly} start="/machines" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machines-list-unavailable"
          label="machines, a peer opened directly"
          reach="open the page on a crew member rather than on the lead. A peer answers 404, which is an answer, not a failure."
        >
          <PhoneFrameCard height={260}>
            <MachinesRouter home={homeSolo} machines={{ census: null, error: false }} start="/machines" />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="One machine">
        <Card
          state="machine-detail-charts"
          label="a machine, the last hour"
          reach="tap a card on the list. The numbers large, the 1 h and 24 h switch, CPU with its peak band, memory, network with down and up, and the alert rules at the bottom."
          note="The dashed line is the alert threshold from the stored rule. A hole in the history is a hole in the line, never a line across it: switch to 24 h to see the thirty minutes the fixture lead was restarting."
          span={2}
        >
          <PhoneFrameCard height={1200}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines/bluefin" history={day} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machine-detail-firing"
          label="a machine, an alert firing"
          reach="open a machine whose alert is firing. The history shows the climb the rule fired on, the numbers say so in words, and the switch in the alert card is marked 'Firing now'."
          span={2}
        >
          <PhoneFrameCard height={1200}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines/workshop" history={hot} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machine-detail-quiet"
          label="a machine, nothing happening"
          reach="open an idle machine. The same charts at a low level, so the axis and the legend can be read without the lines in the way."
        >
          <PhoneFrameCard height={1200}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines/bluefin" history={calm} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machine-detail-no-counters"
          label="a machine with no network counters"
          reach="open a machine on a platform that gives no interface counters. The network chart says so instead of drawing an empty plot."
        >
          <PhoneFrameCard height={1200}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines/bluefin" history={noCounters} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machine-detail-older-machine"
          label="a machine, an older Collie"
          reach="open the page of a member that does not report load yet. One line saying to update it, no range switch and no chart (the lead holds no minute of it, so the page reads no history), and the alert card holds one line saying the machine needs updating, with no switch."
        >
          <PhoneFrameCard height={420}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines/pantry" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machine-detail-history-failed"
          label="a machine, the history could not load"
          reach="open a machine while the bridge cannot answer the history. The numbers and the alert rules above and below still work; each chart box says it could not load."
        >
          <PhoneFrameCard height={900}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines/bluefin" history={failed} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machine-detail-quiet-machine"
          label="a machine that went quiet"
          reach="open the page of a member the lead has lost. Its health and the age of its last reading, and no numbers pretending to be current."
        >
          <PhoneFrameCard height={900}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines/attic" history={empty} />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="The dashboard's Crew tab">
        <Card
          state="crew-tab-cards"
          label="crew tab, four machines"
          reach="the dashboard on a lead with a crew, Crew tab. The Machines list's own cards, read when the tab opens and every 15 s while it is on screen. A tap opens the machine, and its back arrow returns to this tab."
          note="Nothing runs for this tab on any other tab, nor while the page is hidden."
          span={2}
        >
          <PhoneFrameCard height={900}>
            <CrewTabFrame state={tabCrew} />
          </PhoneFrameCard>
        </Card>

        <Card state="crew-tab-loading" label="crew tab, the first read" reach="open the Crew tab for the first time in this page session.">
          <PhoneFrameCard height={420}>
            <CrewTabFrame state="loading" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="crew-tab-fresh-lead"
          label="crew tab, a lead that just started"
          reach="open the tab in the first minute after the lead started. No complete minute yet: each spark is its floor and a dot for the reading now."
        >
          <PhoneFrameCard height={300}>
            <CrewTabFrame state={tabFresh} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="crew-tab-refresh-failed"
          label="crew tab, a refresh that failed"
          reach="the lead stops answering while the tab is open. The cards stay, and a notice says they are the last numbers read."
        >
          <PhoneFrameCard height={520}>
            <CrewTabFrame state={tabFailed} />
          </PhoneFrameCard>
        </Card>

        <Card state="crew-tab-unavailable" label="crew tab, no machine list" reach="a crew member's dashboard, which keeps no machine list. A 404 is an answer.">
          <PhoneFrameCard height={200}>
            <CrewTabFrame state={{ kind: "unavailable" }} />
          </PhoneFrameCard>
        </Card>
      </Group>
    </Section>
  );
}
