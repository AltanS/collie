import { describe, expect, it } from "vitest";

import { TRICK_MEDIA_VERSIONS_MAX } from "./schema";
import { readMediaVersions, readTrick } from "./wire";

const ROW = { host: "lodge", id: "pet", name: "Pet", icon: "flask", on: true, state: "ok", places: ["float"] };

describe("a trick row's picture versions", () => {
  it("keeps a map of image names and 12 hex versions", () => {
    const row = readTrick({ ...ROW, media: { "media/pet.png": "0123456789ab", "media/a/b.webp": "ba9876543210" } });
    expect(row?.media).toEqual({ "media/pet.png": "0123456789ab", "media/a/b.webp": "ba9876543210" });
  });

  it("drops a name the image rule refuses and a version that is not 12 hex", () => {
    const row = readTrick({ ...ROW, media: { "media/pet.png": "0123456789ab", "../x.png": "0123456789ab", "media/.hid.png": "0123456789ab", "media/b.png": "NOPE", "media/c.png": 7 } });
    expect(row?.media).toEqual({ "media/pet.png": "0123456789ab" });
  });

  it("leaves the field out for an older bridge, an empty map and a value of another shape", () => {
    expect(readTrick(ROW)).not.toHaveProperty("media");
    expect(readTrick({ ...ROW, media: {} })).not.toHaveProperty("media");
    expect(readTrick({ ...ROW, media: "x" })).not.toHaveProperty("media");
    expect(readTrick({ ...ROW, media: ["media/pet.png"] })).not.toHaveProperty("media");
  });

  it("reads at most the cap", () => {
    const many = Object.fromEntries(Array.from({ length: TRICK_MEDIA_VERSIONS_MAX + 20 }, (_, i) => [`media/p${String(i)}.png`, "0123456789ab"]));
    expect(Object.keys(readMediaVersions(many) ?? {})).toHaveLength(TRICK_MEDIA_VERSIONS_MAX);
  });
});
