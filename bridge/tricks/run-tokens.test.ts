import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { RunTokens } from "./run-tokens.ts";

// The run tokens of the local API (M105 spec 05, decisions 1 and 2): the table, its compare and each death.

describe("the run tokens", () => {
  test("a token is 43 base64url characters, fresh each time, and resolves to its trick and level", () => {
    const tokens = new RunTokens();
    const a = tokens.mint("lodge", "see", "run-1");
    const b = tokens.mint("workshop", "read", "run-2");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(b).not.toBe(a);
    expect(tokens.resolve(a)).toMatchObject({ trickId: "lodge", level: "see" });
    expect(tokens.resolve(b)).toMatchObject({ trickId: "workshop", level: "read" });
  });

  test("an unknown token, one of another length or alphabet, and a near miss resolve to nothing", () => {
    const tokens = new RunTokens();
    const a = tokens.mint("lodge", "see", "run-1");
    const flipped = `${a.slice(0, 42)}${a.endsWith("A") ? "B" : "A"}`;
    for (const other of ["", "x", "A".repeat(43), a.slice(0, 42), `${a}A`, `${a.slice(0, 42)}=`, flipped, a.toUpperCase() === a ? a.toLowerCase() : a.toUpperCase()]) {
      expect({ other, held: tokens.resolve(other) }).toEqual({ other, held: null });
    }
  });

  test("the run ends: its token dies, and the other run's stays", () => {
    const tokens = new RunTokens();
    const a = tokens.mint("lodge", "see", "run-1");
    const b = tokens.mint("lodge", "see", "run-2");
    tokens.end("run-1");
    expect(tokens.resolve(a)).toBeNull();
    expect(tokens.resolve(b)).not.toBeNull();
    // Ending a run twice, or one that has no token, is nothing.
    tokens.end("run-1");
    tokens.end("run-9");
    expect(tokens.size()).toBe(1);
  });

  test("at most one live token per run: a second mint for the same run ends the first", () => {
    const tokens = new RunTokens();
    const first = tokens.mint("lodge", "see", "run-1");
    const second = tokens.mint("lodge", "see", "run-1");
    expect(tokens.resolve(first)).toBeNull();
    expect(tokens.resolve(second)).not.toBeNull();
    expect(tokens.size()).toBe(1);
  });

  test("the trick is switched off or removed: every token of its runs dies, another trick's stays", () => {
    const tokens = new RunTokens();
    const a = tokens.mint("lodge", "see", "run-1");
    const b = tokens.mint("lodge", "read", "run-2");
    const c = tokens.mint("workshop", "see", "run-3");
    tokens.endTrick("lodge");
    expect([tokens.resolve(a), tokens.resolve(b)]).toEqual([null, null]);
    expect(tokens.resolve(c)).toMatchObject({ trickId: "workshop", level: "see" });
  });

  test("tricks off, or the bridge stops: every token dies", () => {
    const tokens = new RunTokens();
    const a = tokens.mint("lodge", "see", "run-1");
    const c = tokens.mint("workshop", "see", "run-3");
    tokens.clear();
    expect([tokens.resolve(a), tokens.resolve(c), tokens.size()]).toEqual([null, null, 0]);
  });

  test("resolve answers the token's hash hex as its key, never the token; alive asks by that key", () => {
    const tokens = new RunTokens();
    const a = tokens.mint("lodge", "see", "run-1");
    const key = tokens.resolve(a)?.key ?? "";
    expect(key).toBe(createHash("sha256").update(a, "utf8").digest("hex"));
    expect(key).not.toContain(a);
    expect(tokens.alive(key)).toBe(true);
    tokens.end("run-1");
    expect(tokens.alive(key)).toBe(false);
    expect(tokens.alive("not-a-key")).toBe(false);
  });

  test("every death is told to the hook once, with the token's key: run end, a second mint, the trick, clear", () => {
    const ended: string[] = [];
    const tokens = new RunTokens((key) => ended.push(key));
    const keyOf = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
    const a = tokens.mint("lodge", "see", "run-1");
    tokens.end("run-1");
    tokens.end("run-1");
    expect(ended).toEqual([keyOf(a)]);
    const b = tokens.mint("lodge", "see", "run-2");
    const b2 = tokens.mint("lodge", "see", "run-2");
    expect(ended).toEqual([keyOf(a), keyOf(b)]);
    const c = tokens.mint("workshop", "read", "run-3");
    tokens.endTrick("lodge");
    expect(ended).toEqual([keyOf(a), keyOf(b), keyOf(b2)]);
    tokens.clear();
    expect(ended).toEqual([keyOf(a), keyOf(b), keyOf(b2), keyOf(c)]);
  });
});
