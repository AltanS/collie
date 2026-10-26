// The harness's typeahead popups (`idle.volatile.below.popups`), read at a box: the run of rows straight
// under the bottom edge that a rule of the profile names, when the box's text opens that rule's popup (OMP's
// `@` file popup, the `#` issue and pull request popup, the `:` emoji popup). Such a popup belongs to the
// text's last word. It is no dialog, so the modal cues leave its rows out and the Send Protocol leaves them
// out of its row count. It does not take the submit key: the profile's `submitIgnores` says so, and a send
// committed with any other key keeps its refusal (protocol.ts).
//
// A rule with `staleWhenEmpty` also reads the rows left under an EMPTY box, which go with the next key.
//
// Pure: no DOM, no Bun API, no harness name. Every pattern comes from the profile.

import type { PopupRows, PopupRule } from "./profile";

/** A popup read under a box. */
export interface PopupRead {
  /** The name of the rule that read it. */
  readonly name: string;
  /** The first and last row of the popup. */
  readonly first: number;
  readonly last: number;
  /** The row the pointer is on. */
  readonly pointed: number;
  /** The box was empty: the rows are left from a text that is gone. */
  readonly stale: boolean;
}

interface CompiledRule {
  readonly rule: PopupRule;
  readonly text: RegExp;
  readonly rows: RegExp;
}

const compiledRules = new WeakMap<PopupRows, readonly CompiledRule[]>();

function compiled(popups: PopupRows): readonly CompiledRule[] {
  const known = compiledRules.get(popups);
  if (known !== undefined) return known;
  const made = popups.rules.map((rule) => ({ rule, text: new RegExp(rule.text, "u"), rows: new RegExp(rule.rows, "u") }));
  compiledRules.set(popups, made);
  return made;
}

/**
 * The popup under the box whose bottom edge (or open box's last row) is row `bottom`, when `text`, the box's
 * text, opens one of the profile's rules: every row from the bottom edge down to the screen's last non-blank
 * row matches that rule's rows, there are at most `maxRows` of them, and the pointer is on exactly one. Null
 * when a row is anything else, so a dialog drawn under the box is never mistaken for a popup. An empty text
 * opens only the rules that name `staleWhenEmpty`. Null on a profile with no popups.
 */
export function popupUnder(texts: readonly string[], bottom: number, text: string, popups: PopupRows | undefined): PopupRead | null {
  if (popups === undefined) return null;
  let end = texts.length - 1;
  while (end > bottom && texts[end]!.trim().length === 0) end--;
  const first = bottom + 1;
  if (end < first || end - first + 1 > popups.maxRows) return null;
  const empty = text.trim().length === 0;
  for (const { rule, text: opens, rows } of compiled(popups)) {
    if (empty ? rule.staleWhenEmpty !== true : !opens.test(text.trimEnd())) continue;
    let pointed = -1;
    let entry: string | undefined;
    let all = true;
    for (let i = first; i <= end && all; i++) {
      const row = rows.exec(texts[i]!.trimEnd());
      if (row === null) {
        all = false;
      } else if (row.groups?.pointer !== undefined) {
        if (pointed >= 0) all = false;
        pointed = i;
        entry = row.groups.entry;
      }
    }
    // A popup that completes the last word is closed when that word already is the pointed entry.
    if (all && rule.closedWhenTyped === true && entry !== undefined && text.trimEnd().endsWith(`/${entry}`)) continue;
    if (all && pointed >= 0) return { name: rule.name, first, last: end, pointed, stale: empty };
  }
  return null;
}
