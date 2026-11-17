import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AccountStatusRun } from "./account-adapters.ts";
import type { StatusAsk, StatusRunner } from "./account-identity.ts";
import { realLinkDisk } from "./account-links.ts";
import { Accounts, defaultAccountId, ownJournalRoots, seenReading, withoutBridgeSettings, type AccountsAnswer, type AccountsCaller, type AccountsDeps } from "./accounts-routes.ts";
import { accountTest } from "./accounts-skip.ts";
import { AccountStore, MAX_ACCOUNTS, type AccountRecord } from "./accounts-store.ts";
import { AuditLog } from "./audit.ts";
import { harnessLaunch } from "./harness-launch.ts";
import { buildJournalRegistry } from "./journal/registry.ts";
import type { JsonValue } from "./json.ts";
import { memoryAddedIo } from "./launchers-added.ts";
import { serveAccountsRoute } from "./server.ts";
import type { AccountRow, AccountsBody, AgentView } from "./types.ts";
import { UsageSeen } from "./usage-seen.ts";

const ID = "6f1c2a4e-3b5d-4c7e-9f00-112233445566";
const ID2 = "6f1c2a4e-3b5d-4c7e-9f00-112233445577";

function idN(n: number): string {
  return `6f1c2a4e-3b5d-4c7e-9f00-${String(n).padStart(12, "0")}`;
}

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "w",
    workspaceNumber: 1,
    tabId: "t1",
    agent: "claude",
    status: "idle",
    cwd: "/x",
    focused: false,
    agentSession: { kind: "id", value: "s1" },
    ...over,
  };
}

let home = "";
let lines: { action?: string; session?: string }[] = [];
let audit: AuditLog;
let store: AccountStore;

function build(over: Partial<AccountsDeps> = {}): Accounts {
  return new Accounts({
    store,
    harnesses: {
      list: () => Promise.resolve(["claude", "codex", "pi", "opencode"].map((id) => ({ id, label: harnessLaunch(id)?.label ?? id, found: id !== "pi" }))),
      launch: harnessLaunch,
    },
    home,
    env: {},
    platform: "linux",
    disk: realLinkDisk,
    readText: () => null,
    now: () => 1000,
    ...over,
  });
}

const caller = (): AccountsCaller => ({ device: "pixel", audit, session: "default" });

async function bodyOf(accounts: Accounts): Promise<AccountsBody> {
  const body = await accounts.body();
  if (body === null) throw new Error("expected a body");
  return body;
}

async function added(accounts: Accounts, body: JsonValue): Promise<AccountRow> {
  const answer = await accounts.add(body, caller());
  expect(answer.status).toBe(200);
  // SAFETY: a 200 add answers `{ ok: true, account }` (accounts-routes.ts `answerRow`).
  return (answer.body as { account: AccountRow }).account;
}

function codeOf(body: AccountsAnswer["body"]): string | undefined {
  // SAFETY: every refusal of the service is `{ ok: false, error, code }` (accounts-routes.ts `refusal`).
  return (body as { code?: string }).code;
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "collie-acct-routes-")));
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  await writeFile(join(home, ".claude", "settings.json"), "{}");
  lines = [];
  // SAFETY: each line the log appends is one JSON object it just serialised (bridge/audit.ts).
  audit = new AuditLog((line) => void lines.push(JSON.parse(line) as { action?: string; session?: string }), { now: () => 1 });
  store = new AccountStore(memoryAddedIo(), () => {});
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("GET /api/accounts", () => {
  test("only found, account-capable harnesses, each with its Default row first", async () => {
    const body = await bodyOf(build());
    expect(body.harnesses.map((h) => h.id)).toEqual(["claude", "codex"]);
    expect(body.harnesses[0]).toEqual({
      id: "claude",
      label: "Claude Code",
      select: "CLAUDE_CONFIG_DIR",
      kinds: ["shared", "own"],
      newFolder: "~/.claude-{slug}",
      binary: "claude",
      reachesRunningSessions: true,
      signInHosts: ["claude.com", "platform.claude.com"],
    });
    expect(body.harnesses[1]?.kinds).toEqual(["own"]);
    // Codex: a sign-in is not proven to reach running sessions, and it lists no host.
    expect(body.harnesses[1]).not.toHaveProperty("reachesRunningSessions");
    expect(body.harnesses[1]).not.toHaveProperty("signInHosts");
    expect(body.accounts.map((a) => a.id)).toEqual(["claude:default", "codex:default"]);
    expect(body.accounts[0]).toMatchObject({ kind: "default", label: "", folder: "~/.claude", startLine: "claude", windows: [], seenAt: null, live: false });
  });

  test("Windows and a machine with no account-capable agent offer nothing", async () => {
    expect(await build({ platform: "win32" }).body()).toBeNull();
    expect(await build({ harnesses: { list: () => Promise.resolve([{ id: "opencode", label: "opencode", found: true }]), launch: harnessLaunch } }).body()).toBeNull();
  });

  accountTest("found folders: by name and layout, and reported by a session; never the default or an added one", async () => {
    await mkdir(join(home, ".claude-work", "projects"), { recursive: true });
    await mkdir(join(home, ".claude-empty"));
    await mkdir(join(home, ".codex-old", "sessions"), { recursive: true });
    await mkdir(join(home, "elsewhere"));
    const accounts = build({
      reported: {
        reportedConfigDir: () => undefined,
        reportedConfigDirs: () => [{ harness: "claude", dir: join(home, "elsewhere/") }],
      },
    });
    const found = (await bodyOf(accounts)).found;
    expect(found).toEqual([
      { harness: "claude", folder: "~/elsewhere", path: join(home, "elsewhere"), why: "reported" },
      { harness: "claude", folder: "~/.claude-work", path: join(home, ".claude-work"), why: "name" },
      { harness: "codex", folder: "~/.codex-old", path: join(home, ".codex-old"), why: "name" },
    ]);
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "own", path: "~/.claude-work" });
    expect((await bodyOf(accounts)).found.map((f) => f.folder)).toEqual(["~/elsewhere", "~/.codex-old"]);
  });

  accountTest("each row's windows are the reading the usage store keeps under the same harness and folder", async () => {
    const seen = new UsageSeen(memoryAddedIo(), () => 5_000, () => {});
    await seen.settled();
    const accounts = build({ reading: seenReading(seen, () => 6_000) });
    const slash = await added(accounts, { requestId: ID, harness: "claude", label: "Slash", kind: "own", path: "~/acct-slash/" });
    const plain = await added(accounts, { requestId: ID2, harness: "claude", label: "Plain", kind: "own", path: "~/acct-plain" });
    // The tracker records under the folder the session reported, raw: the default as undefined, an
    // added one as its env held it, with or without a trailing slash.
    seen.record("claude", undefined, [{ window: "5h", used: 10, resetsAt: 9_000 }], 4_000);
    seen.record("claude", `${join(home, "acct-slash")}/`, [{ window: "7d:opus", used: 30, resetsAt: 2_000, label: "Opus" }], 4_100);
    seen.record("claude", join(home, "acct-plain"), [{ window: "7d", used: 50, resetsAt: 9_000 }], 4_200);
    const rows = (await bodyOf(accounts)).accounts.filter((a) => a.harness === "claude");
    expect(rows.map((r) => [r.label, r.windows, r.seenAt, r.live])).toEqual([
      ["", [{ window: "5h", usedPct: 10, resetsAt: 9_000 }], 4_000, false],
      // Past its reset at the time of the ask: "reset since".
      [slash.label, [{ window: "7d:opus", label: "Opus", usedPct: null, resetsAt: 2_000 }], 4_100, false],
      [plain.label, [{ window: "7d", usedPct: 50, resetsAt: 9_000 }], 4_200, false],
    ]);
    // Codex has no reading: no windows, never read.
    expect((await bodyOf(accounts)).accounts.find((a) => a.id === "codex:default")).toMatchObject({ windows: [], seenAt: null });
  });

  test("hooks are read from the settings file only, where the adapter names one", async () => {
    const read: string[] = [];
    const accounts = build({ readText: (p) => (read.push(p), null) });
    const body = await bodyOf(accounts);
    expect(body.accounts[0]?.hooks).toBe("missing");
    expect(body.accounts[1]?.hooks).toBeUndefined();
    expect(read).toEqual([join(home, ".claude", "settings.json")]);
  });
});

describe("POST /api/accounts", () => {
  accountTest("a shared account: a new folder that links the default's setup, one audit line, a replay", async () => {
    const accounts = build();
    const row = await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "shared" });
    expect(row).toMatchObject({ id: ID, kind: "shared", label: "Work", folder: "~/.claude-work", startLine: "CLAUDE_CONFIG_DIR=~/.claude-work claude", unlinked: [] });
    const dir = join(home, ".claude-work");
    if (process.platform !== "win32") expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await readlink(join(dir, "projects"))).toBe(join(home, ".claude", "projects"));
    expect(await readlink(join(dir, "settings.json"))).toBe(join(home, ".claude", "settings.json"));
    expect(lines.map((l) => l.action)).toEqual(["account.add"]);
    expect(await added(accounts, { requestId: ID, harness: "claude", label: "Other", kind: "own", path: "/nope" })).toMatchObject({ id: ID, label: "Work" });
    expect(lines).toHaveLength(1);
    expect((await bodyOf(accounts)).accounts.map((a) => a.id)).toEqual(["claude:default", ID, "codex:default"]);
  });

  test("an own account adopts a folder as it is, and makes a missing one empty", async () => {
    await mkdir(join(home, "mine"));
    await writeFile(join(home, "mine", "settings.json"), '{"x":1}');
    const accounts = build();
    await added(accounts, { requestId: ID, harness: "claude", label: "Mine", kind: "own", path: "~/mine" });
    expect((await lstat(join(home, "mine", "settings.json"))).isSymbolicLink()).toBe(false);
    await expect(lstat(join(home, "mine", "projects"))).rejects.toThrow();
    await added(accounts, { requestId: ID2, harness: "codex", label: "Mine", kind: "own", path: "~/.codex-new" });
    expect((await stat(join(home, ".codex-new"))).isDirectory()).toBe(true);
  });

  test("the refusals, each before anything is written", async () => {
    const accounts = build();
    const code = async (body: JsonValue): Promise<string | undefined> => codeOf((await accounts.add(body, caller())).body);
    expect(await code({ requestId: ID, harness: "codex", label: "W", kind: "shared" })).toBe("accounts.kind_unsupported");
    expect(await code({ requestId: ID, harness: "opencode", label: "W", kind: "own", path: "~/x" })).toBe("accounts.kind_unsupported");
    expect(await code({ requestId: ID, harness: "pi", label: "W", kind: "own", path: "~/x" })).toBe("accounts.kind_unsupported");
    expect(await code({ requestId: ID, harness: "claude", label: "", kind: "shared" })).toBe("accounts.bad_label");
    expect(await code({ requestId: ID, harness: "claude", label: "a\nb", kind: "shared" })).toBe("accounts.bad_label");
    expect(await code({ requestId: ID, harness: "claude", label: "W", kind: "own" })).toBe("accounts.bad_folder");
    for (const path of ["~/it's", "~/$(id)", "~/`id`", "~/a\nb", "~/a ", "rel", "~root/x", `~/${"a".repeat(5000)}`, "~/.claude"]) {
      expect(await code({ requestId: ID, harness: "claude", label: "W", kind: "own", path })).toBe("accounts.bad_folder");
    }
    await mkdir(join(home, "used"));
    await writeFile(join(home, "used", "notes"), "x");
    expect(await code({ requestId: ID, harness: "claude", label: "W", kind: "shared", path: "~/used" })).toBe("accounts.bad_folder");
    expect(await store.list()).toEqual([]);
    expect(lines).toEqual([]);
  });

  accountTest("a label is unique per agent without case, a folder once, and the cap holds", async () => {
    const accounts = build();
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "shared" });
    expect(codeOf((await accounts.add({ requestId: ID2, harness: "claude", label: "WORK", kind: "own", path: "~/a" }, caller())).body)).toBe("accounts.label_taken");
    expect(codeOf((await accounts.add({ requestId: ID2, harness: "codex", label: "W2", kind: "own", path: "~/.claude-work" }, caller())).body)).toBe("accounts.folder_taken");
    for (let n = 10; (await store.list()).length < MAX_ACCOUNTS; n++) await added(accounts, { requestId: idN(n), harness: "codex", label: `C${n}`, kind: "own", path: `~/.codex-${n}` });
    expect(codeOf((await accounts.add({ requestId: idN(99), harness: "codex", label: "Full", kind: "own", path: "~/.codex-full" }, caller())).body)).toBe("accounts.limit");
  });

  test("Windows refuses an add", async () => {
    expect(codeOf((await build({ platform: "win32" }).add({ requestId: ID, harness: "claude", label: "W", kind: "own", path: "~/x" }, caller())).body)).toBe("accounts.unavailable");
  });
});

describe("POST /api/accounts/remove", () => {
  accountTest("forgets the label only; the folder and its links stay", async () => {
    const accounts = build();
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "shared" });
    expect(codeOf((await accounts.remove({ id: defaultAccountId("claude") }, caller())).body)).toBe("accounts.default");
    expect(codeOf((await accounts.remove({ id: ID2 }, caller())).body)).toBe("accounts.unknown");
    expect(await accounts.remove({ requestId: ID2, id: ID }, caller())).toEqual({ status: 200, body: { ok: true } });
    expect(await readlink(join(home, ".claude-work", "projects"))).toBe(join(home, ".claude", "projects"));
    expect(lines.map((l) => l.action)).toEqual(["account.add", "account.remove"]);
  });
});

describe("the start line", () => {
  accountTest("no account is the base line; the Default id is too; an own account is the quoted folder", async () => {
    const accounts = build();
    expect(await accounts.startLine({ harness: "claude", base: "claude", account: undefined, signIn: false })).toEqual({ ok: true, command: "claude" });
    expect(await accounts.startLine({ harness: "claude", base: "claude", account: "claude:default", signIn: true })).toEqual({ ok: true, command: "claude" });
    await mkdir(join(home, "my work"));
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "own", path: "~/my work" });
    expect(await accounts.startLine({ harness: "claude", base: "claude --model opus", account: ID, signIn: false })).toMatchObject({
      ok: true,
      command: `CLAUDE_CONFIG_DIR='${join(home, "my work")}' claude --model opus`,
    });
  });

  test("an unknown id, or one of another agent, is refused", async () => {
    const accounts = build();
    await added(accounts, { requestId: ID, harness: "codex", label: "W", kind: "own", path: "~/.codex-w" });
    expect(await accounts.startLine({ harness: "claude", base: "claude", account: ID, signIn: false })).toMatchObject({ ok: false, code: "accounts.unknown" });
    expect(await accounts.startLine({ harness: "codex", base: "codex", account: ID2, signIn: false })).toMatchObject({ ok: false, code: "accounts.unknown" });
    expect(await build({ platform: "win32" }).startLine({ harness: "codex", base: "codex", account: ID, signIn: false })).toMatchObject({ ok: false, code: "accounts.unavailable" });
  });

  accountTest("a shared account runs the link pass first, so an entry the default gained since is linked", async () => {
    const accounts = build();
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "shared" });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "# notes");
    await accounts.startLine({ harness: "claude", base: "claude", account: ID, signIn: false });
    expect(await readlink(join(home, ".claude-work", "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
  });
});

describe("a pane's account", () => {
  const row: AccountRecord = { id: ID, harness: "claude", label: "Work", kind: "own", dir: "/srv/work", addedAt: 1, device: "pixel" };

  accountTest("the folder the agent reported wins; a launch note counts until it reports", async () => {
    await store.add(row);
    let reported: string | null | undefined;
    const accounts = build({ reported: { reportedConfigDir: () => reported, reportedConfigDirs: () => [] } });
    expect(accounts.paneAccount("default", pane())).toBeUndefined();
    accounts.noteLaunch("default", "w1:p1", "claude", ID);
    expect(accounts.paneAccount("default", pane())).toEqual({ id: ID, label: "Work" });
    // The agent says it runs the default folder: the note loses.
    reported = null;
    expect(accounts.paneAccount("default", pane())).toBeUndefined();
    // Started by hand with the account's folder, as the person typed it.
    reported = "/srv/work/";
    expect(accounts.paneAccount("default", pane({ paneId: "w9:p9" }))).toEqual({ id: ID, label: "Work" });
  });

  accountTest("the slash and skill scan reads the account's folder: the folder, and the variable laid over the env", async () => {
    await store.add(row);
    const accounts = build({ env: { HOME: "/home/op" }, reported: { reportedConfigDir: () => "/srv/work", reportedConfigDirs: () => [] } });
    expect(accounts.folderOf("default", pane())).toBe("/srv/work");
    expect(accounts.envOf("default", pane())).toEqual({ HOME: "/home/op", CLAUDE_CONFIG_DIR: "/srv/work" });
    const plain = build({ env: { HOME: "/home/op" } });
    expect(plain.folderOf("default", pane())).toBeUndefined();
    expect(plain.envOf("default", pane())).toEqual({ HOME: "/home/op" });
  });

  test("a note is dropped when the pane runs another agent or is gone", async () => {
    await store.add(row);
    const accounts = build();
    accounts.noteLaunch("default", "w1:p1", "claude", ID);
    expect(accounts.paneAccount("default", pane({ agent: "codex" }))).toBeUndefined();
    expect(accounts.paneAccount("default", pane())).toBeUndefined();
    accounts.noteLaunch("default", "w1:p1", "claude", ID);
    accounts.keep("default", ["w1:p2"]);
    expect(accounts.paneAccount("default", pane())).toBeUndefined();
  });

  accountTest("live follows the panes: an added account's pane, and the Default's", async () => {
    await store.add(row);
    const accounts = build({
      reported: { reportedConfigDir: (p) => (p.paneId === "w1:p2" ? "/srv/work" : undefined), reportedConfigDirs: () => [] },
      panes: () => [
        { session: "default", pane: pane({ paneId: "w1:p2" }) },
        { session: "default", pane: pane({ paneId: "w1:p3", agent: "codex" }) },
      ],
    });
    const body = await bodyOf(accounts);
    expect(body.accounts.map((a) => [a.id, a.live])).toEqual([
      ["claude:default", false],
      [ID, true],
      ["codex:default", true],
    ]);
  });

  accountTest("Change login counts the running sessions of each account, a sign-in session left out", async () => {
    await store.add(row);
    const reported = (p: AgentView) => (p.paneId === "w1:p2" || p.paneId === "w1:p4" ? "/srv/work" : undefined);
    const accounts = build({
      reported: { reportedConfigDir: reported, reportedConfigDirs: () => [] },
      panes: () => [
        { session: "default", pane: pane({ paneId: "w1:p2" }) },
        { session: "default", pane: pane({ paneId: "w1:p4" }) },
        { session: "default", pane: pane({ paneId: "w1:p5" }) },
        { session: "other", pane: pane({ paneId: "w1:p6" }) },
        { session: "default", pane: pane({ paneId: "w1:p7", kind: "shell" }) },
      ],
    });
    const counts = async () => (await bodyOf(accounts)).accounts.map((a) => [a.id, a.running]);
    expect(await counts()).toEqual([
      ["claude:default", 2],
      [ID, 2],
      ["codex:default", undefined],
    ]);
    // A sign-in session started on the Default (the pane its line was typed into) does not count, and the account still reads live.
    accounts.noteSignIn("other", "w1:p6", "claude\u0000x");
    accounts.noteSignIn("default", "w1:p4", "claude\u0000y");
    expect(await counts()).toEqual([
      ["claude:default", 1],
      [ID, 1],
      ["codex:default", undefined],
    ]);
    expect((await bodyOf(accounts)).accounts.map((a) => a.live)).toEqual([true, true, false]);
  });

  accountTest("an account no session uses has no count", async () => {
    await store.add(row);
    const body = await bodyOf(build({ panes: () => [] }));
    for (const a of body.accounts) expect(a).not.toHaveProperty("running");
  });

  accountTest("a row lists the panes that run in its folder, a sign-in session and a pane in an unnamed folder left out", async () => {
    await store.add(row);
    const folders = new Map<string, string | null>([["w1:p2", "/srv/work"], ["w1:p4", "/srv/work"], ["w1:p8", "/srv/elsewhere"], ["w1:p9", null]]);
    const accounts = build({
      reported: { reportedConfigDir: (p) => folders.get(p.paneId), reportedConfigDirs: () => [] },
      panes: () => [
        { session: "default", pane: pane({ paneId: "w1:p2" }) },
        { session: "default", pane: pane({ paneId: "w1:p4" }) },
        { session: "default", pane: pane({ paneId: "w1:p5" }) },
        { session: "other", pane: pane({ paneId: "w1:p6" }) },
        { session: "default", pane: pane({ paneId: "w1:p7", kind: "shell" }) },
        { session: "default", pane: pane({ paneId: "w1:p8" }) },
        { session: "default", pane: pane({ paneId: "w1:p9" }) },
      ],
    });
    accounts.noteSignIn("default", "w1:p4", "claude\u0000y");
    accounts.noteSignIn("other", "w1:p6", "claude\u0000x");
    const body = await bodyOf(accounts);
    const panesOf = (id: string) => body.accounts.find((a) => a.id === id)?.panes;
    // Default holds a pane with no reported folder and one that reported the default; the sign-in pane (p6) is out.
    expect(panesOf("claude:default")).toEqual(["w1:p5", "w1:p9"]);
    // The added row holds p2; p4 is a sign-in session.
    expect(panesOf(ID)).toEqual(["w1:p2"]);
    expect(panesOf("codex:default")).toBeUndefined();
    // p8 reported a folder no row names: in no row's list, though a session runs there.
    for (const a of body.accounts) expect(a.panes ?? []).not.toContain("w1:p8");
    // The list is exactly what `running` counts.
    for (const a of body.accounts) expect(a.panes?.length).toBe(a.running);
    // A shell pane is in no list.
    for (const a of body.accounts) expect(a.panes ?? []).not.toContain("w1:p7");
  });

  accountTest("a row lists at most 64 panes, and none when no session runs", async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ session: "default", pane: pane({ paneId: `w1:p${i + 20}` }) }));
    const body = await bodyOf(build({ panes: () => many }));
    expect(body.accounts[0]?.panes).toHaveLength(64);
    expect(body.accounts[0]?.running).toBe(70);
    const idle = await bodyOf(build({ panes: () => [] }));
    for (const a of idle.accounts) expect(a).not.toHaveProperty("panes");
  });

  accountTest("the journal roots grow with own accounts only", async () => {
    await store.add(row);
    await store.add({ ...row, id: ID2, label: "S", kind: "shared", dir: "/srv/shared" });
    expect(ownJournalRoots(store, "claude")).toEqual(["/srv/work/projects"]);
    expect(ownJournalRoots(store, "codex")).toEqual([]);
  });
});

describe("the server glue (serveAccountsRoute)", () => {
  type Caller = Parameters<typeof serveAccountsRoute>[2];
  function fakeCaller(denyWrite = false): Caller {
    return {
      gate: (level) => (denyWrite && level === "write" ? new Response("read-only", { status: 403 }) : null),
      // SAFETY: the accounts routes read only `name` off the runtime (for the audit line's session).
      resolve: () => Promise.resolve({ name: "default" } as Awaited<ReturnType<Caller["resolve"]>>),
      device: () => "pixel",
      audit,
    };
  }
  const get = () => new Request("http://x/api/accounts");
  const post = (path: string, body: JsonValue) => new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) });

  test("a ?host= read: the gate first, then the member's answer as it came; the lead's own service and audit are not touched (M101 spec 06)", async () => {
    const rows = JSON.stringify({ harnesses: [], accounts: [{ id: "claude:default", identity: { signedIn: true, email: "person@example.com" } }], found: [] });
    let resolved = 0;
    const forwarding = (deny: boolean): Caller => ({
      gate: (level) => (deny && level === "read" ? new Response("not paired", { status: 401 }) : null),
      resolve: () => {
        resolved += 1;
        return Promise.resolve(new Response(rows, { status: 200 }));
      },
      device: () => "pixel",
      audit,
    });
    // The lead's own service must not be asked: a spy that fails the test if it is.
    const own = build();
    const asked = spyOn(own, "body");
    expect((await serveAccountsRoute(get(), "/api/accounts", forwarding(true), own))?.status).toBe(401);
    expect(resolved).toBe(0);
    const res = await serveAccountsRoute(get(), "/api/accounts", forwarding(false), own);
    expect(resolved).toBe(1);
    expect(await res?.text()).toBe(rows);
    expect(asked).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  test("no service answers the read with accounts.unavailable, as an older bridge would be read", async () => {
    const res = await serveAccountsRoute(get(), "/api/accounts", fakeCaller(), undefined);
    expect(res?.status).toBe(404);
    expect(await res?.json()).toMatchObject({ code: "accounts.unavailable" });
  });

  accountTest("read, add and remove; a read-only device may read and not write; other paths are not ours", async () => {
    const accounts = build();
    expect((await serveAccountsRoute(get(), "/api/accounts", fakeCaller(true), accounts))?.status).toBe(200);
    expect((await serveAccountsRoute(post("/api/accounts", { requestId: ID, harness: "claude", label: "W", kind: "shared" }), "/api/accounts", fakeCaller(true), accounts))?.status).toBe(403);
    const add = await serveAccountsRoute(post("/api/accounts", { requestId: ID, harness: "claude", label: "W", kind: "shared" }), "/api/accounts", fakeCaller(), accounts);
    expect(add?.status).toBe(200);
    const removed = await serveAccountsRoute(post("/api/accounts/remove", { id: ID }), "/api/accounts/remove", fakeCaller(), accounts);
    expect(await removed?.json()).toEqual({ ok: true });
    expect(await serveAccountsRoute(get(), "/api/launchers", fakeCaller(), accounts)).toBeNull();
    expect(lines.map((l) => [l.action, l.session])).toEqual([
      ["account.add", "default"],
      ["account.remove", "default"],
    ]);
  });
});

describe("live journal roots", () => {
  accountTest("an own account's journal root joins the registry's search with no rebuild", async () => {
    const work = join(home, "work");
    const sid = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
    await mkdir(join(work, "projects", "-x"), { recursive: true });
    await writeFile(join(work, "projects", "-x", `${sid}.jsonl`), "");
    const registry = buildJournalRegistry(
      { agy: [], claude: [join(home, ".claude", "projects")], codex: [], pi: [], opencode: [], grok: [], hermes: [], muse: [], openclaw: [], kiro: [], "dsh-tui": [], mcode: [] },
      {},
      (agent) => ownJournalRoots(store, agent),
    );
    const claude = registry.claude;
    if (claude === undefined) throw new Error("no claude adapter");
    expect(await claude.source.resolve({ kind: "id", value: sid })).toBeNull();
    await store.add({ id: ID, harness: "claude", label: "W", kind: "own", dir: work, addedAt: 1, device: "pixel" });
    expect(await claude.source.resolve({ kind: "id", value: sid })).toBe(join(work, "projects", "-x", `${sid}.jsonl`));
  });
});

// ── Who is signed in (spec 04) ────────────────────────────────────────────────────────────────────────
//
// The status command runs through the injected seam only: no test starts a process. The answers are
// masked, hand-written `claude auth status` outputs with made-up values.

/** A signed-in answer, with the fields the parser must drop (the organisation carries the email too). */
function signedInAs(email: string): AccountStatusRun {
  const stdout = JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    email,
    orgId: "00000000-0000-0000-0000-000000000000",
    orgName: `${email}'s Organization`,
    subscriptionType: "max",
    planTier: "default_claude_max_20x",
  });
  return { code: 0, stdout, stderr: "" };
}
const SIGNED_OUT: AccountStatusRun = { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
const GARBAGE: AccountStatusRun = { code: 0, stdout: "not json", stderr: "" };

/** A fake seam: answers by the account's variable (absent for Default), and keeps every ask. */
function fakeStatus(answer: (folder: string | undefined) => AccountStatusRun | null | Promise<AccountStatusRun | null>) {
  const asks: StatusAsk[] = [];
  const run: StatusRunner = async (ask) => {
    asks.push(ask);
    return answer(ask.env.CLAUDE_CONFIG_DIR);
  };
  return { run, asks };
}

function identityOf(body: AccountsBody, id: string) {
  return body.accounts.find((a) => a.id === id)?.identity;
}

describe("who is signed in", () => {
  // The Default has run here: `~/.claude.json`, the state file with no variable set. Existence only.
  beforeEach(async () => {
    await writeFile(join(home, ".claude.json"), "{}");
  });

  /** A folder Claude Code has run in: its state file is there. */
  async function ranIn(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".claude.json"), "{}");
  }

  accountTest("each account asks the agent's own status command: Default with nothing set, an added one with its variable", async () => {
    await ranIn(join(home, ".claude-work"));
    const status = fakeStatus((folder) => signedInAs(folder === undefined ? "me@example.com" : "work@example.com"));
    const accounts = build({ status: status.run, env: { HOME: home } });
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "own", path: "~/.claude-work" });
    const body = await bodyOf(accounts);
    expect(identityOf(body, "claude:default")).toEqual({ signedIn: true, email: "me@example.com", plan: "max" });
    expect(identityOf(body, ID)).toEqual({ signedIn: true, email: "work@example.com", plan: "max" });
    // Codex has no status command: its row shows what it showed before.
    expect(identityOf(body, "codex:default")).toBeUndefined();
    // The two run side by side, so their order is not fixed.
    expect(status.asks).toHaveLength(2);
    expect(status.asks).toContainEqual({ binary: "claude", args: ["auth", "status"], env: { HOME: home } });
    expect(status.asks).toContainEqual({ binary: "claude", args: ["auth", "status"], env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude-work") } });
  });

  test("the bridge's own settings stay out of a status run's environment", () => {
    expect(withoutBridgeSettings({ PATH: "/usr/bin", HOME: "/home/you", COLLIE_X: "1", COLLIE_STATE_DIR: "/home/you/.local/state/collie", GONE: undefined })).toEqual({ PATH: "/usr/bin", HOME: "/home/you" });
  });

  accountTest("a status run gets PATH, HOME and the account's variable, never a COLLIE_ setting", async () => {
    await ranIn(join(home, ".claude-work"));
    const status = fakeStatus((folder) => signedInAs(folder === join(home, ".claude-work") ? "work@example.com" : "me@example.com"));
    const env = { PATH: "/usr/bin", HOME: home, COLLIE_X: "1", COLLIE_PORT: "8788" };
    const accounts = build({ status: status.run, env });
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "own", path: "~/.claude-work" });
    await bodyOf(accounts);
    expect(status.asks).toHaveLength(2);
    expect(status.asks.map((a) => a.env)).toContainEqual({ PATH: "/usr/bin", HOME: home });
    expect(status.asks.map((a) => a.env)).toContainEqual({ PATH: "/usr/bin", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude-work") });
  });

  accountTest("CLAUDE_CONFIG_DIR from the bridge's own environment still reaches a Default run", async () => {
    await ranIn(join(home, "elsewhere"));
    const status = fakeStatus(() => signedInAs("me@example.com"));
    await bodyOf(build({ status: status.run, env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "elsewhere"), COLLIE_X: "1" } }));
    expect(status.asks.map((a) => a.env)).toEqual([{ HOME: home, CLAUDE_CONFIG_DIR: join(home, "elsewhere") }]);
  });

  accountTest("a missing folder, or one the agent has not run in, reads not signed in with no run", async () => {
    const status = fakeStatus(() => signedInAs("me@example.com"));
    const accounts = build({ status: status.run });
    // An own account on a new folder: the add makes it empty.
    await added(accounts, { requestId: ID, harness: "claude", label: "New", kind: "own", path: "~/.claude-new" });
    await store.add({ id: ID2, harness: "claude", label: "Gone", kind: "own", dir: join(home, ".claude-gone"), addedAt: 1, device: "pixel" });
    const body = await bodyOf(accounts);
    expect(identityOf(body, ID)).toEqual({ signedIn: false });
    expect(identityOf(body, ID2)).toEqual({ signedIn: false });
    expect(status.asks.map((a) => a.env.CLAUDE_CONFIG_DIR)).toEqual([undefined]);
  });

  accountTest("a shared account that never started has links only: nothing runs until its state file is there", async () => {
    const status = fakeStatus((folder) => signedInAs(folder === undefined ? "me@example.com" : "work@example.com"));
    const accounts = build({ status: status.run });
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "shared" });
    // The links make it look like a Claude Code folder; that is not enough.
    expect(await readlink(join(home, ".claude-work", "projects"))).toBe(join(home, ".claude", "projects"));
    const before = await bodyOf(accounts);
    expect(identityOf(before, ID)).toEqual({ signedIn: false });
    expect(status.asks.map((a) => a.env.CLAUDE_CONFIG_DIR)).toEqual([undefined]);
    // The agent's own first start wrote its state file: now the status command runs there.
    await writeFile(join(home, ".claude-work", ".claude.json"), "{}");
    const after = await bodyOf(accounts);
    expect(identityOf(after, ID)).toEqual({ signedIn: true, email: "work@example.com", plan: "max" });
    expect(status.asks.map((a) => a.env.CLAUDE_CONFIG_DIR)).toEqual([undefined, join(home, ".claude-work")]);
  });

  accountTest("the Default with no state file at home or in its folder reads not signed in with no run", async () => {
    await rm(join(home, ".claude.json"));
    const status = fakeStatus(() => signedInAs("me@example.com"));
    const body = await bodyOf(build({ status: status.run }));
    expect(identityOf(body, "claude:default")).toEqual({ signedIn: false });
    expect(status.asks).toHaveLength(0);
    // With the variable set in the bridge's environment, the state file sits in the folder itself.
    await ranIn(join(home, "elsewhere"));
    const moved = await bodyOf(build({ status: status.run, env: { CLAUDE_CONFIG_DIR: join(home, "elsewhere") } }));
    expect(identityOf(moved, "claude:default")).toMatchObject({ signedIn: true });
  });

  accountTest("an answer the parser cannot read, or no answer, shows no identity", async () => {
    const garbage = await bodyOf(build({ status: fakeStatus(() => GARBAGE).run }));
    expect(identityOf(garbage, "claude:default")).toBeUndefined();
    const none = await bodyOf(build({ status: fakeStatus(() => null).run }));
    expect(identityOf(none, "claude:default")).toBeUndefined();
    const out = await bodyOf(build({ status: fakeStatus(() => SIGNED_OUT).run }));
    expect(identityOf(out, "claude:default")).toEqual({ signedIn: false });
  });

  accountTest("a list read waits at most the cap; the answer arrives with the next read", async () => {
    let answer: (run: AccountStatusRun) => void = () => {};
    const slow = new Promise<AccountStatusRun>((resolve) => {
      answer = resolve;
    });
    const status = fakeStatus(() => slow);
    const accounts = build({ status: status.run, identityWaitMs: 20 });
    expect(identityOf(await bodyOf(accounts), "claude:default")).toBeUndefined();
    answer(signedInAs("me@example.com"));
    await slow;
    expect(identityOf(await bodyOf(accounts), "claude:default")).toMatchObject({ email: "me@example.com" });
    expect(status.asks).toHaveLength(1);
  });

  accountTest("one run serves the reads of a minute; after it the held answer is served at once and refreshed behind it", async () => {
    let now = 1_000;
    let email = "me@example.com";
    let release: () => void = () => {};
    let hold = false;
    const status = fakeStatus(async () => {
      if (hold) {
        await new Promise<void>((resolve) => {
          release = () => resolve();
        });
      }
      return signedInAs(email);
    });
    const accounts = build({ status: status.run, now: () => now });
    await bodyOf(accounts);
    now += 59_000;
    await bodyOf(accounts);
    expect(status.asks).toHaveLength(1);
    now += 2_000;
    email = "new@example.com";
    hold = true;
    // The refresh is held open, and the read does not wait for it.
    const stale = await bodyOf(accounts);
    expect(identityOf(stale, "claude:default")).toMatchObject({ email: "me@example.com" });
    expect(status.asks).toHaveLength(2);
    // Other pages read the list too: no second run while the first is in flight.
    await bodyOf(accounts);
    expect(status.asks).toHaveLength(2);
    hold = false;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(identityOf(await bodyOf(accounts), "claude:default")).toMatchObject({ email: "new@example.com" });
    expect(status.asks).toHaveLength(2);
  });

  accountTest("the email reaches the list and nothing else: no audit line, no log line, no organisation, no raw output", async () => {
    await ranIn(join(home, ".claude-work"));
    const status = fakeStatus((folder) => signedInAs(folder === undefined ? "me@example.com" : "work@example.com"));
    const accounts = build({ status: status.run });
    const said: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      }),
    );
    try {
      await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "own", path: "~/.claude-work" });
      await bodyOf(accounts);
      await accounts.remove({ id: ID }, caller());
      // The add answer carries the identity the bridge already holds for that folder, and runs nothing.
      const again = await added(accounts, { requestId: ID2, harness: "claude", label: "Work", kind: "own", path: "~/.claude-work" });
      expect(again.identity).toEqual({ signedIn: true, email: "work@example.com", plan: "max" });
      expect(status.asks).toHaveLength(2);
      const res = await serveAccountsRoute(new Request("http://x/api/accounts"), "/api/accounts", {
        gate: () => null,
        // SAFETY: the accounts routes read only `name` off the runtime (for the audit line's session).
        resolve: () => Promise.resolve({ name: "default" } as Awaited<ReturnType<Parameters<typeof serveAccountsRoute>[2]["resolve"]>>),
        device: () => "pixel",
        audit,
      }, accounts);
      const wire = await res?.text();
      expect(wire).toContain("me@example.com");
      expect(wire).toContain("work@example.com");
      for (const dropped of ["Organization", "orgId", "00000000-0000", "planTier", "authMethod", "loggedIn"]) expect(wire).not.toContain(dropped);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0);
    const audited = JSON.stringify(lines);
    expect(audited).not.toContain("example.com");
    expect(audited).not.toContain("max");
    expect(said.join("\n")).not.toContain("example.com");
  });

  accountTest("Sign in again: the login menu while the account reads signed in, the plain start otherwise", async () => {
    await ranIn(join(home, ".claude-work"));
    let answer: AccountStatusRun = signedInAs("me@example.com");
    const accounts = build({ status: fakeStatus(() => answer).run });
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "own", path: "~/.claude-work" });
    const start = (account: string | undefined, signIn = true) => accounts.startLine({ harness: "claude", base: "claude", account, signIn });
    const work = `CLAUDE_CONFIG_DIR='${join(home, ".claude-work")}' claude`;
    // Nothing read yet: unknown, so the plain start.
    expect(await start(undefined)).toMatchObject({ ok: true, command: "claude" });
    await bodyOf(accounts);
    // Signed in.
    expect(await start(undefined)).toMatchObject({ ok: true, command: "claude /login" });
    expect(await start("claude:default")).toMatchObject({ ok: true, command: "claude /login" });
    expect(await start(ID)).toMatchObject({ ok: true, command: `${work} /login` });
    // Not a sign-in: the line it always was.
    expect(await start(ID, false)).toEqual({ ok: true, command: work, account: expect.objectContaining({ id: ID }) });
    // Not signed in.
    answer = SIGNED_OUT;
    const fresh = build({ status: fakeStatus(() => answer).run });
    await bodyOf(fresh);
    expect(await fresh.startLine({ harness: "claude", base: "claude", account: ID, signIn: true })).toMatchObject({ ok: true, command: work });
    expect(await fresh.startLine({ harness: "claude", base: "claude", account: undefined, signIn: true })).toMatchObject({ ok: true, command: "claude" });
    // Unknown.
    answer = GARBAGE;
    const unknown = build({ status: fakeStatus(() => answer).run });
    await bodyOf(unknown);
    expect(await unknown.startLine({ harness: "claude", base: "claude", account: undefined, signIn: true })).toMatchObject({ ok: true, command: "claude" });
    // An agent with no status command keeps its start.
    expect(await accounts.startLine({ harness: "codex", base: "codex", account: undefined, signIn: true })).toEqual({ ok: true, command: "codex" });
  });

  accountTest("a sign-in start drops the identity, re-reads it every 5 s while its pane lives, and once more when it goes", async () => {
    let now = 1_000;
    let panes = [{ session: "default", pane: pane({ paneId: "w1:p7" }) }];
    let email = "me@example.com";
    const status = fakeStatus(() => signedInAs(email));
    const accounts = build({ status: status.run, now: () => now, panes: () => panes });
    await bodyOf(accounts);
    expect(status.asks).toHaveLength(1);
    const begun = await accounts.startLine({ harness: "claude", base: "claude", account: undefined, signIn: true });
    if (!begun.ok || begun.signInFor === undefined) throw new Error("expected a sign-in mark");
    accounts.noteSignIn("default", "w1:p7", begun.signInFor);
    // Dropped: the old answer is never served again; the next read waits for a new run.
    expect(await accounts.startLine({ harness: "claude", base: "claude", account: undefined, signIn: true })).toMatchObject({ command: "claude" });
    email = "other@example.com";
    expect(identityOf(await bodyOf(accounts), "claude:default")).toMatchObject({ email: "other@example.com" });
    expect(status.asks).toHaveLength(2);
    now += 3_000;
    await bodyOf(accounts);
    expect(status.asks).toHaveLength(2);
    now += 3_000;
    await bodyOf(accounts);
    expect(status.asks).toHaveLength(3);
    // The pane is gone: dropped once more, then back to the minute.
    panes = [];
    accounts.keep("default", []);
    await bodyOf(accounts);
    expect(status.asks).toHaveLength(4);
    now += 10_000;
    await bodyOf(accounts);
    expect(status.asks).toHaveLength(4);
  });

  test("Windows asks nothing", async () => {
    const status = fakeStatus(() => signedInAs("me@example.com"));
    const accounts = build({ status: status.run, platform: "win32" });
    expect(await accounts.body()).toBeNull();
    expect(await accounts.startLine({ harness: "claude", base: "claude", account: undefined, signIn: true })).toEqual({ ok: true, command: "claude" });
    expect(status.asks).toHaveLength(0);
  });
});
