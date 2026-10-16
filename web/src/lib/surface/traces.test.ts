import { describe, expect, it } from "vitest";

import { fixtureText, fixtureTraces, loadTraceFiles } from "../../test/surface-traces";
import { freeSteps, HOOK_MODES, parseTrace, replayTrace, TraceError, type Trace } from "./trace";

// M56 spec 11: the golden traces. Every trace file and every labelled pane fixture (as a one-read
// trace) replays through the real fold three ways: the hook source present, removed, and lying. A
// negative trace never reads free in any of the three. A trace's own expectations hold with the hook
// source present.

const files = loadTraceFiles();
const all: Trace[] = [...files, ...fixtureTraces()];
const negative = all.filter((trace) => trace.header.set === "negative");

describe("golden traces on disk", () => {
  it("has the required lab and synthetic traces, each with a header", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const trace of files) expect(trace.header.note.length).toBeGreaterThan(0);
    expect(negative.length).toBeGreaterThan(files.filter((trace) => trace.header.set === "negative").length);
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

  for (const trace of files) {
    it(`${trace.name}: the expectations hold with the hook source present`, () => {
      const mismatches = replayTrace(trace, { mode: "present", fixture: fixtureText }).flatMap((result) =>
        result.mismatches.map((line) => `step ${String(result.index + 1)}: ${line}`),
      );
      expect(mismatches).toEqual([]);
    });
  }
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
