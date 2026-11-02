import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog, type AuditEntry } from "./audit.ts";
import { gitRuns } from "./changes.ts";
import { createWorktreeAt } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentView, Launcher, WorkspaceView, WorktreeCreateResponse } from "./types.ts";
import {
  muxAck,
  muxOk,
  muxRefused,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxOutcome,
  type MuxSpaceRequest,
} from "./mux/types.ts";
import { memoryWorktreeReceipts, type WorktreeReceiptSurface } from "./worktree-receipts.ts";
import { memoryWorktreeBases, type WorktreeBaseSurface } from "./worktree-bases.ts";
import type { GitAsk } from "./worktree-base.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { LEAD_ROW_HEADER, LEAD_ROW_MARK } from "./crew/launcher-rows.ts";

// `POST /api/worktree` with a request id and a launcher (ADR 0089, ADR 0093). These cases were
// written for the space-scoped `POST /api/workspace/:id/worktree`, which nothing called after the
// New sheet moved to the folder route; both share `runWorktreeCreate`, so the claims moved here
// with the route's removal. The four claims:
//
//   1. A repeat with a known `requestId` answers from the receipt, `replayed: true`, and the
//      multiplexer is asked once in all. A repeat while the first is still running joins it.
//   2. A `command` that is no row of launchers.toml is a 400 before the multiplexer is touched.
//   3. A branch that would read as a flag, or that Git refuses, is a 400 before it is touched too.
//   4. A launcher that fails AFTER the create is a 200 with the worktree and `launcherStarted: false`:
//      the worktree exists, so nothing is rolled back.
//
// Since M81 the bridge makes the checkout with git (bridge/worktree-add.ts) and the multiplexer only
// opens it (`createSpace`), so the repo here is a real one in a temporary home, and the fake
// multiplexer records the spaces it was asked to open. The two ends of a half-done create:
//
//   5. Git's own refusal is `worktree.create_failed` with git's sentence, and no space is asked for.
//   6. A space that will not open is `worktree.created_not_opened`; the checkout stays, and a retry
//      finds it and only opens it.

let HOME: string;
let REPO: string;
let root: string;
const SPACE = "w1";
const REQUEST_ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const OTHER_ID = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const CLAUDE: Launcher = { command: "claude", label: "Claude" };

/** Run git in `cwd` for the test's own setup and checks, with no operator config. Answers stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME },
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

const commit = (message: string) =>
  git(REPO, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", message);

// The repo: `main` with two commits, and `feature/x` one behind it, so a base shows in the new branch.
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "collie-wt-route-")));
  HOME = join(root, "home", "op");
  REPO = join(HOME, "repo");
  await mkdir(REPO, { recursive: true });
  await git(REPO, "init", "-q", "-b", "main");
  await commit("one");
  await git(REPO, "branch", "feature/x");
  await commit("two");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Herdr's default folder for a branch in this repo: where the checkout goes when no folder is named. */
const target = (slug: string): string => join(HOME, ".herdr", "worktrees", "repo", slug);

/** The commit a branch points at in the repo. */
const commitOf = (ref: string): Promise<string> => git(REPO, "rev-parse", `${ref}^{commit}`);

/** How many linked worktrees the repo has: every one beyond its main checkout. */
async function linkedCount(): Promise<number> {
  const listing = await git(REPO, "worktree", "list", "--porcelain");
  return listing.split("\n").filter((line) => line.startsWith("worktree ")).length - 1;
}

const repoSpace = (): WorkspaceView => ({
  workspaceId: SPACE,
  number: 1,
  label: "repo",
  focused: false,
  activeTabId: "w1:t1",
  tabCount: 1,
  paneCount: 1,
  repoRoot: REPO,
  isWorktree: false,
});

/** An engine whose snapshot holds the repo's space, plus whatever was created since. */
function engineWith(workspaces: WorkspaceView[], agents: AgentView[] = []): StateEngine {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({ agents, shellPanes: [], workspaces, tabs: [], bridge: "connected" }),
  };
  // SAFETY: the route reaches only `current()` (the repo lookup and a replay's label) and
  // `pokeNow()` (after the create). No other member of the engine is reachable from it.
  return stub as StateEngine;
}

/** A clock the test owns, so the launcher's wait for a settled screen passes in no real time. */
function fakeClock() {
  let ms = 0;
  return {
    now: () => ms,
    sleep: (by: number): Promise<void> => {
      ms += by;
      return Promise.resolve();
    },
  };
}

/** Only what the route reaches: open the checkout as a space, read its grid, type, submit, refresh. */
class FakeWorktreeMux {
  readonly spaces: MuxSpaceRequest[] = [];
  readonly texts: Array<[string, string]> = [];
  readonly keys: Array<[string, readonly string[]]> = [];
  readonly closes: string[] = [];
  failSpace: string | null = null;
  failText = false;
  /** Resolves the open when set; the open waits for it. */
  gate: Promise<void> | null = null;

  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.spaces.push(request);
    if (this.gate) await this.gate;
    if (this.failSpace !== null) return muxRefused(this.failSpace);
    return muxOk({
      paneId: "w7:p1",
      spaceId: "w7",
      spaceLabel: "repo-brisk-otter",
      tabId: "w7:t1",
      cwd: request.cwd,
    });
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    return Promise.resolve(this.failText ? muxRefused("pane is gone") : muxAck());
  }
  writeKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    this.keys.push([paneId, keys]);
    return Promise.resolve(muxAck());
  }
  closePane(paneId: string): Promise<MuxAck> {
    this.closes.push(paneId);
    return Promise.resolve(muxAck());
  }
  refresh(): Promise<void> {
    return Promise.resolve();
  }
}

function asMux(fake: Partial<MuxAdapter>): MuxAdapter {
  // SAFETY: the create route reaches exactly the six members FakeWorktreeMux implements:
  // createSpace, then (with a launcher) readGrid, typeText and sendKeys, and refresh after it.
  // `closePane` is there to prove it is NEVER called.
  return fake as MuxAdapter;
}

type AuditLine = AuditEntry & { ts: string };

function auditTrail() {
  const entries: AuditLine[] = [];
  return {
    audit: new AuditLog((line) => {
      // SAFETY: the appender is handed formatAuditLine's own output, so the parse round-trips it.
      entries.push(JSON.parse(line) as AuditLine);
    }),
    entries,
  };
}

/** What a phone posts here. Every field optional, so a case can leave out any of them. */
interface CreateBody {
  branch?: string;
  requestId?: string;
  launcher?: string | null;
  base?: JsonValue;
  /** The lead's row for `launcher`, as a lead's forward carries it (ADR 0127 point 3). */
  row?: JsonValue;
}

/**
 * The folder route's body for a create body: the repo as `cwd`, and the launcher as `command`.
 * `marked`: the request carries the lead's `X-Collie-Lead-Row` mark, as a lead's forward of its own row does.
 */
function post(body: CreateBody, marked = false): Request {
  const sent: JsonObject = { cwd: REPO };
  if (body.branch !== undefined) sent.branch = body.branch;
  if (body.requestId !== undefined) sent.requestId = body.requestId;
  if (body.launcher !== undefined) sent.command = body.launcher;
  if (body.base !== undefined) sent.base = body.base;
  if (body.row !== undefined) sent.row = body.row;
  const headers = new Headers({ "content-type": "application/json" });
  if (marked) headers.set(LEAD_ROW_HEADER, LEAD_ROW_MARK);
  return new Request("http://localhost/api/worktree", {
    method: "POST",
    headers,
    body: JSON.stringify(sent),
  });
}

interface RunOpts {
  receipts?: WorktreeReceiptSurface;
  engine?: StateEngine;
  audit?: AuditLog;
  rows?: Launcher[];
  bases?: WorktreeBaseSurface;
  ask?: GitAsk;
  /** The call came over the crew link from this machine's lead. */
  viaCrew?: boolean;
  /** The request carries the lead's `X-Collie-Lead-Row` mark. */
  marked?: boolean;
}

/** A forward of the lead's own row: over the crew link, with the lead's mark (ADR 0127 point 3). */
const FROM_LEAD = { viaCrew: true, marked: true } as const;

/** The folder route's raw answer, for a case that must read a non-JSON refusal. */
function send(mux: FakeWorktreeMux, body: CreateBody, opts: RunOpts = {}): Promise<Response> {
  return createWorktreeAt(
    asMux(mux),
    opts.engine ?? engineWith([repoSpace()]),
    post(body, opts.marked === true),
    opts.audit ?? auditTrail().audit,
    null,
    "default",
    () => Promise.resolve(opts.rows ?? [CLAUDE]),
    {
      home: HOME,
      ask: opts.ask ?? gitWith([]).ask,
      readHerdrConfig: () => Promise.resolve(null),
      receipts: opts.receipts ?? memoryWorktreeReceipts(),
      bases: opts.bases,
      wait: fakeClock(),
      viaCrew: opts.viaCrew,
    },
  );
}

async function run(
  mux: FakeWorktreeMux,
  body: CreateBody,
  opts: RunOpts = {},
): Promise<{ status: number; answer: WorktreeCreateResponse }> {
  const res = await send(mux, body, opts);
  // SAFETY: every JSON body this route writes is a WorktreeCreateResponse (`satisfies` at each site).
  return { status: res.status, answer: (await res.json()) as WorktreeCreateResponse };
}

describe("POST /api/worktree — a branch alone", () => {
  test("a branch alone creates the worktree with git and opens it, with no launcher and no receipt", async () => {
    const mux = new FakeWorktreeMux();
    const receipts = memoryWorktreeReceipts();
    const { status, answer } = await run(mux, { branch: "feature/new" }, { receipts });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ ok: true, alreadyOpen: false, launcherStarted: false });
    expect(mux.spaces).toEqual([{ cwd: target("feature-new"), label: "feature-new" }]);
    expect(await git(target("feature-new"), "symbolic-ref", "--short", "HEAD")).toBe("feature/new");
    expect(answer.ok && answer.pane.cwd).toBe(target("feature-new"));
    expect(mux.texts).toEqual([]);
  });
});

describe("POST /api/worktree — request id and receipt", () => {
  test("a repeat with a known requestId returns the receipt and asks the multiplexer once", async () => {
    const mux = new FakeWorktreeMux();
    const receipts = memoryWorktreeReceipts();
    const first = await run(mux, { branch: "worktree/brisk-otter-3fa9", requestId: REQUEST_ID, launcher: "claude" }, { receipts });
    expect(first.status).toBe(200);
    expect(first.answer).toMatchObject({ ok: true, launcherStarted: true });
    expect(first.answer.ok && first.answer.replayed).toBeFalsy();

    // The created space is in the snapshot by now, so the replay reads its label off it.
    const engine = engineWith([
      repoSpace(),
      { ...repoSpace(), workspaceId: "w7", label: "repo-brisk-otter", isWorktree: true },
    ]);
    const second = await run(mux, { branch: "worktree/brisk-otter-3fa9", requestId: REQUEST_ID, launcher: "claude" }, { receipts, engine });
    expect(second.status).toBe(200);
    expect(second.answer).toEqual({
      ok: true,
      alreadyOpen: false,
      replayed: true,
      launcherStarted: true,
      pane: {
        paneId: "w7:p1",
        workspaceId: "w7",
        workspaceLabel: "repo-brisk-otter",
        tabId: "",
        cwd: target("worktree-brisk-otter-3fa9"),
      },
    });
    expect(mux.spaces).toHaveLength(1);
    expect(mux.texts).toHaveLength(1);
    expect(await linkedCount()).toBe(1);
  });

  test("a repeat while the first is still running joins it and creates nothing", async () => {
    const mux = new FakeWorktreeMux();
    let open: () => void = () => {};
    mux.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const receipts = memoryWorktreeReceipts();
    const body = { branch: "worktree/x", requestId: REQUEST_ID };
    const first = run(mux, body, { receipts });
    const second = run(mux, body, { receipts });
    // Let both requests reach their wait before the open answers.
    for (let i = 0; i < 200 && mux.spaces.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(mux.spaces).toHaveLength(1);
    // The repo lookup reads the real disk, so either request may be the one that runs the create:
    // exactly one answer is the create's, and the other joins it.
    const answers = [a.answer, b.answer];
    expect(answers.every((answer) => answer.ok && answer.pane.paneId === "w7:p1")).toBe(true);
    expect(answers.filter((answer) => answer.ok && answer.replayed === true)).toHaveLength(1);
    expect(await linkedCount()).toBe(1);
  });

  test("a space that will not open is created_not_opened: the checkout stays, no receipt, and a retry only opens it", async () => {
    const mux = new FakeWorktreeMux();
    mux.failSpace = "workspace.create failed";
    const receipts = memoryWorktreeReceipts();
    const first = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID }, { receipts });
    expect(first.answer).toMatchObject({ ok: false, code: "worktree.created_not_opened" });
    expect(!first.answer.ok && first.answer.error).toContain(target("worktree-x"));
    expect(receipts.get(REQUEST_ID)).toBeUndefined();
    expect(await git(target("worktree-x"), "symbolic-ref", "--short", "HEAD")).toBe("worktree/x");
    mux.failSpace = null;
    // The branch exists now, so a second `git worktree add -b` would refuse: the retry must find it.
    const second = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID }, { receipts });
    expect(second.answer).toMatchObject({ ok: true, pane: { cwd: target("worktree-x") } });
    expect(mux.spaces).toEqual([
      { cwd: target("worktree-x"), label: "worktree-x" },
      { cwd: target("worktree-x"), label: "worktree-x" },
    ]);
    expect(receipts.get(REQUEST_ID)?.path).toBe(target("worktree-x"));
    expect(await linkedCount()).toBe(1);
  });

  test("a fresh request id after a half-done create opens the same checkout too", async () => {
    const mux = new FakeWorktreeMux();
    mux.failSpace = "no";
    await run(mux, { branch: "worktree/x" });
    mux.failSpace = null;
    const { answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID });
    expect(answer).toMatchObject({ ok: true, pane: { cwd: target("worktree-x") } });
    expect(await linkedCount()).toBe(1);
  });

  test("two requests with two ids for one folder at once: one git worktree add, one checkout", async () => {
    const mux = new FakeWorktreeMux();
    const receipts = memoryWorktreeReceipts();
    const before = gitRuns.spawned;
    const [a, b] = await Promise.all([
      run(mux, { branch: "worktree/x", requestId: REQUEST_ID }, { receipts }),
      run(mux, { branch: "worktree/x", requestId: OTHER_ID }, { receipts }),
    ]);
    expect(a.answer).toMatchObject({ ok: true, pane: { cwd: target("worktree-x") } });
    expect(b.answer).toMatchObject({ ok: true, pane: { cwd: target("worktree-x") } });
    // `ask` is a fake here, so every git process is the create's own: one list each, and one add.
    expect(gitRuns.spawned - before).toBe(3);
    expect(await linkedCount()).toBe(1);
  });

  test("the folder holding another branch is target_exists, with the folder and the branch it holds", async () => {
    const mux = new FakeWorktreeMux();
    expect((await run(mux, { branch: "worktree/x" })).answer).toMatchObject({ ok: true });
    // `worktree-x` is the slug of both names, so the second lands on the first one's folder.
    const { answer } = await run(mux, { branch: "worktree-x" });
    expect(answer).toMatchObject({
      ok: false,
      code: "worktree.target_exists",
      detail: { path: target("worktree-x"), reason: "that folder holds branch worktree/x" },
    });
    expect(mux.spaces).toHaveLength(1);
  });

  test("git's own refusal is create_failed with git's sentence, and no space is asked for", async () => {
    const mux = new FakeWorktreeMux();
    await git(REPO, "branch", "worktree/x");
    const receipts = memoryWorktreeReceipts();
    const { answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID }, { receipts });
    expect(answer).toMatchObject({ ok: false, code: "worktree.create_failed", error: "a branch named 'worktree/x' already exists" });
    expect(mux.spaces).toEqual([]);
    expect(receipts.get(REQUEST_ID)).toBeUndefined();
    expect(await linkedCount()).toBe(0);
  });

  test("a requestId that is not a UUID is a 400 and nothing runs", async () => {
    const mux = new FakeWorktreeMux();
    const res = await send(mux, { branch: "worktree/x", requestId: "../../etc/passwd" });
    expect(res.status).toBe(400);
    expect(mux.spaces).toEqual([]);
    expect(await linkedCount()).toBe(0);
  });

  test("the audit line carries the launcher and the request id", async () => {
    const mux = new FakeWorktreeMux();
    const { audit, entries } = auditTrail();
    await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "claude" }, { audit });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("worktree.create");
    expect(entries[0]?.detail).toMatchObject({
      branch: "worktree/x",
      repoRoot: REPO,
      requestId: REQUEST_ID,
      launcher: "claude",
      launcherStarted: "true",
    });
  });
});

describe("POST /api/worktree — the launcher allowlist", () => {
  test("a launcher that is no row is a 400 before the multiplexer is touched", async () => {
    const mux = new FakeWorktreeMux();
    const { audit, entries } = auditTrail();
    const { status, answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "rm -rf ~" }, { audit });
    expect(status).toBe(400);
    expect(answer).toMatchObject({ ok: false, code: "launch.not_allowlisted" });
    expect(mux.spaces).toEqual([]);
    expect(entries).toEqual([]);
    expect(await linkedCount()).toBe(0);
  });

  test("a row is matched exactly, then typed into the new root pane with Enter", async () => {
    const mux = new FakeWorktreeMux();
    const { status, answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "claude" });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ ok: true, launcherStarted: true });
    expect(mux.texts).toEqual([["w7:p1", "claude"]]);
    expect(mux.keys).toEqual([["w7:p1", ["Enter"]]]);
  });

  test("a null launcher is a plain shell", async () => {
    const mux = new FakeWorktreeMux();
    const { answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: null });
    expect(answer).toMatchObject({ ok: true, launcherStarted: false });
    expect(mux.texts).toEqual([]);
  });

  test("a launcher that fails after the create is still a 200 with the worktree, and nothing is closed", async () => {
    const mux = new FakeWorktreeMux();
    mux.failText = true;
    const receipts = memoryWorktreeReceipts();
    const { status, answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "claude" }, { receipts });
    expect(status).toBe(200);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.launcherStarted).toBe(false);
    expect(answer.launcherError).toContain("pane is gone");
    expect(answer.pane.paneId).toBe("w7:p1");
    expect(mux.closes).toEqual([]);
    // The receipt records the truth, so a replay says the launcher did not start either.
    expect(receipts.get(REQUEST_ID)?.launcherStarted).toBe(false);
    expect(await linkedCount()).toBe(1);
  });
});

describe("POST /api/worktree — a lead row carried over the crew link (ADR 0127 point 3)", () => {
  const ROW = { command: "codex --full-auto", label: "Codex", harness: "codex", noPrompts: true };

  test("the lead's row starts as the launcher on the member, audited `source: lead`", async () => {
    const mux = new FakeWorktreeMux();
    const { audit, entries } = auditTrail();
    const { status, answer } = await run(
      mux,
      { branch: "worktree/x", requestId: REQUEST_ID, launcher: "codex --full-auto", row: ROW },
      { audit, ...FROM_LEAD },
    );
    expect(status).toBe(200);
    expect(answer).toMatchObject({ ok: true, launcherStarted: true });
    expect(mux.texts).toEqual([["w7:p1", "codex --full-auto"]]);
    expect(entries[0]?.detail).toMatchObject({ launcher: "codex --full-auto", launcherStarted: "true", source: "lead" });
  });

  test("a phone-direct body with `row` is refused before git or the multiplexer is touched", async () => {
    const mux = new FakeWorktreeMux();
    const { status, answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "codex --full-auto", row: ROW });
    expect(status).toBe(400);
    expect(answer).toMatchObject({ ok: false, code: "launch.row_not_from_lead" });
    expect(mux.spaces).toEqual([]);
    expect(await linkedCount()).toBe(0);
  });

  test("an old lead's shape, a body `row` over the crew link with no mark, is refused before git is touched", async () => {
    // A lead before 0127 forwards the phone's body unchanged, `row` included, and never adds the mark.
    const mux = new FakeWorktreeMux();
    const { status, answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "codex --full-auto", row: ROW }, { viaCrew: true });
    expect(status).toBe(400);
    expect(answer).toMatchObject({ ok: false, code: "launch.row_not_from_lead" });
    expect(mux.spaces).toEqual([]);
    expect(mux.texts).toEqual([]);
    expect(await linkedCount()).toBe(0);
  });

  test("the mark alone, on a call that did not come over the crew link, is refused the same way", async () => {
    const mux = new FakeWorktreeMux();
    const { status, answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "codex --full-auto", row: ROW }, { marked: true });
    expect(status).toBe(400);
    expect(answer).toMatchObject({ ok: false, code: "launch.row_not_from_lead" });
    expect(mux.spaces).toEqual([]);
    expect(await linkedCount()).toBe(0);
  });

  test("this machine's own row wins over a carried one with the same command", async () => {
    const mux = new FakeWorktreeMux();
    const { audit, entries } = auditTrail();
    const carried = { command: "claude", label: "Lead Claude", noPrompts: false };
    const { answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "claude", row: carried }, { audit, ...FROM_LEAD });
    expect(answer).toMatchObject({ ok: true, launcherStarted: true });
    expect(entries[0]?.detail).not.toHaveProperty("source");
  });
});

describe("POST /api/worktree — branch validation", () => {
  for (const branch of ["-rf", "a..b", "has space", "x:y", "trail/", "x.lock", "a//b"]) {
    test(`${JSON.stringify(branch)} is a 400 before the multiplexer is touched`, async () => {
      const mux = new FakeWorktreeMux();
      const { status, answer } = await run(mux, { branch, requestId: REQUEST_ID });
      expect(status).toBe(400);
      expect(answer).toMatchObject({ ok: false, code: "worktree.invalid_branch", error: "invalid branch" });
      expect(mux.spaces).toEqual([]);
      expect(await linkedCount()).toBe(0);
    });
  }

  test("an empty branch keeps its old answer", async () => {
    const mux = new FakeWorktreeMux();
    const { status, answer } = await run(mux, { branch: "  " });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ ok: false, code: "worktree.branch_required" });
  });
});

// ── Where the branch starts (ADR 0089, amended) ───────────────────────────────────────────────────
//
//   1. A body with no `base` is the old create: the branch starts at the repo's HEAD, git is never
//      asked for a starting point, and nothing is stored.
//   2. `default` and `ref` resolve on the bridge, and the new branch starts at the resolved ref.
//   3. A bad base is a 400 before the multiplexer is touched.
//   4. The base is stored by folder after a success, and only then.

const WORKTREE_FOLDER = (): string => target("worktree-x");

/** The commit the new branch `worktree/x` starts at. */
const newBranchCommit = (): Promise<string> => git(WORKTREE_FOLDER(), "rev-parse", "HEAD");

/** A git double and the argv arrays it was asked. */
interface GitDouble {
  ask: GitAsk;
  asked: string[][];
}

/** A git that knows the named branches, and records what it was asked. */
function gitWith(branches: string[]): GitDouble {
  const asked: string[][] = [];
  const ask: GitAsk = (_repo, args) => {
    asked.push([...args]);
    if (args[0] === "check-ref-format") return Promise.resolve("");
    // The folder route finds the repo from `cwd` first; this repo is its own main checkout.
    if (args.includes("--git-common-dir")) return Promise.resolve(`${REPO}/.git`);
    const verifying = args[0] === "rev-parse" ? args[args.length - 1] : undefined;
    const known = branches.some((b) => verifying === `refs/heads/${b}^{commit}` || verifying === `${b}^{commit}`);
    return Promise.resolve(known ? "0123456789abcdef0123456789abcdef01234567" : null);
  };
  return { ask, asked };
}

describe("POST /api/worktree — the starting point", () => {
  test("no base: the branch starts at HEAD, git is not asked for a base, nothing is stored", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    const { ask, asked } = gitWith(["main"]);
    const { status } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID }, { bases, ask });
    expect(status).toBe(200);
    expect(await newBranchCommit()).toBe(await commitOf("HEAD"));
    // Only the repo lookup and the branch check: no ref was resolved.
    expect(asked.filter((args) => args.some((a) => a.endsWith("^{commit}")))).toEqual([]);
    expect(bases.get(WORKTREE_FOLDER())).toBeUndefined();
  });

  test("a null base is the same as none", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    await run(mux, { branch: "worktree/x", base: null }, { bases, ask: gitWith(["main"]).ask });
    expect(await newBranchCommit()).toBe(await commitOf("HEAD"));
    expect(bases.get(WORKTREE_FOLDER())).toBeUndefined();
  });

  test("default is resolved on the bridge and used, then stored under the checkout folder", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    const { ask } = gitWith(["main"]);
    const before = Date.now();
    const { status } = await run(mux, { branch: "worktree/x", base: { kind: "default" } }, { bases, ask });
    expect(status).toBe(200);
    expect(await newBranchCommit()).toBe(await commitOf("main"));
    const stored = bases.get(WORKTREE_FOLDER());
    expect(stored?.base).toBe("main");
    expect(stored?.branch).toBe("worktree/x");
    expect(stored?.createdAt).toBeGreaterThanOrEqual(before);
  });

  test("a default that resolves to nothing uses no base and stores nothing, and the create still happens", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    const { status } = await run(mux, { branch: "worktree/x", base: { kind: "default" } }, { bases, ask: gitWith([]).ask });
    expect(status).toBe(200);
    expect(await newBranchCommit()).toBe(await commitOf("HEAD"));
    expect(bases.get(WORKTREE_FOLDER())).toBeUndefined();
  });

  test("a ref that names a commit is the starting point, as given", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    const { status } = await run(mux, { branch: "worktree/x", base: { kind: "ref", ref: "feature/x" } }, { bases, ask: gitWith(["feature/x"]).ask });
    expect(status).toBe(200);
    expect(await newBranchCommit()).toBe(await commitOf("feature/x"));
    expect(await commitOf("feature/x")).not.toBe(await commitOf("main"));
    expect(bases.get(WORKTREE_FOLDER())?.base).toBe("feature/x");
  });

  test("the audit line names the base", async () => {
    const mux = new FakeWorktreeMux();
    const { audit, entries } = auditTrail();
    await run(mux, { branch: "worktree/x", base: { kind: "default" } }, { audit, ask: gitWith(["main"]).ask });
    expect(entries[0]?.detail).toMatchObject({ base: "main" });
  });

  for (const [label, base] of [
    ["a string", "main"],
    ["an unknown kind", { kind: "tip" }],
    ["a ref with no ref", { kind: "ref" }],
    ["a flag", { kind: "ref", ref: "--upload-pack=x" }],
    ["a revision expression", { kind: "ref", ref: "HEAD~1" }],
    ["whitespace", { kind: "ref", ref: "ma in" }],
    ["a ref that names no commit here", { kind: "ref", ref: "feature/gone" }],
  ] as const) {
    test(`${label} is a 400 (worktree.invalid_base) before the multiplexer is touched`, async () => {
      const mux = new FakeWorktreeMux();
      const bases = memoryWorktreeBases();
      const { status, answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, base }, { bases, ask: gitWith(["main"]).ask });
      expect(status).toBe(400);
      expect(answer).toMatchObject({ ok: false, code: "worktree.invalid_base", error: "invalid base" });
      expect(mux.spaces).toEqual([]);
      expect(await linkedCount()).toBe(0);
      expect(bases.get(WORKTREE_FOLDER())).toBeUndefined();
    });
  }

  test("a refused create stores no base", async () => {
    const mux = new FakeWorktreeMux();
    await git(REPO, "branch", "worktree/x");
    const bases = memoryWorktreeBases();
    const { answer } = await run(mux, { branch: "worktree/x", base: { kind: "default" } }, { bases, ask: gitWith(["main"]).ask });
    expect(answer).toMatchObject({ ok: false, code: "worktree.create_failed" });
    expect(mux.spaces).toEqual([]);
    expect(bases.get(WORKTREE_FOLDER())).toBeUndefined();
  });

  test("a space that will not open stores no base; the retry that opens it does", async () => {
    const mux = new FakeWorktreeMux();
    mux.failSpace = "no";
    const bases = memoryWorktreeBases();
    const body = { branch: "worktree/x", base: { kind: "default" } } as const;
    expect((await run(mux, body, { bases, ask: gitWith(["main"]).ask })).answer).toMatchObject({ ok: false, code: "worktree.created_not_opened" });
    expect(bases.get(WORKTREE_FOLDER())).toBeUndefined();
    mux.failSpace = null;
    expect((await run(mux, body, { bases, ask: gitWith(["main"]).ask })).answer).toMatchObject({ ok: true });
    expect(bases.get(WORKTREE_FOLDER())?.base).toBe("main");
  });

  test("a replay of the same id asks neither git nor the multiplexer again", async () => {
    const mux = new FakeWorktreeMux();
    const receipts = memoryWorktreeReceipts();
    const body = { branch: "worktree/x", requestId: REQUEST_ID, base: { kind: "default" } } as const;
    await run(mux, body, { receipts, ask: gitWith(["main"]).ask });
    const { ask, asked } = gitWith(["main"]);
    const second = await run(mux, body, { receipts, ask });
    expect(second.answer).toMatchObject({ ok: true, replayed: true });
    expect(mux.spaces).toHaveLength(1);
    expect(asked).toEqual([]);
  });
});
