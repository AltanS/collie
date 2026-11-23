import { describe, expect, test } from "bun:test";

import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "../beacon/types.ts";
import { promptStateAfter } from "./edges.ts";

// The prompt latch at a start edge, by the start's `source`. Only a start that opens an empty conversation (`startup`,
// `clear`) makes a pane `no-prompt-yet`. A `resume` or a `fork` opens a conversation that already holds prompts, in the
// same process the latch may have been `no-prompt-yet` for, so it makes the state `unknown`. A `compact` follows prompts
// of the same conversation and keeps what is known.

const PID = 4242;
const START = 777;

function start(source: string | undefined): EdgeRecord {
  const base: EdgeRecord = { schemaVersion: EDGE_SCHEMA_VERSION, harness: "claude", event: "SessionStart", detail: source ?? null, pid: PID, pidStartTime: START, markers: [], at: 1_000_000, promptHash: null };
  return source === undefined ? base : { ...base, source };
}

const SAME = { pid: PID, pidStartTime: START };

describe("the prompt latch at a start edge", () => {
  test("startup and clear make no-prompt-yet, whatever was known", () => {
    for (const source of ["startup", "clear"]) {
      for (const prompt of ["no-prompt-yet", "prompted", "unknown"] as const) expect(promptStateAfter({ ...SAME, prompt }, start(source), "start")).toBe("no-prompt-yet");
      expect(promptStateAfter(undefined, start(source), "start")).toBe("no-prompt-yet");
    }
  });

  test("resume and fork make unknown in the same process, whatever was known", () => {
    for (const source of ["resume", "fork"]) {
      for (const prompt of ["no-prompt-yet", "prompted", "unknown"] as const) expect(promptStateAfter({ ...SAME, prompt }, start(source), "start")).toBe("unknown");
      expect(promptStateAfter(undefined, start(source), "start")).toBe("unknown");
    }
  });

  test("compact keeps the known state while the process is the same", () => {
    for (const prompt of ["no-prompt-yet", "prompted", "unknown"] as const) expect(promptStateAfter({ ...SAME, prompt }, start("compact"), "start")).toBe(prompt);
    expect(promptStateAfter({ pid: PID + 1, pidStartTime: START, prompt: "prompted" }, start("compact"), "start")).toBe("unknown");
  });

  test("another source or none keeps the known state, as before", () => {
    for (const source of ["teleport", undefined]) expect(promptStateAfter({ ...SAME, prompt: "no-prompt-yet" }, start(source), "start")).toBe("no-prompt-yet");
  });

  test("a prompt edge still makes prompted", () => {
    expect(promptStateAfter({ ...SAME, prompt: "no-prompt-yet" }, start(undefined), "prompt")).toBe("prompted");
  });
});
