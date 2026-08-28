import { describe, expect, test } from "bun:test";

import { adapterFor, buildJournalRegistry, journalAgents, KNOWN_HARNESS_NAMES } from "./registry.ts";

// The registry is the SINGLE decision site for "which agents have a journal". These tests pin the
// two properties that keep it from rotting: keys come from the adapters themselves, and a hostile
// agent name can't resolve to something that isn't an adapter.

const roots = { claude: ["/c"], codex: ["/x"], pi: ["/p"], opencode: ["/o"], grok: ["/g"] };

describe("buildJournalRegistry", () => {
  test("serves the five verified harnesses", () => {
    expect(journalAgents(buildJournalRegistry(roots))).toEqual([
      "claude",
      "codex",
      "grok",
      "opencode",
      "pi",
    ]);
  });

  test("every key IS its adapter's own agent string — the map can't drift from the adapters", () => {
    const registry = buildJournalRegistry(roots);
    for (const [key, adapter] of Object.entries(registry)) expect(adapter.agent).toBe(key);
  });
});

describe("adapterFor", () => {
  const registry = buildJournalRegistry(roots);

  test.each(["claude", "codex", "pi", "opencode", "grok"])("resolves %s", (agent) => {
    expect(adapterFor(registry, agent)?.agent).toBe(agent);
  });

  test("an agent with no journal is undefined, not a throw", () => {
    expect(adapterFor(registry, "aider")).toBeUndefined();
    expect(adapterFor(registry, undefined)).toBeUndefined();
  });

  // The agent string comes from Herdr, but it ORIGINATES in an agent's own report — so an inherited
  // Object.prototype key must not resolve to a function masquerading as an adapter.
  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "%s does not resolve to a non-adapter",
    (key) => {
      expect(adapterFor(registry, key)).toBeUndefined();
    },
  );
});

// ── The frontend's mirror of this list (issue #137) ──────────────────────────
//
// `web/src/lib/journal-agents.ts` carries the same names, because the browser must tell an agent
// that COULD have a transcript (and reported no session — the case an operator can fix) from one
// that never could. The list is not on the wire, so the mirror is kept by hand — and this test is
// what makes "by hand" safe: adding a sixth adapter above fails here until the frontend follows.
describe("the frontend mirror", () => {
  test("web/src/lib/journal-agents.ts names exactly these agents", async () => {
    const source = await Bun.file(new URL("../../web/src/lib/journal-agents.ts", import.meta.url)).text();
    // The `new Set([…])` literal alone — the prose around it names agents too ("claude-code").
    const literal = /new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? "";
    const listed = [...literal.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
    expect(listed.toSorted()).toEqual([...KNOWN_HARNESS_NAMES].toSorted());
  });
});
