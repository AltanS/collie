import type { JsonValue } from "./json";
import { paneBadge, paneHeaderLine, paneProgress, paneSubtitle } from "./pane-marks";
import type { AgentView } from "./types";

// A crew peer's pane arrives unchecked, so these helpers take any JSON shape for the field.
// SAFETY: the cases below pass the wrong shapes a peer could send; the helpers under test read the field through the JSON guards.
const badge = (value: JsonValue | undefined) => paneBadge({ badge: value as AgentView["badge"] });
// SAFETY: as above, for the subtitle field.
const subtitle = (value: JsonValue | undefined) => paneSubtitle({ subtitle: value as AgentView["subtitle"] });

describe("pane marks: subtitle", () => {
  it("reads a trimmed non-empty string, and nothing else", () => {
    expect(subtitle("  a customer cannot log in ")).toBe("a customer cannot log in");
    for (const value of [undefined, null, "", "   ", 3, {}, ["x"]]) expect(subtitle(value)).toBeNull();
  });
});

describe("pane marks: badge", () => {
  it("reads a whole count from 1 to 9999 and a non-empty text", () => {
    expect(badge({ count: 1 })).toBe("1");
    expect(badge({ count: 9999 })).toBe("9999");
    expect(badge({ text: " new " })).toBe("new");
  });

  it("reads zero, a fraction, a count out of range and every other shape as no badge", () => {
    for (const value of [{ count: 0 }, { count: 1.5 }, { count: 10000 }, { count: -2 }, { count: "3" }, { text: "" }, { text: 4 }, { count: 2, text: "x" }, {}, null, undefined, 7, "3", []]) {
      expect(badge(value)).toBeNull();
    }
  });
});

const progressOf = (progress: JsonValue | undefined, status: AgentView["status"] = "working") =>
  // SAFETY: as above, a crew peer's body is not checked on the way here; the helper reads the field through the JSON guards.
  paneProgress({ progress: progress as AgentView["progress"], status });

describe("pane marks: progress", () => {
  const steps = (...states: string[]) => ({ kind: "steps", steps: states.map((state, index) => ({ label: `step ${index + 1}`, state })) });

  it("reads a step list as the running step with its place in the list, and the done share as the fill", () => {
    expect(progressOf(steps("done", "running", "todo"))).toEqual({ kind: "steps", label: "step 2", n: 2, m: 3, value: (1 / 3) * 100 });
  });

  // M53 spec 12: "Step n of m" counts the running step, and the bar fills by the steps that are done,
  // done / m. The two agree while one step runs, and a list with every step done fills to full.
  it("header line: the bar fills done / m, whatever step runs", () => {
    expect(progressOf(steps("todo", "done", "running"))).toEqual({ kind: "steps", label: "step 3", n: 3, m: 3, value: (1 / 3) * 100 });
    expect(progressOf(steps("running", "done", "done"))).toMatchObject({ n: 1, m: 3, value: (2 / 3) * 100 });
    expect(progressOf(steps("done", "done", "done"))).toMatchObject({ n: 3, m: 3, value: 100 });
  });

  it("reads the first step still to do when none runs, and the last step when all are done", () => {
    expect(progressOf(steps("done", "todo", "todo"))).toMatchObject({ label: "step 2", n: 2, m: 3 });
    expect(progressOf(steps("done", "done"))).toEqual({ kind: "steps", label: "step 2", n: 2, m: 2, value: 100 });
  });

  it("reads a percent with its label, or without one", () => {
    expect(progressOf({ kind: "percent", value: 40, label: " uploading " })).toEqual({ kind: "percent", label: "uploading", value: 40 });
    expect(progressOf({ kind: "percent", value: 0 })).toEqual({ kind: "percent", label: null, value: 0 });
  });

  it("draws only while the pane works or waits", () => {
    for (const status of ["idle", "done", "unknown"] as const) expect(progressOf({ kind: "percent", value: 10 }, status)).toBeNull();
    expect(progressOf({ kind: "percent", value: 10 }, "blocked")).not.toBeNull();
  });

  it("reads every shape the bridge would not have kept as no progress", () => {
    for (const value of [
      undefined,
      null,
      "half way",
      [],
      {},
      { kind: "ring", value: 3 },
      { kind: "percent", value: 101 },
      { kind: "percent", value: -1 },
      { kind: "percent", value: "40" },
      { kind: "steps", steps: [] },
      { kind: "steps", steps: "a" },
      steps("paused"),
      { kind: "steps", steps: [{ state: "done" }] },
      { kind: "steps", steps: [{ label: " ", state: "done" }] },
    ]) {
      expect(progressOf(value)).toBeNull();
    }
  });
});

describe("pane marks: the header line", () => {
  const reading = (progress: JsonValue) => progressOf(progress);

  it("header line: the running step leads, as Step n of m with its label", () => {
    const steps = { kind: "steps", steps: [{ label: "read", state: "done" }, { label: "write a note", state: "running" }, { label: "reply", state: "todo" }] };
    expect(paneHeaderLine(reading(steps), "a subtitle")).toBe("Step 2 of 3: write a note");
  });

  it("header line: a percent reads as the rounded number and its label, or the number alone", () => {
    expect(paneHeaderLine(reading({ kind: "percent", value: 41.6, label: "uploading" }), "a subtitle")).toBe("42%: uploading");
    expect(paneHeaderLine(reading({ kind: "percent", value: 40 }), "a subtitle")).toBe("40%");
  });

  it("header line: a step list with every step done gives the line back to the subtitle", () => {
    const done = { kind: "steps", steps: [{ label: "read", state: "done" }, { label: "reply", state: "done" }] };
    expect(paneHeaderLine(reading(done), "a subtitle")).toBe("a subtitle");
    expect(paneHeaderLine(reading(done), null)).toBeNull();
    // Nothing runs yet, but a step is still to do: that step is named.
    const next = { kind: "steps", steps: [{ label: "read", state: "done" }, { label: "reply", state: "todo" }] };
    expect(paneHeaderLine(reading(next), "a subtitle")).toBe("Step 2 of 2: reply");
  });

  it("header line: the subtitle when there is no progress, and nothing when there is neither", () => {
    expect(paneHeaderLine(null, "a subtitle")).toBe("a subtitle");
    expect(paneHeaderLine(null, null)).toBeNull();
  });
});
