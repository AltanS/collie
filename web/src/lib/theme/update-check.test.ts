import { describe, expect, it } from "vitest";

import type { JsonValue } from "../json";
import { checkForUpdate } from "./update-check";

const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const AT = Date.parse("2026-11-08T10:00:00Z");
const FETCHED = "2026-11-08T09:00:00Z";
const ORIGIN = { kind: "registry", repo: "sam/my-day", path: "collie-theme.json", sha: OLD, at: AT } as const;

function text(id: string): string {
  return JSON.stringify({ version: 1, id, name: id, light: { background: "#fdfaf3" }, dark: { background: "#101418" } });
}

function listed(over: Record<string, JsonValue> = {}): JsonValue {
  return { repo: "sam/my-day", sha: NEW, path: "collie-theme.json", text: text("my-day"), ...over };
}

/** The host's copy, fetched at FETCHED: a time before the install, which must not matter. */
function copy(themes: JsonValue[]) {
  return { fetchedAt: FETCHED, themes };
}

describe("checkForUpdate", () => {
  it("offers another commit of the same file, whatever the clocks say", () => {
    const check = checkForUpdate(ORIGIN, copy([listed()]));
    expect(check.kind).toBe("newer");
    expect(check.kind === "newer" && check.item.entry.sha).toBe(NEW);
  });

  it("matches on repo and path, never on the id: a fork with the same id is not an update", () => {
    const fork = listed({ repo: "kim/my-day" });
    const otherFile = listed({ path: "themes/b.collie-theme.json" });
    expect(checkForUpdate(ORIGIN, copy([fork, otherFile]))).toEqual({ kind: "unlisted" });
    // And a new id at the same file is still the same file.
    const renamed = listed({ text: text("my-day-2") });
    expect(checkForUpdate(ORIGIN, copy([renamed])).kind).toBe("newer");
  });

  it("matches the repo without regard to case, as GitHub does, and the path exactly", () => {
    expect(checkForUpdate(ORIGIN, copy([listed({ repo: "Sam/My-Day" })])).kind).toBe("newer");
    expect(checkForUpdate(ORIGIN, copy([listed({ repo: "SAM/MY-DAY", sha: OLD })]))).toEqual({ kind: "current" });
    expect(checkForUpdate(ORIGIN, copy([listed({ path: "Collie-Theme.json" })]))).toEqual({ kind: "unlisted" });
  });

  it("says current for the same commit, and unlisted when the file is gone", () => {
    expect(checkForUpdate(ORIGIN, copy([listed({ sha: OLD })]))).toEqual({ kind: "current" });
    expect(checkForUpdate(ORIGIN, copy([]))).toEqual({ kind: "unlisted" });
  });

  it("says unknown while the host has no copy, and only then", () => {
    expect(checkForUpdate(ORIGIN, { fetchedAt: null, themes: [] })).toEqual({ kind: "unknown" });
    expect(checkForUpdate(ORIGIN, { fetchedAt: null, themes: [listed()] })).toEqual({ kind: "unknown" });
  });

  it("says needs-newer, never unlisted, for the same file at a version this Collie cannot read", () => {
    const future = JSON.stringify({ version: 99, id: "my-day", name: "My day", light: { background: "#fdfaf3" } });
    expect(checkForUpdate(ORIGIN, copy([listed({ text: future })]))).toEqual({ kind: "needs-newer" });
    // A readable entry for the same file wins over an unreadable one, in either order.
    expect(checkForUpdate(ORIGIN, copy([listed({ text: future }), listed()])).kind).toBe("newer");
    // An unreadable entry of another file says nothing about this one.
    expect(checkForUpdate(ORIGIN, copy([listed({ repo: "kim/my-day", text: future })]))).toEqual({ kind: "unlisted" });
  });

  it("reads any refused entry at the same file as needs-newer: the file is listed, not for this Collie", () => {
    const bad = listed({ text: text("harbour") });
    expect(checkForUpdate(ORIGIN, copy([bad]))).toEqual({ kind: "needs-newer" });
  });
});
