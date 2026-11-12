// Chapter 1 of the tricks explainer: where a trick can show. One phone and a chip per place, on the app's
// own screens (place-explorer.tsx), each place said the same way (place-data.ts). The owner picked it from
// round 3's three variants. Then the walk: Release Gates in four places. No prose around them, and no code: the code lives in the reference.
// DEV-ONLY, like the rest of `src/playground/`.

import { Chapter, Sub } from "./chapter";
import { SCHEMA_PLACES } from "./place-ids";
import { GatesWalk, PlacesExplorer } from "./place-explorer";

export { PLACE_ENTRIES, SCHEMA_PLACES, type PlaceId } from "./place-data";

export function PlacesChapter() {
  return (
    <Chapter at="places" lead={`A trick can show in ${SCHEMA_PLACES.length} places on the phone, and nowhere else.`}>
      <PlacesExplorer />
      <Sub>One trick, in four places</Sub>
      <GatesWalk />
    </Chapter>
  );
}
