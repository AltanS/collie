import { describe, expect, test } from "bun:test";

import {
  adapterFor,
  AGENT_ALIASES,
  buildJournalRegistry,
  DISCOVERS_OWN_SESSIONS,
  DRAWS_IMAGES_OFF_GRID,
  journalAgents,
  KNOWN_HARNESS_NAMES,
  REPORTS_SESSION_ON_FIRST_PROMPT,
} from "./registry.ts";

// The registry is the SINGLE decision site for "which agents have a journal". These tests pin the
// two properties that keep it from rotting: keys come from the adapters themselves, and a hostile
// agent name can't resolve to something that isn't an adapter.

const roots = {
  claude: ["/c"],
  codex: ["/x"],
  pi: ["/p"],
  opencode: ["/o"],
  grok: ["/g"],
  hermes: ["/h"],
  muse: ["/m"],
};

describe("buildJournalRegistry", () => {
  test("serves the seven verified harnesses", () => {
    expect(journalAgents(buildJournalRegistry(roots))).toEqual([
      "claude",
      "codex",
      "grok",
      "hermes",
      "muse",
      "opencode",
      "pi",
    ]);
  });

  test("every key IS its adapter's own agent string — the map can't drift from the adapters", () => {
    const registry = buildJournalRegistry(roots);
    for (const [key, adapter] of Object.entries(registry)) expect(adapter.agent).toBe(key);
  });
});

describe("sendQueuedNow", () => {
  test("Claude Code declares Ctrl+Enter and no other harness declares anything", async () => {
    const { canonicalMuxKey } = await import("../mux/keys.ts");
    const registry = buildJournalRegistry(roots);
    expect(registry.claude!.sendQueuedNow).toEqual(["ctrl+Enter"]);
    // A declared key must be a valid neutral spelling, in its canonical form.
    for (const key of registry.claude!.sendQueuedNow ?? []) expect(canonicalMuxKey(key)).toBe(key);
    for (const [agent, adapter] of Object.entries(registry)) {
      if (agent !== "claude") expect(adapter.sendQueuedNow).toBeUndefined();
    }
  });
});

describe("adapterFor", () => {
  const registry = buildJournalRegistry(roots);

  test.each(["claude", "codex", "pi", "opencode", "grok", "hermes", "muse"])("resolves %s", (agent) => {
    expect(adapterFor(registry, agent)?.agent).toBe(agent);
  });

  // An alias is a second NAME for one adapter, never a sixth adapter — derived from the map so a
  // new pair is covered the day it is added.
  test.each(Object.entries(AGENT_ALIASES))("resolves the %s alias to %s", (alias, canonical) => {
    expect(adapterFor(registry, alias)?.agent).toBe(canonical);
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
// what makes "by hand" safe: adding a seventh adapter above fails here until the frontend follows.
describe("the frontend mirror", () => {
  test("web/src/lib/journal-agents.ts names exactly these agents", async () => {
    const source = await Bun.file(new URL("../../web/src/lib/journal-agents.ts", import.meta.url)).text();
    // The `new Set([…])` literal alone — the prose around it names agents too ("claude-code").
    const literal = /new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? "";
    const listed = [...literal.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
    // DERIVED, never patched by hand: the browser's set is the adapters plus every alias name, so
    // adding either on this side fails here until the frontend follows.
    const expected = [...KNOWN_HARNESS_NAMES, ...Object.keys(AGENT_ALIASES)];
    expect(listed.toSorted()).toEqual(expected.toSorted());
  });

  // Issue #294: the phone's note and `collie doctor` must agree on which agents report their session
  // only on the first prompt, or one of them blames the integration for a pane that has had no turn.
  test("web/src/lib/journal-agents.ts names the same first-prompt agents", async () => {
    const source = await Bun.file(new URL("../../web/src/lib/journal-agents.ts", import.meta.url)).text();
    const literal = /const FIRST_PROMPT_AGENTS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(source)?.[1];
    expect(literal).toBeDefined();
    const listed = [...(literal ?? "").matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
    expect(listed.toSorted()).toEqual([...REPORTS_SESSION_ON_FIRST_PROMPT].toSorted());
    // Every one of them is an agent this build reads a journal for; the fact means nothing otherwise.
    for (const agent of REPORTS_SESSION_ON_FIRST_PROMPT) expect(KNOWN_HARNESS_NAMES).toContain(agent);
  });

  // #292: the phone reads the newest turn's picture after each finished turn only for these agents.
  // A drift either way is a silent failure: a missing name loses that agent's pictures, an extra one
  // costs every finished turn a history read for nothing.
  test("web/src/lib/journal-agents.ts names the same off-grid image agents", async () => {
    const source = await Bun.file(new URL("../../web/src/lib/journal-agents.ts", import.meta.url)).text();
    const literal = /const OFF_GRID_IMAGE_AGENTS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(source)?.[1];
    expect(literal).toBeDefined();
    const listed = [...(literal ?? "").matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
    expect(listed.toSorted()).toEqual([...DRAWS_IMAGES_OFF_GRID].toSorted());
    // Each one has a journal to read the picture out of, by its own name or as an alias.
    const registry = buildJournalRegistry(roots);
    for (const agent of DRAWS_IMAGES_OFF_GRID) expect(adapterFor(registry, agent)).toBeDefined();
  });
});

// `DISCOVERS_OWN_SESSIONS` names exactly the adapters that implement `discover` — derived from the
// adapters themselves, so neither side can drift. `collie doctor` reads the list; the routes read
// the capability.
test("DISCOVERS_OWN_SESSIONS names exactly the discovering adapters", () => {
  const registry = buildJournalRegistry(roots);
  const discovering = Object.entries(registry)
    .filter(([, adapter]) => adapter.discover !== undefined)
    .map(([agent]) => agent)
    .toSorted();
  expect([...DISCOVERS_OWN_SESSIONS].toSorted()).toEqual(discovering);
});
