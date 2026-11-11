import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { PRIVATE_ROOTS } from "./acl-policy.ts";

// THE PRIVATE-ROOTS GUARD (M43 spec 04). On Windows a secret is private because it sits in a folder
// whose access list start-up made private (`PRIVATE_ROOTS`: the state folder and the config folder),
// and every file written there inherits that list. A `mode: 0o600` or a `0o700` folder anywhere else
// is a promise only POSIX keeps. So every such write site in `bridge/` and `cli/` must name a
// private root on its line or in the lines just above it (each root's `sourceNames`), or sit in
// ELSEWHERE with a one-line reason and a count per file. A new site fails this test; the fix is to
// write under the state or config folder, or to add the site here with the reason it is safe.
//
// The second test holds the temp-then-rename writes to the same rule: the temp file is a sibling of
// the target (`${target}.tmp`) or is joined onto the folder being written, so it is born inside the
// private folder and inherits its list, never in the system temp folder.

const ROOT = join(import.meta.dir, "..");
const SCANNED = ["bridge", "cli"];
/** How far above a site its private root may be named: the function that computes the path. */
const LOOK_BACK = 12;
/**
 * Files in the scanned folders that are not Collie code. `cli/trick-kit/trick.ts` is the trick helper
 * (M94): `collie trick init` copies it as text into a trick folder, where it runs under plain bun, outside
 * this repo. Its 0600 and 0700 writes go to the trick's own state folder, which the bridge hands it, not to
 * Collie's state or config folder. It is user-side code shipped as a file, so this rule does not reach it.
 */
const SHIPPED_AS_TEXT: ReadonlySet<string> = new Set(["cli/trick-kit/trick.ts"]);

const SITE = /mode: 0o700|mode: 0o600|[(,]\s*0o600\)|[(,]\s*0o700\)|BEACON_DIR_MODE\)/;

interface Elsewhere {
  readonly file: string;
  /** How many sites in the file are allowed. Any other number fails, up or down. */
  readonly count: number;
  readonly why: string;
}

const ELSEWHERE: readonly Elsewhere[] = [
  { file: "bridge/activity.ts", count: 2, why: "`this.dir` is `cfg.stateDir`, set in the constructor" },
  { file: "bridge/audit.ts", count: 1, why: "the appender is handed `<stateDir>/audit.log` by index.ts and cli/crew.ts" },
  { file: "bridge/config.ts", count: 1, why: "the POSIX mode rule tightens a config file in place; Windows reads its access list instead" },
  { file: "cli/context.ts", count: 1, why: "the POSIX mode rule tightens .env in place; Windows reads its access list instead" },
  { file: "cli/config.ts", count: 2, why: "`collie config set` writes config.toml into the config folder or ~/.collie, which the loader checks" },
  { file: "cli/hooks.ts", count: 2, why: "an agent's own settings file (~/.claude), not Collie's; documented as not covered" },
  { file: "cli/codex-hooks.ts", count: 2, why: "an agent's own config file ($CODEX_HOME/config.toml), not Collie's; the same case as cli/hooks.ts" },
  { file: "cli/skill-install.ts", count: 1, why: "the one-time `.collie-backup` copy beside an agent's own instruction file (~/.codex/AGENTS.md and kin), not Collie's; the same case as cli/hooks.ts" },
  { file: "cli/update.ts", count: 1, why: "the staging log is `stagingLogPath(deps.ctx.stateDir, runId)`, set further up the same function" },
  { file: "bridge/math/store.ts", count: 7, why: "every path is under `mathPackDir(deps.stateDir)`, `<stateDir>/math` (ADR 0132): the folder, a download's part file, and a version's temporary folder with its files and `pack.json`" },
  { file: "bridge/themes/registry.ts", count: 3, why: "every path is under `themesDir(deps.stateDir)`, `<stateDir>/themes` (M59 spec 06): the folder at 0700 and the registry copy's part file at 0600, renamed onto `registry.json`" },
  { file: "bridge/tricks/switches.ts", count: 1, why: "the lock file is `${path}.lock`, a sibling of `<stateDir>/tricks/switches.json`, inside the state folder (M94)" },
  { file: "bridge/tricks/approved.ts", count: 11, why: "every path is under `tricksConfigDir(configDir)` (M94, crew slice 2): `.collie-approved/<id>/` and `.collie-pending/<id>/` in the config folder, each copy staged in a `.stage-*` folder beside its target with its subfolders, code files, `config.toml`, origin record and writable folders, then renamed into place; `syncConfig` writes the copy's `config.toml` through a temp file in the copy itself" },
  { file: "bridge/tricks/inputs.ts", count: 5, why: "every path is under `inputs/` of the trick folder it is handed (M99), the approved copy inside `tricksConfigDir(configDir)` on the bridge, or the author's own folder under `trick dev --inputs`: the folder made at 0700, the `.stage-*` folder beside the live tree with its subfolders and its 0600 files, and the `.old-*` folder the swap moves the old tree into" },
  { file: "cli/trick-dev.ts", count: 1, why: "`trick dev --inputs` marks the author's own trick folder with `.collie-dev-inputs` (M99), a folder the author named, as `collie trick init` writes into one; nothing private is in it" },
  { file: "bridge/tricks/proposal-install.ts", count: 6, why: "every path is under the tricks root `tricksConfigDir(configDir)` it is handed (crew slice 8): the staged `.collie-add-<id>-*` folder, its subfolders and its origin record, renamed onto `tricks/<id>`; for a new version, the folders of a code file and the origin record, each through a `.collie-new-*` temp beside it" },
  { file: "bridge/tricks/proposals.ts", count: 3, why: "the inert store `.collie-proposed/<id>/<hash>/` under `tricksConfigDir(configDir)` and `proposals.json` under `<stateDir>/tricks/` (crew slice 8): the version folder, its subfolders and the state file through its `.tmp` sibling" },
  { file: "cli/trick-add.ts", count: 2, why: "every path is under `tricksConfigDir(deps.ctx.configDir)` (M94 review 15): the staged `.collie-add-<id>-*` folder, renamed onto `tricks/<id>`, and the chmod after that swap" },
  { file: "bridge/tricks/fetch.ts", count: 3, why: "`writeCandidateFiles` writes into the folder it is handed (M94 review 15): the staged `.collie-add-<id>-*` folder under `tricksConfigDir(configDir)` for an add, or a fetch's own temp folder (under `<stateDir>/tricks/` on the bridge, under the OS temp dir in the maintainer script) to take a code hash; the folder, its subfolders and its files" },
  { file: "cli/trick.ts", count: 1, why: "`runAgainstFixture` makes the state folder of one fixture run: a `mkdtemp` folder under the OS temp dir, or the scratch folder the person names with `collie trick dev --state <dir>`; never the bridge's own state (M94)" },
  { file: "bridge/crew/standby-tricks.ts", count: 11, why: "every path is under `this.dir`, `<stateDir>/standby-tricks` (crew slice 10, CREW_PROTOCOL §25): the folder, `index.json` through its `.tmp` sibling, and the `.stage-*` folders with their subfolders and files, renamed onto `code/<id>/<hash16>/` and `state/<id>/`" },
  { file: "bridge/crew/carry-adopt.ts", count: 6, why: "the takeover tap writes a carried trick into a staged `.collie-carry-*` folder under `tricksConfigDir(configDir)`, or an `.adopt-*` scratch folder under `<stateDir>/standby-tricks` (crew slice 10): its subfolders, code, `config.toml`, origin record and pictures; and copies the state into `trickStateDir(stateDir, id)`" },
  { file: "bridge/crew/carry-notices.ts", count: 1, why: "`<stateDir>/tricks/carried-notices.json` through its `.tmp` sibling (crew slice 10)" },
  { file: "bridge/stt/whistle-model.ts", count: 6, why: "every path is `whistlePaths(deps.stateDir)`, the model's folder inside the state folder" },
  { file: "bridge/stt/local-cli.ts", count: 2, why: "one recording's mkdtemp folder under the OS temp dir, the user's own; removed in finally" },
  { file: "bridge/durable/log.ts", count: 8, why: "every path is `<stateDir>/durable/<source>/<pane>.jsonl` or the cursor beside it, `<pane>.cursor.json` (the two chmods hold the folder at 0700 and the file at 0600 when they were there before): `DurableLogs` is handed `sourceLogDir(cfg.stateDir, source.name)` by index.ts for each program, and `moveFlatLogs` makes `durable/default/` once, at boot" },
  { file: "cli/durable-attach.ts", count: 1, why: "the path is `sourcesPath(deps.ctx)`, `sources.json` in the instance config folder beside `.env`; the temp file is its `.tmp` sibling" },
  { file: "bridge/surface/requests.ts", count: 6, why: "every path is under the folder `RequestStore` is handed, `<stateDir>/sends` from index.ts (M56 spec 05): the folder, its `.salt`, each `<id>.json` and each ask answer's `ask.<id>.json` (M56 spec 08), both through their `.tmp` siblings" },
  { file: "bridge/surface/holds.ts", count: 4, why: "every path is under the folder `HoldStore` is handed, `<stateDir>/held` from index.ts (M56 spec 15): the folder and each `<id>.json` through its `.tmp` sibling" },
  { file: "bridge/surface/counters.ts", count: 5, why: "every path is under `<stateDir>/surface`, the folder `SurfaceLedger` builds from the state folder index.ts hands it (M56 spec 09): the day files through their `.tmp` siblings, the examples folder and its files, and the inbox file beside them" },
  { file: "bridge/walky/socket.ts", count: 3, why: "the walky talky socket's folder and file, `walkySocketPath(cfg.stateDir)` from index.ts (M62): `<stateDir>/walky` at 0700 and its `sock` at 0600; the server does not start on Windows" },
  { file: "bridge/walky/log.ts", count: 6, why: "every path is under the folder `WalkyLog` is handed, `<stateDir>/walky` from index.ts (M62): the folder and its `inbox` folder at 0700, `log.jsonl` and each `inbox/<hash>.json` at 0600, the rewrites through their `.tmp` siblings" },
  { file: "bridge/walky/seen.ts", count: 3, why: "the dedupe file `WalkySeen` is handed the folder for, `<stateDir>/walky` from index.ts (M62 hardening E): the folder at 0700 and `seen.json` at 0600 through its `.tmp` sibling" },
  { file: "bridge/walky/instances.ts", count: 3, why: "the pane instance registry `WalkyInstances` is handed the folder for, `<stateDir>/walky` from index.ts: the folder at 0700 and `instances.json` at 0600 through its `.tmp` sibling" },
  { file: "bridge/walky/off.ts", count: 3, why: "the off flags `WalkyOff` is handed the folder for, `<stateDir>/walky` from index.ts (M89): the folder at 0700 and `off.json` at 0600 through its `.tmp` sibling" },
  { file: "bridge/hill/store.ts", count: 4, why: "the decisions file `HillStore` is handed the folder for, `hillDir(cfg.stateDir)`, `<stateDir>/hill` from index.ts (M96): the folder at 0700 (made and held) and `decisions.json` at 0600 (written and held) through its `.tmp` sibling" },
  { file: "bridge/tricks/hill.ts", count: 4, why: "the trick decisions map `TrickHill` builds under `hillDir(deps.stateDir)`, `<stateDir>/hill` from the state folder index.ts hands it (M94, M96): the folder at 0700 (made and held) and `tricks.json` at 0600 (written and held) through its `.tmp` sibling" },
  { file: "bridge/hill/media.ts", count: 6, why: "the images `HillMediaStore` is handed the hill folder for, `hillDir(cfg.stateDir)` from index.ts (M96): `<stateDir>/hill/media` and each `<decision id>` folder at 0700 (made and held), each `<media id>` file at 0600 through its `.tmp` sibling" },
  { file: "bridge/pins/store.ts", count: 3, why: "the pin files `PinStore` is handed the folder for, `<stateDir>/pins` from index.ts (M90): the folder at 0700 and each `<sessionKey>.json` at 0600 through its `.tmp` sibling" },
  { file: "bridge/walky/refusals.ts", count: 3, why: "the refusal counter `RefusalCounter` is handed the folder for, `<stateDir>/walky` from index.ts (M62 hardening I): the folder at 0700 and `refusals.json` at 0600 through its `.tmp` sibling" },
  { file: "bridge/surface/hold.ts", count: 3, why: "the hold socket's folder and file, `holdSocketPath(cfg.stateDir)` from index.ts (M56 spec 12): `<stateDir>/hold` at 0700 and its `sock` at 0600; the server does not start on Windows" },
  { file: "bridge/owner-only.ts", count: 2, why: "the private-folder code itself: the backup folder inside the state folder, and the folder being made private" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    const full = join(entry.parentPath, entry.name);
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !SHIPPED_AS_TEXT.has(rel(full))) out.push(full);
  }
  return out;
}

const rel = (full: string): string => relative(ROOT, full).split(sep).join("/");

interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly rooted: boolean;
}

function sites(): Site[] {
  const out: Site[] = [];
  for (const dir of SCANNED) {
    for (const full of sourceFiles(dir)) {
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((text, i) => {
        const code = text.replace(/\/\/.*$/, "");
        if (!SITE.test(code) || /^\s*\*/.test(text)) return;
        const context = lines.slice(Math.max(0, i - LOOK_BACK), i + 1).join("\n");
        out.push({ file: rel(full), line: i + 1, text: text.trim(), rooted: PRIVATE_ROOTS.some((r) => r.sourceNames.test(context)) });
      });
    }
  }
  return out;
}

describe("every private write lives under a private root", () => {
  test("a 0600 file or 0700 folder names the state or config folder, or is listed with its reason", () => {
    const loose = sites().filter((s) => !s.rooted);
    const byFile = new Map<string, Site[]>();
    for (const s of loose) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    const problems: string[] = [];
    for (const [file, list] of byFile) {
      const allowed = ELSEWHERE.find((e) => e.file === file);
      if (allowed === undefined) {
        problems.push(
          ...list.map(
            (s) =>
              `${s.file}:${String(s.line)} writes a private file outside the state and config folders (${s.text}). ` +
              "Write it under one of them, or list the file in ELSEWHERE in bridge/private-roots-guard.test.ts with the reason it is safe on Windows.",
          ),
        );
      } else if (allowed.count !== list.length) {
        problems.push(`${file}: ELSEWHERE allows ${String(allowed.count)} site(s), the file has ${String(list.length)}. Update the count.`);
      }
    }
    for (const e of ELSEWHERE) {
      if (!byFile.has(e.file)) problems.push(`${e.file}: listed in ELSEWHERE but has no unrooted site any more. Remove the entry.`);
    }
    expect(problems).toEqual([]);
  });

  test("the scan finds the known sites, so a broken pattern cannot pass by finding nothing", () => {
    const found = sites().map((s) => s.file);
    for (const file of ["bridge/push.ts", "bridge/pairing.ts", "bridge/crew/trust-store.ts", "cli/pairing.ts", "cli/push-keys.ts"]) {
      expect(found).toContain(file);
    }
  });

  test("a temp file for a temp-then-rename write is born inside the folder of its target", () => {
    const bad: string[] = [];
    let seen = 0;
    for (const dir of SCANNED) {
      for (const full of sourceFiles(dir)) {
        readFileSync(full, "utf8")
          .split("\n")
          .forEach((text, i) => {
            const m = /const (tmp|temp|temporary)\s*=\s*(.+);$/.exec(text.trim());
            if (m === null) return;
            seen++;
            const expr = m[2]!;
            const sibling = /^`\$\{[\w.]+\}\.[^`/\\]*`$/.test(expr);
            const joined = /^join\(\s*(dir|\w*Dir)\b/.test(expr);
            if (!sibling && !joined) bad.push(`${rel(full)}:${String(i + 1)} ${text.trim()}`);
          });
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });
});
