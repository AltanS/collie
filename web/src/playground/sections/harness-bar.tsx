// Harness-bar section of the states playground: one card per shipped bar, plus the chooser open,
// plus the two ways the row renders nothing. See app.tsx's header for the page's own rules — mount
// the REAL component with REAL props, and drive a module store through its own mutators.
//
// Every card runs the real `HarnessBar` against a stub `onRun` that resolves true, so the echo's
// checkmark actually lands when you tap. Nothing here mocks the table or the sheet.
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect } from "react";

import { HarnessBar } from "@/components/harness-bar";
import { HarnessBarControl } from "@/components/harness-bar-control";
import { __resetHarnessBar } from "@/lib/harness-bar-pref";

import { Card, Group, Section, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "harness-bar",
  title: "Harness bar",
  intent:
    "The row of the running agent's own slash commands, above the key rail. Four or five 44px buttons per harness, every one of them sending its bare command, and nothing at all on a harness the table does not name. Tapping a button really runs it — here that means a stub that says yes, so the checkmark is the real echo.",
};

/** A stub `send()` that accepted the text, which is what drives the ✓. */
const took = async () => true;

export function HarnessBarSection() {
  // The toggle is ONE module store, so it cannot hold two values on one page: flipping it off in the
  // last card below empties every bar above it too, which is exactly what it does on a real phone.
  // Reset on the way out so leaving this tab does not leave the rest of the playground switched off.
  useEffect(() => () => __resetHarnessBar(), []);

  return (
    <Section def={DEF}>
      <Group title="One row per harness">
        <Card
          state="claude"
          label="claude code: model, effort, compact, resume"
          reach="open a pane running Claude Code. The four commands Altan drives it with from the phone, in that order."
          note="Every button is one tap. Model sends /model and Claude's own picker takes the screen from there, which is why Collie carries no list of model names to go stale."
        >
          <HarnessBar agent="claude" onRun={took} />
        </Card>

        <Card
          state="codex"
          label="codex: model, compact, resume"
          reach="open a pane running Codex. No Effort button, because Codex's own /model picker sets the model and the reasoning effort together."
          note="One button reaches both dials, so there is nothing for a second one to do."
        >
          <HarnessBar agent="codex" onRun={took} />
        </Card>

        <Card
          state="pi"
          label="pi: model, compact, tree, resume"
          reach="open a pane running pi. Every button is one tap, because pi's /model and /resume open their own pickers in the mirror."
          note="No Effort button: pi's thinking level lives inside /settings, a modal the phone would then have to drive with the keys pad."
        >
          <HarnessBar agent="pi" onRun={took} />
        </Card>

        <Card
          state="omp"
          label="omp: model, compact, tree, resume"
          reach="open a pane running oh-my-pi. Four buttons, each vouched for by a capture under web/src/fixtures/panes/."
          note="Tree waited on its capture rather than on omp being a pi fork. web/src/fixtures/panes/omp--tree.txt is a live omp pane where /tree painted a Session Tree picker, so the button ships in pi's order."
        >
          <HarnessBar agent="omp" onRun={took} />
        </Card>
      </Group>

      <Group title="Nothing to draw">
        <Card
          state="none"
          label="grok: the row renders nothing"
          reach="open a pane running any harness the table does not name — grok, opencode, agy, antigravity, or a bare shell. The row costs no height at all."
          note="The box below is empty on purpose. grok has a command CATALOG; what it does not have is a bar, because nobody has driven one from a phone and said which four buttons it should be."
        >
          <HarnessBar agent="grok" onRun={took} />
        </Card>

        <Card
          state="hidden-by-toggle"
          label="the same claude bar, and the switch that hides it"
          reach="Settings → Harness shortcuts. Per device, and the choice never leaves the phone it was made on. On by default, because a row nobody can see until they find Settings is a row nobody uses."
          note="The real Settings card above the real bar. Flip it off and the bar below goes, and so does every bar in the cards above — one module store, one answer per device, which is what it does on a real phone."
          span={2}
        >
          <div className="flex flex-col gap-3">
            <HarnessBarControl />
            <HarnessBar agent="claude" onRun={took} />
          </div>
        </Card>
      </Group>

    </Section>
  );
}
