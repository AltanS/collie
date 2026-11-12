// Chapter 0 of the tricks explainer: what a trick is, the whole map once with its numbered callouts,
// and the colour key. DEV-ONLY, like the rest of `src/playground/`.

import { Chapter, P, Term } from "./chapter";
import { ColourKey, Num, W } from "./hues";
import { TricksMap } from "./map";

export function TopChapter() {
  return (
    <Chapter at="top" lead="A trick adds its own parts to Collie on your phone: a count, a question, or a whole screen.">
      <P>
        <Term>ColliePWA</Term> is a web app for your phone. It lets you watch and answer the AI coding agents that run in the terminals of your computer. A{" "}
        <Term>trick</Term> extends Collie. It is a folder on your computer: a small program, or rules for an agent, or both. What it shows on the phone is drawn by
        Collie, in Collie's own look. This page shows how, on one map.
      </P>
      <TricksMap callouts label="The map: your phone, the bridge on your machine, your agent sessions, a trick folder, and you" />
      <p className="text-[15px] font-semibold">Tricks need no cloud service from Collie. The phone talks to your own machine.</p>
      <ol className="grid grid-cols-1 gap-2 text-[15px] leading-snug lg:grid-cols-2">
        <li className="flex gap-2">
          <Num n={1} hue="phone" />
          <span>
            The <W hue="phone">phone</W> talks only to the <W hue="bridge">bridge</W>, Collie's own program on your machine, over your private network.
          </span>
        </li>
        <li className="flex gap-2">
          <Num n={2} hue="bridge" />
          <span>
            The <W hue="bridge">bridge</W> runs a <W hue="trick">trick</W>'s program and reads the data it prints.
          </span>
        </li>
        <li className="flex gap-2">
          <Num n={3} hue="bridge" />
          <span>
            The <W hue="bridge">bridge</W> types a line into an <W hue="agent">agent session</W>: a terminal pane where an agent such as Claude Code works.
          </span>
        </li>
        <li className="flex gap-2">
          <Num n={4} hue="agent" />
          <span>
            An <W hue="agent">agent</W> runs a <code className="font-mono text-[13px]">collie</code> command in its own pane, and the bridge knows which pane asked.
          </span>
        </li>
        <li className="flex gap-2">
          <Num n={5} hue="you" />
          <span>
            <W hue="you">You</W> tap on the phone. Every yes in this page is a tap of yours.
          </span>
        </li>
      </ol>
      <div className="rounded-sm border border-border bg-card px-4 py-3">
        <p className="mb-2 text-sm font-semibold">The colour key. Each colour means one thing, everywhere on this page.</p>
        <ColourKey />
      </div>
    </Chapter>
  );
}
