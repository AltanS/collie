// Real machine names, the maintainer's tailnet addresses and his home folder stay out of hand-written
// code and tests. Tests use the neutral set: `lodge` and `workshop` for hosts, `example` for the
// domain, `192.0.2.N` or `100.64.10.N` for addresses, `/home/dev` or `/var/home/dev` for a home
// folder. This test runs `git grep` over the repository and fails, naming the file, when a hit sits
// outside the allow list below.
//
// The allow list has two parts. NO_TOUCH holds whole classes of file that must keep the real name
// because a recording, a golden file or a masking test keys on it. KEPT holds the single files that
// keep a hit on purpose, each with its reason. A new file with a real name fails here: rename the
// name, or add the file to KEPT with a reason a reviewer accepts.
//
// The patterns are built from halves so this file does not match itself.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const PATTERN = [`blue${"fin"}`, `mini${"buch"}`, `sprq${"vntrs"}`, `/var/home/${"altan"}`, `100\\.64\\.0\\.`].join("|");

// Whole classes of file that keep the real names. Each entry is a prefix (ends in `/`) or an exact path.
const NO_TOUCH: readonly string[] = [
  ".adr/", // decision records quote the real setup
  "docs/", // user docs quote the real setup
  "scripts/harness-canary/", // lab redaction tests assert the masking of these names
  "web/e2e/rig/cassettes-data/", // recordings: the skill text in each prompt is part of the replay key
  "web/e2e/rig/cassettes/", // recordings: the skill text in each prompt is part of the replay key
  "web/src/fixtures/", // captured panes, traces and labels are real screens
  "cli/skills/", // the WalkyTalky skill text keys every cassette (walky-talky.md lines 69-71)
  "CHANGELOG.md", // release notes quote what shipped
  "CREW_PROTOCOL.md", // wire spec examples
  "HC_API.md", // API reference examples
  "README.md", // public text
];

// Single files that keep a hit on purpose. Sorted by path.
const KEPT = {
  ".env.example": "COLLIE_TAILSCALE_HOSTS example uses the CGNAT range 100.64/10, not a real address",
  "bridge/pair-audit.ts": "comment names the CGNAT range 100.64/10",
  "bridge/stt/whistle-model.ts": "the private-range table holds the CGNAT block 100.64/10 (code, behaviour)",
  "bridge/surface/protocol.not-sure.test.ts": "reads the captured pane file the starship motd pane fixture by name",
  "bridge/surface/protocol.test.ts": "reads the captured pane file the starship motd pane fixture by name",
  "bridge/themes/registry.ts": "comments name the CGNAT range 100.64/10",
  "cli/testdata/walky-skill-v2.golden.md": "golden copy of the skill text; its digest keys the cassettes",
  "experiments/harnesses/steer-queue-2026-10-23.md": "dated lab note about the real lab path; history, not code",
  "MUX_CONTRACT.md": "contract document with a captured tmux probe line",
  "scripts/build-ui-font.sh": "dev default: glyph list for the UI font subset",
  "web/e2e/rig/replay-stub.test.ts": "asserts the masking of these names in recordings",
  "web/e2e/rig/replay/check.ts": "the cassette check that refuses these names (cassettes-check HOSTS)",
  "web/e2e/rig/replay/tier.ts": "OWNER_HOSTS and the skill hash mask these names in recordings",
  "web/src/lib/surface/profiles/agy.json": "profile note, part of the fixture class",
  "web/src/lib/surface/profiles/muse.json": "profile note, part of the fixture class",
  "web/src/lib/table-run.test.ts": "names the captured pane file the starship motd pane fixture",
  "web/vite.config.ts": "dev default: COLLIE_DEV_HOSTS example in comments and a startup hint",
} satisfies Record<string, string>;

function inGit(): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}

function filesWithHits(): string[] {
  try {
    const out = execFileSync("git", ["grep", "-l", "--untracked", "-E", PATTERN], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter((line) => line !== "");
  } catch (err) {
    // git grep exits 1 when nothing matches.
    // SAFETY: execFileSync throws an Error that carries the child's exit `status`; nothing else is read.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

function allowed(file: string): boolean {
  if (file in KEPT) return true;
  return NO_TOUCH.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

describe.skipIf(!inGit())("neutral names in the repository", () => {
  test("no file outside the allow list holds a real machine name, address or home folder", () => {
    const offenders = filesWithHits().filter((file) => !allowed(file));
    expect(offenders).toEqual([]);
  });

  test("the KEPT list is sorted and names only files that still hold a hit", () => {
    const keys = Object.keys(KEPT);
    expect(keys).toEqual(keys.toSorted((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
    const hits = new Set(filesWithHits());
    expect(keys.filter((file) => !hits.has(file))).toEqual([]);
  });
});
