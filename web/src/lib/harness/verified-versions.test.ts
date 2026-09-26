import { describe, expect, it } from "vitest";

import { agyAdapter, antigravityAdapter } from "./agy";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { grokAdapter } from "./grok";
import { museAdapter } from "./muse";
import { ompAdapter } from "./omp";
import ledgerJson from "./verified-versions.json";

// M37 spec 01 — the invariant is "every key of the ADAPTER REGISTRY has a ledger entry; so do
// opencode and pi (adapter: false)". `registry.ts` deliberately exports only `adapterFor` /
// `hasBlockGrammar`, never its private `ADAPTERS` map, so this reads the registered agent names
// straight off the same adapter modules `registry.ts` itself imports — the registry's own source
// list, not a second hand-copied one. A removed or renamed adapter fails here exactly as it would
// fail `registry.test.ts`'s `hasBlockGrammar` pins.
const REGISTERED_AGENTS = [
  claudeAdapter,
  codexAdapter,
  grokAdapter,
  ompAdapter,
  agyAdapter,
  antigravityAdapter,
  museAdapter,
].map((a) => a.agent);

// opencode and pi have no adapter at all — raw mirror, one-shot send — but the ledger still owes
// them an entry (Ground Truth: both are installed and their version drifts too).
const UNADAPTED_AGENTS = ["opencode", "pi"];

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
// check (every registered adapter plus opencode/pi, `how` in the allowed set, plain `x.y.z`
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

  it("has an entry for opencode and pi, with adapter: false", () => {
    for (const agent of UNADAPTED_AGENTS) {
      const entry = entryFor(agent);
      expect(entry, `missing ledger entry for "${agent}"`).toBeDefined();
      expect(entry?.adapter, agent).toBe(false);
    }
  });

  it("marks every registered adapter's entry adapter: true", () => {
    for (const agent of REGISTERED_AGENTS) {
      expect(entryFor(agent)?.adapter, agent).toBe(true);
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
