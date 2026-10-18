// Pure-logic tests of web/e2e/rig/sock-path.ts: where the rig's scratch Herdr keeps its sockets and
// the length guard in front of them. NO Herdr, no rig, no process: strings in, strings out. It sits in
// scripts/ for the reason browser-leg-nightly.test.ts does: `bun test ./scripts` runs it there.
import { describe, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";

import { XDG_HOME_NAME, herdrSocketPaths, shortXdgHome, socketPathProblem, sunPathLimit } from "../web/e2e/rig/sock-path";

const SESSION = "collie-rig";
/** The nightly runner's state root on 2026-10-18: the one whose Herdr could not open its socket. */
const NIGHTLY_ROOT = "/var/home/altan/.cache/collie-lab/browser-leg-nightly/state";
/** The manual run's default state root. */
const DEFAULT_ROOT = "/var/home/altan/.cache/collie-lab/browser-leg-state";
/** A runtime dir as systemd sets it. Paths are compared through `join`, so the tests hold on Windows too. */
const RUNTIME = "/run/user/1000";

/** An XDG home whose longest Herdr socket path is exactly `bytes` long. */
function xdgForLongestPath(bytes: number): string {
  const tail = join("herdr", "sessions", SESSION, "herdr-client.sock");
  return "/".padEnd(bytes - tail.length - 1, "y");
}

describe("sunPathLimit", () => {
  test("sun_path holds 108 bytes on Linux and 104 on macOS, and the NUL takes one", () => {
    expect(sunPathLimit("linux")).toBe(107);
    expect(sunPathLimit("darwin")).toBe(103);
  });
});

describe("herdrSocketPaths", () => {
  test("Herdr binds the API socket and the client socket in the session folder under the config home", () => {
    expect(herdrSocketPaths("/cfg", SESSION)).toEqual([
      join("/cfg", "herdr", "sessions", "collie-rig", "herdr.sock"),
      join("/cfg", "herdr", "sessions", "collie-rig", "herdr-client.sock"),
    ]);
  });
});

describe("socketPathProblem", () => {
  test("the nightly state root fails: 111 bytes, and the message names the path and its length", () => {
    const problem = socketPathProblem(join(NIGHTLY_ROOT, "rig", "xdg"), SESSION, "linux");
    expect(problem).toContain("111 bytes");
    expect(problem).toContain("107");
    expect(problem).toContain(join(NIGHTLY_ROOT, "rig", "xdg", "herdr", "sessions", SESSION, "herdr-client.sock"));
  });

  test("the default state root fits at 103 bytes", () => {
    expect(socketPathProblem(join(DEFAULT_ROOT, "rig", "xdg"), SESSION, "linux")).toBeNull();
  });

  test("the limit is exact on Linux: 107 bytes fit, 108 do not", () => {
    expect(socketPathProblem(xdgForLongestPath(107), SESSION, "linux")).toBeNull();
    expect(socketPathProblem(xdgForLongestPath(108), SESSION, "linux")).toContain("108 bytes");
  });

  test("the limit is exact on macOS: 103 bytes fit, 104 do not", () => {
    expect(socketPathProblem(xdgForLongestPath(103), SESSION, "darwin")).toBeNull();
    expect(socketPathProblem(xdgForLongestPath(104), SESSION, "darwin")).toContain("104 bytes");
  });

  test("bytes count, not characters: a two-byte letter costs two", () => {
    const once = xdgForLongestPath(106).replace("y", "ä"); // 106 characters, 107 bytes
    const twice = once.replace("y", "ä"); // still 106 characters, 108 bytes
    expect(socketPathProblem(once, SESSION, "linux")).toBeNull();
    expect(socketPathProblem(twice, SESSION, "linux")).toContain("108 bytes");
  });

  test("a long session name trips the guard, even under a short home", () => {
    expect(socketPathProblem("/tmp/collie-rig-1a2b3c4d", "s".repeat(80), "linux")).not.toBeNull();
  });
});

describe("shortXdgHome", () => {
  test("the nightly state root gets a home in the runtime dir whose sockets fit", () => {
    const home = shortXdgHome(NIGHTLY_ROOT, SESSION, RUNTIME, "linux");
    expect(dirname(home)).toBe(join(RUNTIME));
    expect(XDG_HOME_NAME.test(basename(home))).toBe(true);
    expect(socketPathProblem(home, SESSION, "linux")).toBeNull();
  });

  test("the same state root gives the same home, two state roots give two homes", () => {
    const a = shortXdgHome(NIGHTLY_ROOT, SESSION, RUNTIME, "linux");
    expect(shortXdgHome(NIGHTLY_ROOT, SESSION, RUNTIME, "linux")).toBe(a);
    expect(shortXdgHome(DEFAULT_ROOT, SESSION, RUNTIME, "linux")).not.toBe(a);
    expect(shortXdgHome(join(NIGHTLY_ROOT, "..", "other"), SESSION, RUNTIME, "linux")).not.toBe(a);
  });

  test("without a runtime dir the home is in /tmp", () => {
    const home = shortXdgHome(NIGHTLY_ROOT, SESSION, undefined, "linux");
    expect(dirname(home)).toBe(join("/tmp"));
    expect(XDG_HOME_NAME.test(basename(home))).toBe(true);
    expect(socketPathProblem(home, SESSION, "linux")).toBeNull();
  });

  test("a relative runtime dir is not trusted: the home is in /tmp", () => {
    expect(dirname(shortXdgHome(NIGHTLY_ROOT, SESSION, "run/user", "linux"))).toBe(join("/tmp"));
  });

  test("a runtime dir that is too long for the sockets gives way to /tmp", () => {
    const longRuntime = `/${"r".repeat(90)}`;
    expect(dirname(shortXdgHome(NIGHTLY_ROOT, SESSION, longRuntime, "linux"))).toBe(join("/tmp"));
  });

  test("a session name too long even for /tmp still returns the /tmp home, so the guard can say so", () => {
    const home = shortXdgHome(NIGHTLY_ROOT, "s".repeat(90), RUNTIME, "linux");
    expect(dirname(home)).toBe(join("/tmp"));
    expect(socketPathProblem(home, "s".repeat(90), "linux")).not.toBeNull();
  });
});
