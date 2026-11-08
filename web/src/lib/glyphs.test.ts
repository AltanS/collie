import { describe, expect, it, vi } from "vitest";

import type { JsonValue } from "./json";

// The set the startup preload asks for (main.tsx): on a cold start it must be the stored theme's set,
// read from storage before anything renders, or the first paint waits for the wrong chunk.

interface Stored {
  design: { theme?: string };
  library: { version: number; themes: readonly JsonValue[] };
}

async function boot({ design, library }: Stored) {
  localStorage.clear();
  localStorage.setItem("collie:design:v1", JSON.stringify(design));
  localStorage.setItem("collie:themes:v1", JSON.stringify(library));
  vi.resetModules();
  return import("./glyphs");
}

const worn = { version: 4, id: "worn", name: "Worn", light: { background: "#ffffff" }, glyphs: "iconoir" };

describe("the startup glyph set", () => {
  it("is the stored theme's set on a cold start", async () => {
    const glyphs = await boot({ design: { theme: "worn" }, library: { version: 1, themes: [worn] } });
    expect(glyphs.currentGlyphSetId()).toBe("iconoir");
    expect(glyphs.storedGlyphSetId()).toBe("iconoir");
  });

  it("is lucide when the stored theme names none, or a set this Collie lacks", async () => {
    expect((await boot({ design: {}, library: { version: 1, themes: [worn] } })).currentGlyphSetId()).toBe("lucide");
    const future = { ...worn, glyphs: "tabler" };
    expect((await boot({ design: { theme: "worn" }, library: { version: 1, themes: [future] } })).currentGlyphSetId()).toBe("lucide");
  });
});
