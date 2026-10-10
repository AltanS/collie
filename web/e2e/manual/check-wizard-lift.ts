// check-wizard-lift.ts — verifies that an ANSI pane capture lifts to a wizard block.
//
// Reads a capture as saved by `herdr pane read --format ansi`, runs it through the same
// pipeline the PWA uses (parseAnsi → splitLines → detectQuestionTabs), and requires a
// `wizard` lift. Prints a one-line JSON summary for the log and exits 0 on a lift,
// 1 when the screen stays raw or lifts to another kind.
//
// Run with bun from the web/ directory:
//
//     bun e2e/manual/check-wizard-lift.ts /tmp/collie-wizard-<pane>.ansi
//
// No network, no model, no writes: the capture is read, nothing is sent anywhere.
import { readFileSync } from "node:fs";

import { parseAnsi } from "../../src/lib/ansi.ts";
import { splitLines } from "../../src/lib/blocks.ts";
import { detectQuestionTabs } from "../../src/lib/harness/opencode/question-tabs.ts";

const [capturePath, phaseArg] = process.argv.slice(2);
if (capturePath === undefined || capturePath === "") {
  console.error("usage: bun check-wizard-lift.ts <capture.ansi> [question|review]");
  process.exit(2);
}
const expectPhase = phaseArg ?? "question";

const text = readFileSync(capturePath, "utf8");
const region = detectQuestionTabs(splitLines(parseAnsi(text)));
if (region === null || region.kind !== "wizard") {
  console.error(`no wizard lift: ${region === null ? "stays raw" : `lifts as ${region.kind}`}`);
  process.exit(1);
}
const model = region.model;
if (model.phase !== expectPhase) {
  console.error(`wizard lifts as phase ${model.phase}, expected ${expectPhase}`);
  process.exit(1);
}
const summary =
  model.phase === "question"
    ? {
        kind: region.kind,
        phase: model.phase,
        question: model.question,
        options: model.options.map((o) => o.label),
        steps: model.steps.map((s) => s.label),
      }
    : { kind: region.kind, phase: model.phase, answers: model.answers };
console.log(JSON.stringify(summary));
