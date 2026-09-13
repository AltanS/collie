// Actions-row section of the states playground: the one row above the keyboard, in each layout, on
// each harness, and in the two states where half of it is missing. See app.tsx's header for the
// page's own rules — mount the REAL component with REAL props, and drive a module store through its
// own mutators.
//
// Every card runs the real `ActionsRow` against a stub `onRun` that resolves true, so the echo's
// checkmark actually lands when you tap a harness button. Nothing here mocks the table.
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect, useState } from "react";
import { Keyboard, Settings2, Slash, Terminal, Zap } from "lucide-react";

import { ActionsRow, type GeneralAction } from "@/components/actions-row";
import { HarnessBarControl } from "@/components/harness-bar-control";
import { __resetHarnessBar } from "@/lib/harness-bar-pref";

import { Card, Group, Section, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "actions-row",
  title: "Actions row",
  intent:
    "The one row above the keyboard, drawn as two capsules of one shape: Collie's own controls — Keys, Type, Quick, Agent, Display — in an outlined one, then the running harness's own commands in a filled one that opens with the harness's mark and takes its colour. Every pill is an icon and a word, in both halves. It scrolls sideways rather than wrapping, and nothing is ever dropped from it. Tapping a harness button really runs it; here that means a stub that says yes, so the checkmark is the real echo.",
};

/** A stub `send()` that accepted the text, which is what drives the ✓. */
const took = async () => true;

/**
 * The roomy layout's five, wired to local state so the cards behave: tapping Keys really marks Keys
 * as open. The composer owns these for real; this is the same shape, one card deep.
 */
function useGeneral(): readonly GeneralAction[] {
  const [open, setOpen] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const toggle = (id: string) => () => setOpen((was) => (was === id ? null : id));
  return [
    { id: "keys", icon: Keyboard, label: "Keys", on: open === "keys", expanded: open === "keys", onSelect: toggle("keys") },
    { id: "type", icon: Terminal, label: "Type into terminal", word: "Type", on: typing, pressed: typing, onSelect: () => setTyping((was) => !was) },
    { id: "quick", icon: Zap, label: "Quick", on: open === "quick", expanded: open === "quick", onSelect: toggle("quick") },
    { id: "agent", icon: Slash, label: "Agent", onSelect: toggle("cmd") },
    { id: "display", icon: Settings2, label: "Display settings", word: "Display", on: open === "display", expanded: open === "display", onSelect: toggle("display") },
  ];
}

function Roomy({ agent }: { agent: string | null }) {
  const general = useGeneral();
  return <ActionsRow general={general} agent={agent} onRun={took} />;
}

export function ActionsRowSection() {
  // The harness switch is ONE module store, so it cannot hold two values on one page: flipping it
  // off in the last card empties the harness segment in every card above it too, which is exactly
  // what it does on a real phone. Reset on the way out so leaving this tab does not leave the rest
  // of the playground switched off.
  useEffect(() => () => __resetHarnessBar(), []);

  return (
    <Section def={DEF}>
      <Group title="The roomy layout, one harness at a time">
        <Card
          state="roomy-claude"
          label="claude code: five controls, then Model, Effort, Compact, Resume"
          reach="open a pane running Claude Code."
          note="The harness half is FILLED with Claude's own #D97757, opens with Claude's mark and paints its icons in that colour, so it reads as belonging to Claude Code rather than to Collie. The general half is the same capsule, outlined instead. Model sends /model and Claude's own picker takes the screen from there."
          span={2}
        >
          <Roomy agent="claude" />
        </Card>

        <Card
          state="roomy-codex"
          label="codex: no Effort button, and a segment with no colour"
          reach="open a pane running Codex."
          note="Codex's /model picker sets the model and the reasoning effort together, so one button reaches both dials. Its brand is officially black, which is invisible as an icon in the dark theme — so the segment takes the app's own muted ground instead of a wrong colour."
          span={2}
        >
          <Roomy agent="codex" />
        </Card>

        <Card
          state="roomy-pi"
          label="pi: model, compact, tree, resume"
          reach="open a pane running pi."
          note="No Effort button: pi's thinking level lives inside /settings, a modal the phone would then have to drive with the keys pad. pi is the second monochrome brand, so its segment is muted too."
          span={2}
        >
          <Roomy agent="pi" />
        </Card>

        <Card
          state="roomy-omp"
          label="omp: the purple segment, every button vouched for by a capture"
          reach="open a pane running oh-my-pi."
          note="omp's mark is a gradient; the segment flattens it to the mid stop, #9B4DFF, which is the colour a flattening would take anyway."
          span={2}
        >
          <Roomy agent="omp" />
        </Card>

        <Card
          state="roomy-no-harness"
          label="a bare shell: the controls alone"
          reach="open a shell pane, or one running grok, opencode or antigravity."
          note="The row's LEFT EDGE is the reason the general half comes first: it is Keys on every pane there is. Lead with the harness half and the left edge would mean a different thing per pane."
          span={2}
        >
          <Roomy agent={null} />
        </Card>
      </Group>

      <Group title="The switch and the scroll">
        <Card
          state="hidden-by-toggle"
          label="the switch that hides the harness half, and only that half"
          reach="Settings → Harness shortcuts. Per device, and the choice never leaves the phone it was made on."
          note="The real Settings card above the real row. Flip it off and the tinted segment goes; Keys, Type, Quick, Agent and the gear stay exactly where they were. Every card above empties with it — one module store, one answer per device, which is what it does on a real phone."
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
