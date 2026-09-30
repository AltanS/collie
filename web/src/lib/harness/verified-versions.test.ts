import { describe, expect, it } from "vitest";

import { hasJournalAdapter, JOURNAL_AGENT_NAMES } from "../journal-agents";
import { hasBlockGrammar, registeredAgents } from "./registry";
import ledgerJson from "./verified-versions.json";

// M37 spec 01 — the invariant is "every key of the ADAPTER REGISTRY has a ledger entry, and every
// entry says whether the registry has an adapter for it". The agent list is read from the registry
// itself (`registeredAgents`), not from a second hand-copied list: a hand copy here once left out
// opencode's new adapter while claiming to be the registry's own list.
const REGISTERED_AGENTS = registeredAgents();

// M41 spec 05 — the SECOND reader. Chat draws from the agent's own session log, which is a different
// registry with a different list (`bridge/journal/registry.ts`, mirrored by `lib/journal-agents.ts`
// and pinned against the bridge's own list by `bridge/journal/registry.test.ts`). An entry's
// `journal` block is the journal reader's line, and it is present exactly where that registry can
// serve the agent: an agent with one reader and not the other is ordinary, and the two versions
// drift apart because a vendor can change what it paints without changing what it writes.
const JOURNAL_AGENTS = [...JOURNAL_AGENT_NAMES];

// pi and hermes have no block grammar at all — raw mirror, one-shot send — but the ledger still owes
// them an entry: pi is installed and its version drifts too, and hermes has a journal reader.
const UNADAPTED_AGENTS = ["pi", "hermes"];

const ALLOWED_HOW = new Set(["canary", "live sweep", "capture", "unverified"]);

/** The three facts a reader's line carries. `adapter` belongs to the screen half only. */
interface ReaderLine {
  version: string;
  verified: string;
  how: string;
  evidence: string;
}

interface LedgerEntry extends ReaderLine {
  adapter: boolean;
  journal?: ReaderLine;
}

interface Ledger {
  agents: Record<string, LedgerEntry>;
}

// SAFETY: `verified-versions.json` is a checked-in, hand-authored file; this test IS the shape
// check (every registered adapter plus pi and hermes, a `journal` block for every journal adapter,
// `how` in the allowed set, plain `x.y.z` versions, ISO dates) — asserting the type here, once, is
// what the rest of the file verifies.
const ledger = ledgerJson as Ledger;

/** Every reader line in the file, named by agent and half, so one loop checks both. */
function readerLines(): [string, ReaderLine][] {
  const lines: [string, ReaderLine][] = [];
  for (const [agent, entry] of Object.entries(ledger.agents)) {
    lines.push([agent, entry]);
    if (entry.journal !== undefined) lines.push([`${agent}.journal`, entry.journal]);
  }
  return lines;
}

function entryFor(agent: string): LedgerEntry | undefined {
  return Object.hasOwn(ledger.agents, agent) ? ledger.agents[agent] : undefined;
}

describe("verified-versions ledger", () => {
  it("has an entry for every registered adapter", () => {
    for (const agent of REGISTERED_AGENTS) {
      expect(entryFor(agent), `missing ledger entry for "${agent}"`).toBeDefined();
    }
  });

  it("has an entry for pi, with adapter: false", () => {
    for (const agent of UNADAPTED_AGENTS) {
      const entry = entryFor(agent);
      expect(entry, `missing ledger entry for "${agent}"`).toBeDefined();
      expect(entry?.adapter, agent).toBe(false);
    }
  });

  it("marks every registered adapter's entry adapter: true", () => {
    expect(REGISTERED_AGENTS).toContain("opencode");
    for (const agent of REGISTERED_AGENTS) {
      expect(entryFor(agent)?.adapter, agent).toBe(true);
    }
  });

  it("says adapter: true exactly where the registry has an adapter", () => {
    for (const [agent, entry] of Object.entries(ledger.agents)) {
      expect(entry.adapter, agent).toBe(hasBlockGrammar(agent));
    }
  });

  it("uses only the allowed `how` values, on both halves", () => {
    for (const [name, line] of readerLines()) {
      expect(ALLOWED_HOW.has(line.how), `"${name}" has an unknown how: "${line.how}"`).toBe(true);
    }
  });

  it("versions are plain x.y.z and dates are ISO, on both halves", () => {
    for (const [name, line] of readerLines()) {
      expect(line.version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(line.verified, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("every reader line cites its evidence", () => {
    for (const [name, line] of readerLines()) {
      expect(line.evidence.length > 0, name).toBe(true);
    }
  });

  // ── The journal reader's half (M41 spec 05) ───────────────────────────────
  it("has an entry with a journal block for every agent the journal registry serves", () => {
    for (const agent of JOURNAL_AGENTS) {
      const entry = entryFor(agent);
      expect(entry, `missing ledger entry for "${agent}", which has a journal adapter`).toBeDefined();
      expect(entry?.journal, `"${agent}" has a journal adapter and no journal block`).toBeDefined();
    }
  });

  it("carries a journal block exactly where the journal registry can serve the agent", () => {
    for (const [agent, entry] of Object.entries(ledger.agents)) {
      expect(entry.journal !== undefined, agent).toBe(hasJournalAdapter(agent));
    }
  });

  it("the two readers are recorded apart, never folded into one line", () => {
    // Claude is the case that forces it: the screen reader was verified by a canary run on 2.1.284
    // and the journal reader by the type sweep of M41/05. One date could not have said both.
    const claude = entryFor("claude");
    expect(claude?.journal?.evidence).not.toBe(claude?.evidence);
    // A `journal` block never carries `adapter`: its presence IS that fact.
    for (const [agent, entry] of Object.entries(ledger.agents)) {
      expect(Object.hasOwn(entry.journal ?? {}, "adapter"), agent).toBe(false);
    }
  });
});
