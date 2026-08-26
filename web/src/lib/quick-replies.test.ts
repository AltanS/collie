import { quickRepliesFor } from "./quick-replies";

// The catalog is data, but the LOOKUP carries the policy — that a shell is not an agent, and that an
// unknown/hostile agent string can't crash the dock.
describe("quickRepliesFor", () => {
  it("gives every LLM harness the same agent set", () => {
    const claude = quickRepliesFor("claude", false);
    for (const agent of ["codex", "pi", "opencode"]) {
      expect(quickRepliesFor(agent, false)).toEqual(claude);
    }
    expect(claude.flatMap((g) => g.items)).toContain("continue");
  });

  it("gives a shell y/n and NOT the agent phrases", () => {
    const shell = quickRepliesFor("shell", true);
    const items = shell.flatMap((g) => g.items);
    expect(items).toEqual(["y", "n"]);
    // "commit and push" at a bare bash prompt is nonsense; "skip" is meaningless there.
    expect(items).not.toContain("commit and push");
    expect(items).not.toContain("skip");
  });

  it("isShell wins over the agent string — the caller knows the pane kind, the string may drift", () => {
    expect(quickRepliesFor("claude", true)).toEqual(quickRepliesFor("shell", true));
  });

  it("falls back to the agent set for an unknown or absent agent", () => {
    const fallback = quickRepliesFor("claude", false);
    expect(quickRepliesFor("some-future-harness", false)).toEqual(fallback);
    expect(quickRepliesFor(undefined, false)).toEqual(fallback);
    expect(quickRepliesFor(null, false)).toEqual(fallback);
  });

  // Object.hasOwn, not a truthy index — an inherited prototype key must not resolve to a non-array
  // and blow up the render path. Same hardening adapterFor() applies.
  it("does not resolve inherited Object.prototype keys to a non-catalog value", () => {
    const fallback = quickRepliesFor("claude", false);
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const got = quickRepliesFor(key, false);
      expect(Array.isArray(got)).toBe(true);
      expect(got).toEqual(fallback);
    }
  });
});

// The operator's own groups (their `quick-replies.toml`, ADR 0018): on a pane their rows address,
// those rows ARE the dock.
describe("quickRepliesFor with operator rows", () => {
  const german = [{ title: "bestätigen", items: ["ja", "nein"] }];

  it("replaces the shipped groups on a pane the rows address", () => {
    expect(quickRepliesFor("claude", false, german)).toEqual(german);
  });

  it("leaves a pane untouched when no row addresses it", () => {
    const scoped = [{ agent: "codex", title: "bestätigen", items: ["ja"] }];
    expect(quickRepliesFor("claude", false, scoped)).toEqual(quickRepliesFor("claude", false));
    expect(quickRepliesFor("codex", false, scoped)).toEqual([
      { title: "bestätigen", items: ["ja"] },
    ]);
  });

  it("reaches a shell too — an operator's language is not an agent-only choice", () => {
    expect(quickRepliesFor("shell", true, german)).toEqual(german);
    const shellOnly = [{ agent: "shell", title: "confirm", items: ["j", "n"] }];
    expect(quickRepliesFor("shell", true, shellOnly)).toEqual([
      { title: "confirm", items: ["j", "n"] },
    ]);
    // ...and a shell-scoped row must not leak onto an agent pane.
    expect(quickRepliesFor("claude", false, shellOnly)).toEqual(quickRepliesFor("claude", false));
  });

  it("an empty list is exactly the shipped behaviour", () => {
    expect(quickRepliesFor("claude", false, [])).toEqual(quickRepliesFor("claude", false));
    expect(quickRepliesFor("shell", true, [])).toEqual(quickRepliesFor("shell", true));
  });

  it("a narrower row wins over an unscoped one, as everywhere else", () => {
    const mixed = [
      { title: "confirm", items: ["global"] },
      { agent: "claude", title: "confirm", items: ["scoped"] },
    ];
    expect(quickRepliesFor("claude", false, mixed)).toEqual([
      { title: "confirm", items: ["scoped"] },
    ]);
  });
});
