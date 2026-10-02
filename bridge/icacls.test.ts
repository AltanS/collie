import { describe, expect, test } from "bun:test";

import { ACL_TIMEOUT_MS, aclTool, type Runner, type RunResult, type Scratch, systemTool } from "./icacls.ts";

/** A runner that records each argv and answers from a queue (the last answer repeats). */
function fakeRunner(answers: (RunResult | null)[] = [{ code: 0, stdout: "", timedOut: false }]) {
  const calls: { argv: string[]; timeoutMs: number }[] = [];
  let n = 0;
  const runner: Runner = {
    run(argv, timeoutMs) {
      calls.push({ argv: [...argv], timeoutMs });
      return answers[Math.min(n++, answers.length - 1)] ?? null;
    },
  };
  return { runner, calls };
}

/** A scratch folder in memory: what `/save` would have written, and what `/restore` was given. */
function fakeScratch(saved: string | null = null) {
  const removed: string[] = [];
  const scratch: Scratch = {
    file: () => "C:\\Users\\pat\\AppData\\Local\\Temp\\collie-acl-1.txt",
    readUtf16: () => saved,
    remove: (path) => void removed.push(path),
  };
  return { scratch, removed };
}

const ENV = { SystemRoot: "D:\\Win" };

describe("every tool runs by its absolute path under SystemRoot", () => {
  test("SystemRoot decides; an unset or empty one falls back to C:\\Windows, never to a bare name", () => {
    expect(systemTool(ENV, "icacls.exe")).toBe("D:\\Win\\System32\\icacls.exe");
    expect(systemTool({}, "icacls.exe")).toBe("C:\\Windows\\System32\\icacls.exe");
    expect(systemTool({ SystemRoot: "" }, "whoami.exe")).toBe("C:\\Windows\\System32\\whoami.exe");
  });

  test("save: the exact vector, bounded, and the temp file removed", () => {
    const { runner, calls } = fakeRunner();
    const { scratch, removed } = fakeScratch("x\r\nD:(A;;FA;;;SY)\r\n");
    const tool = aclTool(runner, ENV, scratch);
    expect(tool.save("C:\\s", true)).toEqual({ kind: "ok", code: 0, text: "x\r\nD:(A;;FA;;;SY)\r\n" });
    expect(tool.save("C:\\s", false).kind).toBe("ok");
    expect(calls.map((c) => c.argv)).toEqual([
      ["D:\\Win\\System32\\icacls.exe", "C:\\s", "/save", "C:\\Users\\pat\\AppData\\Local\\Temp\\collie-acl-1.txt", "/T", "/C", "/Q"],
      ["D:\\Win\\System32\\icacls.exe", "C:\\s", "/save", "C:\\Users\\pat\\AppData\\Local\\Temp\\collie-acl-1.txt", "/C", "/Q"],
    ]);
    expect(calls.every((c) => c.timeoutMs === ACL_TIMEOUT_MS && ACL_TIMEOUT_MS === 10_000)).toBe(true);
    expect(removed).toHaveLength(2);
  });

  test("the repair is the icacls call it is given; reset never takes /T and passes /L", () => {
    const { runner, calls } = fakeRunner();
    const tool = aclTool(runner, ENV, fakeScratch().scratch);
    tool.icacls(["C:\\x\\state", "/grant:r", "*S-1-5-18:(OI)(CI)F", "/inheritance:r"]);
    tool.reset("C:\\x\\state\\a.json");
    tool.whoami();
    expect(calls.map((c) => c.argv)).toEqual([
      ["D:\\Win\\System32\\icacls.exe", "C:\\x\\state", "/grant:r", "*S-1-5-18:(OI)(CI)F", "/inheritance:r"],
      ["D:\\Win\\System32\\icacls.exe", "C:\\x\\state\\a.json", "/reset", "/L", "/C", "/Q"],
      ["D:\\Win\\System32\\whoami.exe", "/user", "/fo", "csv", "/nh"],
    ]);
    expect(calls.some((c) => c.argv.includes("/T") && c.argv.includes("/reset"))).toBe(false);
  });

  test("a call that ran out of time is 'timed-out', and one that never started is 'not-run'", () => {
    const { scratch } = fakeScratch("x\r\nD:\r\n");
    expect(aclTool(fakeRunner([{ code: 124, stdout: "", timedOut: true }]).runner, ENV, scratch).save("C:\\s", true)).toEqual({ kind: "timed-out" });
    expect(aclTool(fakeRunner([null]).runner, ENV, scratch).save("C:\\s", true)).toEqual({ kind: "not-run" });
  });

  test("descriptors: one PowerShell by absolute path, quotes doubled, answers matched by index", () => {
    const { runner, calls } = fakeRunner([{ code: 0, stdout: "0\tO:BAD:(A;;FA;;;SY)\r\n2\tO:S-1-5-21-1-2-3-1002D:\r\n", timedOut: false }]);
    const tool = aclTool(runner, ENV, fakeScratch().scratch);
    const got = tool.descriptors(["C:\\a", "C:\\it's", "C:\\c"]);
    expect([...(got ?? new Map())]).toEqual([
      ["C:\\a", "O:BAD:(A;;FA;;;SY)"],
      ["C:\\c", "O:S-1-5-21-1-2-3-1002D:"],
    ]);
    expect(calls[0]!.argv[0]).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0]!.argv.at(-1)).toContain("@('C:\\a','C:\\it''s','C:\\c')");
  });
});
