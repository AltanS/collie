// Chapter 5 of the tricks explainer, example 2: a trick that asks on the Hill. The program trick from the
// places chapter, Release gates, lists a Decision in what it prints; the bridge posts it; the person's
// answer comes back to the program as a tap. The card is the REAL `DecisionCard`; the animation moves its
// answer state from idle to sending to answered, with a trick's receipt ("ran").
// DEV-ONLY, like the rest of `src/playground/`.

import { DecisionCard } from "@/components/decision-card";
import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import type { HillReceipt } from "@/lib/hill/wire";

import { playgroundMedia, receipts } from "../fixtures/hill/decisions";
import { Chapter, P, Sub, Term } from "./chapter";
import { CodeBlock, W, type Seg } from "./hues";
import { HILL_FLOW } from "./flows";
import { TricksMap } from "./map";
import { GATES_ASKS } from "./real-places";
import { Steps, type Step } from "./steps";
import { Uses } from "./uses";

const NOOP = () => {};

/** A trick's receipt: nothing was typed into a session, and the program's run with the answer succeeded. */
const RAN: HillReceipt = { ...receipts.typed, delivery: "none", trick: "ran" };

const SENDING: HillAnswerState = { phase: "sending", intent: "rerun", text: null };
const ANSWERED: HillAnswerState = { phase: "answered", intent: "rerun", text: null, receipt: RAN };

/** What the program prints: its parts, and a list of the Decisions it wants open. */
const PRINTED: Seg[] = [
  { t: "{\n  " },
  { t: '"decisions": [{', hue: "trick" },
  { t: '\n    "key": "tag-1-28-2",\n    "title": "Tag 1.28.2 with the e2e gate red?",\n    "summary": "Six of the seven gates are green. …",\n    "options": [\n      { "intent": "rerun", "label": "Rerun e2e first" },\n      { "intent": "tag", "label": "Tag it now", "confirm": "Tag now" }\n    ],\n    "recommends": { "intent": "rerun", "why": "…" },\n    "view": [ …the gates as chips… ]\n  ', hue: "trick" },
  { t: "}]", hue: "trick" },
  { t: "\n}" },
];

/** What the program reads on stdin when you answer: one tap, with your choice. */
const TAP: Seg[] = [
  { t: '{ "kind": "tap", "node": "hill/tag-1-28-2",', hue: "bridge" },
  { t: ' "intent": "rerun", "value": { "text": null },', hue: "you" },
  { t: ' "rid": "0b9e8d7c-…", "seen": "944a71314b332828" }', hue: "bridge" },
];

const STEPS: Step[] = [
  { hue: "bridge", text: <>The <W hue="bridge">bridge</W> runs the trick's program on its timer, and hands it the facts.</> },
  { hue: "trick", text: <>The <W hue="trick">program</W> prints its parts, and a list of the questions it wants open. Each has its own key.</> },
  { hue: "bridge", text: <>The <W hue="bridge">bridge</W> posts a new key to the Hill once, with the trick as the sender. The next run with the same key posts nothing again.</> },
  { hue: "phone", text: <>The <W hue="phone">phone</W> shows the card on the Hill. The recommended option carries a star, and nothing is chosen for you.</> },
  { hue: "you", text: <><W hue="you">You</W> tap “Rerun e2e first”.</> },
  { hue: "bridge", text: <>The <W hue="bridge">bridge</W> closes the card and runs the program once more, with your answer as a tap.</> },
  { hue: "trick", text: <>The <W hue="trick">program</W> starts the rerun. The card's receipt says that the trick took your answer.</> },
];



function answerAt(step: number, all: boolean): HillAnswerState {
  if (all || step >= 5) return ANSWERED;
  if (step === 4) return SENDING;
  return HILL_IDLE;
}

function HillCard({ step, all }: { step: number; all: boolean }) {
  return (
    <div className="w-full max-w-[390px] rounded-sm border border-rule bg-background p-3">
      <p className="mb-2 font-mono text-[11px] text-muted-foreground">phone · the Hill</p>
      <DecisionCard decision={GATES_ASKS} answer={answerAt(step, all)} onSend={NOOP} mediaSource={playgroundMedia} />
    </div>
  );
}

export function HillChapter() {
  return (
    <Chapter at="hill" lead="A trick can ask you a question, and your answer goes back to its program.">
      <P>
        The <Term>Hill</Term> is the page of questions that wait for your tap. Each card is one <Term>Decision</Term>: one question with its choices. Release gates,
        the trick from the places chapter, posts one when a gate is red before a release. You answer when you have a moment.
      </P>
      <Uses places={["hill"]} parts={["bar", "chip", "list", "row"]} />
      <Steps label="A trick asks on the Hill" steps={STEPS} renderAside={(step, all) => <HillCard step={step} all={all} />}>
        {(step, all) => <TricksMap label="The map, lit for a trick that asks on the Hill" focus={all ? { lit: ["trick", "bridge", "phone", "you"] } : (HILL_FLOW[step] ?? {})} />}
      </Steps>
      <div className="grid grid-cols-1 gap-6">
        <div className="min-w-0 space-y-2">
          <Sub>What the program prints</Sub>
          <CodeBlock title="stdout" segs={PRINTED} />
        </div>
        <div className="min-w-0 space-y-2">
          <Sub>What the program reads when you answer</Sub>
          <CodeBlock wrap title="stdin" segs={TAP} />
          <p className="text-sm text-muted-foreground">
            <W hue="you">Your</W> choice and words, in fields of Collie's. <code className="font-mono">seen</code> names the version of the card you answered, so a
            program that changed it since can tell.
          </p>
        </div>
      </div>
      <P>
        A key the program stops listing is taken back from the Hill. A changed card replaces the open one. When the program fails, the last good cards stay.
      </P>
      <P>
        An <W hue="agent">agent</W> can post a Decision too, with <code className="font-mono text-[13px]">collie hill post</code>. Its answer is then typed into its
        session as a short message from you. A trick's Decision can name a session too: your answer then reaches that session as your own message, and then the
        program.
      </P>
      <P>
        <strong>A permission needs a person's tap.</strong> A trick cannot answer a Decision, press a key or type into a session for you. And a recommendation you did
        not read never becomes the answer by default.
      </P>
    </Chapter>
  );
}
