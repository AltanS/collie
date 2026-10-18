// The Surface corpus (M56 spec 04): every pane fixture with its hand-checked label, read the way the
// bridge's shadow reads a live pane (the block readers lift an ask, the fold computes the Surface
// with the harness's own profile). Shared by the surface tests and `scripts/surface-corpus.ts`, so the
// table the script prints and the cases the tests pin are one reading.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAnsi } from "../lib/ansi";
import { lineText, splitLines, type StyledLine } from "../lib/blocks";
import { displayWidth } from "../lib/text-width";
import type { IdleProfile } from "../lib/surface/frame";
import { surfaceOfScreen, type SurfaceRead } from "../lib/surface/fold";
import { liftAsk, legacyFree, readerBlocks } from "../lib/surface/lift";
import { loadProfiles } from "../lib/surface/profile";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");
export const PANES_DIR = join(FIXTURES_DIR, "panes");
export const SURFACE_FIXTURES_DIR = join(FIXTURES_DIR, "surface");

/**
 * Dialog fixtures the generic cues cannot reach, with the reason. The cues-alone rule (fold.corpus.test.ts,
 * scripts/surface-corpus.ts) skips them by name; the reader of their own harness is what refuses a
 * reply there. This map is the only mechanism for a new cues-blind fixture: name it here with its
 * reason. (The older "-cut" suffix rule stays for the screens truncated on purpose; add no more.)
 */
export const CUES_BLIND = new Map<string, string>([
  [
    "oc--update-available.txt",
    "opencode's Update Available dialog stands over the splash: three blank rows set it apart from the tip and path rows, so the bottom cluster never reaches it",
  ],
  [
    "grok--trust-prompt.txt",
    "Grok's folder trust prompt ends its choices in a key letter at the right edge (`Yes, proceed   y`, `No, quit   n`), which the single-key cue does not read",
  ],
]);

export type FixtureState = "idle" | "draft" | "running" | "popup" | "dialog" | "screen" | "other";

export interface FixtureLabel {
  /** The multiplexer's agent string the fixture was captured under; `shell` for a bare shell. */
  readonly harness: string;
  readonly version: string;
  readonly state: FixtureState;
}

export interface SyntheticScreen {
  readonly base: string;
  readonly drop?: readonly string[];
  readonly replace?: readonly (readonly [string, string])[];
  readonly replaceLast?: readonly [string, string];
}

export interface Incident {
  readonly agent: string;
  readonly fixtures?: readonly string[];
  readonly synthetic?: readonly SyntheticScreen[];
}

export interface SurfaceLabels {
  readonly fixtures: Readonly<Record<string, FixtureLabel>>;
  readonly incidents: Readonly<Record<string, Incident>>;
  /** Fixtures labelled `running` that read free, each with its reason (the `$comment` key dropped). */
  readonly knownMismatches: Readonly<Record<string, string>>;
}

let labels: SurfaceLabels | null = null;

/** The labels file, read once. */
export function loadLabels(): SurfaceLabels {
  if (labels !== null) return labels;
  // SAFETY: a committed file of this repo; fold.corpus.test.ts checks every fixture has a row of this shape.
  // The one key under `incidents` that is no incident is its `$comment`, dropped by name below.
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, "surface-labels.json"), "utf8")) as {
    fixtures: Record<string, FixtureLabel>;
    incidents: Record<string, Incident>;
    knownMismatches?: Record<string, string>;
  };
  const incidents: Record<string, Incident> = {};
  for (const [sha, entry] of Object.entries(raw.incidents)) if (!sha.startsWith("$")) incidents[sha] = entry;
  const knownMismatches: Record<string, string> = {};
  for (const [name, why] of Object.entries(raw.knownMismatches ?? {})) if (!name.startsWith("$")) knownMismatches[name] = why;
  labels = { fixtures: raw.fixtures, incidents, knownMismatches };
  return labels;
}

/** The agent string to hand the block readers for a label's harness, or undefined for a bare shell. */
export function agentOf(harness: string): string | undefined {
  return harness === "shell" ? undefined : harness;
}

const rowsCache = new Map<string, StyledLine[]>();

/** A screen's rows from its raw text. */
export function rowsOf(raw: string): StyledLine[] {
  return splitLines(parseAnsi(raw));
}

/** A pane fixture's rows, parsed once. */
export function fixtureRows(name: string, dir = PANES_DIR): StyledLine[] {
  const key = join(dir, name);
  const hit = rowsCache.get(key);
  if (hit !== undefined) return hit;
  const rows = rowsOf(readFileSync(key, "utf8"));
  rowsCache.set(key, rows);
  return rows;
}

/** The profile `idle` block for a harness, or null when it has none. */
export function idleFor(harness: string): IdleProfile | null {
  return loadProfiles().get(harness)?.idle ?? null;
}

export interface ReadOptions {
  /** False reads with the generic cues alone: no block reader lifts an ask. */
  readonly lift?: boolean;
}

/** One screen through the shadow's pipeline: the readers lift, the fold reads. */
export function readScreen(rows: StyledLine[], agent: string | undefined, idle: IdleProfile | null, options: ReadOptions = {}): SurfaceRead {
  const ask = options.lift === false ? null : liftAsk(readerBlocks(rows, agent), 1);
  return surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows, ask }, idle);
}

/** The old send verdict on a screen, for the shadow comparison. */
export function legacyOf(rows: StyledLine[], agent: string | undefined): boolean {
  return legacyFree(rows, readerBlocks(rows, agent), agent);
}

function plainRow(text: string): StyledLine {
  return { segments: [{ text, style: {}, muted: false }] };
}

/** A synthetic incident screen, rebuilt from its base fixture. */
export function syntheticRows(screen: SyntheticScreen): StyledLine[] {
  let rows = fixtureRows(screen.base);
  for (const pattern of screen.drop ?? []) {
    const re = new RegExp(pattern, "u");
    rows = rows.filter((row) => !re.test(lineText(row)));
  }
  for (const [pattern, replacement] of screen.replace ?? []) {
    const re = new RegExp(pattern, "u");
    rows = rows.map((row) => {
      const text = lineText(row);
      return re.test(text) ? plainRow(text.replace(re, replacement)) : row;
    });
  }
  if (screen.replaceLast !== undefined) {
    const [pattern, text] = screen.replaceLast;
    const re = new RegExp(pattern, "u");
    const i = rows.findLastIndex((row) => re.test(lineText(row)));
    if (i < 0) throw new Error(`${screen.base}: no row matches ${pattern}`);
    rows = [...rows.slice(0, i), plainRow(text), ...rows.slice(i + 1)];
  }
  return rows;
}

export interface IncidentScreen {
  readonly sha: string;
  readonly agent: string;
  readonly name: string;
  readonly rows: StyledLine[];
}

/** Every incident screen: the captured fixtures and the synthetic rebuilds. */
export function incidentScreens(): IncidentScreen[] {
  const out: IncidentScreen[] = [];
  for (const [sha, incident] of Object.entries(loadLabels().incidents)) {
    for (const name of incident.fixtures ?? []) out.push({ sha, agent: incident.agent, name, rows: fixtureRows(name) });
    (incident.synthetic ?? []).forEach((screen, i) =>
      out.push({ sha, agent: incident.agent, name: `${screen.base} (synthetic ${String(i + 1)})`, rows: syntheticRows(screen) }),
    );
  }
  return out;
}

// ── Perturbations ────────────────────────────────────────────────────────────────────────────────
//
// The profile tests of the design record: a moved row, a dropped border, an extra status row and a
// width change. They are generic, so they run on every screen, framed or not.

const RULE_ROW = /^\s*[─━═╭╮╰╯┌┐└┘├┤┬┴┼│┃╹▀▔▁-]{8,}[^\S\n]*$/u;

function isBlankRow(row: StyledLine): boolean {
  return lineText(row).trim().length === 0;
}

function lastNonBlank(rows: readonly StyledLine[]): number {
  let i = rows.length - 1;
  while (i >= 0 && isBlankRow(rows[i]!)) i--;
  return i;
}

/** A row cut into rows of at most `cols` cells, as a terminal wraps output. */
function hardWrap(row: StyledLine, cols: number): StyledLine[] {
  const cells: StyledLine["segments"] = [];
  for (const segment of row.segments) for (const ch of segment.text) cells.push({ ...segment, text: ch });
  const out: StyledLine[] = [];
  let current: typeof cells = [];
  let used = 0;
  for (const cell of cells) {
    const w = displayWidth(cell.text);
    if (used + w > cols && current.length > 0) {
      out.push({ segments: current });
      current = [];
      used = 0;
    }
    current.push(cell);
    used += w;
  }
  out.push({ segments: current });
  return out;
}

function screenWidth(rows: readonly StyledLine[]): number {
  return rows.reduce((max, row) => Math.max(max, displayWidth(lineText(row).trimEnd())), 0);
}

/** A rule row drawn 20 cells longer, as a wider terminal draws it; any other row as it is. */
function widerRule(row: StyledLine): StyledLine {
  const text = lineText(row).trimEnd();
  if (!RULE_ROW.test(text)) return row;
  const last = text.at(-1)!;
  const longer = /[╮╯┐┘┤]/u.test(last) ? `${text.slice(0, -1)}${"─".repeat(20)}${last}` : `${text}${last.repeat(20)}`;
  return plainRow(longer);
}

export interface Perturbation {
  readonly name: string;
  readonly rows: StyledLine[];
}

/** The perturbed copies of one screen. */
export function perturbations(rows: readonly StyledLine[]): Perturbation[] {
  const end = lastNonBlank(rows);
  if (end < 1) return [];
  const list: Perturbation[] = [];
  const at = (i: number, ...insert: StyledLine[]): StyledLine[] => [...rows.slice(0, i), ...insert, ...rows.slice(i)];
  const without = (i: number): StyledLine[] => [...rows.slice(0, i), ...rows.slice(i + 1)];

  list.push({ name: "the last row moved up one", rows: [...rows.slice(0, end - 1), rows[end]!, rows[end - 1]!, ...rows.slice(end + 1)] });
  list.push({ name: "a blank row over the last row", rows: at(end, plainRow("")) });
  list.push({ name: "one more status row at the bottom", rows: at(end + 1, plainRow("  one more status row · ok")) });
  list.push({ name: "one more status row over the last row", rows: at(end, plainRow("  one more status row · ok")) });

  const rules: number[] = [];
  for (let i = end; i >= 0 && end - i < 40; i--) if (RULE_ROW.test(lineText(rows[i]!))) rules.push(i);
  if (rules.length > 0) list.push({ name: "the lowest border dropped", rows: without(rules[0]!) });
  if (rules.length > 1) list.push({ name: "the highest border dropped", rows: without(rules.at(-1)!) });

  const width = screenWidth(rows);
  if (width >= 60) list.push({ name: `re-wrapped at ${String(width - 20)} columns`, rows: rows.flatMap((row) => hardWrap(row, width - 20)) });
  list.push({ name: "20 columns wider", rows: rows.map(widerRule) });
  return list;
}
