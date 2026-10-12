// What `bun app.ts` reads from the environment, and the platform rule. No socket, no Pi Durable run.
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { optionsFromEnv, platformProblem } from "../app.ts";

describe("options from the environment", () => {
  test("no variable at all: the socket under XDG_RUNTIME_DIR, the data under ~/.local/state, the defence on", () => {
    const o = optionsFromEnv({ XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(o.socket).toBe("/run/user/1000/durable-member/app.sock");
    expect(o.storage).toBe(`${homedir()}/.local/state/durable-member/store`);
    expect(o.notesFile).toBe(`${homedir()}/.local/state/durable-member/notes.txt`);
    expect(o.callerCheck).toBe("descendant");
    expect([o.stepMs, o.slowMs, o.helperMs]).toEqual([undefined, undefined, undefined]);
  });

  test("without XDG_RUNTIME_DIR the socket folder in /tmp carries the uid, so another user cannot own it first", () => {
    expect(optionsFromEnv({}).socket).toBe(`/tmp/durable-member-${process.getuid!()}/app.sock`);
  });

  test("COLLIE_DURABLE_SOCKET, DM_DATA, XDG_STATE_HOME and the timings are read", () => {
    expect(optionsFromEnv({ XDG_STATE_HOME: "/s" }).storage).toBe("/s/durable-member/store");
    expect(optionsFromEnv({ DM_DATA: "", XDG_STATE_HOME: "" }).storage).toBe(`${homedir()}/.local/state/durable-member/store`); // empty reads as unset
    const o = optionsFromEnv({ COLLIE_DURABLE_SOCKET: "/x/y.sock", DM_DATA: "/d", DM_STEP_MS: "0", DM_SLOW_MS: "300", DM_HELPER_MS: "5" });
    expect(o).toMatchObject({ socket: "/x/y.sock", storage: "/d/store", notesFile: "/d/notes.txt", stepMs: 0, slowMs: 300, helperMs: 5 });
  });

  test("a timing that is not a whole number of milliseconds, or an unknown DM_CALLER_CHECK, stops the start", () => {
    for (const v of ["-1", "1.5", "soon"]) expect(() => optionsFromEnv({ DM_STEP_MS: v })).toThrow("DM_STEP_MS");
    expect(() => optionsFromEnv({ DM_CALLER_CHECK: "no" })).toThrow("DM_CALLER_CHECK");
    expect(optionsFromEnv({ DM_CALLER_CHECK: "off" }).callerCheck).toBe("off");
  });
});

describe("the platform rule", () => {
  test("Linux runs with the defence; another OS runs only with DM_CALLER_CHECK=off", () => {
    expect(platformProblem({ callerCheck: "descendant" }, "linux")).toBeUndefined();
    expect(platformProblem({ callerCheck: "descendant" }, "darwin")).toContain("DM_CALLER_CHECK=off");
    expect(platformProblem({ callerCheck: "descendant" }, "win32")).toContain("Linux");
    expect(platformProblem({ callerCheck: "off" }, "darwin")).toBeUndefined();
  });
});
