import { describe, expect, it } from "vitest";

import { hasBlockGrammar, registeredAgents } from "./registry";
import ledgerJson from "./verified-versions.json";

// M37 spec 01 — the invariant is "every key of the ADAPTER REGISTRY has a ledger entry, and every
// entry says whether the registry has an adapter for it". The agent list is read from the registry
// itself (`registeredAgents`), not from a second hand-copied list: a hand copy here once left out
// opencode's new adapter while claiming to be the registry's own list.
const REGISTERED_AGENTS = registeredAgents();

// pi has no adapter at all — raw mirror, one-shot send — but the ledger still owes it an entry
// (Ground Truth: it is installed and its version drifts too).
const UNADAPTED_AGENTS = ["pi"];

const ALLOWED_HOW = new Set(["canary", "live sweep", "capture", "unverified"]);

interface LedgerEntry {
  version: string;
  verified: string;
  how: string;
  adapter: boolean;
  evidence: string;
}

interface Ledger {
  agents: Record<string, LedgerEntry>;
}

// SAFETY: `verified-versions.json` is a checked-in, hand-authored file; this test IS the shape
// check (every registered adapter plus pi, `how` in the allowed set, plain `x.y.z`
// versions, ISO dates) — asserting the type here, once, is what the rest of the file verifies.
const ledger = ledgerJson as Ledger;

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

  it("uses only the allowed `how` values", () => {
    for (const [agent, entry] of Object.entries(ledger.agents)) {
      expect(ALLOWED_HOW.has(entry.how), `"${agent}" has an unknown how: "${entry.how}"`).toBe(true);
    }
  });

  it("versions are plain x.y.z and dates are ISO", () => {
    for (const [agent, entry] of Object.entries(ledger.agents)) {
      expect(entry.version, agent).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.verified, agent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("every entry cites its evidence", () => {
    for (const [agent, entry] of Object.entries(ledger.agents)) {
      expect(entry.evidence.length > 0, agent).toBe(true);
    }
  });
});
