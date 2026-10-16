// The golden traces on disk (M56 spec 11), and every labelled pane fixture as a one-read trace. The
// format and the replay are in lib/surface/trace.ts; this file only finds the files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseTrace, type Trace, type TraceSet, type TraceStep } from "../lib/surface/trace";
import { FIXTURES_DIR, loadLabels, PANES_DIR } from "./surface-corpus";

export const TRACES_DIR = join(FIXTURES_DIR, "traces");

/** The label states whose screens must never read free: the negative set of the fold tests. */
export const NEGATIVE_STATES = new Set(["dialog", "screen"]);

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
 * Each labelled pane fixture as a trace of one read. A dialog or screen fixture is negative and expects
 * no free; every other one is positive and expects nothing, because the fold tests own its label.
 * The text is not copied: the read names the fixture.
 */
export function fixtureTraces(): Trace[] {
  return Object.entries(loadLabels().fixtures)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, label]) => {
      const set: TraceSet = NEGATIVE_STATES.has(label.state) ? "negative" : "positive";
      const read: TraceStep = { at: 0, read: { rows: 0, cols: 0, fixture: name } };
      const step: TraceStep = set === "negative" ? { ...read, expect: { free: false } } : read;
      const trace: Trace = {
        name: `fixture ${name}`,
        header: { kind: "trace", harness: label.harness, version: label.version, set, source: `fixtures/panes/${name}`, note: `one read, labelled ${label.state}` },
        steps: [step],
      };
      return trace;
    });
}
