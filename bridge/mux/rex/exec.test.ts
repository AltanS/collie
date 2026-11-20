import { describe, expect, test } from "bun:test";

import { defaultRexSocket, rexBinaryCandidates, rexChildEnv } from "./exec.ts";

// The macOS facts these pin were probed against the Rex.app-managed server, rex 0.0.1793974979
// (API revision 11), on an Apple-silicon Mac (MUX_CONTRACT.md, RX): the app exports REX_BIN_DIR into
// every block pointing inside its bundle, the default socket lives under Application Support, and an
// ambient REX_SESSION scopes every bare `-b` to that session alone.

describe("rexBinaryCandidates", () => {
  test("rex's own REX_BIN_DIR comes first", () => {
    expect(rexBinaryCandidates("/home/o", "/Applications Support/bundle/MacOS")).toEqual([
      "/Applications Support/bundle/MacOS/rex",
      "/home/o/.local/bin/rex",
      "/usr/local/bin/rex",
      "/usr/bin/rex",
      "/bin/rex",
      "/opt/homebrew/bin/rex",
      "/opt/local/bin/rex",
    ]);
  });

  test("no REX_BIN_DIR leaves the fixed prefixes", () => {
    expect(rexBinaryCandidates("/home/o", "")).not.toContain("/rex");
    expect(rexBinaryCandidates("/home/o", "  ")).toEqual([
      "/home/o/.local/bin/rex",
      "/usr/local/bin/rex",
      "/usr/bin/rex",
      "/bin/rex",
      "/opt/homebrew/bin/rex",
      "/opt/local/bin/rex",
    ]);
  });
});

describe("rexChildEnv", () => {
  test("strips the ambient session and block scope, keeps the rest, never mutates the source", () => {
    const env = { PATH: "/usr/bin", REX_SESSION: "session:1", REX_BLOCK: "block:1", REX_SERVER: "unix:///x" };
    expect(rexChildEnv(env)).toEqual({ PATH: "/usr/bin", REX_SERVER: "unix:///x" });
    expect(env).toEqual({ PATH: "/usr/bin", REX_SESSION: "session:1", REX_BLOCK: "block:1", REX_SERVER: "unix:///x" });
  });
});

describe("defaultRexSocket", () => {
  test("XDG_RUNTIME_DIR wins on every platform — it is how a throwaway server is placed", () => {
    expect(defaultRexSocket("/tmp/run", 1000, "/home/o", "darwin")).toBe("/tmp/run/rex/server.sock");
    expect(defaultRexSocket("/run/user/1000", 1000, "/home/o", "linux")).toBe("/run/user/1000/rex/server.sock");
  });

  // "" — not undefined: an explicit undefined wakes the parameter's own default, which reads this
  // process's XDG_RUNTIME_DIR, and a Linux CI runner always has one (probed the hard way).
  test("a Mac with no XDG runtime dir reads the app-managed Application Support socket", () => {
    expect(defaultRexSocket("", 501, "/Users/o", "darwin")).toBe("/Users/o/Library/Application Support/rex/server.sock");
  });

  test("Linux keeps /run/user when nothing is configured", () => {
    expect(defaultRexSocket("", 1000, "/home/o", "linux")).toBe("/run/user/1000/rex/server.sock");
  });
});
