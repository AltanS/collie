// What the places chapter says about each place, the same in all three variants of round 3
// (place-variants.tsx). Plain data and the finders that light each place on its real screen.
//
// The list of places is read from the schema, never typed here alone: `PLACE_KINDS` (the places a
// program's parts draw in), `AGENT_VIEW_PLACE` (the view a session's agent draws), and the Hill, which is
// built in and where a trick asks you something. `PLACE_ENTRIES` must hold an entry for each, and
// places.test.tsx fails when a new place has none. The names come from the catalogue; the rest is the
// explainer's own plain words, with no code: the code lives in the reference.
// DEV-ONLY, like the rest of `src/playground/`.

import { HILL, PLACES } from "@/lib/tricks/catalogue";

import { PLACE_NUMBER, SCHEMA_PLACES, type PlaceId } from "./place-ids";
import { byText, bySelector, type SceneId, type Target } from "./place-scenes";

export { SCHEMA_PLACES, type PlaceId };

/** Where the person is when they see the place. */
export type PlaceGroup = "dashboard" | "session" | "anywhere";

export const GROUP_NAMES = {
  dashboard: "On the Dashboard",
  session: "In a session",
  anywhere: "Wherever you are",
} as const satisfies Record<PlaceGroup, string>;

export interface PlaceEntry {
  /** The place's number, the same in every variant. */
  n: number;
  /** The app's word for the place, from the catalogue. */
  name: string;
  /** The catalogue's sentence on where it shows. Kept for the test; the chapter shows `good`. */
  where: string;
  group: PlaceGroup;
  /** What the place is good for, in one sentence. */
  good: string;
  /** What a tap does. */
  tap: string;
  /** A real trick that uses the place. */
  trick: string;
  /** The real screen the place is lit on. */
  scene: SceneId;
  /** How to find the place's part on that screen. */
  find: Target["find"];
}

/** One entry per place. `satisfies Record<PlaceId, ...>` makes a new schema place a type error here first. */
export const PLACE_ENTRIES = {
  dashboard: {
    n: PLACE_NUMBER["dashboard"],
    name: PLACES["dashboard"].name,
    where: PLACES["dashboard"].where,
    group: "dashboard",
    good: "A count you see at a glance, the moment you open Collie.",
    tap: "Opens the trick's Page.",
    trick: "PR Inbox: the pull requests that wait for you.",
    scene: "dashboard",
    find: byText("Inbox"),
  },
  tabbar: {
    n: PLACE_NUMBER["tabbar"],
    name: PLACES["tabbar"].name,
    where: PLACES["tabbar"].where,
    group: "dashboard",
    good: "A count that stays in reach under every list of the Dashboard.",
    tap: "Opens the trick's Page.",
    trick: "Design Review: the designs that wait for your yes.",
    scene: "dashboard",
    find: byText("Review"),
  },
  session: {
    n: PLACE_NUMBER["session"],
    name: PLACES["session"].name,
    where: PLACES["session"].where,
    group: "dashboard",
    good: "A whole screen for one job: a list, a number, a few buttons.",
    tap: "The row opens the Page. A button on the Page runs the trick once.",
    trick: "Running Builds: the builds that run in your sessions now.",
    scene: "dashboard",
    find: byText("Running Builds"),
  },
  status: {
    n: PLACE_NUMBER["status"],
    name: PLACES["status"].name,
    where: PLACES["status"].where,
    group: "session",
    good: "One short state you see while you read an agent.",
    tap: "Opens the trick's Page.",
    trick: "Release Gates: which check is red before a release.",
    scene: "session",
    find: byText("e2e red"),
  },
  belt: {
    n: PLACE_NUMBER["belt"],
    name: PLACES["belt"].name,
    where: PLACES["belt"].where,
    group: "session",
    good: "One action, one tap away, beside the controls you already use.",
    tap: "Runs the trick once. The mark turns until the trick answers.",
    trick: "Release Gates: rerun the red checks.",
    scene: "session",
    find: byText("5/7"),
  },
  "agent-view": {
    n: PLACE_NUMBER["agent-view"],
    name: PLACES["agent-view"].name,
    where: PLACES["agent-view"].where,
    group: "session",
    good: "Your agent answers with one clear screen, not a wall of text.",
    tap: "Sends your choice to that agent, in your name.",
    trick: "Morph: the agent draws the screen it wants you to see.",
    scene: "agent-view",
    find: bySelector("[data-slot='agent-view']"),
  },
  hill: {
    n: PLACE_NUMBER["hill"],
    name: HILL.name,
    where: HILL.what,
    group: "anywhere",
    good: "A question that waits for you, answered with one tap.",
    tap: "Your answer goes back to the trick. Nothing is chosen for you.",
    trick: "Release Gates: tag the release with one check red?",
    scene: "hill",
    find: (root) => {
      const card = root.querySelector("[data-slot='decision-meta']")?.closest("article, section, li") ?? null;
      return card !== null && root.contains(card) ? card : null;
    },
  },
} as const satisfies Record<PlaceId, PlaceEntry>;

/** The places in number order: by group, then where the person meets them. */
export const IN_ORDER: readonly PlaceId[] = SCHEMA_PLACES.toSorted((a, b) => PLACE_ENTRIES[a].n - PLACE_ENTRIES[b].n);

export const GROUPS: readonly PlaceGroup[] = ["dashboard", "session", "anywhere"];

export function placesOf(group: PlaceGroup): readonly PlaceId[] {
  return IN_ORDER.filter((id) => PLACE_ENTRIES[id].group === group);
}

