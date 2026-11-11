// The line an example opens with: the places it shows in (numbered as in the places chapter) and the parts
// it draws with, so each example points back to the generic chapters in the same hues.
// DEV-ONLY, like the rest of `src/playground/`.

import { Num } from "./hues";
import { PLACE_ENTRIES, type PlaceId } from "./places";

export function Uses({ places, parts }: { places: readonly PlaceId[]; parts: readonly string[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border bg-card px-4 py-3 text-[15px] sm:flex-row sm:flex-wrap sm:gap-x-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">Places</span>
        {places.map((id) => (
          <span key={id} className="inline-flex items-center gap-1.5">
            <Num n={PLACE_ENTRIES[id].n} hue="trick" />
            {PLACE_ENTRIES[id].name}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">Parts</span>
        {parts.map((p) => (
          <code key={p} className="rounded-sm border border-border px-1.5 font-mono text-[13px]">
            {p}
          </code>
        ))}
      </div>
    </div>
  );
}
