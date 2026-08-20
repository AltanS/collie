import { describe, expect, test } from "bun:test";

import {
  formatRecord,
  instanceSuffixOf,
  managedHandlerPath,
  releaseManagedFrontDoor,
  shouldReleaseFrontDoor,
  type FrontDoorDeps,
  type FrontDoorExec,
  type FrontDoorFiles,
} from "./front-door.ts";

// The bridge half of ADR 0001: a machine that is no longer a lead takes ITS OWN recorded mapping
// down, and nothing else, ever.
//
// SAFETY: every `tailscale` call in this file goes through a fake Exec. Nothing here may reach the
// real tailnet — this code path unpublishes a live front door.

const HANDLER = "/config/tailscale-managed-handler";
const RECORD = formatRecord({
  mode: "http",
  port: 8788,
  hostPort: "box.tail.ts.net:8788",
  proxy: "http://127.0.0.1:8788",
});

/** The status JSON tailscaled prints for a root mount Collie itself published. */
const OURS = JSON.stringify({
  TCP: { "8788": { HTTP: true } },
  Web: { "box.tail.ts.net:8788": { Handlers: { "/": { Proxy: "http://127.0.0.1:8788" } } } },
});

/** …and the one it prints once somebody else has taken that root over. */
const THEIRS = JSON.stringify({
  TCP: { "8788": { HTTP: true } },
  Web: { "box.tail.ts.net:8788": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
});

interface Harness {
  deps: FrontDoorDeps;
  calls: string[];
  out: string[];
  err: string[];
  record(): string | null;
}

function harness(over: { record?: string | null; status?: string; missing?: boolean } = {}): Harness {
  let record = over.record === undefined ? RECORD : over.record;
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exec: FrontDoorExec = {
    which: (tool) => (over.missing === true ? null : `/usr/bin/${tool}`),
    capture(tool, args) {
      calls.push(`${tool} ${args.join(" ")}`);
      const stdout = args[1] === "status" ? (over.status ?? OURS) : "";
      return { code: 0, stdout, stderr: "", found: true };
    },
  };
  const files: FrontDoorFiles = {
    exists: (p) => p === HANDLER && record !== null,
    read: (p) => (p === HANDLER ? record : null),
    remove: (p) => {
      if (p === HANDLER) record = null;
    },
  };
  return {
    deps: { handlerFile: HANDLER, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, exec, files },
    calls,
    out,
    err,
    record: () => record,
  };
}

describe("the record file both processes have to name identically", () => {
  test("the unsuffixed instance keeps today's name, byte for byte", () => {
    expect(managedHandlerPath("/config", instanceSuffixOf(undefined))).toBe(
      "/config/tailscale-managed-handler",
    );
  });

  test("a second instance names its own, so it can never take the first's door down", () => {
    expect(managedHandlerPath("/config", instanceSuffixOf("v1"))).toBe(
      "/config/tailscale-managed-handler-v1",
    );
  });
});

describe("shouldReleaseFrontDoor — mode + record, and nothing else", () => {
  test("a peer with a record of its own takes it down", () => {
    expect(shouldReleaseFrontDoor({ mode: "peer", deposed: false, hasRecord: true })).toBe(true);
  });

  test("a deposed machine takes it down whatever mode its store still resolves to", () => {
    // The parked ex-lead: it never reaches `peer`, and its live mapping is what black-holes the
    // pack's hostname while its own health check fails behind it.
    expect(shouldReleaseFrontDoor({ mode: "lead", deposed: true, hasRecord: true })).toBe(true);
  });

  test("a healthy lead and a solo instance keep theirs", () => {
    expect(shouldReleaseFrontDoor({ mode: "lead", deposed: false, hasRecord: true })).toBe(false);
    expect(shouldReleaseFrontDoor({ mode: "solo", deposed: false, hasRecord: true })).toBe(false);
  });

  test("no record is KEEP for every mode — an unrecorded mapping is not ours", () => {
    for (const mode of ["solo", "lead", "peer"] as const) {
      expect(shouldReleaseFrontDoor({ mode, deposed: true, hasRecord: false })).toBe(false);
    }
  });
});

describe("releaseManagedFrontDoor — only the recorded mapping", () => {
  test("removes the recorded root, scoped to the listener and `/`, then drops the record", () => {
    const h = harness();
    expect(releaseManagedFrontDoor(h.deps)).toBe(true);
    expect(h.calls).toEqual([
      "tailscale serve status --json",
      "tailscale serve --http=8788 --set-path=/ off",
    ]);
    expect(h.record()).toBeNull();
    expect(h.out.join("\n")).toContain("removed Collie's managed http:8788 mapping");
  });

  test("a root replaced out from under us is REFUSED, and the record is kept", () => {
    const h = harness({ status: THEIRS });
    expect(releaseManagedFrontDoor(h.deps)).toBe(false);
    // Status was read; nothing was turned off.
    expect(h.calls).toEqual(["tailscale serve status --json"]);
    expect(h.record()).toBe(RECORD);
    expect(h.err.join("\n")).toContain("refusing to remove the current handler");
  });

  test("no record at all is success and spawns nothing", () => {
    const h = harness({ record: null });
    expect(releaseManagedFrontDoor(h.deps)).toBe(true);
    expect(h.calls).toEqual([]);
  });

  test("an unreadable record is refused and retained — a mapping we cannot prove we own", () => {
    const h = harness({ record: "garbage\n" });
    expect(releaseManagedFrontDoor(h.deps)).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.record()).toBe("garbage\n");
  });

  test("no tailscale binary reports and retains, and never throws — the peer still has to come up", () => {
    const h = harness({ missing: true });
    expect(releaseManagedFrontDoor(h.deps)).toBe(false);
    expect(h.record()).toBe(RECORD);
    expect(h.err.join("\n")).toContain("tailscale not found");
  });
});
