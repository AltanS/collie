// "MiniMax Code as built", the round that shows the owner what PR 735 puts on screen for an `mcode` pane,
// because the owner cannot see it on a phone without that agent. A pick round is a proposal in the
// workspace's design app (`design propose <worktree> minimax-look`), never a design reference entry.
//
// Three pieces, each the REAL component with `mcode` data, none copied:
//   1. The belt, `ActionsRow` with `agent="mcode"`: Collie's own five controls, then the tinted harness
//      section with the mark and Plan, Compact, History, Resume (lib/harness-bar.ts, `MCODE`).
//   2. The mark, `AgentIcon agent="mcode"`: the purple M tile, at the belt's size and at a size that shows
//      its shape, and in the agent Select of the recipe form.
//   3. The four start chips: Continue last, Programmatic Tool Calling, Mode: lightweight, Mode: standard.
//      They are the recipe chips of `RecipeForm`, the "Add your own" page (routes/new-add.tsx), exported
//      for this round. They are NOT on the New tab sheet: that sheet lists launcher rows and has no chips.
//      The chips' data is bridge/launcher-recipes.ts `mcode`, written out here as the `Recipe` the
//      bridge sends, because the web bundle does not import the bridge.
//
// No stub of a bridge, no hand-written stylesheet. The belt's `onRun` is the playground's stub that
// answers true, so a tap on Plan shows the real echo and sends nothing. The cases are the theme and the
// width: light and dark at 390 px, and light at 360 px.
//
// After the pick: build whatever changes, move the state into the design reference, delete this file, its
// test and its line in ../rounds.ts.

import { useState, type CSSProperties, type ReactNode } from "react";

import { ActionsRow } from "@/components/actions-row";
import { AgentIcon } from "@/components/agent-icon";
import { RecipeForm } from "@/routes/new-add";
import { togglePick } from "@/lib/launcher-add";
import type { Recipe } from "@/lib/types";
import { cn } from "@/lib/utils";
import { took, useRoomyActions } from "@/playground/sections/shared";

import type { PickCase, PickOption, PickRoundDef } from "../types";

const STATE = "minimax-as-built";

/** `RECIPE_TABLE.mcode` of bridge/launcher-recipes.ts, as the bridge sends it (`Recipe`, lib/types.ts). */
const MCODE_RECIPE: Recipe = {
  harness: "mcode",
  label: "MiniMax Code",
  binary: "mcode",
  options: [
    { id: "continue", label: "Continue last", args: "--continue" },
    { id: "ptc", label: "Programmatic Tool Calling", args: "--ptc" },
    { id: "lightweight", label: "Mode: lightweight", args: "--mode lightweight", group: "mode" },
    { id: "standard", label: "Mode: standard", args: "--mode standard", group: "mode" },
  ],
};

const CASES: readonly PickCase[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "light-360", label: "Light, 360 px" },
];

interface Look {
  readonly dark: boolean;
  readonly narrow: boolean;
}

function lookOf(caseId: string): Look {
  return { dark: caseId.startsWith("dark"), narrow: caseId.endsWith("-360") };
}

/** The theme and the width: the `dark` class and `color-scheme` the app's root sets, and a 360 px column. */
function Stage({ look, children }: { look: Look; children: ReactNode }) {
  const style: CSSProperties = { colorScheme: look.dark ? "dark" : "light" };
  return (
    <div
      data-state={STATE}
      className={cn("flex min-h-full flex-1 flex-col bg-background text-foreground", look.dark && "dark")}
      style={style}
    >
      <div className={cn("flex min-h-0 flex-1 flex-col gap-6 py-4", look.narrow && "mx-auto w-[360px] max-w-full border-x border-rule")}>{children}</div>
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-4 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** The belt of a pane that runs `mcode`: the general controls, then the tinted section. */
function Belt() {
  const general = useRoomyActions();
  return <ActionsRow general={general} agent="mcode" onRun={took} />;
}

/** The mark on its own: the belt's size, a size that shows the M, and the size of a dashboard tile. */
function Mark() {
  return (
    <div className="flex items-end gap-4 px-4">
      <AgentIcon agent="mcode" className="size-5" />
      <AgentIcon agent="mcode" className="size-9 rounded-lg" />
      <AgentIcon agent="mcode" className="size-16 rounded-2xl" />
    </div>
  );
}

/** The recipe form of "Add your own", holding only MiniMax Code, with the chips tappable as in the app. */
function Chips() {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="px-4">
      <RecipeForm
        recipes={[MCODE_RECIPE]}
        recipe={MCODE_RECIPE}
        picked={picked}
        name=""
        onHarness={() => undefined}
        onPick={(id) => setPicked((was) => togglePick(MCODE_RECIPE, was, id))}
        onName={() => undefined}
        loaded
      />
    </div>
  );
}

function render(caseId: string): ReactNode {
  return (
    <Stage look={lookOf(caseId)}>
      <Part title="The belt on a MiniMax Code pane">
        <Belt />
      </Part>
      <Part title="The mark">
        <Mark />
      </Part>
      <Part title="The start chips (Add your own)">
        <Chips />
      </Part>
    </Stage>
  );
}

const OPTIONS: readonly PickOption[] = [{ n: 1, label: "MiniMax Code as built", state: STATE, render }];

const ROUND: PickRoundDef = { title: "MiniMax Code as built", options: OPTIONS, cases: CASES, frameHeight: 760 };

export default ROUND;
