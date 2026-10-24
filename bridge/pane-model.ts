// The model a pane names above the belt, from two sources that each know it at a different time.
//
//  - THE JOURNAL (bridge/cache/tracker.ts) reads the session's transcript: the model of the newest turn,
//    or a `/model` chosen since. It is exact, and per turn. But Claude Code writes no transcript until
//    the first message or local command, so a fresh session has no journal reading at all (seen on
//    2.1.310: `claude --model sonnet`, no prompt, no `.jsonl` anywhere under the config root).
//  - THE START HOOK (cli/beacon.ts) names the model the session starts on, on the `SessionStart` edge
//    (bridge/surface/edges.ts keeps it per pane while the pane's hook source lives). It is there from
//    the first moment, and it never changes after: `/model` fires no hook.
//
// THE RULE. The journal wins, except where the hook is the only one that knows, or knows something
// newer: a hook reading with no journal reading is shown, and a hook reading that names ANOTHER model
// and came AFTER the journal's last reading replaces it (a new session started in the pane, a resume
// on another model). A journal reading taken after the hook wins again, so the first turn or a `/model`
// after the start takes over. "The same model" is compared by family and version, so the hook's
// `claude-opus-5-5[1m]` and the journal's "Opus 5.5" are one model.
//
// Both `at`s are the bridge's own clock: when the tracker recorded the reading, and when the router took
// the edge. Display only: no rule, no TTL and no cache state reads this.

import { normaliseModel } from "./journal/claude-resets.ts";

/** One source's model, and when the bridge learned it. */
export interface ModelReading {
  readonly model: string;
  readonly at: number;
}

/** A model name with its tags removed: the `[1m]` window tag, a parenthesis, surrounding space. */
export function displayModel(name: string): string {
  return name
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
}

/** The name two readings are compared by: family and version where it is a Claude name, else the lower-cased name. */
function modelKey(name: string): string {
  return normaliseModel(name) ?? displayModel(name).toLowerCase();
}

/** Whether two names are the same model, however each source spells it. */
export function sameModel(a: string, b: string): boolean {
  return modelKey(a) === modelKey(b);
}

/**
 * The model the pane shows, or undefined. The hook's name goes out with its `[1m]` tag removed, so the
 * wire carries an id like the journal's; the window that tag names reaches the usage dots on its own
 * path (cli/context-reading.ts).
 */
export function paneModel(journal: ModelReading | undefined, hook: ModelReading | undefined): string | undefined {
  const fromHook = hook === undefined ? "" : displayModel(hook.model);
  if (hook === undefined || fromHook === "") return journal?.model;
  if (journal === undefined) return fromHook;
  return hook.at > journal.at && !sameModel(hook.model, journal.model) ? fromHook : journal.model;
}

/** Whether the shown model is the journal's, so the journal's effort may ride beside it. */
export function journalModelShown(journal: ModelReading | undefined, hook: ModelReading | undefined): boolean {
  return journal !== undefined && paneModel(journal, hook) === journal.model;
}
