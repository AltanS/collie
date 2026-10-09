import type { Launcher, LaunchersAdding, Recipe, RecipeOption } from "@/lib/types";

// THE RULES OF "ADD YOUR OWN" (M48 spec 02, ADR 0094), apart from the page so each is tested without
// rendering it: which harnesses have a recipe, how chips exclude each other, the line a recipe builds
// (exactly as the bridge builds it), and the example row the explainer shows.

/** The recipes worth showing: a harness with no option has nothing to pick, so it is not offered. */
export function recipesWithOptions(adding: Pick<LaunchersAdding, "recipes">): readonly Recipe[] {
  return adding.recipes.filter((r) => r.options.length > 0);
}

/**
 * The chips after a tap on `id`. A chip in a group is one choice of that group: tapping another of
 * the group replaces it, and tapping the chosen one clears the group (no model is a fine answer). A
 * chip with no group simply toggles. The bridge refuses two of a group whatever this does.
 */
export function togglePick(recipe: Recipe, picked: readonly string[], id: string): string[] {
  const option = recipe.options.find((o) => o.id === id);
  if (option === undefined) return [...picked];
  if (picked.includes(id)) return picked.filter((p) => p !== id);
  const group = option.group;
  const kept = group === undefined ? picked : picked.filter((p) => recipe.options.find((o) => o.id === p)?.group !== group);
  return [...kept, id];
}

/** The picked options in TABLE order, which is the order the bridge builds the line in. */
export function pickedOptions(recipe: Recipe, picked: readonly string[]): RecipeOption[] {
  return recipe.options.filter((o) => picked.includes(o.id));
}

/**
 * The line a recipe types, as the bridge's `buildRecipe` builds it: the binary, then each picked
 * option's words in table order. The bridge builds the real one; this is the preview of it.
 */
export function recipeLine(recipe: Recipe, picked: readonly string[]): string {
  return [recipe.binary, ...pickedOptions(recipe, picked).map((o) => o.args)].join(" ");
}

/** Whether any picked option makes the agent act without asking first. */
export function recipeSkipsPrompts(recipe: Recipe, picked: readonly string[]): boolean {
  return pickedOptions(recipe, picked).some((o) => o.noPrompts === true);
}

/** One example row for the explainer, in `launchers.toml`'s own grammar (docs/configure.md). */
export const EXAMPLE_ROW = [
  "[[launchers]]",
  'command = "claude --model opus"',
  'label = "Claude, opus"',
  'harness = "claude"',
].join("\n");

/** The key an added row is picked under on the New page: `row:<its line>`. */
export function rowKey(row: Pick<Launcher, "command">): string {
  return `row:${row.command}`;
}
