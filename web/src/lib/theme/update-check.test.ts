import { describe, expect, it } from "vitest";

import type { JsonValue } from "../json";
import { checkForUpdate } from "./update-check";

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const AT = Date.parse("2026-11-08T10:00:00Z");
const ORIGIN = { kind: "registry", repo: "sam/my-day", path: "collie-theme.json", sha: OLD, at: AT } as const;

function text(id: string): string {
  return JSON.stringify({ version: 1, id, name: id, light: { background: "#fdfaf3" }, dark: { background: "#101418" } });
}

function listed(over: Record<string, JsonValue> = {}): JsonValue {
  return { repo: "sam/my-day", sha: NEW, path: "collie-theme.json", text: text("my-day"), ...over };
}

const LATER = "2026-11-09T06:00:00Z";
const EARLIER = "2026-11-08T06:00:00Z";

describe("checkForUpdate", () => {
  it("offers the newer commit of the same file in a list made after the install", () => {
    const check = checkForUpdate(ORIGIN, { generated: LATER, themes: [listed()] }, false);
    expect(check.kind).toBe("newer");
    expect(check.kind === "newer" && check.item.entry.sha).toBe(NEW);
  });

  it("matches on repo and path, never on the id: a fork with the same id is not an update", () => {
    const fork = listed({ repo: "kim/my-day" });
    const otherFile = listed({ path: "themes/b.collie-theme.json" });
    expect(checkForUpdate(ORIGIN, { generated: LATER, themes: [fork, otherFile] }, false)).toEqual({ kind: "unlisted" });
    // And a new id at the same file is still the same file.
    const renamed = listed({ text: text("my-day-2") });
    expect(checkForUpdate(ORIGIN, { generated: LATER, themes: [renamed] }, false).kind).toBe("newer");
  });

  it("never offers a commit from a copy made before the install, which could be a downgrade", () => {
    expect(checkForUpdate(ORIGIN, { generated: EARLIER, themes: [listed()] }, false)).toEqual({ kind: "unknown" });
    expect(checkForUpdate(ORIGIN, { generated: null, themes: [listed()] }, false)).toEqual({ kind: "unknown" });
    expect(checkForUpdate(ORIGIN, { generated: "not a date", themes: [listed()] }, false)).toEqual({ kind: "unknown" });
    // After a check the host has no newer list: nothing newer is listed.
    expect(checkForUpdate(ORIGIN, { generated: EARLIER, themes: [listed()] }, true)).toEqual({ kind: "current" });
  });

  it("says current for the same commit, and unlisted when the file is gone", () => {
    expect(checkForUpdate(ORIGIN, { generated: LATER, themes: [listed({ sha: OLD })] }, false)).toEqual({ kind: "current" });
    expect(checkForUpdate(ORIGIN, { generated: LATER, themes: [] }, false)).toEqual({ kind: "unlisted" });
  });

  it("skips an entry the phone refuses, as Browse does", () => {
    const bad = listed({ text: text("harbour") });
    expect(checkForUpdate(ORIGIN, { generated: LATER, themes: [bad] }, false)).toEqual({ kind: "unlisted" });
  });
});
