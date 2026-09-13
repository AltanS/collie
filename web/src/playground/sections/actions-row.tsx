// Actions-row section of the states playground: the one belt above the keyboard, in each layout, on
// each harness, and in the two states where part of it is missing. See app.tsx's header for the
// page's own rules — mount the REAL component with REAL props, and drive a module store through its
// own mutators.
//
// The cards sit on the playground's own card ground, not on the composer's `--chrome`, so the
// belt's ground reads a little differently here than it does on a phone. What the cards DO show
// truthfully is the shape: one band, hairlines top and bottom, square ends, Collie's controls bare
// on the ground and the harness's commands in a tinted section of full height.
//
// Every card runs the real `ActionsRow` against a stub `onRun` that resolves true, so the echo's
// checkmark actually lands when you tap a harness button. Nothing here mocks the table.
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect } from "react";

import { ActionsRow } from "@/components/actions-row";
import { HarnessBarControl } from "@/components/harness-bar-control";
import { __resetHarnessBar } from "@/lib/harness-bar-pref";

import { Card, Group, Section, type SectionDef } from "../harness";
import { took, useRoomyActions } from "./shared";

export const DEF: SectionDef = {
  id: "actions-row",
  title: "Actions row",
  intent:
    "The one row above the keyboard, drawn as a BELT: one full-bleed band with a hairline above and below, no rounded ends, and a quiet ground of its own. Collie's own controls — Keys, Type, Quick, Agent, Display — stand directly on that ground; the running harness's own commands stand in a section of the same band, square-cornered, full height, tinted with the harness's colour and opening with its mark. Every pill is an icon and a word, in both parts. It scrolls sideways rather than wrapping, and nothing is ever dropped from it. Tapping a harness button really runs it; here that means a stub that says yes, so the checkmark is the real echo.",
};

function Roomy({ agent }: { agent: string | null }) {
  const general = useRoomyActions();
  return <ActionsRow general={general} agent={agent} onRun={took} />;
}

export function ActionsRowSection() {
  // The harness switch is ONE module store, so it cannot hold two values on one page: flipping it
  // off in the last card empties the harness section in every card above it too, which is exactly
  // what it does on a real phone. Reset on the way out so leaving this tab does not leave the rest
  // of the playground switched off.
  useEffect(() => () => __resetHarnessBar(), []);

  return (
    <Section def={DEF}>
      <Group title="The roomy layout, one harness at a time">
        <Card
          state="roomy-claude"
          label="claude code: five bare controls, then Claude's own tinted section"
          reach="open a pane running Claude Code."
          note="The harness section is FILLED with Claude's own #D97757 at 14%, opens with Claude's mark and paints its icons in that colour, so it reads as belonging to Claude Code rather than to Collie. The five controls beside it wear no box at all — they stand on the belt's own ground. Model sends /model and Claude's own picker takes the screen from there."
          span={2}
        >
          <Roomy agent="claude" />
        </Card>

        <Card
          state="roomy-codex"
          label="codex: no Effort button, and a section with no colour"
          reach="open a pane running Codex."
          note="Codex's /model picker sets the model and the reasoning effort together, so one button reaches both dials. Its brand is officially black, which is invisible as an icon in the dark theme — so the section takes the app's own muted ground instead of a wrong colour. That ground measures 1.02:1 against the belt in dark, i.e. nothing, which is the one case that earns a hairline: this section alone carries a left edge on --border."
          span={2}
        >
          <Roomy agent="codex" />
        </Card>

        <Card
          state="roomy-pi"
          label="pi: model, compact, tree, resume"
          reach="open a pane running pi."
          note="No Effort button: pi's thinking level lives inside /settings, a modal the phone would then have to drive with the keys pad. pi is the second monochrome brand, so its section is muted too, hairline included."
          span={2}
        >
          <Roomy agent="pi" />
        </Card>

        <Card
          state="roomy-omp"
          label="omp: the purple section, every button vouched for by a capture"
          reach="open a pane running oh-my-pi."
          note="omp's mark is a gradient; the section flattens it to the mid stop, #9B4DFF, which is the colour a flattening would take anyway."
          span={2}
        >
          <Roomy agent="omp" />
        </Card>

        <Card
          state="roomy-no-harness"
          label="a bare shell: the controls alone"
          reach="open a shell pane, or one running grok, opencode or antigravity."
          note="The belt with no section on it at all — five bare pills on the band. The row's LEFT EDGE is the reason the general part comes first: it is Keys on every pane there is. Lead with the harness part and the left edge would mean a different thing per pane."
          span={2}
        >
          <Roomy agent={null} />
        </Card>
      </Group>

      <Group title="The switch and the scroll">
        <Card
          state="hidden-by-toggle"
          label="the switch that hides the harness section, and only it"
          reach="Settings → Harness shortcuts. Per device, and the choice never leaves the phone it was made on."
          note="The real Settings card above the real belt. Flip it off and the tinted section goes; Keys, Type, Quick, Agent and the gear stay exactly where they were, on the same band. Every card above empties with it — one module store, one answer per device, which is what it does on a real phone."
          span={2}
        >
          <div className="flex flex-col gap-3">
            <HarnessBarControl />
            <Roomy agent="claude" />
          </div>
        </Card>

        <Card
          state="overflow"
          label="a narrow phone: the row scrolls, it never wraps"
          reach="hold a 320px phone, or run a harness whose operator put ten rows on the bar."
          note="The card below is clamped to 280px. Drag the row sideways: the fade and the chevron move to whichever end still hides something — right at rest, both in the middle, left at the far end — nothing wraps to a second line, and no button is dropped."
        >
          <div className="w-[280px] overflow-hidden">
            <Roomy agent="claude" />
          </div>
        </Card>
      </Group>
    </Section>
  );
}
