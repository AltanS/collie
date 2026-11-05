// "Update signal", round 5: how the dashboard's bottom explains the beads on the mark. The bead rule
// is fixed (playground.css, `.upd-*`): update ready is three yellow beads (the update band's colour),
// machine busy is three red ones, both is both, an urgent update keeps today's band and its beads
// stay ink. The four options are the footer. Sample data only (./update-signal/model.ts).
//
// DEV-ONLY, unreachable from the app entry.

import { Round, type RoundOption } from "../round";
import { Section, type SectionDef } from "../layout";

import { SignalDashboard, type Option } from "./update-signal/dashboard";
import { SIGNAL_CASES } from "./update-signal/model";

export const DEF: SectionDef = { id: "update-signal", title: "Update signal" };

const TITLES: readonly (readonly [Option, string])[] = [
  [0, "Today"],
  [1, "Bead lines"],
  [2, "Mark key"],
  [3, "Tap the mark"],
];

const OPTIONS: readonly RoundOption[] = TITLES.map(([n, title]) => ({
  n,
  title,
  render: ({ caseValue }) => <SignalDashboard key={caseValue} option={n} caseValue={caseValue} />,
}));

export function UpdateSignalSection() {
  return (
    <Section def={DEF}>
      <Round id="update-signal" cases={SIGNAL_CASES} options={OPTIONS} frame={{ kind: "phone", height: 720 }} />
    </Section>
  );
}
