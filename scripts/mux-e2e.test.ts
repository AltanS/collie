// The failure paths of scripts/mux-e2e.ts that a passing live run never shows: a malformed command
// line, a hung subprocess and a teardown that did not finish. The live run itself needs real
// multiplexers and stays out of this suite.

import { describe, expect, test } from "bun:test";

import { parseArgs, run, withCleanup, type Result } from "./mux-e2e.ts";

describe("parseArgs", () => {
  test("no arguments drive every multiplexer", () => {
    expect(parseArgs([])).toEqual({ ok: true, muxes: ["tmux", "zellij", "tuios"] });
  });

  test("--mux picks one", () => {
    expect(parseArgs(["--mux", "zellij"])).toEqual({ ok: true, muxes: ["zellij"] });
  });

  test("a bare --mux, an unknown name or a stray flag is refused, never widened to all three", () => {
    for (const args of [["--mux"], ["--mux", "screen"], ["--mux", "tmux", "--keep"], ["--muxx", "tmux"], ["tmux"]]) {
      expect(parseArgs(args).ok).toBe(false);
    }
  });
});

describe("run", () => {
  test("a hung child is killed at its deadline and says so", async () => {
    const started = Date.now();
    const r = await run([process.execPath, "-e", "await Bun.sleep(10000)"], { PATH: process.env.PATH ?? "" }, process.cwd(), 300);
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("killed after 300 ms");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a child that finishes in time is not marked", async () => {
    const r = await run([process.execPath, "-e", "console.log('done')"], { PATH: process.env.PATH ?? "" }, process.cwd(), 10000);
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.out.trim()).toBe("done");
  });
});

describe("withCleanup", () => {
  const passed: Result = { mux: "tmux", verdict: "pass", lines: ["probe exit 0, 12 checks passed"] };

  test("a pass whose teardown failed is a fail, with the problem in its lines", () => {
    const r = withCleanup(passed, ["tmux -S /x kill-server exited 1: no server"]);
    expect(r.verdict).toBe("fail");
    expect(r.lines).toContain("cleanup: tmux -S /x kill-server exited 1: no server");
  });

  test("a clean teardown leaves the verdict alone", () => {
    expect(withCleanup(passed, [])).toEqual(passed);
  });
});
