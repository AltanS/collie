// Bring the rig up before the first case: the scratch Herdr, the bridge from this checkout, one
// paired device. Names the run, so every case writes into the same results folder.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
  if (readRun()?.ready === true && process.env.COLLIE_RIG_REUSE === "1") return;
  execFileSync("bun", [join(WEB, "e2e", "rig", "rig.ts"), "up", ...(crew ? ["--crew"] : [])], { cwd: WEB, stdio: "inherit", timeout: crew ? 300_000 : 120_000 });
}

export default async function globalSetup(): Promise<void> {
  await startRun(false);
}
