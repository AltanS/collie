import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeLaunchers } from "../launcher-adds.ts";
import { DEFAULT_SWITCHES } from "../operator-launchers.ts";
import { launchersRoute } from "../server.ts";
import type { Launcher, LaunchersResponse } from "../types.ts";
import { withLeadRows } from "./launcher-rows.ts";
import {
  copiedRowsOf,
  copyDigest,
  copyKept,
  copyPushNeeded,
  copyReportOf,
  copyServed,
  LAUNCHERS_DIGEST_FIELD,
  MAX_COPIED_ROWS,
  parseCopiedRows,
  parseCopyReport,
  parseLaunchersCopy,
  parseStandbyLaunchers,
  serializeStandbyLaunchers,
  StandbyLauncherStore,
  STANDBY_LAUNCHERS_FILENAME,
  STANDBY_LAUNCHERS_VERSION,
  withCopyRows,
  type CopiedRow,
  type CopyRole,
  type StandbyLaunchers,
} from "./standby-launchers.ts";

// The deputy keeps a copy of the lead's launcher rows (ADR 0127 point 5): what crosses, what lands,
// whose copy it is, and what a deputy serves only once it leads.

const LEAD_HOME = "/home/lead";
const DEPUTY_HOME = "/home/deputy";

const leadRows: Launcher[] = [
  { command: "claude --resume", label: "Claude", harness: "claude", kind: "agent", source: "operator", cwd: "/home/lead/src/app", noPrompts: false },
  { command: "make test", label: "Tests", kind: "command", source: "operator", cwd: "/srv/shared" },
  { command: "htop", label: "htop", kind: "command", source: "added", id: "11111111-1111-4111-8111-111111111111", addedBy: "phone", addedAt: 5, addedAs: "text", noPrompts: false },
];

const copy = (rows: readonly CopiedRow[] = copiedRowsOf(leadRows, LEAD_HOME), over: Partial<StandbyLaunchers> = {}): StandbyLaunchers => ({
  version: STANDBY_LAUNCHERS_VERSION,
  crewId: "crew-1",
  from: "desk",
  at: 7,
  rows,
  ...over,
});

const cold: CopyRole = { crewId: "crew-1", leads: false, leadMemberId: "desk", deputy: true };
const leading: CopyRole = { crewId: "crew-1", leads: true, leadMemberId: null, deputy: false };

describe("what the lead sends", () => {
  test("each row as it runs, its folder under the lead's home written for the deputy's", () => {
    expect(copiedRowsOf(leadRows, LEAD_HOME)).toEqual([
      { command: "claude --resume", label: "Claude", kind: "agent", noPrompts: false, cwd: "~/src/app", harness: "claude" },
      { command: "make test", label: "Tests", kind: "command", noPrompts: false, cwd: "/srv/shared" },
      // The added-row bookkeeping stays on the lead: the copy cannot be renamed or removed.
      { command: "htop", label: "htop", kind: "command", noPrompts: false },
    ]);
  });

  test("bounded on the wire, operator rows first", () => {
    const many = Array.from({ length: MAX_COPIED_ROWS + 5 }, (_, i): Launcher => ({ command: `run ${i}`, label: `r${i}` }));
    const sent = copiedRowsOf(many, LEAD_HOME);
    expect(sent).toHaveLength(MAX_COPIED_ROWS);
    expect(sent[0]?.command).toBe("run 0");
  });

  test("the same rows digest the same, and a changed row changes the digest", () => {
    const a = copiedRowsOf(leadRows, LEAD_HOME);
    expect(copyDigest(a)).toBe(copyDigest(copiedRowsOf([...leadRows], LEAD_HOME)));
    expect(copyDigest(a)).not.toBe(copyDigest(copiedRowsOf(leadRows.slice(1), LEAD_HOME)));
    // An empty list is still a list the deputy must hold: a removed row has to go there too.
    expect(copyDigest([])).not.toBe(copyDigest(a));
  });

  test("a send is needed when the deputy reports nothing or another digest, never when level", () => {
    expect(copyPushNeeded("d1", null)).toBe(true);
    expect(copyPushNeeded("d1", "d0")).toBe(true);
    expect(copyPushNeeded("d1", "d1")).toBe(false);
  });
});

describe("what the deputy accepts", () => {
  const sent = copiedRowsOf(leadRows, LEAD_HOME);

  test("a clean body round-trips", () => {
    expect(parseLaunchersCopy({ rows: sent })).toEqual(sent);
    expect(parseLaunchersCopy({ rows: [] })).toEqual([]);
  });

  test("one bad row refuses the whole list", () => {
    const bad: unknown[] = [
      { command: "", label: "x", kind: "command", noPrompts: false },
      { command: "ls", label: "x", kind: "shell", noPrompts: false },
      { command: "ls", label: "x", kind: "command" },
      { command: "ls\nrm -rf ~", label: "x", kind: "command", noPrompts: false },
      { command: "ls", label: "x", kind: "command", noPrompts: false, cwd: "relative/dir" },
      { command: "ls", label: "x", kind: "command", noPrompts: false, harness: 7 },
    ];
    for (const row of bad) {
      // SAFETY: a deliberately malformed wire value; `parseCopiedRows` takes any JSON value.
      expect(parseCopiedRows([...sent, row] as never)).toBeNull();
    }
  });

  test("two rows with one command, a list over the cap, or no list at all are refused", () => {
    expect(parseCopiedRows([...sent, sent[0]!])).toBeNull();
    const over = Array.from({ length: MAX_COPIED_ROWS + 1 }, (_, i) => ({ command: `r${i}`, label: "r", kind: "command", noPrompts: false }));
    expect(parseCopiedRows(over)).toBeNull();
    expect(parseLaunchersCopy({})).toBeNull();
    expect(parseLaunchersCopy([])).toBeNull();
  });

  test("the file round-trips, and a foreign version or a bent field reads as no copy", () => {
    const held = copy();
    expect(parseStandbyLaunchers(serializeStandbyLaunchers(held))).toEqual(held);
    expect(parseStandbyLaunchers(serializeStandbyLaunchers({ ...held, version: 2 }))).toBeNull();
    expect(parseStandbyLaunchers(serializeStandbyLaunchers({ ...held, from: "" }))).toBeNull();
    expect(parseStandbyLaunchers("{")).toBeNull();
  });

  test("the report is the digest of what is held, absent with nothing held", () => {
    expect(copyReportOf(null)).toBeNull();
    expect(copyReportOf(copy())).toBe(copyDigest(copiedRowsOf(leadRows, LEAD_HOME)));
    expect(parseCopyReport({ [LAUNCHERS_DIGEST_FIELD]: "abc" })).toBe("abc");
    expect(parseCopyReport({ [LAUNCHERS_DIGEST_FIELD]: "" })).toBeNull();
    expect(parseCopyReport({ [LAUNCHERS_DIGEST_FIELD]: 7 })).toBeNull();
    expect(parseCopyReport({ [LAUNCHERS_DIGEST_FIELD]: "x".repeat(129) })).toBeNull();
    expect(parseCopyReport({})).toBeNull();
  });
});

describe("whose copy it is", () => {
  test("a deputy of that lead keeps it", () => {
    expect(copyKept(copy(), cold)).toBe(true);
  });

  test("a demotion clears it: the warrant names another deputy, or none", () => {
    expect(copyKept(copy(), { ...cold, deputy: false })).toBe(false);
  });

  test("a different lead, another crew, or no crew clears it", () => {
    expect(copyKept(copy(), { ...cold, leadMemberId: "attic" })).toBe(false);
    expect(copyKept(copy(), { ...cold, crewId: "crew-2" })).toBe(false);
    expect(copyKept(copy(), { crewId: null, leads: false, leadMemberId: null, deputy: false })).toBe(false);
  });

  test("after a takeover this machine leads the crew, and keeps the crew's rows", () => {
    expect(copyKept(copy(), leading)).toBe(true);
  });

  test("a COLD deputy holds the copy and serves none of it", () => {
    expect(copyServed(copy(), cold)).toBeNull();
  });

  test("a LEADING deputy serves it, and only for the crew the copy is from", () => {
    expect(copyServed(copy(), leading)).toEqual(copy().rows);
    expect(copyServed(copy(), { ...leading, crewId: "crew-2" })).toBeNull();
    expect(copyServed(null, leading)).toBeNull();
  });
});

describe("a leading deputy serves the copy, its own rows winning", () => {
  const own: Launcher[] = [
    // The deputy's own row for the same line: its label and its folder count.
    { command: "make test", label: "Deputy tests", cwd: "/home/deputy/work" },
  ];
  const sent = copiedRowsOf(leadRows, LEAD_HOME);

  test("the copy comes after the own rows, read under this machine's home", () => {
    const merged = withCopyRows(mergeLaunchers(own, [], DEFAULT_SWITCHES), sent, DEPUTY_HOME);
    expect(merged.rows.map((r) => [r.command, r.label, r.cwd ?? null, r.source])).toEqual([
      ["make test", "Deputy tests", "/home/deputy/work", "operator"],
      ["claude --resume", "Claude", "/home/deputy/src/app", "operator"],
      ["htop", "htop", null, "operator"],
    ]);
    // Nothing of the copy can be renamed or removed from a phone here.
    expect(merged.rows.some((r) => r.id !== undefined || r.addedBy !== undefined)).toBe(false);
    // The adding block stays this machine's own: the copy is not in its store.
    expect(merged.stored).toEqual([]);
  });

  test("with nothing served, the own rows come back as they were", () => {
    const mine = mergeLaunchers(own, [], DEFAULT_SWITCHES);
    expect(withCopyRows(mine, null, DEPUTY_HOME)).toBe(mine);
  });

  test("an own row the switches hold back still wins: the New screen's keys stay unique", () => {
    const held = mergeLaunchers(
      [],
      [{ id: "22222222-2222-4222-8222-222222222222", command: "htop", label: "mine", kind: "command", noPrompts: false, device: "phone", via: "local", at: 1, source: "text" }],
      { ...DEFAULT_SWITCHES, freeText: false },
    );
    expect(held.off.map((o) => o.command)).toEqual(["htop"]);
    expect(withCopyRows(held, sent, DEPUTY_HOME).rows.map((r) => r.command)).toEqual(["claude --resume", "make test"]);
  });

  test("GET /api/launchers on the leading deputy lists the copy as its own items", async () => {
    const merged = () => Promise.resolve(withCopyRows(mergeLaunchers(own, [], DEFAULT_SWITCHES), sent, DEPUTY_HOME));
    const res = await launchersRoute(
      async () => (await merged()).rows,
      null,
      { list: () => Promise.resolve([{ id: "claude", label: "Claude Code", found: true }]) },
      { merged, file: "/home/deputy/.config/launchers.toml" },
    );
    // SAFETY: the route answers a LaunchersResponse as JSON.
    const body = (await res.json()) as LaunchersResponse;
    expect(body.items?.map((i) => i.key)).toEqual(["harness:claude", "row:claude --resume", "shell", "row:make test", "row:htop"]);
    expect(body.items?.find((i) => i.key === "row:make test")).toMatchObject({ label: "Deputy tests", cwd: "/home/deputy/work" });
    // Plain items on itself, not marked as the lead's.
    expect(body.items?.some((i) => i.from !== undefined)).toBe(false);
    expect(body.launchers.map((l) => l.command)).toEqual(["make test", "claude --resume", "htop"]);
  });

  test("a member picked on the leading deputy gets the copy as the lead's rows", () => {
    const merged = withCopyRows(mergeLaunchers([], [], DEFAULT_SWITCHES), sent, DEPUTY_HOME);
    const member: LaunchersResponse = {
      launchers: [],
      home: "/home/member",
      harnesses: [{ id: "claude", label: "Claude Code", found: true }],
      items: [],
    };
    const out = withLeadRows(member, { merged, file: "/home/deputy/.config/launchers.toml", home: DEPUTY_HOME });
    expect(out.items?.find((i) => i.command === "claude --resume")).toMatchObject({ from: "lead", cwd: "/home/member/src/app" });
    expect(out.items?.filter((i) => i.from === "lead").map((i) => i.command)).toEqual(["claude --resume", "make test", "htop"]);
  });
});

describe("the file on the deputy", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const fresh = (): string => {
    dir = mkdtempSync(join(tmpdir(), "standby-launchers-"));
    return join(dir, "state");
  };

  test("a copy lands 0600, whole, and is read back by a new process", async () => {
    const stateDir = fresh();
    const store = new StandbyLauncherStore(stateDir);
    expect(await store.load()).toBeNull();
    await store.replace(copy());
    const path = join(stateDir, STANDBY_LAUNCHERS_FILENAME);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(await new StandbyLauncherStore(stateDir).load()).toEqual(copy());
    // Its own file: nothing else was written beside it.
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, from: "desk", crewId: "crew-1" });
  });

  test("a second copy replaces the first wholesale", async () => {
    const store = new StandbyLauncherStore(fresh());
    await store.replace(copy());
    await store.replace(copy([], { at: 9 }));
    expect(store.current()?.rows).toEqual([]);
  });

  test("a demotion removes the file; a deputy still in place, or a leading one, keeps it", async () => {
    const stateDir = fresh();
    const store = new StandbyLauncherStore(stateDir);
    await store.replace(copy());
    expect(await store.reconcile(cold)).toBe(false);
    expect(await store.reconcile(leading)).toBe(false);
    expect(existsSync(join(stateDir, STANDBY_LAUNCHERS_FILENAME))).toBe(true);
    expect(await store.reconcile({ ...cold, deputy: false })).toBe(true);
    expect(existsSync(join(stateDir, STANDBY_LAUNCHERS_FILENAME))).toBe(false);
    expect(store.current()).toBeNull();
    // Nothing held is nothing to clear.
    expect(await store.reconcile({ ...cold, deputy: false })).toBe(false);
  });
});
