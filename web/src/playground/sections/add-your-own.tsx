// Add your own section of the states playground: the recipe form of the "Add your own" page
// (routes/new-add.tsx), the way a person builds a launcher row from a harness and its option chips. The card
// mounts the REAL `RecipeForm` with the `Recipe` the bridge sends for MiniMax Code (bridge/launcher-recipes.ts
// `mcode`), written out here because the web bundle does not import the bridge. Taps on the chips work as in the
// app; nothing is saved.
//
// Cards are numbered from 76.

import { useState } from "react";

import { togglePick } from "@/lib/launcher-add";
import type { Recipe } from "@/lib/types";
import { RecipeForm } from "@/routes/new-add";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "add-your-own",
  title: "Add your own",
  intent:
    "The page of the New tab flow where a person adds a launcher row of their own (/new/add). A harness, the option chips its recipe offers, the line " +
    "they build, and an optional name. The card mounts the real form with MiniMax Code's recipe; a tap on a chip " +
    "works, nothing is saved.",
};

/** `RECIPE_TABLE.mcode` of bridge/launcher-recipes.ts, as the bridge sends it (`Recipe`, lib/types.ts). */
export const MCODE_RECIPE: Recipe = {
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

/** The recipe form holding only MiniMax Code, with its four chips tappable as in the app. */
export function MiniMaxChips() {
  const [picked, setPicked] = useState<string[]>([]);
  return (
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
  );
}

export function AddYourOwnSection() {
  return (
    <Section def={DEF}>
      <Group title="The recipe form">
        <Card
          state="add-your-own-mcode"
          label="76: MiniMax Code start chips"
          reach="open the New tab page, tap Add your own (/new/add), and pick MiniMax Code as the agent."
          note="Four chips: Continue last, Programmatic Tool Calling, Mode: lightweight and Mode: standard. The two modes are one group, so a tap on one replaces the other. The line under the chips is the row that would be saved. The chips are not on the New tab sheet itself, which lists launcher rows only."
          span={2}
        >
          <MiniMaxChips />
        </Card>
      </Group>
    </Section>
  );
}
