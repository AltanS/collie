// The golden traces on disk (M56 spec 11), and every labelled pane fixture as a one-read trace. The
// format and the replay are in lib/surface/trace.ts; this file only finds the files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseTrace, type Trace, type TraceSet, type TraceStep } from "../lib/surface/trace";
import { loadProfiles } from "../lib/surface/profile";
import { FIXTURES_DIR, incidentScreens, loadLabels, PANES_DIR } from "./surface-corpus";

export const TRACES_DIR = join(FIXTURES_DIR, "traces");

/** The label states whose screens must never read free: the negative set of the fold tests. */
export const NEGATIVE_STATES = new Set(["dialog", "screen"]);
/** The label state whose screens read free on a harness with a profile: the positive set. */
export const POSITIVE_STATE = "idle";

/** The set a label puts a pane fixture in, or null when the label is neither (a draft, a running turn, a popup, other). */
export function setOfState(state: string): TraceSet | null {
  if (NEGATIVE_STATES.has(state)) return "negative";
  return state === POSITIVE_STATE ? "positive" : null;
}

/** A pane fixture's text, for a read that names one. */
export function fixtureText(name: string): string {
  return readFileSync(join(PANES_DIR, name), "utf8");
}

/** Every trace file under `fixtures/traces/<harness>/`, parsed, sorted by path. */
export function loadTraceFiles(): Trace[] {
  if (!existsSync(TRACES_DIR)) return [];
  const out: Trace[] = [];
  for (const harness of readdirSync(TRACES_DIR).toSorted()) {
    const dir = join(TRACES_DIR, harness);
    if (!existsSync(dir) || harness.startsWith(".") || harness.endsWith(".md")) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl")).toSorted()) {
      out.push(parseTrace(`${harness}/${file}`, readFileSync(join(dir, file), "utf8")));
    }
  }
  return out;
}

/**
 * Each labelled pane fixture as a trace of one read, marked by its label (README.md beside the traces
 * has the rule). A dialog or screen label is negative and expects no free. An idle label is positive,
 * and expects free where the harness has a profile (a harness with none reads with the generic cues
 * alone, which never say free). Every other label is in neither set. The text is not copied: the read
 * names the fixture.
 */
export function fixtureTraces(): Trace[] {
  const profiled = loadProfiles();
  const out: Trace[] = [];
  for (const [name, label] of Object.entries(loadLabels().fixtures).toSorted(([a], [b]) => a.localeCompare(b))) {
    const set = setOfState(label.state);
    if (set === null) continue;
    const read: TraceStep = { at: 0, read: { rows: 0, cols: 0, fixture: name } };
    const expect = set === "negative" ? { free: false } : profiled.has(label.harness) ? { free: true } : undefined;
    out.push({
      name: `fixture ${name}`,
      header: { kind: "trace", harness: label.harness, version: label.version, set, source: `fixtures/panes/${name}`, note: `one read, labelled ${label.state}` },
      steps: [expect === undefined ? read : { ...read, expect }],
    });
  }
  return out;
}

/**
 * Each of the eight incident screens as a negative trace of one read (surface-labels.json, `incidents`):
 * the captured screens and the synthetic rebuilds. The rows are handed over parsed, because a rebuilt
 * screen has no file.
 */
export function incidentTraces(): Trace[] {
  return incidentScreens().map((screen) => ({
    name: `incident ${screen.sha} ${screen.name}`,
    header: { kind: "trace", harness: screen.agent, version: "unversioned", set: "negative", source: `incident ${screen.sha}`, note: "one read of a screen a send once landed in, or nearly did" },
    steps: [{ at: 0, read: { rows: 0, cols: 0, styled: screen.rows }, expect: { free: false } }],
  }));
}
