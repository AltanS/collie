import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "./json.ts";
import type { WorktreeCreateResponse } from "./types.ts";
import {
  MAX_RECEIPTS,
  RECEIPTS_FILE,
  WorktreeReceiptStore,
  coerceReceipts,
  isRequestId,
  memoryWorktreeReceipts,
  type WorktreeReceipt,
} from "./worktree-receipts.ts";

// The receipt store behind a worktree create's replay (ADR 0089): one receipt per request id, 0600,
// capped at MAX_RECEIPTS with the oldest dropped, and a create in flight joined rather than repeated.

let stateDir = "";
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "collie-worktree-receipts-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A distinct, well-formed request id for index `n`. */
function idOf(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function receiptOf(n: number): WorktreeReceipt {
  return {
    requestId: idOf(n),
    at: 1_000 + n,
    workspaceId: `w${n}`,
    paneId: `w${n}:p1`,
    path: `/home/op/repo/.worktrees/x${n}`,
    branch: `worktree/x${n}`,
    launcherStarted: n % 2 === 0,
  };
}

const silent = () => {};

describe("isRequestId", () => {
  test("accepts a canonical UUID in either case", () => {
    expect(isRequestId("0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c")).toBe(true);
    expect(isRequestId("0B9E6A1C-3F2D-4C5E-8A7B-1D2E3F4A5B6C")).toBe(true);
  });

  test("refuses anything else", () => {
    for (const bad of ["", "nope", "0b9e6a1c3f2d4c5e8a7b1d2e3f4a5b6c", "../../etc", " 0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c"]) {
      expect(isRequestId(bad)).toBe(false);
    }
    expect(isRequestId(42)).toBe(false);
    expect(isRequestId(null)).toBe(false);
    expect(isRequestId(undefined)).toBe(false);
  });
});

describe("WorktreeReceiptStore — the file", () => {
  test("loading an empty state dir writes nothing", async () => {
    const store = new WorktreeReceiptStore(stateDir, silent);
    await store.load();
    expect(await readdir(stateDir)).toEqual([]);
    expect(store.get(idOf(1))).toBeUndefined();
  });

  test("a recorded receipt is read back, from memory and from the file after a reload", async () => {
    const store = new WorktreeReceiptStore(stateDir, silent);
    await store.load();
    await store.record(receiptOf(1));
    expect(store.get(idOf(1))).toEqual(receiptOf(1));

    const again = new WorktreeReceiptStore(stateDir, silent);
    await again.load();
    expect(again.get(idOf(1))).toEqual(receiptOf(1));
  });

  test("the file is owner-only (0600)", async () => {
    if (process.platform === "win32") return;
    const store = new WorktreeReceiptStore(stateDir, silent);
    await store.record(receiptOf(1));
    const mode = (await stat(join(stateDir, RECEIPTS_FILE))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test(`keeps at most ${MAX_RECEIPTS}, dropping the oldest first`, async () => {
    const store = new WorktreeReceiptStore(stateDir, silent);
    for (let n = 1; n <= MAX_RECEIPTS + 5; n++) await store.record(receiptOf(n));
    for (let n = 1; n <= 5; n++) expect(store.get(idOf(n))).toBeUndefined();
    expect(store.get(idOf(6))).toEqual(receiptOf(6));
    expect(store.get(idOf(MAX_RECEIPTS + 5))).toEqual(receiptOf(MAX_RECEIPTS + 5));

    const again = new WorktreeReceiptStore(stateDir, silent);
    await again.load();
    expect(again.get(idOf(5))).toBeUndefined();
    expect(again.get(idOf(6))).toEqual(receiptOf(6));
  });

  test("a broken file loads as no receipts and is not rewritten by loading", async () => {
    const file = join(stateDir, RECEIPTS_FILE);
    await writeFile(file, "{not json");
    const store = new WorktreeReceiptStore(stateDir, silent);
    await store.load();
    expect(store.get(idOf(1))).toBeUndefined();
    expect(await Bun.file(file).text()).toBe("{not json");
  });

  test("a failed write keeps the receipt in memory and warns, it never throws", async () => {
    const warnings: string[] = [];
    // A state dir that is a FILE: mkdir and the temp write both fail.
    const blocked = join(stateDir, "blocked");
    await writeFile(blocked, "");
    const store = new WorktreeReceiptStore(blocked, (line) => warnings.push(line));
    await store.record(receiptOf(1));
    expect(store.get(idOf(1))).toEqual(receiptOf(1));
    expect(warnings).toHaveLength(1);
  });
});

describe("coerceReceipts", () => {
  test("drops entries that are not receipts and keeps the rest in order", () => {
    const good = receiptOf(3);
    const raw: JsonObject = {
      receipts: [
        { ...receiptOf(1), requestId: "not-a-uuid" },
        { ...receiptOf(2), launcherStarted: "yes" },
        { ...good },
        7,
        null,
      ],
    };
    expect(coerceReceipts(raw)).toEqual([good]);
  });

  test("anything but a receipts list is empty", () => {
    expect(coerceReceipts(null)).toEqual([]);
    expect(coerceReceipts([])).toEqual([]);
    expect(coerceReceipts({ receipts: "x" })).toEqual([]);
  });
});

describe("the in-flight half", () => {
  const answer: WorktreeCreateResponse = {
    ok: true,
    alreadyOpen: false,
    launcherStarted: false,
    pane: { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "x", tabId: "w1:t1", cwd: "/x" },
  };

  for (const [name, make] of [
    ["file store", () => new WorktreeReceiptStore(stateDir, silent)],
    ["memory store", () => memoryWorktreeReceipts()],
  ] as const) {
    test(`${name}: a tracked create is joinable until it settles, then forgotten`, async () => {
      const store = make();
      let finish: (value: WorktreeCreateResponse) => void = () => {};
      const running = new Promise<WorktreeCreateResponse>((resolve) => {
        finish = resolve;
      });
      store.track(idOf(1), running);
      expect(store.inflight(idOf(1))).toBe(running);
      expect(store.inflight(idOf(2))).toBeUndefined();
      finish(answer);
      await running;
      await Promise.resolve();
      expect(store.inflight(idOf(1))).toBeUndefined();
    });
  }

  test("memory store: record and get", async () => {
    const store = memoryWorktreeReceipts();
    await store.record(receiptOf(1));
    expect(store.get(idOf(1))).toEqual(receiptOf(1));
  });
});
