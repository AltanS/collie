import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "./audit.ts";
import { createWorktree, listWorktrees } from "./server.ts";
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
  type MuxWorktreeCreateRequest,
} from "./mux/types.ts";
import { memoryWorktreeReceipts, type WorktreeReceiptSurface } from "./worktree-receipts.ts";
import { memoryWorktreeBases, type WorktreeBaseSurface } from "./worktree-bases.ts";
import type { GitAsk } from "./worktree-base.ts";
import type { JsonValue } from "./json.ts";

// `POST /api/workspace/:id/worktree` with a request id and a launcher (ADR 0089). The four claims:
//
//   1. A repeat with a known `requestId` answers from the receipt, `replayed: true`, and the
//      multiplexer is asked once in all. A repeat while the first is still running joins it.
//   2. A `launcher` that is no row of launchers.toml is a 400 before the multiplexer is touched.
//   3. A branch that would read as a flag, or that Git refuses, is a 400 before it is touched too.
//   4. A launcher that fails AFTER the create is a 200 with the worktree and `launcherStarted: false`:
//      the worktree exists, so nothing is rolled back.

const REPO = "/home/op/repo";
const SPACE = "w1";
const REQUEST_ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const CLAUDE: Launcher = { command: "claude", label: "Claude" };

const repoSpace: WorkspaceView = {
  workspaceId: SPACE,
  number: 1,
  label: "repo",
  focused: false,
  activeTabId: "w1:t1",
  tabCount: 1,
  paneCount: 1,
  repoRoot: REPO,
  isWorktree: false,
};

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

/** Only what the route reaches: create the worktree, read its grid, type, submit, refresh. */
class FakeWorktreeMux {
  readonly creates: MuxWorktreeCreateRequest[] = [];
  readonly texts: Array<[string, string]> = [];
  readonly keys: Array<[string, readonly string[]]> = [];
  readonly closes: string[] = [];
  failCreate: string | null = null;
  failText = false;
  /** Resolves the create when set; the create waits for it. */
  gate: Promise<void> | null = null;

  async createWorktree(request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.creates.push(request);
    if (this.gate) await this.gate;
    if (this.failCreate !== null) return muxRefused(this.failCreate);
    return muxOk({
      paneId: "w7:p1",
      spaceId: "w7",
      spaceLabel: "repo-brisk-otter",
      tabId: "w7:t1",
      cwd: `${REPO}/.worktrees/brisk-otter`,
    });
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    return Promise.resolve(this.failText ? muxRefused("pane is gone") : muxAck());
  }
  sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
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
  // createWorktree, then (with a launcher) readGrid, typeText and sendKeys, and refresh after it.
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
}

function post(body: CreateBody): Request {
  return new Request(`http://localhost/api/workspace/${SPACE}/worktree`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function run(
  mux: FakeWorktreeMux,
  body: CreateBody,
  opts: {
    receipts?: WorktreeReceiptSurface;
    engine?: StateEngine;
    audit?: AuditLog;
    rows?: Launcher[];
    bases?: WorktreeBaseSurface;
    ask?: GitAsk;
  } = {},
): Promise<{ status: number; answer: WorktreeCreateResponse }> {
  const res = await createWorktree(
    asMux(mux),
    opts.engine ?? engineWith([repoSpace]),
    SPACE,
    post(body),
    opts.audit ?? auditTrail().audit,
    null,
    "default",
    () => Promise.resolve(opts.rows ?? [CLAUDE]),
    opts.receipts ?? memoryWorktreeReceipts(),
    fakeClock(),
    { bases: opts.bases, ask: opts.ask },
  );
  // SAFETY: every JSON body this route writes is a WorktreeCreateResponse (`satisfies` at each site).
  return { status: res.status, answer: (await res.json()) as WorktreeCreateResponse };
}

describe("POST /api/workspace/:id/worktree — the old body still works", () => {
  test("a branch alone creates the worktree, with no launcher and no receipt", async () => {
    const mux = new FakeWorktreeMux();
    const receipts = memoryWorktreeReceipts();
    const { status, answer } = await run(mux, { branch: "feature/x" }, { receipts });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ ok: true, alreadyOpen: false, launcherStarted: false });
    expect(mux.creates).toEqual([{ repoRoot: REPO, branch: "feature/x" }]);
    expect(mux.texts).toEqual([]);
  });
});

describe("POST /api/workspace/:id/worktree — request id and receipt", () => {
  test("a repeat with a known requestId returns the receipt and asks the multiplexer once", async () => {
    const mux = new FakeWorktreeMux();
    const receipts = memoryWorktreeReceipts();
    const first = await run(mux, { branch: "worktree/brisk-otter-3fa9", requestId: REQUEST_ID, launcher: "claude" }, { receipts });
    expect(first.status).toBe(200);
    expect(first.answer).toMatchObject({ ok: true, launcherStarted: true });
    expect(first.answer.ok && first.answer.replayed).toBeFalsy();

    // The created space is in the snapshot by now, so the replay reads its label off it.
    const engine = engineWith([
      repoSpace,
      { ...repoSpace, workspaceId: "w7", label: "repo-brisk-otter", isWorktree: true },
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
        cwd: `${REPO}/.worktrees/brisk-otter`,
      },
    });
    expect(mux.creates).toHaveLength(1);
    expect(mux.texts).toHaveLength(1);
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
    // Let both requests reach their wait before the create answers.
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(mux.creates).toHaveLength(1);
    expect(a.answer).toMatchObject({ ok: true });
    expect(b.answer).toMatchObject({ ok: true, replayed: true });
    expect(b.answer.ok && b.answer.pane.paneId).toBe("w7:p1");
  });

  test("a refused create stores no receipt, so the same id may simply be tried again", async () => {
    const mux = new FakeWorktreeMux();
    mux.failCreate = "worktree_operation_in_progress: busy";
    const receipts = memoryWorktreeReceipts();
    const first = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID }, { receipts });
    expect(first.answer).toMatchObject({ ok: false, code: "worktree.busy" });
    expect(receipts.get(REQUEST_ID)).toBeUndefined();
    mux.failCreate = null;
    const second = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID }, { receipts });
    expect(second.answer).toMatchObject({ ok: true });
    expect(mux.creates).toHaveLength(2);
  });

  test("a requestId that is not a UUID is a 400 and nothing runs", async () => {
    const mux = new FakeWorktreeMux();
    const res = await createWorktree(
      asMux(mux),
      engineWith([repoSpace]),
      SPACE,
      post({ branch: "worktree/x", requestId: "../../etc/passwd" }),
      auditTrail().audit,
      null,
      "default",
      () => Promise.resolve([CLAUDE]),
      memoryWorktreeReceipts(),
      fakeClock(),
    );
    expect(res.status).toBe(400);
    expect(mux.creates).toEqual([]);
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

describe("POST /api/workspace/:id/worktree — the launcher allowlist", () => {
  test("a launcher that is no row is a 400 before the multiplexer is touched", async () => {
    const mux = new FakeWorktreeMux();
    const { audit, entries } = auditTrail();
    const { status, answer } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID, launcher: "rm -rf ~" }, { audit });
    expect(status).toBe(400);
    expect(answer).toMatchObject({ ok: false, code: "launch.not_allowlisted" });
    expect(mux.creates).toEqual([]);
    expect(entries).toEqual([]);
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
  });
});

describe("POST /api/workspace/:id/worktree — branch validation", () => {
  for (const branch of ["-rf", "a..b", "has space", "x:y", "trail/", "x.lock", "a//b"]) {
    test(`${JSON.stringify(branch)} is a 400 before the multiplexer is touched`, async () => {
      const mux = new FakeWorktreeMux();
      const { status, answer } = await run(mux, { branch, requestId: REQUEST_ID });
      expect(status).toBe(400);
      expect(answer).toMatchObject({ ok: false, code: "worktree.invalid_branch", error: "invalid branch" });
      expect(mux.creates).toEqual([]);
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
//   1. A body with no `base` is the old create: no `base` reaches the multiplexer, git is never
//      asked, and nothing is stored.
//   2. `default` and `ref` resolve on the bridge, and the resolved ref is what the multiplexer gets.
//   3. A bad base is a 400 before the multiplexer is touched.
//   4. The base is stored by folder after a success, and only then.

const WORKTREE_FOLDER = `${REPO}/.worktrees/brisk-otter`;

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
    const verifying = args[0] === "rev-parse" ? args[args.length - 1] : undefined;
    const known = branches.some((b) => verifying === `refs/heads/${b}^{commit}` || verifying === `${b}^{commit}`);
    return Promise.resolve(known ? "0123456789abcdef0123456789abcdef01234567" : null);
  };
  return { ask, asked };
}

describe("POST /api/workspace/:id/worktree — the starting point", () => {
  test("no base: the multiplexer gets no base, git is not asked, nothing is stored", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    const { ask, asked } = gitWith(["main"]);
    const { status } = await run(mux, { branch: "worktree/x", requestId: REQUEST_ID }, { bases, ask });
    expect(status).toBe(200);
    expect(mux.creates).toEqual([{ repoRoot: REPO, branch: "worktree/x" }]);
    expect(Object.keys(mux.creates[0] ?? {})).not.toContain("base");
    expect(asked).toEqual([]);
    expect(bases.get(WORKTREE_FOLDER)).toBeUndefined();
  });

  test("a null base is the same as none", async () => {
    const mux = new FakeWorktreeMux();
    await run(mux, { branch: "worktree/x", base: null }, { ask: gitWith(["main"]).ask });
    expect(mux.creates).toEqual([{ repoRoot: REPO, branch: "worktree/x" }]);
  });

  test("default is resolved on the bridge and passed on, then stored under the checkout folder", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    const { ask } = gitWith(["main"]);
    const before = Date.now();
    const { status } = await run(mux, { branch: "worktree/x", base: { kind: "default" } }, { bases, ask });
    expect(status).toBe(200);
    expect(mux.creates).toEqual([{ repoRoot: REPO, branch: "worktree/x", base: "main" }]);
    const stored = bases.get(WORKTREE_FOLDER);
    expect(stored?.base).toBe("main");
    expect(stored?.createdAt).toBeGreaterThanOrEqual(before);
  });

  test("a default that resolves to nothing sends no base and stores nothing, and the create still happens", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    const { status } = await run(mux, { branch: "worktree/x", base: { kind: "default" } }, { bases, ask: gitWith([]).ask });
    expect(status).toBe(200);
    expect(mux.creates).toEqual([{ repoRoot: REPO, branch: "worktree/x" }]);
    expect(bases.get(WORKTREE_FOLDER)).toBeUndefined();
  });

  test("a ref that names a commit is passed on as given", async () => {
    const mux = new FakeWorktreeMux();
    const bases = memoryWorktreeBases();
    const { status } = await run(mux, { branch: "worktree/x", base: { kind: "ref", ref: "feature/x" } }, { bases, ask: gitWith(["feature/x"]).ask });
    expect(status).toBe(200);
    expect(mux.creates).toEqual([{ repoRoot: REPO, branch: "worktree/x", base: "feature/x" }]);
    expect(bases.get(WORKTREE_FOLDER)?.base).toBe("feature/x");
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
      expect(mux.creates).toEqual([]);
      expect(bases.get(WORKTREE_FOLDER)).toBeUndefined();
    });
  }

  test("a refused create stores no base", async () => {
    const mux = new FakeWorktreeMux();
    mux.failCreate = "worktree_create_failed: path taken";
    const bases = memoryWorktreeBases();
    const { answer } = await run(mux, { branch: "worktree/x", base: { kind: "default" } }, { bases, ask: gitWith(["main"]).ask });
    expect(answer).toMatchObject({ ok: false, code: "worktree.create_failed" });
    expect(mux.creates).toEqual([{ repoRoot: REPO, branch: "worktree/x", base: "main" }]);
    expect(bases.get(WORKTREE_FOLDER)).toBeUndefined();
  });

  test("a replay of the same id asks neither git nor the multiplexer again", async () => {
    const mux = new FakeWorktreeMux();
    const receipts = memoryWorktreeReceipts();
    const body = { branch: "worktree/x", requestId: REQUEST_ID, base: { kind: "default" } } as const;
    await run(mux, body, { receipts, ask: gitWith(["main"]).ask });
    const { ask, asked } = gitWith(["main"]);
    const second = await run(mux, body, { receipts, ask });
    expect(second.answer).toMatchObject({ ok: true, replayed: true });
    expect(mux.creates).toHaveLength(1);
    expect(asked).toEqual([]);
  });
});

describe("GET /api/workspace/:id/worktrees — the default branch the sheet names", () => {
  function listing(refuse = false) {
    return asMux({
      listWorktrees: () =>
        Promise.resolve(
          refuse
            ? muxRefused("not_git_worktree: no repo")
            : muxOk([{ path: REPO, branch: "main", openSpaceId: SPACE, linked: false, prunable: false }]),
        ),
    });
  }
  const get = () => new Request(`http://localhost/api/workspace/${SPACE}/worktrees`);

  test("carries the branch a default base resolves to", async () => {
    const res = await listWorktrees(listing(), engineWith([repoSpace]), SPACE, get(), gitWith(["main"]).ask);
    expect(await res.json()).toMatchObject({ ok: true, defaultBranch: "main" });
  });

  test("is null when the repo has no branch to name", async () => {
    const res = await listWorktrees(listing(), engineWith([repoSpace]), SPACE, get(), gitWith([]).ask);
    expect(await res.json()).toMatchObject({ ok: true, defaultBranch: null });
  });

  test("a listing the multiplexer refused stays a refusal", async () => {
    const res = await listWorktrees(listing(true), engineWith([repoSpace]), SPACE, get(), gitWith(["main"]).ask);
    expect(await res.json()).toMatchObject({ ok: false, code: "worktree.not_a_repo" });
  });
});
