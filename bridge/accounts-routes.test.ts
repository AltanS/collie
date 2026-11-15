import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { realLinkDisk } from "./account-links.ts";
import { Accounts, defaultAccountId, ownJournalRoots, type AccountsAnswer, type AccountsCaller, type AccountsDeps } from "./accounts-routes.ts";
import { AccountStore, MAX_ACCOUNTS, type AccountRecord } from "./accounts-store.ts";
import { AuditLog } from "./audit.ts";
import { harnessLaunch } from "./harness-launch.ts";
import { buildJournalRegistry } from "./journal/registry.ts";
import type { JsonValue } from "./json.ts";
import { memoryAddedIo } from "./launchers-added.ts";
import { serveAccountsRoute } from "./server.ts";
import type { AccountRow, AccountsBody, AgentView } from "./types.ts";

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
    expect(body.harnesses[0]).toEqual({ id: "claude", label: "Claude Code", select: "CLAUDE_CONFIG_DIR", kinds: ["shared", "own"], newFolder: "~/.claude-{slug}" });
    expect(body.harnesses[1]?.kinds).toEqual(["own"]);
    expect(body.accounts.map((a) => a.id)).toEqual(["claude:default", "codex:default"]);
    expect(body.accounts[0]).toMatchObject({ kind: "default", label: "", folder: "~/.claude", startLine: "claude", windows: [], seenAt: null, live: false });
  });

  test("Windows and a machine with no account-capable agent offer nothing", async () => {
    expect(await build({ platform: "win32" }).body()).toBeNull();
    expect(await build({ harnesses: { list: () => Promise.resolve([{ id: "opencode", label: "opencode", found: true }]), launch: harnessLaunch } }).body()).toBeNull();
  });

  test("found folders: by name and layout, and reported by a session; never the default or an added one", async () => {
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
  test("a shared account: a new folder that links the default's setup, one audit line, a replay", async () => {
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

  test("a label is unique per agent without case, a folder once, and the cap holds", async () => {
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
  test("forgets the label only; the folder and its links stay", async () => {
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
  test("no account is the base line; the Default id is too; an own account is the quoted folder", async () => {
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

  test("a shared account runs the link pass first, so an entry the default gained since is linked", async () => {
    const accounts = build();
    await added(accounts, { requestId: ID, harness: "claude", label: "Work", kind: "shared" });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "# notes");
    await accounts.startLine({ harness: "claude", base: "claude", account: ID, signIn: false });
    expect(await readlink(join(home, ".claude-work", "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
  });
});

describe("a pane's account", () => {
  const row: AccountRecord = { id: ID, harness: "claude", label: "Work", kind: "own", dir: "/srv/work", addedAt: 1, device: "pixel" };

  test("the folder the agent reported wins; a launch note counts until it reports", async () => {
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

  test("the slash and skill scan reads the account's folder: the folder, and the variable laid over the env", async () => {
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

  test("live follows the panes: an added account's pane, and the Default's", async () => {
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

  test("the journal roots grow with own accounts only", async () => {
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

  test("no service answers the read with accounts.unavailable, as an older bridge would be read", async () => {
    const res = await serveAccountsRoute(get(), "/api/accounts", fakeCaller(), undefined);
    expect(res?.status).toBe(404);
    expect(await res?.json()).toMatchObject({ code: "accounts.unavailable" });
  });

  test("read, add and remove; a read-only device may read and not write; other paths are not ours", async () => {
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
  test("an own account's journal root joins the registry's search with no rebuild", async () => {
    const work = join(home, "work");
    const sid = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
    await mkdir(join(work, "projects", "-x"), { recursive: true });
    await writeFile(join(work, "projects", "-x", `${sid}.jsonl`), "");
    const registry = buildJournalRegistry(
      { agy: [], claude: [join(home, ".claude", "projects")], codex: [], pi: [], opencode: [], grok: [], hermes: [], muse: [], openclaw: [], kiro: [], "dsh-tui": [] },
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
