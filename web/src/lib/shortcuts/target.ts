// The one way a control says which shortcut action presses it (M108, key hints). A control spreads the
// result onto its element: `<button {...shortcutTarget("open_actions")}>`. While the prefix waits, the
// hint layer (components/shortcut-hint-layer.tsx) finds every element that carries the attribute and
// draws the action's live key on it. No control draws a hint itself, and no control's layout changes.
//
// `lib/shortcuts/hint-coverage.test.ts` reads the sources for these calls: an action with a default
// `prefix+` key that no control names, and that `NO_CONTROL_ACTIONS` does not list, fails the test.
//
// This file imports nothing but a type, so the core stays free of React and of the DOM.

import type { ActionId } from "./actions";

/** The attribute that names the action. Read by the layer with `querySelectorAll`. */
export const TARGET_ATTRIBUTE = "data-shortcut-action";
/** The attribute that carries the digit of an indexed action (`switch_tab`: the tab's number). */
export const TARGET_INDEX_ATTRIBUTE = "data-shortcut-index";
/** The attribute that moves the cap to the top left corner, for a control whose top right corner has a label beside it. */
export const TARGET_CORNER_ATTRIBUTE = "data-shortcut-corner";
/** The attribute that makes the control's icon the anchor of its cap, however small the box around the icon is. */
export const TARGET_ICON_ATTRIBUTE = "data-shortcut-icon";

/** The corner of the control the cap's centre goes on. The top right is the default. */
export type HintCorner = "top-right" | "top-left";

export interface ShortcutTarget {
  readonly "data-shortcut-action": ActionId;
  readonly "data-shortcut-index"?: number;
  readonly "data-shortcut-corner"?: HintCorner;
  readonly "data-shortcut-icon"?: "true";
}

type TargetDraft = { -readonly [K in keyof ShortcutTarget]: ShortcutTarget[K] };

/** The data attributes of a control that an action key would press. `index` is the digit of an indexed action. */
export function shortcutTarget(id: ActionId, options: { index?: number; corner?: HintCorner; icon?: boolean } = {}): ShortcutTarget {
  const target: TargetDraft = { "data-shortcut-action": id };
  if (options.index !== undefined) target["data-shortcut-index"] = options.index;
  if (options.corner !== undefined && options.corner !== "top-right") target["data-shortcut-corner"] = options.corner;
  if (options.icon === true) target["data-shortcut-icon"] = "true";
  return target;
}
