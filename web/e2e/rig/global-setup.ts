// Bring the rig up before the first case: the scratch Herdr, the bridge from this checkout, one
// paired device. Names the run, so every case writes into the same results folder.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { STUB_HARNESSES, TIERS_ENV, planTiers, readVersions, tierLine } from "./replay/tier";
import { P, memGuard, readRun } from "./rig-lib";

const WEB = resolve(import.meta.dirname, "..", "..");

/** Name the run and bring one leg's rig up: `up` for the solo leg, `up --crew` for the crew leg (crew-setup.ts). */
export async function startRun(crew: boolean): Promise<void> {
  if (!existsSync(join(WEB, "dist", "index.html"))) {
    throw new Error("no web/dist in this checkout: run `bun run build` in web/ first (the bridge serves that bundle)");
  }
  memGuard(crew ? "the crew rig" : "the rig");
  const id = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  process.env.COLLIE_RIG_RUN_ID = id;
  mkdirSync(join(P.results, id), { recursive: true });
  // The model tier of pi and omp (M67, replay/tier.ts), chosen once, before the rig starts: the daemon's
  // stub serves it and the workers start the harnesses for it. COLLIE_RIG_MODEL=replay with no cassette
  // for a harness version stops the run here, before anything starts or spends.
  const kept = readRun();
  const reuse = kept?.ready === true && process.env.COLLIE_RIG_REUSE === "1";
  // The counters of an earlier run must never reach this run's summary: a run that stops before its stub
  // starts (a replay with no cassette) would print them. A reused rig keeps its daemon, which answers live.
  if (!reuse) rmSync(P.stubStats, { force: true });
  const tiers = reuse && kept.stub !== undefined ? kept.stub.tiers : planTiers(crew ? "crew" : "solo", process.env, readVersions());
  process.env[TIERS_ENV] = JSON.stringify(tiers);
  const lines = STUB_HARNESSES.flatMap((h) => {
    const plan = tiers[h];
    return plan === undefined ? [] : [tierLine(plan)];
  });
  console.log(`model tiers: ${lines.join("; ")}; claude live (its own login)`);
  if (reuse) return;
  execFileSync("bun", [join(WEB, "e2e", "rig", "rig.ts"), "up", ...(crew ? ["--crew"] : [])], { cwd: WEB, stdio: "inherit", timeout: crew ? 300_000 : 120_000 });
}

export default async function globalSetup(): Promise<void> {
  await startRun(false);
}
