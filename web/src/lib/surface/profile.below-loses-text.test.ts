// `idle.volatile.below.losesText` (#847): a hint row under the box may lose words once the box holds a
// character. Only `true` is a value, and only beside hint patterns; only the Codex profile sets it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asJsonObject, parseJsonObject, type JsonObject } from "../json";
import { loadProfiles, parseProfile, ProfileError } from "./profile";

const PROFILES_DIR = join(import.meta.dirname, "profiles");

function rawCodexBelow(edit: (below: JsonObject) => void): JsonObject {
  const raw = parseJsonObject(readFileSync(join(PROFILES_DIR, "codex.json"), "utf8"));
  if (raw === undefined) throw new Error("codex.json is not a JSON object");
  const below = asJsonObject(asJsonObject(asJsonObject(raw.idle)?.volatile)?.below);
  if (below === undefined) throw new Error("codex.json has no idle.volatile.below");
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

describe("idle.volatile.below.losesText", () => {
  it("is set in the Codex profile only", () => {
    const setting = [...loadProfiles().values()].filter((profile) => profile.idle.volatile.below.losesText === true).map((profile) => profile.id);
    expect(setting).toEqual(["codex"]);
  });

  it("is absent from the parsed profile when the file leaves it out", () => {
    expect(parseProfile(rawCodexBelow((below) => delete below.losesText)).idle.volatile.below.losesText).toBeUndefined();
  });

  it("refuses a value that is not true", () => {
    expect(failurePath(rawCodexBelow((below) => (below.losesText = false)))).toBe("idle.volatile.below.losesText");
  });

  it("refuses the rule with no hint patterns: only a hint row may lose text", () => {
    expect(failurePath(rawCodexBelow((below) => delete below.hints))).toBe("idle.volatile.below.losesText");
  });
});
