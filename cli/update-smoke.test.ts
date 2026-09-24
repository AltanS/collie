import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { realExec } from "./sys.ts";
import { smoke, smokeReason } from "./update.ts";

// #283, IN THE LAB SHAPE. A REAL compiled `collie`, laid down as a candidate version the way a binary
// update lays one down, smoke-tested by an updater that inherited `COLLIE_PLUGIN_ROOT` from the
// service it runs under (the macOS LaunchAgent injects it; so does the systemd unit). Before the
// fix the candidate read the OLD root's manifest, answered with the old version, and the update
// stopped at "checking that X runs here" with nothing said. Linux shows it the moment the variable
// is set, which is how this runs in CI with no Mac.

const OLD = "1.0.0";
const NEW = "1.1.0";
const REPO = join(import.meta.dir, "..");

let lab = "";
let candidate = "";
let oldRoot = "";

beforeAll(() => {
  lab = mkdtempSync(join(tmpdir(), "collie-smoke-lab-"));
  oldRoot = join(lab, "versions", OLD);
  candidate = join(lab, "versions", NEW);
  for (const [dir, version] of [
    [oldRoot, OLD],
    [candidate, NEW],
  ] as const) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "herdr-plugin.toml"), `id = "herdr.collie"\nversion = "${version}"\n`);
  }
  // Compiled from THIS tree, in the lab directory, so Bun's sidecars never land in the checkout.
  const built = Bun.spawnSync(
    [process.execPath, "build", "--compile", join(REPO, "cli", "main.ts"), "--outfile", join(candidate, "bin", "collie")],
    { cwd: lab, stdout: "pipe", stderr: "pipe" },
  );
  if (built.exitCode !== 0) throw new Error(`compile failed: ${built.stderr.toString()}`);
}, 120_000);

afterAll(() => {
  if (lab !== "") rmSync(lab, { recursive: true, force: true });
});

/** The updater's own environment, as a phone-started run inherits it on a Mac. */
const inherited = () => ({
  PATH: process.env.PATH ?? "",
  HOME: lab,
  COLLIE_PLUGIN_ROOT: oldRoot,
});

describe("#283: the candidate answers with its own version under an inherited COLLIE_PLUGIN_ROOT", () => {
  test("the failure, reproduced: a plain child of that updater reads the OLD root", () => {
    const r = realExec(inherited(), lab).capture(join(candidate, "bin", "collie"), ["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(OLD);
    expect(r.stdout).not.toContain(NEW);
  });

  test("the smoke runs it under its own root, and it passes", () => {
    expect(smoke({ exec: realExec(inherited(), lab) }, candidate, NEW)).toEqual({ ok: true });
  });

  test("a candidate that really is the wrong version still fails, and the reason says what it said", () => {
    const result = smoke({ exec: realExec(inherited(), lab) }, candidate, "9.9.9");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(smokeReason(result)).toStartWith("the new version did not start here (`collie version` answered 1.1.0");
  });
});
