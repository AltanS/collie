#!/usr/bin/env bun
// THE LIVE LAYER of mux conformance — the same checks, against a REAL multiplexer.
//
//   bun scripts/mux-probe.ts                 # every registered adapter
//   bun scripts/mux-probe.ts --mux herdr     # just one
//   COLLIE_MUX_ENDPOINT_TMUX=/tmp/tmux-1000/default bun scripts/mux-probe.ts --mux tmux
//
// WHY IT EXISTS SEPARATELY FROM `bun test bridge/mux`. The pure layer drives every adapter through a
// fake transport, which is what lets it run with no multiplexer installed — and is also exactly what
// it cannot prove: real escape sequences, real id shapes, real resize behaviour, real timing. Memory
// `collie-live-probe-harness` records the trap this avoids — a "live" probe that is really talking to
// a fixture proves less than nothing, because it reads as evidence.
//
// IT ONLY EVER RUNS {@link MUX_READ_ONLY_CHECKS}, and that is not a limitation to lift later. A live
// pane is somebody's work session: a probe that typed into one, renamed one or closed one would be a
// tool nobody could safely run. Calls to UNDECLARED capabilities are in the read-only set because
// they refuse before they touch anything — which is the property being probed.
//
// IT SKIPS LOUDLY. An adapter whose multiplexer is not on this box prints why, in full, and does not
// count as a pass. The exit code is non-zero only when a REACHABLE multiplexer failed a check —
// "not installed" is an answer, not a failure.

import { loadConfig } from "../bridge/config.ts";
import { MUX_READ_ONLY_CHECKS } from "../bridge/mux/conformance.ts";
import { HERDR_DIAL_MODE_OPTION } from "../bridge/mux/herdr/adapter.ts";
import {
  buildMuxRegistry,
  createMux,
  DEFAULT_MUX,
  MUX_ADAPTERS,
  muxEndpointVar,
  type MuxAdapterFactory,
} from "../bridge/mux/registry.ts";
import { TMUX_BINARY_OPTION } from "../bridge/mux/tmux/adapter.ts";

/** Per-call budget for a probe. Generous — a real multiplexer under load is not a failure. */
const TIMEOUT_MS = 10_000;

/** The env var carrying an adapter's live endpoint. One rule, shared with `bridge/config.ts`. */
const endpointVar = muxEndpointVar;

/**
 * Where this adapter's multiplexer lives.
 *
 * The env var wins, then — for the DEFAULT adapter only — Collie's own configured socket path, so
 * running the probe on the deployment host needs no arguments at all. Anything else falls to the
 * empty string, which every adapter reads as "your own default target": tmux's default server, and
 * for an adapter that has no such thing, a `reachable()` of false and a loud skip below.
 */
function endpointFor(factory: MuxAdapterFactory, configured: string): string {
  const fromEnv = process.env[endpointVar(factory.mux)];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return factory.mux === DEFAULT_MUX ? configured : "";
}

let skipped = 0;

function skip(mux: string, why: string): void {
  skipped += 1;
  console.log(`\n╭─ SKIPPED — ${mux}`);
  console.log(`│  ${why}`);
  console.log("╰─ nothing was probed for this adapter; it is NOT a pass.\n");
}

async function probe(factory: MuxAdapterFactory, endpoint: string, dialMode: string): Promise<number> {
  const adapter = createMux(buildMuxRegistry(), factory.mux, {
    endpoint,
    timeoutMs: TIMEOUT_MS,
    // Every adapter's private knobs at once — each one reads its own key and ignores the rest, which
    // is exactly what `MuxTarget.options` being opaque to the registry buys.
    options: { [HERDR_DIAL_MODE_OPTION]: dialMode, [TMUX_BINARY_OPTION]: process.env.COLLIE_TMUX_BIN ?? "" },
  });

  // Reachability first and separately: an unreachable multiplexer is "not here", not "broken", and
  // every check below would fail for the same uninformative reason.
  let reachable = false;
  try {
    reachable = await adapter.reachable();
  } catch (err) {
    skip(factory.mux, `dialling ${endpoint} threw: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  if (!reachable) {
    skip(factory.mux, `nothing is answering at ${endpoint} — start the multiplexer, or point ${endpointVar(factory.mux)} at it`);
    return 0;
  }

  console.log(`\n── ${factory.mux} @ ${endpoint} — live, running ${MUX_READ_ONLY_CHECKS.length} read-only checks`);
  let failed = 0;
  for (const check of MUX_READ_ONLY_CHECKS) {
    let problems: string[];
    try {
      problems = await check.run(adapter);
    } catch (err) {
      problems = [`the check itself threw: ${err instanceof Error ? err.message : String(err)}`];
    }
    if (problems.length === 0) {
      console.log(`   ✓ ${check.name}`);
      continue;
    }
    failed += 1;
    console.log(`   ✗ ${check.name}`);
    for (const problem of problems) console.log(`       · ${problem}`);
  }
  return failed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = args.includes("--mux") ? args[args.indexOf("--mux") + 1] : undefined;
  const cfg = loadConfig();
  const factories = MUX_ADAPTERS.filter((factory) => only === undefined || factory.mux === only);

  if (factories.length === 0) {
    console.error(`no registered adapter named "${String(only)}" — this build drives: ${MUX_ADAPTERS.map((f) => f.mux).join(", ")}`);
    process.exit(2);
  }

  console.log("collie mux probe — read-only conformance against whatever is actually running here.");
  console.log("Writes (typing, rename, close) are NOT probed by design: a live pane is someone's session.");

  let failed = 0;
  for (const factory of factories) {
    failed += await probe(factory, endpointFor(factory, cfg.socketPath), cfg.dialMode ?? "auto");
  }

  const probed = factories.length - skipped;
  if (failed > 0) console.log(`\n${String(failed)} check(s) failed across ${String(probed)} probed adapter(s).\n`);
  else if (probed === 0) console.log("\nNOTHING WAS PROBED — every adapter skipped above. This run proves nothing.\n");
  else console.log(`\nall ${String(probed)} probed adapter(s) conform (${String(skipped)} skipped).\n`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
