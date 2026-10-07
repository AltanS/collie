import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "./audit.ts";
import { createWorktree } from "./server.ts";
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
  opts: { receipts?: WorktreeReceiptSurface; engine?: StateEngine; audit?: AuditLog; rows?: Launcher[] } = {},
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
