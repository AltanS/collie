// Chapter 10 of the tricks explainer: write your own in five minutes. The four commands, then an agent
// that writes one with you and proposes it on the Hill. The proposal is the REAL `DecisionCard`, fed a
// fixture shaped like the proposal card Collie posts.
// DEV-ONLY, like the rest of `src/playground/`.

import { DecisionCard } from "@/components/decision-card";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import type { HillDecision } from "@/lib/hill/wire";

import { playgroundMedia, versionPlain } from "../fixtures/hill/decisions";
import { FigureSlot } from "../explainer-figures";
import { Chapter, P, Sub } from "./chapter";
import { CodeBlock, W } from "./hues";

const NOOP = () => {};


/** The card Collie posts when an agent proposes a trick: Collie's own, the code on it, no recommendation. */
const PROPOSAL: HillDecision = {
  ...versionPlain,
  id: "dc_p4w8n2c6v0z3",
  from: { ...versionPlain.from, host: "workshop" },
  title: "Switch on the trick disk-space?",
  summary: "The session repo#main proposed it. 2 files. It asks for no environment names. All of its code is on this card.",
  options: [
    { intent: "on", label: "Switch it on", confirm: "Yes, switch on" },
    { intent: "no", label: "Not now" },
  ],
  recommends: null,
  view: [
    { kind: "bar", kids: [{ kind: "chip", text: "Draws in: dashboard, status" }, { kind: "chip", text: "starts other programs", attrs: { tone: "warn", icon: "warn" } }] },
    {
      kind: "code",
      attrs: { lang: "sh", max: "6" },
      kids: [
        { kind: "line", text: "#!/bin/sh" },
        { kind: "line", text: "cat > /dev/null" },
        { kind: "line", text: "kb=$(df -Pk \"$HOME\" | awk 'NR==2 {print $4}')" },
        { kind: "line", text: "gb=$((kb / 1048576))" },
        { kind: "line", text: "tone=plain" },
        { kind: "line", text: "[ \"$gb\" -lt 10 ] && tone=warn" },
      ],
    },
  ],
};

export function WriteChapter() {
  return (
    <Chapter at="write" lead="Four commands, and your agent can write one with you.">
      <FigureSlot name="write-your-own" className="mx-auto max-w-[560px]" />
      <P>
        <code className="font-mono text-[13px]">collie trick init</code> also writes the notes an agent needs. <code className="font-mono text-[13px]">dev</code> sends
        nothing to the phone. <code className="font-mono text-[13px]">check</code> searches the code for the five risky things. And{" "}
        <code className="font-mono text-[13px]">on</code> refuses in a pane where an agent works, so the yes stays yours.
      </P>

      <Sub>Or let an agent write it</Sub>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <P>
            Ask one of your <W hue="agent">agents</W> for the trick you want. It reads <code className="font-mono text-[13px]">collie trick guide</code>, writes the
            folder, tries it with <code className="font-mono text-[13px]">collie trick dev</code>, and then proposes it to you:
          </P>
          <CodeBlock wrap segs={[{ t: "collie trick propose ~/work/disk-space", hue: "agent" }]} />
          <P>
            A card appears on your Hill with the whole code on it. Collie never recommends “Switch it on”: your own reading is the check. Nothing of the trick runs
            before your yes, and an agent cannot switch a trick on itself.
          </P>
          <P>
            An agent can propose a program trick. It cannot propose a trick that carries a view or rules: <strong>an agent must not write instructions for your other
            agents and get them in with one tap.</strong> You add such a trick by hand, or from a repository.
          </P>
        </div>
        <div className="w-full max-w-[390px] rounded-sm border border-rule bg-background p-3">
          <p className="mb-2 font-mono text-[11px] text-muted-foreground">phone · the Hill, a proposal</p>
          <DecisionCard decision={PROPOSAL} answer={HILL_IDLE} onSend={NOOP} mediaSource={playgroundMedia} />
        </div>
      </div>
    </Chapter>
  );
}
