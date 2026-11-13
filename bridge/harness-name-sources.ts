// Which harness names its session somewhere OTHER than a journal the title tracker reads, as data.
//
// The name rule and the state engine name no harness (bridge/session-title-no-harness.test.ts). A
// harness whose journal holds its names declares a `nameProbe` on its adapter (journal/types.ts), and
// the title tracker asks it by session id. Two fallbacks remain, each keyed here by the harness word
// rather than branched on in shared code:
//
//  - SCREEN: Claude Code paints a `/rename` name into the rule of its input box. The engine reads it off
//    the screen only while the journal has given the pane no name: a pane whose session id is not
//    known (tmux with no hooks installed), or a session the journal has not named yet.
//  - ARGV: Muse names no session in a ref Herdr reports, so its reader binds the pane by its foreground
//    argv (journal/muse.ts `museSessionNameReader`). The bridge wires that reader under this word.

import { extractClaudeSessionName } from "./state-engine.ts";

/**
 * A screen reader: the name in the pane's visible grid; `null` when the screen proves there is none;
 * `undefined` when the screen cannot say (no input box in view).
 */
export type ScreenNameReader = (text: string) => string | null | undefined;

/**
 * The harnesses whose screens carry a name, and how to read it, by harness word: the engine looks a
 * pane's agent up here and branches on nothing.
 */
export const SCREEN_NAME_READERS: ReadonlyMap<string, ScreenNameReader> = new Map<string, ScreenNameReader>([["claude", extractClaudeSessionName]]);

/** The harness word the bridge wires the Muse argv reader under (bridge/index.ts). */
export const ARGV_NAMED_AGENT = "muse";
