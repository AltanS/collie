// Machines section of the states playground. Split out of app.tsx; see that file's header comment for
// the whole page's rules.
//
// The fixtures are the unit suite's and the browser tier's (`@/test/machine-fixtures`), so a card here
// shows exactly what a test asserts. Nothing is stubbed: the list and the detail take the census the way
// the loader hands it in, and the detail takes its history as the one prop that exists for that.

import type { MachineHistoryState } from "@/hooks/use-machine-history";
import type { MachinesData } from "@/lib/loaders";
import { fixtureMachineHistory, fixtureMachineRows, fixtureMachines, fixtureMachinesSolo } from "@/test/machine-fixtures";
import { homeCrew, homeSolo } from "../fixtures";
import { Card, Group, MachinesRouter, Section, type SectionDef } from "../harness";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "machines",
  title: "Machines",
  intent:
    "What every machine is doing now, and the last hour and day of it. The list at the phone's width, a card whose alert is firing, the detail page with its three charts and its alert rules, and an older machine that does not report load yet.",
};

const crew: MachinesData = { census: fixtureMachines, error: false };
const solo: MachinesData = { census: fixtureMachinesSolo, error: false };

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

/** Only the firing machine and the older one, so a card shows just that state. */
const firingOnly: MachinesData = {
  census: { ts: fixtureMachines.ts, machines: [fixtureMachineRows[1]!] },
  error: false,
};
const olderOnly: MachinesData = {
  census: { ts: fixtureMachines.ts, machines: [fixtureMachineRows[3]!] },
  error: false,
};

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
          reach="a peer's CPU stays at or above its alert rule's threshold for the rule's minutes. The bar turns the blocked colour and the card says so in words."
          note="Colour alone is not a state: the line 'Alert firing: CPU' is what a screen reader and a colour-blind operator get."
        >
          <PhoneFrameCard height={420}>
            <MachinesRouter home={homeCrew} machines={firingOnly} start="/machines" />
          </PhoneFrameCard>
        </Card>

        <Card
          state="machines-list-older-machine"
          label="machines, an older machine"
          reach="a crew member that still runs a Collie from before 1.17. It answers, so it is reachable, but it sends no load."
        >
          <PhoneFrameCard height={300}>
            <MachinesRouter home={homeCrew} machines={olderOnly} start="/machines" />
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
          reach="open the page of a member that does not report load yet. No numbers, no history, every chart box says there is nothing to draw, and the alert card holds one line saying the machine needs updating, with no switch."
        >
          <PhoneFrameCard height={900}>
            <MachinesRouter home={homeCrew} machines={crew} start="/machines/pantry" history={empty} />
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
    </Section>
  );
}
