// The test sets, in one place: what the quick gate (`bun run gate`) runs, which tests are frozen, and
// which paths wake a CI job. `scripts/gate.ts`, `scripts/test.ts` and `scripts/ci-changes.ts` read
// it, and `scripts/gate.test.ts` pins the rules that join the lists. Nothing here runs a test.
//
// Three naming rules, the same in every runner:
//   - `*.quarantine.test.ts`  a flaky test. No run includes it; the non-blocking `quarantine` job in
//     `ci.yml` runs only these files. It comes back to its old name when it is fixed. Its first line is
//     `// quarantined: YYYY-MM-DD <reason>` (a guard test pins that), and after 14 days that job turns
//     red until the test is fixed or deleted (`scripts/check-quarantine.ts`).
//   - `*.slow.test.ts`        slow on purpose. A full run keeps it; the quick gate leaves it out.
//   - `*.test.ts` and the rest  everything else. No test file passes 100 KB (`scripts/test-file-size.test.ts`):
//     a new case goes in a new file next to the old one.

import { basename, dirname } from "node:path";

// ── Ignore patterns for `bun test` ─────────────────────────────────────────────────────────────
// `--path-ignore-patterns` on the command line REPLACES the list in `bunfig.toml`, so a runner that
// passes it must restate it. The flag takes one pattern, so it is repeated: see `ignoreFlags`.
export const IGNORE_ENGINE_TESTS = ["inside/claude/tests/**"];
export const IGNORE_ALWAYS = [...IGNORE_ENGINE_TESTS, "**/*.quarantine.test.ts"];

export function ignoreFlags(patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) => ["--path-ignore-patterns", pattern]);
}

// ── Frozen code ────────────────────────────────────────────────────────────────────────────────
// Code that no longer changes by the week: the plugin data path (`collie harness link`, frozen since
// 2026-11-17), and the browser-leg rig and the harness lab tooling. Its tests stay in the default
// `bun run test` and in a full vitest run. They leave three places:
//   - the quick gate runs them only as near tests;
//   - the CI test jobs skip them unless a path below changed (`scripts/ci-changes.ts`, output `frozen`);
//   - the nightly CI run runs them every time.
// A path here is the whole claim: a change to a shared module that a frozen test imports does not wake
// them, and the nightly run is where that shows.
export const FROZEN_PATHS: readonly RegExp[] = [
  /^bridge\/inside\//, // the hub a part inside the agent dials
  /^cli\/(harness-link|inside-embed)/, // `collie harness link` and the embedded plugin files
  /^inside\//, // the plugin itself
  /^scripts\/harness-canary\//, // the harness lab and the canary
  /^scripts\/browser-leg-/, // the browser-leg rig tooling tests
  /^web\/e2e\/rig\//, // the browser-leg rig, its cassettes and `cassettes-data/`
  /^web\/src\/lib\/harness\/verified-versions\.json$/, // the canary ledger tests read the live range
];

/** The same set as `bun test --path-ignore-patterns` globs, for the CI jobs that skip it. */
export const FROZEN_BUN_IGNORE = [
  "bridge/inside/**",
  "cli/harness-link.test.ts",
  "cli/inside-embed.test.ts",
  "scripts/harness-canary/**",
  "scripts/browser-leg-*.test.ts",
];

/** Vitest projects that never hold frozen tests. The `rig` project is all frozen. */
export const WEB_PROJECTS_WITHOUT_FROZEN = ["logic", "dom"];

// ── Paths that wake the heavy CI jobs ──────────────────────────────────────────────────────────
// Every one of these jobs also runs nightly and on a manual dispatch. A change to `ci.yml` wakes all
// of them, and so does a change to this file.
const CI_SELF: readonly RegExp[] = [/^\.github\/workflows\/ci\.yml$/, /^scripts\/(test-sets|ci-changes)\.ts$/];
const LOCKFILES: readonly RegExp[] = [/^(package\.json|bun\.lock|bunfig\.toml)$/];

export const CI_JOB_PATHS = {
  // The frozen tests (above), plus whatever changes how every test runs.
  frozen: [
    ...FROZEN_PATHS,
    ...CI_SELF,
    ...LOCKFILES,
    /^web\/(package\.json|bun\.lock|vitest\.config\.ts)$/,
    /^scripts\/(test|test-preload)\.ts$/,
  ],
  // The backend suite on the Bun floor. It wakes on what decides which Bun runs and how: the pin, the
  // lockfile, the test preload. A backend source change that only the floor Bun rejects shows in the
  // nightly run.
  bunFloor: [...CI_SELF, ...LOCKFILES, /^(flake\.nix|flake\.lock)$/, /^cli\/update-check\.ts$/, /^scripts\/test-preload\.ts$/],
  // The durable examples and the SDK package built from them.
  durable: [
    ...CI_SELF,
    ...LOCKFILES,
    /^examples\//,
    /^packages\/durable-sdk\//,
    /^bridge\/mux\/durable\//,
    /^scripts\/sdk-(build|pack-check)\./,
  ],
  // The swap-server browser specs: the service worker, the update screen and the bundle server.
  swap: [
    ...CI_SELF,
    /^web\/(package\.json|bun\.lock|playwright\.config\.ts|vite\.config\.ts|index\.html)$/,
    /^web\/public\//,
    /^web\/e2e\/(service-worker\.spec|update-screen\.spec|serve-builds)\.ts$/,
    /^web\/e2e\/fixtures\//,
    /^web\/src\/sw\.ts$/,
    /^web\/src\/lib\/(sw-|self-update|update-|server-build|reload-guard|chunk-reload)/,
    /^web\/src\/components\/update-/,
    /^web\/src\/hooks\/use-update-screen\.ts$/,
    /^web\/src\/routes\/updates\.tsx$/,
    /^bridge\/update(-action)?\.ts$/,
  ],
} satisfies Record<string, readonly RegExp[]>;

export type CiJob = keyof typeof CI_JOB_PATHS;

/** Whether any changed file wakes the job. */
export function wakes(job: CiJob, changed: readonly string[]): boolean {
  return changed.some((file) => CI_JOB_PATHS[job].some((pattern) => pattern.test(file)));
}

// ── The guard tests ────────────────────────────────────────────────────────────────────────────
// Repo-rule tests: they read source, docs or generated files and fail when a rule is broken. They
// are fast, they catch what a type check cannot, and the quick gate always runs them. One entry, one
// reason. A new rule test joins this list in the commit that adds it.

/** `bun test` files, run as one process. */
export const GUARD_BUN: readonly (readonly [file: string, rule: string])[] = [
  ["bridge/host-guard.test.ts", "Windows: no startsWith('/'), URL pathname, split('/') or a bare binary name outside the Host object"],
  ["bridge/private-roots-guard.test.ts", "Windows: a 0o600 or 0o700 write names a private root"],
  ["bridge/root.test.ts", "the checkout root never resolves from the compiled bundle"],
  ["bridge/session-title-no-harness.test.ts", "session naming code names no harness"],
  ["bridge/api/ask-reach.test.ts", "the local API cannot reach an ask, a key press or a write"],
  ["bridge/auth-path-contract.test.ts", "the service worker and the bridge agree on the reserved /auth path"],
  ["bridge/error-codes.test.ts", "the error codes of the bridge and the web app match"],
  ["bridge/push-titles.test.ts", "the push title codes of the bridge and the web app match"],
  ["bridge/config-schema.test.ts", "every COLLIE_* name the code reads has a row in the config schema"],
  ["bridge/api-front-gate.test.ts", "every /api route asks the front gate, by source"],
  ["cli/docs-embed.test.ts", "every docs page is embedded in the binary"],
  ["scripts/check-mux-names.test.ts", "multiplexer names stay out of the web app's and the bridge's decisions"],
  ["scripts/bridge-web-imports.test.ts", "the bridge and the CLI import nothing that needs the web install"],
  ["scripts/check-adr.test.ts", "the decision records keep their header, topic map and back pointers"],
  ["scripts/check-docs-placeholders.test.ts", "docs write a placeholder inside a code span"],
  ["scripts/check-flake-bun.test.ts", "the pinned Bun, MIN_BUN and the Windows workflow agree"],
  ["scripts/release-notes.test.ts", "every CHANGELOG bullet is shaped for the release page"],
  ["scripts/release-workflow.test.ts", "release.yml keeps its payload and Windows job rules"],
  ["scripts/neutral-names.test.ts", "no real machine name, address or home folder in code or tests"],
  ["scripts/tricks-limits-unchanged.test.ts", "the trick limits keep their pinned values"],
  ["scripts/menu-sheet-labels.test.ts", "the generated sheet labels match the catalogues"],
  ["scripts/docs-places.test.ts", "one place picture for every trick place"],
  ["scripts/themes-reference.test.ts", "the themes reference page is the generator's output"],
  ["scripts/tricks-reference.test.ts", "the tricks reference page is the generator's output"],
  ["scripts/check-quarantine.test.ts", "every quarantined test file says since when and why"],
  ["scripts/test-file-size.test.ts", "no test file is over 100 KB, and a listed one stays under its ceiling"],
];

/** One `bun test -t <name>` run over a file that is not a guard as a whole. */
export const GUARD_BUN_NAMED: readonly (readonly [file: string, name: string, rule: string])[] = [
  ["bridge/server.test.ts", "open routes", "only /api/health and /api/pair answer without a gate"],
];

/** Scripts that exit non-zero on a broken rule. */
export const GUARD_SCRIPTS: readonly (readonly [command: readonly string[], rule: string])[] = [
  [["bash", "scripts/check-version.sh"], "the three version files and the CHANGELOG agree"],
  [["bun", "scripts/check-doc-links.ts"], "every local link in a tracked markdown file resolves"],
  [["bun", "scripts/surface-corpus.ts"], "every dialog fixture reads as not free"],
];

/** Vitest files, run in `web/` as one process. */
export const GUARD_WEB: readonly (readonly [file: string, rule: string])[] = [
  ["src/lib/storage-keys.test.ts", "every storage key has a decided fate at unpair"],
  ["src/components/collie-mark-hash.test.ts", "the generated marks carry the hash of their source"],
  ["src/lib/i18n/update-ribbon-budget.test.ts", "the update ribbon fits its length budget in every language"],
  ["src/lib/harness/fence.test.ts", "no harness module but guard.ts imports the network API"],
  ["src/lib/surface/no-harness-names.test.ts", "the surface code names no harness"],
  ["src/components/icons/icon-buttons-labelled.test.ts", "every icon-only button has a name"],
  ["src/lib/key-writes.test.ts", "every write to a pane's keyboard goes through lib/api"],
  ["src/lib/shortcuts/words.test.ts", "no shortcut label uses the words workspace, column, zoom or switcher"],
  ["src/lib/shortcuts/docs-table.test.ts", "the keyboard shortcuts page lists exactly the actions of the app, with their keys"],
  ["src/lib/tricks/places.test.ts", "no lib file tests a pane's kind for a trick but places.ts"],
  ["src/components/ui/notice.test.tsx", "the alert family does not grow a seventh component"],
  ["src/lib/surface/traces.test.ts", "the golden traces: a negative trace never reads free"],
  ["e2e/rig/cassettes-check.test.ts", "the committed cassettes hold no key, home path or host name"],
];

// ── Near tests ─────────────────────────────────────────────────────────────────────────────────
// For the bun areas the quick gate runs a changed test file, and the tests in the same folder that
// are named after a changed source file: `foo.ts` gives `foo.test.ts` and `foo.<part>.test.ts`.
// The web app uses `vitest --changed`, which follows imports.

export const BUN_NEAR_AREAS = ["bridge", "cli", "scripts", "herdr-app-mod", "omp-extension"] as const;
/** Shell tests (`*.test.sh`) are picked the same way and run with `bash`. */
export const SHELL_NEAR_AREAS = [...BUN_NEAR_AREAS, "packaging"] as const;

const TEST_FILE = /\.test\.(ts|tsx|sh)$/;
const EXCLUDED_FROM_NEAR = /\.(slow|quarantine)\.test\.(ts|tsx|sh)$/;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

export function isExcludedFromNear(file: string): boolean {
  return EXCLUDED_FROM_NEAR.test(file);
}

/** The name a source file lends to its tests: `foo.ts` and `foo.test.ts` both give `foo`. */
export function stemOf(file: string): string {
  const name = basename(file);
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

function inAreas(file: string, areas: readonly string[]): boolean {
  return areas.some((area) => file.startsWith(`${area}/`));
}

/** Which sibling test files a changed file picks: quick ones for the gate, or the slow ones left out. */
type NearKind = "quick" | "slow";

const SLOW_TEST = /\.slow\.test\.(ts|tsx|sh)$/;

function pickNear(
  changed: readonly string[],
  all: readonly string[],
  areas: readonly string[],
  wanted: RegExp,
  kind: NearKind,
): string[] {
  const exists = new Set(all);
  const picked = new Set<string>();
  const dirs = new Map<string, string[]>();
  for (const file of all) {
    const dir = dirname(file);
    dirs.set(dir, [...(dirs.get(dir) ?? []), file]);
  }
  for (const file of changed) {
    if (!inAreas(file, areas) || !exists.has(file)) continue;
    const stem = stemOf(file);
    for (const sibling of dirs.get(dirname(file)) ?? []) {
      if (!wanted.test(sibling)) continue;
      if (kind === "quick" ? isExcludedFromNear(sibling) : !SLOW_TEST.test(sibling)) continue;
      const own = file === sibling;
      const named = stemOf(sibling) === stem;
      if (own || named) picked.add(sibling);
    }
  }
  return [...picked].toSorted();
}

function wantedFor(kind: "bun" | "shell"): RegExp {
  return kind === "bun" ? /\.test\.(ts|tsx)$/ : /\.test\.sh$/;
}

/**
 * The near tests of a change. `changed` is the changed paths, `all` is every file the repo holds
 * (tracked and not ignored), both relative to the root. A changed test file counts as itself and as
 * a source file, so a change to `foo.test.ts` also picks `foo.part.test.ts` beside it.
 */
export function nearTests(
  changed: readonly string[],
  all: readonly string[],
  areas: readonly string[],
  kind: "bun" | "shell",
): string[] {
  return pickNear(changed, all, areas, wantedFor(kind), "quick");
}

/** The `*.slow.test.*` files the near selection would pick, were they not slow. */
export function slowNearTests(
  changed: readonly string[],
  all: readonly string[],
  areas: readonly string[],
  kind: "bun" | "shell",
): string[] {
  return pickNear(changed, all, areas, wantedFor(kind), "slow");
}

const SOURCE_FILE = /\.(ts|tsx|sh)$/;

/**
 * Changed code files in the near areas that no test picks: no quick one, and no slow one either
 * (a slow one is reported by `slowNearTests`). A test file and a declaration file never count.
 */
export function withoutNearTest(changed: readonly string[], all: readonly string[], areas: readonly string[]): string[] {
  const exists = new Set(all);
  return changed
    .filter((file) => inAreas(file, areas) && exists.has(file) && SOURCE_FILE.test(file) && !file.endsWith(".d.ts") && !isTestFile(file))
    .filter((file) => {
      const one = [file];
      return (["bun", "shell"] as const).every((kind) => nearTests(one, all, areas, kind).length === 0 && slowNearTests(one, all, areas, kind).length === 0);
    })
    .toSorted();
}

export interface NearReport {
  bunFiles: number;
  shellFiles: number;
  noNearTest: string[];
  slowNear: string[];
}

export function nearReport(changed: readonly string[], all: readonly string[]): NearReport {
  return {
    bunFiles: nearTests(changed, all, BUN_NEAR_AREAS, "bun").length,
    shellFiles: nearTests(changed, all, SHELL_NEAR_AREAS, "shell").length,
    noNearTest: withoutNearTest(changed, all, SHELL_NEAR_AREAS),
    slowNear: [...new Set([...slowNearTests(changed, all, BUN_NEAR_AREAS, "bun"), ...slowNearTests(changed, all, SHELL_NEAR_AREAS, "shell")])].toSorted(),
  };
}

const NAME_CAP = 10;

/** At most ten names, then "and K more". */
export function capNames(names: readonly string[], cap = NAME_CAP): string {
  if (names.length <= cap) return names.join(", ");
  return `${names.slice(0, cap).join(", ")} and ${names.length - cap} more`;
}

/** The lines the quick gate prints at its end, to say what it did not run. */
export function gateFooter(report: NearReport | null): string[] {
  const lines: string[] = [];
  if (report !== null) {
    const shell = report.shellFiles === 0 ? "" : `, ${report.shellFiles} shell files`;
    lines.push(`near tests: ${report.bunFiles} bun files${shell}, web via vitest --changed`);
    if (report.noNearTest.length > 0) lines.push(`no near test for: ${capNames(report.noNearTest)}`);
    if (report.slowNear.length > 0) {
      lines.push(`slow tests near the change, not run: ${capNames(report.slowNear)}`);
      // Past the cap the command would fill the screen, so it names every slow file instead.
      const command = report.slowNear.length > NAME_CAP ? "bun test .slow.test (every slow file, the list above is cut)" : `bun test ${report.slowNear.join(" ")}`;
      lines.push(`run them: ${command}`);
    }
  }
  lines.push("not run here: the full suites, Windows, WebKit; CI runs them (bun run gate --full runs the suites here)");
  return lines;
}
