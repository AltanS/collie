import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.ts";
import {
  bindIsWildcard,
  PEER_BROWSER_ENV,
  resolvePackRuntime,
  SOLO_RUNTIME,
  warnsOnWildcardBind,
  type PackRuntime,
} from "./config.ts";
import type { Enrollment } from "./mode.ts";

// Pack config is a pure function of (trust store, env) — driven here with an injected env object
// rather than by mutating process.env, which is what keeps it usable from the startup path without
// a global to restore.

const led = (leadId: string): Enrollment => ({ peers: [], lead: { memberId: leadId } });
const leading = (...ids: string[]): Enrollment => ({
  peers: ids.map((memberId) => ({ memberId })),
  lead: null,
});

describe("resolvePackRuntime — solo costs nothing", () => {
  test("no trust store, empty env → the solo runtime, exactly", () => {
    expect(resolvePackRuntime(null, {})).toEqual(SOLO_RUNTIME);
  });

  test("SOLO_RUNTIME is the value, not a separate story", () => {
    expect(SOLO_RUNTIME).toEqual(resolvePackRuntime(null, {}));
  });

  test("a solo instance ignores the peer-browser key entirely", () => {
    // Setting it changes nothing outside peer mode, so it can never read as 'the lead turned its
    // own UI off' — and a stray value in a shared env file is inert.
    expect(resolvePackRuntime(null, { [PEER_BROWSER_ENV]: "1" })).toEqual(SOLO_RUNTIME);
    expect(resolvePackRuntime(leading("nas"), { [PEER_BROWSER_ENV]: "1" }).peerServesBrowser).toBe(
      false,
    );
  });
});

describe("resolvePackRuntime — mode comes from the roster, never from the env", () => {
  test("the roster decides, and no env value can override it", () => {
    const hostile = { COLLIE_MODE: "lead", COLLIE_PACK_MODE: "solo", [PEER_BROWSER_ENV]: "1" };
    expect(resolvePackRuntime(led("desk"), hostile).mode).toBe("peer");
    expect(resolvePackRuntime(leading("nas"), hostile).mode).toBe("lead");
    expect(resolvePackRuntime(null, hostile).mode).toBe("solo");
  });

  test("a self-contradictory roster surfaces its conflict through the runtime", () => {
    const rt = resolvePackRuntime({ peers: [{ memberId: "nas" }], lead: { memberId: "desk" } }, {});
    expect(rt.mode).toBe("peer");
    expect(rt.conflict).toBeString();
  });
});

describe("resolvePackRuntime — a peer's own browser front door is an explicit choice", () => {
  test("a peer serves no browser by default", () => {
    expect(resolvePackRuntime(led("desk"), {}).peerServesBrowser).toBe(false);
  });

  test("the operator opts back in with COLLIE_PEER_BROWSER", () => {
    for (const v of ["1", "on", "true", "yes", "TRUE"]) {
      expect(resolvePackRuntime(led("desk"), { [PEER_BROWSER_ENV]: v }).peerServesBrowser).toBe(true);
    }
  });

  test("explicit off, blank and garbage all land on the closed default", () => {
    for (const v of ["0", "off", "false", "no", "", "   ", "maybe"]) {
      expect(resolvePackRuntime(led("desk"), { [PEER_BROWSER_ENV]: v }).peerServesBrowser).toBe(
        false,
      );
    }
  });
});

describe("pack config pays no solo tax at the config layer", () => {
  const RUNTIME_KEYS = {
    mode: true,
    peerServesBrowser: true,
    conflict: true,
  } satisfies Record<keyof PackRuntime, true>;

  test("nothing pack-shaped leaked onto Config", () => {
    // The solo baseline pins `keyof Config` exhaustively; this is the same claim from the pack
    // side, so a future pack setting added in the wrong file fails in BOTH places.
    const keys = Object.keys(loadConfig());
    expect(keys.filter((k) => /pack|peer|lead|federat/i.test(k))).toEqual([]);
  });

  test("bridge/config.ts names no pack env key", () => {
    const src = readFileSync(join(import.meta.dir, "..", "config.ts"), "utf8");
    expect(src).not.toContain(PEER_BROWSER_ENV);
  });

  test("the runtime carries exactly these three facts", () => {
    expect(Object.keys(RUNTIME_KEYS).toSorted()).toEqual(["conflict", "mode", "peerServesBrowser"]);
  });
});

describe("bindIsWildcard — which binds answer on every interface", () => {
  test("the three wildcard values are wildcard", () => {
    expect(bindIsWildcard("0.0.0.0")).toBe(true);
    expect(bindIsWildcard("::")).toBe(true);
    expect(bindIsWildcard("")).toBe(true);
    // Absent COLLIE_HOST and whitespace-only are the empty case.
    expect(bindIsWildcard(undefined)).toBe(true);
    expect(bindIsWildcard("  ")).toBe(true);
  });

  test("every concrete address is bounded, not wildcard", () => {
    expect(bindIsWildcard("127.0.0.1")).toBe(false);
    expect(bindIsWildcard("::1")).toBe(false);
    expect(bindIsWildcard("100.101.102.103")).toBe(false); // a tailnet IP
    expect(bindIsWildcard("192.168.1.20")).toBe(false); // a LAN IP
    expect(bindIsWildcard("nas.tail.ts.net")).toBe(false); // a hostname
  });
});

describe("warnsOnWildcardBind — only a peer on a wildcard bind warns", () => {
  test("a peer on a wildcard bind warns", () => {
    expect(warnsOnWildcardBind("peer", "0.0.0.0")).toBe(true);
    expect(warnsOnWildcardBind("peer", "::")).toBe(true);
    expect(warnsOnWildcardBind("peer", "")).toBe(true);
    expect(warnsOnWildcardBind("peer", undefined)).toBe(true);
  });

  test("a peer on a concrete bind does NOT warn", () => {
    expect(warnsOnWildcardBind("peer", "127.0.0.1")).toBe(false);
    expect(warnsOnWildcardBind("peer", "100.101.102.103")).toBe(false);
  });

  test("solo and lead never warn, even on a wildcard bind", () => {
    // A solo opens no pack listener; a lead's pack surface rides the hardened front door (ADR 0013).
    expect(warnsOnWildcardBind("solo", "0.0.0.0")).toBe(false);
    expect(warnsOnWildcardBind("lead", "0.0.0.0")).toBe(false);
    expect(warnsOnWildcardBind("solo", "")).toBe(false);
    expect(warnsOnWildcardBind("lead", "::")).toBe(false);
  });
});
