/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { FRESH, isStaleBuild, observeBuild, type BuildWatch } from "./build-check";

const OURS = "1.17.0-dev+abc1234.1790000000";
const NEW = "1.17.0-dev+def5678.1790000100";
const OTHER = "1.17.0-dev+0123456.1790000200";

function run(ids: readonly (string | undefined)[]): BuildWatch {
  return ids.reduce<BuildWatch>((watch, id) => observeBuild(watch, OURS, id), FRESH);
}

describe("isStaleBuild (web/src/lib/build.ts, word for word)", () => {
  test("a missing, empty or unknown server id is never stale", () => {
    expect(isStaleBuild(OURS, undefined)).toBe(false);
    expect(isStaleBuild(OURS, "")).toBe(false);
    expect(isStaleBuild(OURS, "unknown")).toBe(false);
  });
  test("our own id is current, any other id is stale", () => {
    expect(isStaleBuild(OURS, OURS)).toBe(false);
    expect(isStaleBuild(OURS, NEW)).toBe(true);
  });
});

describe("observeBuild: two consecutive sightings confirm", () => {
  test("one sighting is pending, not confirmed", () => {
    expect(run([NEW])).toEqual({ pending: NEW, confirmed: undefined });
  });
  test("two sightings in a row confirm", () => {
    expect(run([NEW, NEW]).confirmed).toBe(NEW);
  });
  test("a confirmed id stays confirmed on further sightings", () => {
    expect(run([NEW, NEW, NEW, NEW]).confirmed).toBe(NEW);
  });
  test("a header that flips for one poll during a swap never confirms", () => {
    expect(run([NEW, OURS, NEW, OURS]).confirmed).toBeUndefined();
  });
  test("a different stale id restarts the count", () => {
    const watch = run([NEW, NEW, OTHER]);
    expect(watch).toEqual({ pending: OTHER, confirmed: undefined });
    expect(observeBuild(watch, OURS, OTHER).confirmed).toBe(OTHER);
  });
  test("returning to our id clears everything", () => {
    expect(run([NEW, NEW, OURS])).toEqual(FRESH);
  });
  test("an older bridge with no header never opens the sheet", () => {
    expect(run([undefined, undefined, undefined])).toEqual(FRESH);
  });
});
