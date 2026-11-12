import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERDICTS, type Row } from "../../src/playground/hitbox/data";
import { checkAgainstKnown, nextKnown, type KnownTarget } from "../../src/playground/hitbox/known";

// THE CENSUS AS A CHECK. Builds the app, walks every screen at both phone sizes (e2e/hitbox/census.run.ts),
// and FAILS when a tap target is small or covered and is not on the written list of known ones
// (`known.json` beside this file). A person reads a failure and either fixes the target or, deciding it
// stays, adds it to the list with `--update` and a reason. It is NOT in a CI workflow: the lead decides that.
//
//     cd web && bun run hitbox:check             # build, walk, compare; exit 1 on a new one
//     cd web && bun run hitbox:check --no-build  # reuse web/dist
//     cd web && bun run hitbox:check --update    # rewrite known.json to what is found now (read the diff)
//     cd web && bun run hitbox:check --from=/tmp/census.json   # compare a census already written, walk nothing
//
// `HITBOX_KNOWN=<path>` reads another list than `known.json`: how the check itself is tried with a target removed.
//
// The census writes into a temp file (`HITBOX_OUT`), never into the playground's fixture, so a check leaves
// the tree as it found it. About 4 minutes. `HITBOX_PORT` picks the preview's port (default 5301).

const WEB = fileURLToPath(new URL("../../", import.meta.url));
const KNOWN = process.env.HITBOX_KNOWN ?? fileURLToPath(new URL("./known.json", import.meta.url));
const args = new Set(process.argv.slice(2));

function run(cmd: string, argv: string[], env: { [key: string]: string } = {}): void {
  const r = spawnSync(cmd, argv, { cwd: WEB, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`hitbox:check: \`${cmd} ${argv.join(" ")}\` failed (${String(r.status)})`);
    process.exit(2);
  }
}

const fromArg = process.argv.slice(2).find((a) => a.startsWith("--from="));
const out = fromArg === undefined ? join(mkdtempSync(join(tmpdir(), "hitbox-check-")), "census.json") : fromArg.slice("--from=".length);
if (fromArg === undefined) {
  if (!args.has("--no-build")) run("bunx", ["vite", "build"]);
  run("bunx", ["playwright", "test", "-c", "e2e/hitbox/playwright.config.ts", "census"], { HITBOX_OUT: out });
}

interface Census {
  rows: (Omit<Row, "verdict"> & { verdict: string })[];
  notReached: { screen: string; size: string; why: string }[];
}
const census: Census = JSON.parse(readFileSync(out, "utf8"));
const rows: Row[] = census.rows.map((r) => ({ ...r, verdict: VERDICTS.find((v) => v === r.verdict) ?? "ok" }));
const known: KnownTarget[] = existsSync(KNOWN) ? JSON.parse(readFileSync(KNOWN, "utf8")) : [];

if (args.has("--update")) {
  const next = nextKnown(rows, known);
  writeFileSync(KNOWN, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`hitbox:check: wrote ${String(next.length)} known targets to e2e/hitbox/known.json`);
  process.exit(0);
}

// A screen the walk could not reach is a hole in the check, not a pass.
if (census.notReached.length > 0) {
  console.error(`hitbox:check: ${String(census.notReached.length)} screens not reached:`);
  for (const n of census.notReached) console.error(`  ${n.screen} at ${n.size}: ${n.why}`);
  process.exit(1);
}

const result = checkAgainstKnown(rows, known);
console.log(`hitbox:check: ${String(rows.length)} readings, ${String(result.seen)} small or covered targets, ${String(known.length)} known`);
if (result.fixed.length > 0) {
  console.log(`\n${String(result.fixed.length)} known targets are no longer small or covered. Drop them with --update:`);
  for (const t of result.fixed) console.log(`  ${t.screen}  ${t.name}  ${t.selector}`);
}
if (result.fresh.length > 0) {
  console.error(`\n${String(result.fresh.length)} NEW small or covered targets, worst first:`);
  for (const r of result.fresh) console.error(`  ${r.verdict.padEnd(7)} ${r.screen}  "${r.name}"  box ${r.box.join("x")}  hit ${r.hit === null ? "none" : r.hit.join("x")}  ${r.selector}`);
  console.error("\nFix the target, or accept it with `bun run hitbox:check --update` and write why in e2e/hitbox/known.json.");
  process.exit(1);
}
console.log("hitbox:check: no new small or covered target.");
