// The places a trick can show in, in the order the sketch numbers them. Read from the schema's own lists
// (`PLACE_KINDS`, `AGENT_VIEW_PLACE`) plus the Hill, so a figure and the places chapter use the same ids
// and the same numbers. Plain data: no fixture, no component.
// DEV-ONLY, like the rest of `src/playground/`.

import { AGENT_VIEW_PLACE, PLACE_KINDS, type PlaceKind } from "@/lib/tricks/schema";

/** Every place a trick can show: the schema's drawing places, the agent view, and the Hill. */
export type PlaceId = PlaceKind | typeof AGENT_VIEW_PLACE | "hill";

/** The places in the schema's own lists, plus the Hill. */
export const SCHEMA_PLACES: readonly PlaceId[] = [...PLACE_KINDS, AGENT_VIEW_PLACE, "hill"];

/**
 * Each place's number, in the order a person meets them: on the Dashboard (tile, bottom bar item, the
 * Page's row), in a session (status chip, Belt mark, agent view), then wherever you are (the Hill).
 */
export const PLACE_NUMBER = {
  dashboard: 1,
  tabbar: 2,
  session: 3,
  status: 4,
  belt: 5,
  "agent-view": 6,
  hill: 7,
} as const satisfies Record<PlaceId, number>;
