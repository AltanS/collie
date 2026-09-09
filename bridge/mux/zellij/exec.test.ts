import { describe, expect, test } from "bun:test";

import { NO_ZELLIJ_BINARY, resolveZellijBinary, timedOutMessage, zellijBinaryCandidates } from "./exec.ts";

// THE PURE HALF OF exec.ts. `SpawnZellijExec` needs `Bun.spawn` and is therefore out of the pure
// layer by CLAUDE.md § Tests — but the two decisions it makes with no process at all are here,
// because both reach an operator as a sentence they have to act on.

describe("timedOutMessage", () => {
  // The line this replaced: a killed child hands back empty pipes, and an empty listing used to
  // arrive as *could not read the session's listing: not JSON*. That sends the reader after a parse
  // bug in zellij when the real cause is a machine too busy to spawn a process inside 5 s
  // (measured five times on one peer during a `crew update` push, M22/04 zellij leg).
  test("names the verb, the budget, and the cause", () => {
    const message = timedOutMessage(["action", "list-panes", "--all", "--json"], 5000);
    expect(message).toContain("action list-panes");
    expect(message).toContain("5000ms");
    expect(message).toContain("too busy");
    expect(message).not.toContain("not JSON");
  });

  test("a flags-only argv still says something", () => {
    expect(timedOutMessage(["--json"], 250)).toContain("the call");
  });
});

describe("resolveZellijBinary", () => {
  test("a configured absolute path that is there wins over every candidate", () => {
    expect(resolveZellijBinary("/opt/zellij", (path) => path === "/opt/zellij")).toBe("/opt/zellij");
  });

  test("a configured path that is not there resolves to nothing rather than falling back", () => {
    // Fail closed: an operator who named a binary gets `reachable() === false` and the doctor's
    // sentence about it, never a silently different zellij.
    expect(resolveZellijBinary("/opt/zellij", () => false)).toBeNull();
  });

  test("a relative name is refused — PATH is not this process's to trust", () => {
    expect(resolveZellijBinary("zellij", () => true)).toBeNull();
  });

  test("with nothing configured, the operator's own install directory is probed first", () => {
    const candidates = zellijBinaryCandidates("/home/op");
    expect(candidates.at(0)).toBe("/home/op/.local/bin/zellij");
    expect(resolveZellijBinary("", (path) => path === "/usr/bin/zellij", candidates)).toBe("/usr/bin/zellij");
  });

  test("no zellij anywhere is null, and the message says what to set", () => {
    expect(resolveZellijBinary("", () => false, zellijBinaryCandidates("/home/op"))).toBeNull();
    expect(NO_ZELLIJ_BINARY).toContain("COLLIE_ZELLIJ_BIN");
  });
});
