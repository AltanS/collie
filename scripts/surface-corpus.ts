#!/usr/bin/env bun
// The Surface corpus table (M56 spec 04). Reads every pane fixture through the shadow's pipeline (the
// block readers lift an ask, the fold reads the Surface with the harness's own profile) and prints one
// row per harness and version: the fixture count, how many read free, how many show a modal, how many
// read unknown and why, and how many the generic cues alone read as a modal (no reader lifting).
//
// Exits 1 when a dialog fixture (a label of state `dialog` or `screen` in
// web/src/fixtures/surface-labels.json) reads free, or when fewer than 95% of the idle fixtures of the
// chosen harness (Claude unless `--harness` names another profiled harness) read free. One idle miss is forgiven on the last three versions above the profile's
// `verifiedThrough`: a version nobody has verified yet may move one row before its profile does.
// Exits 1 too when the generic cues alone (no reader lifting) read a `dialog` fixture of any other
// harness (codex, pi, opencode, grok, omp and the rest) as anything but a modal: most of those
// harnesses have no profile, so the cues are what stands between their dialogs and a guess.
//
//   bun scripts/surface-corpus.ts                  # every harness, the idle rule on Claude
//   bun scripts/surface-corpus.ts --harness codex  # the Codex rows, the idle rule on Codex (M56 spec 13)
//
// With `--harness`, the table shows that harness's rows and the idle rule and its thresholds apply
// to that harness. The dialog rule and the cues rule still run over every fixture.
//
// The fixtures and the labels are the ones the fold.*.test.ts files pin; this script prints what the tests check.

import { readdirSync } from "node:fs";

import { agentOf, CUES_BLIND, fixtureRows, idleFor, loadLabels, PANES_DIR, readScreen, type FixtureState } from "../web/src/test/surface-corpus.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { askOf, isFree, type Surface } from "../web/src/lib/surface/surface.ts";

/** The labels that must never read free. */
const NEGATIVE: ReadonlySet<FixtureState> = new Set(["dialog", "screen"]);
/** The harness with the most readers: the cues rule leaves its dialogs to them. scripts/ is outside the surface code's name ban. */
const READER_HARNESS = "claude";

function harnessArg(argv: readonly string[]): string {
  const at = argv.indexOf("--harness");
  if (at === -1) return READER_HARNESS;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("-")) {
    console.error("usage: bun scripts/surface-corpus.ts [--harness <profile id>]");
    process.exit(2);
  }
  if (!loadProfiles().has(value)) {
    console.error(`no profile named ${value}; known: ${[...loadProfiles().keys()].join(", ")}`);
    process.exit(2);
  }
  return value;
}

/** The profile the idle rule is about. */
const IDLE_HARNESS = harnessArg(process.argv.slice(2));
/** Whether the table shows one harness only. */
const ONLY = process.argv.includes("--harness");
/** The label a bare shell carries: no harness, so no cue rule. */
const SHELL = "shell";
const IDLE_SHARE = 0.95;
const UNVERIFIED_WINDOW = 3;
const UNVERIFIED_MISSES = 1;

interface Row {
  fixtures: number;
  free: number;
  modal: number;
  unknown: Map<string, number>;
  cuesModal: number;
}

function semver(v: string): number[] | null {
  return /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  return 0;
}

function isModal(surface: Surface): boolean {
  return askOf(surface.modal) !== null || surface.modal === "unreadable";
}

/** Why a read that is neither free nor a modal has a claim unknown, or null. A weak cue has no reason. */
function unknownReason(surface: Surface): string | null {
  if (isFree(surface) || isModal(surface)) return null;
  if (surface.turn !== "unknown" && surface.modal !== "unknown" && surface.composer !== "unknown") return null;
  return surface.reason ?? (surface.modal === "unknown" ? "weak-cue" : "other");
}

const labels = loadLabels().fixtures;
const names = readdirSync(PANES_DIR)
  .filter((name) => name.endsWith(".txt"))
  .toSorted();

const rows = new Map<string, Row>();
const freeDialogs: string[] = [];
const idleMisses: { name: string; version: string }[] = [];
const cuesMisses: string[] = [];
let idleTotal = 0;
let unlabelled = 0;

for (const name of names) {
  const label = labels[name];
  if (label === undefined) {
    unlabelled++;
    continue;
  }
  const agent = agentOf(label.harness);
  const idle = idleFor(label.harness);
  const shown = fixtureRows(name);
  const surface = readScreen(shown, agent, idle).surface;
  const cuesAlone = readScreen(shown, agent, idle, { lift: false }).surface;

  const key = `${label.harness}\t${label.version}`;
  let row = rows.get(key);
  if (row === undefined) {
    row = { fixtures: 0, free: 0, modal: 0, unknown: new Map(), cuesModal: 0 };
    rows.set(key, row);
  }
  row.fixtures++;
  const free = isFree(surface);
  if (free) row.free++;
  if (isModal(surface)) row.modal++;
  if (isModal(cuesAlone)) row.cuesModal++;
  // A "-cut" fixture is a screen truncated on purpose: it hides the footer that proves the dialog, and its uncut sibling is in the set.
  else if (label.state === "dialog" && label.harness !== READER_HARNESS && label.harness !== SHELL && !name.endsWith("-cut.txt") && !CUES_BLIND.has(name)) cuesMisses.push(`${name} (${label.harness})`);
  const reason = unknownReason(surface);
  if (reason !== null) row.unknown.set(reason, (row.unknown.get(reason) ?? 0) + 1);

  if (free && NEGATIVE.has(label.state)) freeDialogs.push(name);
  if (label.harness === IDLE_HARNESS && label.state === "idle") {
    idleTotal++;
    if (!free) idleMisses.push({ name, version: label.version });
  }
}

const header = ["harness", "version", "fixtures", "free", "modal", "unknown by reason", "cues-alone modal"];
const body = [...rows.entries()]
  .filter(([key]) => !ONLY || key.startsWith(`${IDLE_HARNESS}\t`))
  .toSorted(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
  .map(([key, row]) => {
    // SAFETY: every key was built above as `${harness}\t${version}`, and neither part holds a tab.
    const [harness, version] = key.split("\t") as [string, string];
    const unknown = [...row.unknown.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([reason, n]) => `${reason} ${String(n)}`)
      .join(", ");
    return [harness, version, String(row.fixtures), String(row.free), String(row.modal), unknown || "-", String(row.cuesModal)];
  });
const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
console.log(line(header));
console.log(line(widths.map((w) => "-".repeat(w))));
for (const r of body) console.log(line(r));
console.log("");

// The idle rule, with the allowance on the newest unverified versions.
const profile = loadProfiles().get(IDLE_HARNESS);
const verified = profile?.versions.map((v) => v.verifiedThrough).filter((v): v is string => v !== null).map(semver).filter((v): v is number[] => v !== null) ?? [];
const through = verified.toSorted(compare).at(-1) ?? null;
const unverified = [...new Set(Object.values(labels).filter((l) => l.harness === IDLE_HARNESS).map((l) => l.version))]
  .map((v) => ({ v, n: semver(v) }))
  .filter((x): x is { v: string; n: number[] } => x.n !== null && (through === null || compare(x.n, through) > 0))
  .toSorted((a, b) => compare(a.n, b.n))
  .slice(-UNVERIFIED_WINDOW)
  .map((x) => x.v);
const forgivable = idleMisses.filter((m) => unverified.includes(m.version));
const forgiven = Math.min(forgivable.length, UNVERIFIED_MISSES);
const idleFree = idleTotal - idleMisses.length;
const share = idleTotal === 0 ? 0 : (idleFree + forgiven) / idleTotal;

let failed = false;
console.log(`unlabelled fixtures: ${String(unlabelled)}`);
if (freeDialogs.length > 0) {
  failed = true;
  console.log(`FAIL: ${String(freeDialogs.length)} dialog fixture(s) read free:`);
  for (const name of freeDialogs) console.log(`  ${name}`);
} else {
  console.log("ok: no dialog fixture reads free");
}
const window = unverified.length > 0 ? unverified.join(", ") : "none";
console.log(
  `${share >= IDLE_SHARE ? "ok" : "FAIL"}: ${String(idleFree)} of ${String(idleTotal)} idle ${IDLE_HARNESS} fixtures read free` +
    ` (${String(forgiven)} miss forgiven on the unverified versions: ${window}; need ${String(IDLE_SHARE * 100)}%)`,
);
for (const miss of idleMisses) console.log(`  not free: ${miss.name} (${miss.version})`);
if (share < IDLE_SHARE) failed = true;
if (cuesMisses.length > 0) {
  failed = true;
  console.log(`FAIL: the cues alone miss ${String(cuesMisses.length)} dialog fixture(s) of the other harnesses:`);
  for (const name of cuesMisses) console.log(`  ${name}`);
} else {
  console.log("ok: the cues alone read every dialog fixture of the other harnesses as a modal");
}
if (unlabelled > 0) {
  failed = true;
  console.log("FAIL: every pane fixture needs a row in web/src/fixtures/surface-labels.json");
}
process.exit(failed ? 1 : 0);
