// omp's prompt suggestion in any theme (issue 854): the profile flag that says the suggestion may wear
// any style, the colour of a box's text that a receipt names, and how the captures of 2026-11-24 read.
// The Send Protocol's proof by behaviour is tested in bridge/surface/protocol.omp-suggestion.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonObject, type JsonObject } from "../json";
import { fixtureRows, idleFor, readScreen, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { boxInk } from "./frame";
import { parseProfile, ProfileError } from "./profile";
import { readSurfaceWords } from "./send";

const OMP_TEXT = readFileSync(join(import.meta.dirname, "profiles", "omp.json"), "utf8");

/** omp's raw profile with its `"anyStyle": true` written as `replacement` (a JSON member, or "" for none). */
function ompWith(replacement: string): JsonObject {
  const text = OMP_TEXT.replace(/"anyStyle": true,\s*/u, replacement);
  if (replacement !== "" && !text.includes(replacement)) throw new Error("omp.json lost its anyStyle flag");
  const raw = parseJsonObject(text);
  if (raw === undefined) throw new Error("omp.json is no JSON object");
  return raw;
}

describe("the profile flag `idle.placeholders.anyStyle` (issue 854)", () => {
  it("omp says its suggestion may wear any style; a false flag reads as absent", () => {
    expect(parseProfile(ompWith('"anyStyle": true, ')).idle.placeholders.anyStyle).toBe(true);
    expect(parseProfile(ompWith('"anyStyle": false, ')).idle.placeholders.anyStyle).toBeUndefined();
    expect(parseProfile(ompWith("")).idle.placeholders.anyStyle).toBeUndefined();
  });

  it("refuses a flag that is no boolean", () => {
    const raw = ompWith('"anyStyle": "yes", ');
    let path: string | null = null;
    try {
      parseProfile(raw);
    } catch (caught) {
      if (caught instanceof ProfileError) path = caught.path;
    }
    expect(path).toBe("idle.placeholders.anyStyle");
  });
});

describe("the captures: omp 18.22.0's suggestion in three themes", () => {
  const read = (name: string) => readScreen(fixtureRows(name, SURFACE_FIXTURES_DIR), "omp", idleFor("omp"));
  const ink = (name: string): string | null => {
    const rows = fixtureRows(name, SURFACE_FIXTURES_DIR);
    const frame = read(name).frame;
    return frame === null ? null : boxInk(rows, frame);
  };

  it("titanium's grey is the one the profile names: the box reads empty", () => {
    expect(read("omp--v18-22-0-suggestion-titanium--w120.txt").surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(ink("omp--v18-22-0-suggestion-titanium--w120.txt")).toBe("rgb(107,114,128)");
  });

  it("the dark and light greys are no colour a profile can list: a pure read takes the box for a draft, in one colour", () => {
    for (const [name, colour] of [
      ["omp--v18-22-0-suggestion-dark--w120.txt", "rgb(95,102,115)"],
      ["omp--v18-22-0-suggestion-light--w120.txt", "rgb(118,118,118)"],
    ] as const) {
      const screen = read(name);
      expect(screen.surface, name).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      expect(screen.frame?.interior.text, name).toBe("Mountains.");
      expect(ink(name), name).toBe(colour);
    }
  });

  it("the probe alone, a typed draft, and a typed start before the suggestion's rest", () => {
    expect(read("omp--v18-22-0-suggestion-probe-dark--w120.txt").frame?.interior.text).toBe("⌁");
    expect(ink("omp--v18-22-0-suggestion-probe-dark--w120.txt")).toBe("rgb(229,229,231)");
    expect(read("omp--v18-22-0-suggestion-typed-light--w120.txt").frame?.interior.text).toBe("hey");
    expect(ink("omp--v18-22-0-suggestion-typed-light--w120.txt")).toBe("rgb(0,0,0)");
    // Two colours in one box: no one colour covers it.
    expect(read("omp--v18-22-0-suggestion-under-typed-dark--w120.txt").frame?.interior.text).toBe("Mountains.");
    expect(ink("omp--v18-22-0-suggestion-under-typed-dark--w120.txt")).toBeNull();
  });
});

describe("a receipt's words carry the colour of the draft (issue 854)", () => {
  it("reads a colour and a palette colour, and drops anything else while the words stand", () => {
    expect(readSurfaceWords({ turn: "idle", modal: "none", composer: "draft", ink: "rgb(95,102,115)" })).toEqual({ turn: "idle", modal: "none", composer: "draft", ink: "rgb(95,102,115)" });
    expect(readSurfaceWords({ turn: "idle", modal: "none", composer: "draft", ink: "var(--ansi-8)" })).toMatchObject({ ink: "var(--ansi-8)" });
    expect(readSurfaceWords({ turn: "idle", modal: "none", composer: "draft", ink: "my own words" })).toEqual({ turn: "idle", modal: "none", composer: "draft" });
    expect(readSurfaceWords({ turn: "idle", modal: "none", composer: "draft", reason: "stale", ink: "rgb(1,2,3)" })).toEqual({ turn: "idle", modal: "none", composer: "draft", reason: "stale", ink: "rgb(1,2,3)" });
  });
});
