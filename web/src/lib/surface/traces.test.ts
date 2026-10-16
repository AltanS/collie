import { describe, expect, it } from "vitest";

import { loadLabels } from "../../test/surface-corpus";
import { fixtureText, fixtureTraces, incidentTraces, loadTraceFiles, setOfState } from "../../test/surface-traces";
import { loadProfiles } from "./profile";
import { freeSteps, HOOK_MODES, parseTrace, replayTrace, TraceError, type Trace } from "./trace";

// M56 spec 11: the golden traces. Every trace file and every labelled pane fixture (as a one-read
// trace) replays through the real fold three ways: the hook source present, removed, and lying. A
// negative trace never reads free in any of the three. A trace's own expectations hold with the hook
// source present.

const files = loadTraceFiles();
const incidents = incidentTraces();
const fixtures = fixtureTraces();
const all: Trace[] = [...files, ...fixtures, ...incidents];
const negative = all.filter((trace) => trace.header.set === "negative");
const positive = all.filter((trace) => trace.header.set === "positive");
/** The share of the positive traces of a harness with a profile that must read free (the rule of scripts/surface-corpus.ts). */
const POSITIVE_SHARE = 0.95;

describe("golden traces on disk", () => {
  it("has the required lab and synthetic traces, each with a header", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const trace of files) expect(trace.header.note.length).toBeGreaterThan(0);
    expect(negative.length).toBeGreaterThan(files.filter((trace) => trace.header.set === "negative").length + incidents.length - 1);
  });

  it("codex: has the five Codex lab traces (M56 spec 13)", () => {
    const codex = files.filter((trace) => trace.header.harness === "codex").map((trace) => trace.name);
    expect(codex.toSorted()).toEqual([
      "codex/lab-approval-dialog.jsonl",
      "codex/lab-notify-edge.jsonl",
      "codex/lab-queued-message.jsonl",
      "codex/lab-running-turn.jsonl",
      "codex/lab-steered-draft.jsonl",
    ]);
  });

  it("opencode: has a running turn and a dialog trace (M56 spec 14)", () => {
    const names = files.filter((trace) => trace.header.harness === "opencode").map((trace) => trace.name);
    expect(names.toSorted()).toEqual(["opencode/lab-approval-dialog.jsonl", "opencode/lab-running-turn.jsonl"]);
  });

  it("pi: has a running turn, a queued message and a dialog trace (M56 spec 14)", () => {
    const names = files.filter((trace) => trace.header.harness === "pi").map((trace) => trace.name);
    expect(names.toSorted()).toEqual(["pi/lab-model-dialog.jsonl", "pi/lab-queued-message.jsonl", "pi/lab-running-turn.jsonl"]);
  });

  it("omp: has a running turn, a queued message and a dialog trace (M56 spec 14)", () => {
    const names = files.filter((trace) => trace.header.harness === "omp").map((trace) => trace.name);
    expect(names.toSorted()).toEqual(["omp/lab-model-dialog.jsonl", "omp/lab-queued-message.jsonl", "omp/lab-running-turn.jsonl"]);
  });

  /** The omp running-turn reads with one running sign taken away at a time (the Working row blinks; the top row's spinner does not). */
  describe("omp: each running sign on its own (M56 spec 14 review)", () => {
    const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`, "gu");
    const WORKING = /^.*[⠀-⣿⎋]\s+Working….*$/mu;
    const TOP_SPINNER = /^(\s?)[⠀-⣿]\s+\d+s(\s.*▶.*)$/mu;
    const running = files.find((trace) => trace.name === "omp/lab-running-turn.jsonl")!;
    const turn = running.steps.filter((step) => "read" in step && step.expect?.turn === "running");
    const without = (change: (text: string) => string): Trace => ({
      ...running,
      steps: turn.map((step) => {
        if (!("read" in step) || step.read.text === undefined) throw new Error("a running step reads its screen text");
        const text = change(step.read.text);
        // The change must take one running row away, or the test would pass on the screen as it was.
        if (text === step.read.text) throw new Error("the running row to take away is not on this read");
        return { at: step.at, read: { ...step.read, text } };
      }),
    });
    const blank = (text: string): string => text.split("\n").map((row) => (WORKING.test(row.replace(SGR, "")) ? "" : row)).join("\n");
    const idleTop = (text: string): string => text.split("\n").map((row) => { const plain = row.replace(SGR, ""); return TOP_SPINNER.test(plain) ? plain.replace(TOP_SPINNER, "$1π$2") : row; }).join("\n");

    it("the top row's spinner and seconds alone show the turn: the Working row blank on every read, none reads free", () => {
      expect(turn.length).toBeGreaterThan(2);
      const results = replayTrace(without(blank), { mode: "present", fixture: fixtureText });
      for (const result of results) expect(result.surface.turn, `step ${String(result.index)}`).toBe("running");
      expect(freeSteps(results)).toEqual([]);
    });

    it("the Working row alone shows the turn: the top row reads as at rest, none reads free", () => {
      const results = replayTrace(without(idleTop), { mode: "present", fixture: fixtureText });
      for (const result of results) expect(result.surface.turn, `step ${String(result.index)}`).toBe("running");
      expect(freeSteps(results)).toEqual([]);
    });
  });

  for (const trace of files) {
    it(`${trace.name}: the expectations hold with the hook source present`, () => {
      const mismatches = replayTrace(trace, { mode: "present", fixture: fixtureText }).flatMap((result) =>
        result.mismatches.map((line) => `step ${String(result.index + 1)}: ${line}`),
      );
      expect(mismatches).toEqual([]);
    });
  }
});

describe("the sets, marked by label (traces/README.md)", () => {
  it("puts every dialog and screen label in the negative set, and no other label", () => {
    const labels = loadLabels().fixtures;
    const marked = fixtures.filter((trace) => trace.header.set === "negative").map((trace) => trace.name.replace("fixture ", ""));
    const expected = Object.entries(labels).filter(([, label]) => label.state === "dialog" || label.state === "screen").map(([name]) => name);
    expect(marked.toSorted()).toEqual(expected.toSorted());
    expect(setOfState("dialog")).toBe("negative");
    expect(setOfState("screen")).toBe("negative");
    expect(setOfState("idle")).toBe("positive");
    for (const state of ["draft", "running", "popup", "other"]) expect(setOfState(state)).toBeNull();
  });

  it("holds the eight incidents, each as a negative trace that expects no free", () => {
    expect(new Set(incidents.map((trace) => trace.header.source)).size).toBe(8);
    for (const trace of incidents) {
      expect(trace.header.set).toBe("negative");
      expect(trace.steps.every((step) => step.expect?.free === false)).toBe(true);
    }
  });

  it("never reads free: every negative trace, with the hook source present, step by step", () => {
    const failures = negative.flatMap((trace) =>
      replayTrace(trace, { mode: "present", fixture: fixtureText }).flatMap((result) => result.mismatches.map((line) => `${trace.name}: ${line}`)),
    );
    expect(failures).toEqual([]);
  });

  it("reads free on at least 95% of the positive traces of a harness with a profile", () => {
    const profiled = positive.filter((trace) => loadProfiles().has(trace.header.harness));
    expect(profiled.length).toBeGreaterThan(0);
    const missed = profiled.filter((trace) => freeSteps(replayTrace(trace, { mode: "present", fixture: fixtureText })).length === 0);
    expect((profiled.length - missed.length) / profiled.length).toBeGreaterThanOrEqual(POSITIVE_SHARE);
  });

  it("a negative trace that reads free is caught: the rule has teeth", () => {
    const idle = positive.find((trace) => loadProfiles().has(trace.header.harness));
    expect(idle).toBeDefined();
    const lying: Trace = { ...idle!, header: { ...idle!.header, set: "negative" } };
    expect(freeSteps(replayTrace(lying, { mode: "present", fixture: fixtureText })).length).toBeGreaterThan(0);
  });
});

describe("the hook source varied", () => {
  for (const mode of HOOK_MODES) {
    it(`never free: every negative trace, with the hook source ${mode}`, () => {
      const freed = negative.flatMap((trace) => freeSteps(replayTrace(trace, { mode, fixture: fixtureText })).map((step) => `${trace.name} step ${String(step + 1)}`));
      expect(freed).toEqual([]);
    });
  }

  it("hook source removed: the screen alone decides, so a free screen after a prompt edge reads free", () => {
    const trace = files.find((t) => t.name === "claude/synthetic-contested.jsonl");
    expect(trace).toBeDefined();
    const removed = replayTrace(trace!, { mode: "removed", fixture: fixtureText });
    const present = replayTrace(trace!, { mode: "present", fixture: fixtureText });
    expect(removed[1]?.surface.reason).toBeUndefined();
    expect(present[1]?.surface.reason).toBe("contested");
  });

  it("hook source lying: a closing edge before every read never frees a running screen", () => {
    const trace = files.find((t) => t.name === "claude/synthetic-stop-edge-spinner.jsonl");
    const lying = replayTrace(trace!, { mode: "lying", fixture: fixtureText });
    expect(lying[1]?.surface.turn).toBe("running");
    expect(lying[3]?.surface.turn).toBe("running");
  });

  it("hook source removed: a prompt edge closes no receipt", () => {
    const trace = files.find((t) => t.name === "claude/synthetic-prompt-closes-receipt.jsonl");
    const removed = replayTrace(trace!, { mode: "removed", fixture: fixtureText });
    expect(removed.at(-1)?.receipts).toEqual({ r1: "open" });
  });
});

describe("the trace format", () => {
  const header = JSON.stringify({ kind: "trace", harness: "claude", version: "2.1.201", set: "negative", source: "test", note: "test" });

  it("refuses a file with no header, a bad step, or no step", () => {
    expect(() => parseTrace("x", '{"at":0,"tick":true}')).toThrow(TraceError);
    expect(() => parseTrace("x", `${header}\n{"at":0,"jump":true}`)).toThrow(TraceError);
    expect(() => parseTrace("x", header)).toThrow(TraceError);
  });

  it("reads a step that names a fixture or carries the screen text", () => {
    const trace = parseTrace("x", `${header}\n{"at":0,"read":{"rows":2,"cols":10,"text":"hello"}}\n{"at":5,"edge":{"event":"Stop"},"expect":{"free":false}}`);
    expect(trace.steps).toHaveLength(2);
  });
});
