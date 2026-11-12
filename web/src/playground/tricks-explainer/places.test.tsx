// The "Where a trick can show" chapter names every place the schema knows: a new place in `PLACE_KINDS`
// or a new `AGENT_VIEW_PLACE` with no entry in the chapter fails here, so the explainer cannot miss one.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HILL, PLACE_ORDER, PLACES } from "@/lib/tricks/catalogue";
import { AGENT_VIEW_PLACE, PLACE_KINDS } from "@/lib/tricks/schema";

import { PLACE_ENTRIES, PlacesChapter, SCHEMA_PLACES } from "./places";

describe("the places chapter", () => {
  it("lists every place of the schema, and the Hill", () => {
    for (const place of [...PLACE_KINDS, AGENT_VIEW_PLACE, "hill"]) expect(SCHEMA_PLACES).toContain(place);
    expect(Object.keys(PLACE_ENTRIES).toSorted()).toEqual([...SCHEMA_PLACES].toSorted());
  });

  it("names and describes each place in the catalogue's words", () => {
    for (const place of PLACE_ORDER) {
      expect(PLACE_ENTRIES[place].name).toBe(PLACES[place].name);
      expect(PLACE_ENTRIES[place].where).toBe(PLACES[place].where);
    }
    expect(PLACE_ENTRIES.hill.name).toBe(HILL.name);
    expect(PLACE_ENTRIES.hill.where).toBe(HILL.what);
  });

  it("gives each place its own number in the sketch", () => {
    const numbers = SCHEMA_PLACES.map((place) => PLACE_ENTRIES[place].n);
    expect(new Set(numbers).size).toBe(SCHEMA_PLACES.length);
  });

  it("draws one entry per place, with its real component", async () => {
    const { container } = render(<PlacesChapter />);
    await waitFor(() => {
      for (const place of SCHEMA_PLACES) expect(container.querySelector(`[data-place="${place}"]`)).not.toBeNull();
    });
  });
});
