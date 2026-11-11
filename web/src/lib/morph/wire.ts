// TODO(agent-view web): a thin adapter. The phone's Morph code (lib/morph/, components/morph-*.tsx,
// hooks/use-morph-pane.ts) reads the agent view wire (lib/agent-view/wire.ts) through these old names
// until the web half of agent views replaces it. Nothing here is a new rule: every type is the agent
// view's own, and every reader is the agent view's reader.
//
// The one shape that differs: the bridge keys a view by (trick, session), and `GET /api/trick-views`
// answers a list of views. The phone's Morph store holds one view per session, so `morphAnswerOf` keeps,
// for each session, the view that is on, else the first one listed. A read with `since` that answers only
// the views that moved (it carries `keys`) is not one this store can merge: it reads the whole list again.

import type { JsonValue } from "../json";
import {
  readTrickViewsAnswer,
  readTrickViewSession,
  TRICK_VIEWS_ROUTE,
  TRICK_VIEWS_SWITCH_ROUTE,
  type TrickViewSession,
  type TrickViewsAnswer,
  type ViewChoice,
  type ViewDrawing,
  type ViewMedia,
  type ViewNote,
  type ViewOption,
  type ViewScreen,
} from "../agent-view/wire";

export { parseAgentView as parseMorphView, viewBlocksOf as morphBlocksOf, viewMediaPath as morphMediaPath, VIEW_DRAWING_MAX_MS as MORPH_DRAWING_MAX_MS, nextBlockId } from "../agent-view/wire";

export type MorphView = ViewScreen;
export type MorphChoice = ViewChoice;
export type MorphOption = ViewOption;
export type MorphMedia = ViewMedia;
export type MorphNote = ViewNote;
export type MorphDrawing = ViewDrawing;
export type MorphSession = TrickViewSession;

/** The routes, the agent views' own. */
export const MORPH_ROUTE = TRICK_VIEWS_ROUTE;
export const MORPH_SWITCH_ROUTE = TRICK_VIEWS_SWITCH_ROUTE;

/**
 * TODO(agent-view web): the trick a switch names while the phone offers no choice of trick: the view
 * already held for the session, else the Morph trick's id.
 */
export const DEFAULT_VIEW_TRICK = "morph";

/** What the phone's Morph store holds of one read: one view per session. */
export interface MorphAnswer {
  rev: number;
  unchanged?: true;
  sessions: MorphSession[];
}

/** What the phone sends to `POST /api/trick-views/switch`. */
export interface MorphSwitchBody {
  trick: string;
  session: string;
  on: boolean;
}

/** One view per session: the one that is on, else the first listed. Null for a `since` read of moved views only. */
export function morphAnswerOf(answer: TrickViewsAnswer): MorphAnswer | null {
  if (answer.unchanged === true) return { rev: answer.rev, unchanged: true, sessions: [] };
  if (answer.keys !== undefined) return null;
  const bySession = new Map<string, MorphSession>();
  for (const view of answer.views) {
    const held = bySession.get(view.session);
    if (held === undefined || (!held.on && view.on)) bySession.set(view.session, view);
  }
  return { rev: answer.rev, sessions: [...bySession.values()] };
}

/** The answer of `GET /api/trick-views`, as the phone's Morph store holds it; null for a body it cannot read or a partial one. */
export function readMorphAnswer(raw: JsonValue | undefined): MorphAnswer | null {
  const answer = readTrickViewsAnswer(raw);
  return answer === null ? null : morphAnswerOf(answer);
}

/** One view as served. */
export function readMorphSession(raw: JsonValue | undefined): MorphSession | null {
  return readTrickViewSession(raw);
}
