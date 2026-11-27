// `idle.volatile.below.losesRows`: the last rows under the box may go to a box that grew by as many.
// Only `true` is a value; only the Claude profile sets it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asJsonObject, parseJsonObject, type JsonObject } from "../json";
import { loadProfiles, parseProfile, ProfileError } from "./profile";

const PROFILES_DIR = join(import.meta.dirname, "profiles");

function rawClaudeBelow(edit: (below: JsonObject) => void): JsonObject {
  const raw = parseJsonObject(readFileSync(join(PROFILES_DIR, "claude.json"), "utf8"));
  if (raw === undefined) throw new Error("claude.json is not a JSON object");
  const below = asJsonObject(asJsonObject(asJsonObject(raw.idle)?.volatile)?.below);
  if (below === undefined) throw new Error("claude.json has no idle.volatile.below");
  edit(below);
  return raw;
}

function failurePath(raw: JsonObject): string {
  try {
    parseProfile(raw);
  } catch (error) {
    if (error instanceof ProfileError) return error.path;
    throw error;
  }
  throw new Error("the profile parsed");
}

describe("idle.volatile.below.losesRows", () => {
  it("is set in the Claude profile only", () => {
    const setting = [...loadProfiles().values()].filter((profile) => profile.idle.volatile.below.losesRows === true).map((profile) => profile.id);
    expect(setting).toEqual(["claude"]);
  });

  it("is absent from the parsed profile when the file leaves it out", () => {
    expect(parseProfile(rawClaudeBelow((below) => delete below.losesRows)).idle.volatile.below.losesRows).toBeUndefined();
  });

  it("refuses a value that is not true", () => {
    expect(failurePath(rawClaudeBelow((below) => (below.losesRows = false)))).toBe("idle.volatile.below.losesRows");
  });

  it("stands beside losesText", () => {
    const below = parseProfile(rawClaudeBelow((node) => (node.losesText = true))).idle.volatile.below;
    expect(below).toMatchObject({ losesText: true, losesRows: true });
  });
});
