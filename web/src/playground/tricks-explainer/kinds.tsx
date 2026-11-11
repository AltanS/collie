// Chapter 2 of the tricks explainer: the two kinds of trick, side by side. A program trick (a program on
// your machine prints parts, the bridge runs it) and an agent view (the session's own agent draws one
// screen, the trick holds only the rules). One map each, lit for its own path, and the folder it is.
// DEV-ONLY, like the rest of `src/playground/`.

import type { ReactNode } from "react";

import { PLACE_KINDS } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";

import { FigureSlot } from "../explainer-figures";
import { Chapter, P, Term } from "./chapter";
import { CodeBlock, HUE_BORDER, HUE_TEXT, W, type Hue, type Seg } from "./hues";


const PROGRAM_TOML: Seg[] = [
  { t: 'id = "gates"\nname = "Release gates"\n' },
  { t: 'run = "./program.sh"\nevery = "5m"\n', hue: "trick" },
  { t: 'places = ["dashboard", "status", "session"]', hue: "phone" },
];

const VIEW_TOML: Seg[] = [
  { t: 'id = "release-view"\nname = "Release view"\ncontract = 2\n' },
  { t: 'places = ["agent-view"]\n', hue: "phone" },
  { t: 'rules = "rules.md"', hue: "trick" },
];

const RULES_MD: Seg[] = [
  { t: "These are the rules of Release view, a view of this session that you draw.\nPut the answer first. Short words, short lines.\nLabel each button with what happens when it is tapped.\n…", hue: "trick" },
];

interface Fact {
  q: string;
  a: ReactNode;
}

function Kind({ hue, name, line, files, facts }: { hue: Hue; name: string; line: string; files: ReactNode; facts: readonly Fact[] }) {
  return (
    <section aria-label={name} className={cn("min-w-0 space-y-4 rounded-sm border-2 bg-card p-4", HUE_BORDER[hue])}>
      <div>
        <h4 className={cn("text-lg font-semibold", HUE_TEXT[hue])}>{name}</h4>
        <p className="text-[15px]">{line}</p>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-[15px] sm:grid-cols-[8rem_minmax(0,1fr)]">
        {facts.map((f) => (
          <div key={f.q} className="contents">
            <dt className="font-semibold">{f.q}</dt>
            <dd className="min-w-0">{f.a}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">{files}</div>
    </section>
  );
}

export function KindsChapter() {
  return (
    <Chapter at="kinds" lead="A trick is a program that prints parts, or rules for an agent that draws a screen.">
      <FigureSlot name="two-kinds" className="mx-auto max-w-[560px]" />
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
        <Kind
          hue="trick"
          name="A program trick"
          line="A small program on your machine. It prints what to show, and Collie draws it."
          facts={[
            { q: "Who draws", a: <>The trick's <W hue="trick">program</W>. It prints data, the <W hue="bridge">bridge</W> checks it, the <W hue="phone">phone</W> draws it.</> },
            { q: "When", a: <>On a timer, when a file it watches changes, and when you tap one of its buttons.</> },
            { q: "Where", a: <>Any of the {PLACE_KINDS.length} drawing places, and the Hill.</> },
            { q: "The folder", a: <>A manifest and a program, in any language.</> },
          ]}
          files={<CodeBlock title="trick.toml" segs={PROGRAM_TOML} />}
        />
        <Kind
          hue="agent"
          name="An agent view"
          line="Rules for the agent of one session. The agent answers you by drawing one screen."
          facts={[
            { q: "Who draws", a: <>The <W hue="agent">agent</W> of one session, one screen at a time, with a <code className="font-mono text-[13px]">collie</code> command.</> },
            { q: "When", a: <>When you ask it something in the view.</> },
            { q: "Where", a: <>The agent view of a session, and only where you switched it on.</> },
            { q: "The folder", a: <>A manifest and a rules file. No program: nothing runs on a timer.</> },
          ]}
          files={
            <>
              <CodeBlock title="trick.toml" segs={VIEW_TOML} />
              <CodeBlock wrap title="rules.md" segs={RULES_MD} />
            </>
          }
        />
      </div>
      <P>
        Both are a <Term>trick</Term>: one folder under <code className="font-mono text-[13px]">~/.config/collie/tricks/</code>, added and switched on the same way, with
        the same parts to draw with. One trick can also be both: a program for its places, and a view.
      </P>
    </Chapter>
  );
}
