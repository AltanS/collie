import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import { withAgentHints } from "./beacon/hint.ts";
import { crewRouteFor, forwardKind } from "./crew/forward.ts";
import type { JsonObject } from "./json.ts";
import { readMerged, type LauncherSources } from "./launcher-adds.ts";
import { memoryAddedLaunchers } from "./launchers-added.ts";
import type { MuxAdapter } from "./mux/types.ts";
import { DURABLE_MUX, DurableMux, MIN_SNAPSHOT_GAP_MS } from "./mux/durable/adapter.ts";
import { FakeDurableClock, FakeDurableProgram, hasHostileChars, hostileText } from "./mux/durable/fixture.ts";
import { DEFAULT_SWITCHES } from "./operator-launchers.ts";
import { launch, launchersRoute, type LaunchDeps } from "./server.ts";
import {
  STARTER_RECEIPTS_FILE,
  starterDigest,
  StarterReceiptStore,
  coerceStarterReceipt,
  memoryStarterReceipts,
  starterItems,
  type StarterReceiptSurface,
} from "./starter-launch.ts";
import type { StateEngine } from "./state-engine.ts";
import type { CreateResponse, Launcher, LauncherItem, LaunchersResponse } from "./types.ts";

// Starters as launcher rows (ADR 0102). The claims:
//
//   1. durable: a program's starters ride `GET /api/launchers` as items, one per starter, with a row
//      key made of the machine and the starter id. A program that is down lists none, and the rest of
//      the list is untouched.
//   2. `POST /api/launch` with `{ starter, requestId }` writes the receipt first, then runs the starter
//      with the same request id, and answers the program's pane.
//   3. request id: a repeat of an id with a finished receipt answers the stored pane and calls nothing
//      (not even the program's own list). An id whose first run is unfinished runs again with the SAME
//      id, so the program's replay, not a second start, is what answers.
//   4. A starter takes no text: a body with anything but the starter, the id and a folder is refused.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const ID2 = "6a1d3b5c-7e9f-4a2b-8c4d-0e1f2a3b4c5d";
const STARTER = "notes-new";
const HTOP: Launcher = { command: "htop", label: "htop" };

const programs: FakeDurableProgram[] = [];

interface Rig {
  program: FakeDurableProgram;
  adapter: DurableMux;
  receipts: StarterReceiptSurface;
  clock: FakeDurableClock;
}

async function rig(receipts: StarterReceiptSurface = memoryStarterReceipts()): Promise<Rig> {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  return { program, adapter: new DurableMux(program.wire(), clock), receipts, clock };
}

afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

function engine(): StateEngine {
  // SAFETY: the starter path never reaches the engine; only the launch route's own kinds do.
  return {} as StateEngine;
}

const post = (body: JsonObject) =>
  new Request("http://x/api/launch", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function run(rigged: Rig, body: JsonObject, deps: LaunchDeps = {}) {
  // Past the adapter's 250 ms floor, so this request's first look at the program is a real read.
  rigged.clock.advance(MIN_SNAPSHOT_GAP_MS);
  const res = await launch(rigged.adapter, engine(), post(body), new AuditLog(() => {}), "phone", "default", () => Promise.resolve([HTOP]), {}, {
    starterReceipts: rigged.receipts,
    ...deps,
  });
  // SAFETY: the starter path answers a CreateResponse as JSON, or a plain-text 400 that parses to `null` here.
  const parsed = (await res.json().catch(() => null)) as CreateResponse | null;
  return { status: res.status, body: parsed };
}

async function read(rigged: Rig): Promise<LaunchersResponse> {
  rigged.clock.advance(MIN_SNAPSHOT_GAP_MS);
  const sources: LauncherSources = {
    operator: () => Promise.resolve([HTOP]),
    added: memoryAddedLaunchers(),
    switches: () => Promise.resolve({ ...DEFAULT_SWITCHES }),
  };
  const res = await launchersRoute(
    async () => (await readMerged(sources)).rows,
    null,
    undefined,
    { merged: () => readMerged(sources), file: "/x/launchers.toml" },
    rigged.adapter.listStarters?.bind(rigged.adapter),
  );
  // SAFETY: the route answers a LaunchersResponse as JSON.
  return (await res.json()) as LaunchersResponse;
}

/** The pane of a successful launch answer; fails the test for any other. */
function paneOf(body: CreateResponse | null) {
  if (body === null || !body.ok) throw new Error("the launch did not succeed");
  return body.pane;
}

const posts = (program: FakeDurableProgram) => program.requests.filter((request) => request.method === "POST");

describe("durable: starters on GET /api/launchers", () => {
  test("a reachable program's starter is one item, marked as taking no text, ahead of the other rows", async () => {
    const rigged = await rig();
    const body = await read(rigged);
    const row: LauncherItem = {
      key: `starter:denis-laptop:${STARTER}`,
      start: { starter: STARTER },
      group: "agents",
      label: "New note chat",
      source: "program",
      noPrompts: false,
      takesPrompt: false,
      branch: false,
      available: true,
    };
    expect(body.items?.[0]).toEqual(row);
    // Beside the config launchers, which are untouched.
    expect(body.items?.some((item) => item.key === "row:htop")).toBe(true);
    expect(body.launchers).toHaveLength(1);
  });

  test("an unreachable program lists no starters, and the list is still answered", async () => {
    const rigged = await rig();
    await rigged.program.close();
    const body = await read(rigged);
    expect(body.items?.filter((item) => "starter" in item.start)).toEqual([]);
    expect(body.items?.some((item) => item.key === "row:htop")).toBe(true);
  });

  test("a program without the starters cap lists none; a bridge on another multiplexer has no such method", async () => {
    const rigged = await rig();
    rigged.program.hello.caps.starters = false;
    expect((await read(rigged)).items?.filter((item) => "starter" in item.start)).toEqual([]);
    const res = await launchersRoute(() => Promise.resolve([]), null);
    expect(await res.json()).not.toHaveProperty("items");
  });

  test("a label with hostile characters reaches the row cleaned", async () => {
    const rigged = await rig();
    rigged.program.snapshot.starters = [{ id: STARTER, label: hostileText("Review", 400) }];
    const item = (await read(rigged)).items?.[0];
    expect(item?.label.startsWith("Review")).toBe(true);
    expect(hasHostileChars(item?.label ?? "")).toBe(false);
    expect(Buffer.byteLength(item?.label ?? "")).toBeLessThanOrEqual(128);
  });

  test("two machines with one starter id get two row keys, so a phone merging both lists never confuses them", () => {
    const lead = starterItems({ hostName: "bluefin", starters: [{ id: STARTER, label: "Notes" }], reachable: true });
    const peer = starterItems({ hostName: "minibuch", starters: [{ id: STARTER, label: "Notes" }], reachable: true });
    expect(lead[0]?.key).toBe(`starter:bluefin:${STARTER}`);
    expect(peer[0]?.key).toBe(`starter:minibuch:${STARTER}`);
    expect(lead[0]?.key).not.toBe(peer[0]?.key);
    // A program that gave its machine no name still gets a stable key.
    expect(starterItems({ hostName: "", starters: [{ id: STARTER, label: "" }], reachable: true })[0]).toMatchObject({ key: `starter:program:${STARTER}`, label: STARTER });
  });

  test("the lead reaches a member's rows through the existing `?host=` read forward", () => {
    expect(crewRouteFor("/api/launchers")).toBe("launchers");
    expect(forwardKind("launchers")).toBe("read");
    expect(crewRouteFor("/api/launch")).not.toBeNull();
  });

  test("a decorator around the adapter keeps the starter methods", async () => {
    const rigged = await rig();
    const wrapped = withAgentHints(rigged.adapter, { hooksInstalled: () => false });
    expect(wrapped.mux).toBe(DURABLE_MUX);
    expect((await wrapped.listStarters?.())?.starters).toEqual([{ id: STARTER, label: "New note chat" }]);
  });
});

describe("durable: POST /api/launch with a starter", () => {
  test("the receipt is written before the program is called, then completed with its pane", async () => {
    const rigged = await rig();
    const seen: Array<{ pane: unknown } | undefined> = [];
    rigged.program.override = (path) => {
      if (path.includes("/starter/")) {
        const receipt = rigged.receipts.get(ID);
        seen.push(receipt === undefined ? undefined : { pane: receipt.pane });
      }
      return undefined;
    };
    const { status, body } = await run(rigged, { starter: STARTER, requestId: ID });
    expect(status).toBe(200);
    expect(seen).toEqual([{ pane: null }]);
    const started = rigged.program.starts[0];
    expect(started).toMatchObject({ starterId: STARTER, requestId: ID });
    expect(body).toEqual({
      ok: true,
      pane: { paneId: started?.paneId ?? "", workspaceId: "ws-notes", workspaceLabel: "notes", tabId: "ws-notes:main", cwd: "/home/denis/notes" },
    });
    expect(rigged.receipts.get(ID)?.pane?.paneId).toBe(started?.paneId);
  });

  test("a repeat of the request id answers the stored pane and calls nothing, not even the program's list", async () => {
    const rigged = await rig();
    const first = await run(rigged, { starter: STARTER, requestId: ID });
    const before = rigged.program.requests.length;
    const again = await run(rigged, { starter: STARTER, requestId: ID });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect(paneOf(first.body)).toEqual(paneOf(again.body));
    expect(rigged.program.requests.length).toBe(before);
    expect(rigged.program.starts).toHaveLength(1);
  });

  test("a repeat of the request id while the first is running joins it: one start", async () => {
    const rigged = await rig();
    const [a, b] = await Promise.all([
      run(rigged, { starter: STARTER, requestId: ID }),
      run(rigged, { starter: STARTER, requestId: ID }),
    ]);
    expect(rigged.program.starts).toHaveLength(1);
    expect([a.body?.ok, b.body?.ok]).toEqual([true, true]);
    const replayed = [a.body, b.body].filter((body) => body?.ok === true && body.replayed === true);
    expect(replayed).toHaveLength(1);
  });

  test("a new request id is a new start", async () => {
    const rigged = await rig();
    await run(rigged, { starter: STARTER, requestId: ID });
    await run(rigged, { starter: STARTER, requestId: ID2 });
    expect(rigged.program.starts.map((start) => start.requestId)).toEqual([ID, ID2]);
  });

  test("starter-failed shows the program's message, and the same request id may run again", async () => {
    const rigged = await rig();
    rigged.program.starterFailure = "the model key is missing";
    const failed = await run(rigged, { starter: STARTER, requestId: ID });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ ok: false, code: "workspace.create_failed", detail: { reason: "the model key is missing" } });
    expect(rigged.receipts.get(ID)?.pane).toBeNull();
    rigged.program.starterFailure = null;
    const retried = await run(rigged, { starter: STARTER, requestId: ID });
    expect(retried.body?.ok).toBe(true);
    expect(rigged.program.starts).toHaveLength(1);
  });

  test("not-supported from the program is a refusal with its reason, and nothing is stored as a pane", async () => {
    const rigged = await rig();
    rigged.program.override = (path) => (path.includes("/starter/") ? Response.json({ code: "not-supported" }, { status: 409 }) : undefined);
    const { status, body } = await run(rigged, { starter: STARTER, requestId: ID });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, code: "workspace.create_failed" });
    expect(rigged.receipts.get(ID)?.pane).toBeNull();
  });

  test("an unknown outcome keeps the receipt unfinished, and Try again sends the same request id", async () => {
    const rigged = await rig();
    rigged.program.override = (path) => (path.includes("/starter/") ? Response.json({ code: "internal" }, { status: 500 }) : undefined);
    const unknown = await run(rigged, { starter: STARTER, requestId: ID });
    expect(unknown.status).toBe(502);
    expect(unknown.body).toMatchObject({ ok: false, code: "workspace.create_failed" });
    expect(rigged.receipts.get(ID)).toMatchObject({ requestId: ID, starterId: STARTER, pane: null });

    // The program comes back. The retry is NOT answered from the unfinished receipt: it reaches the
    // program with the same id, which is what lets the program replay a start it did run.
    rigged.program.override = null;
    const retried = await run(rigged, { starter: STARTER, requestId: ID });
    expect(retried.body?.ok).toBe(true);
    expect(rigged.program.starts).toEqual([{ starterId: STARTER, requestId: ID, paneId: rigged.receipts.get(ID)?.pane?.paneId ?? "" }]);
    expect(posts(rigged.program)).toHaveLength(2);
  });

  test("a program that is down is a 503: nothing reached it", async () => {
    const rigged = await rig();
    await rigged.program.close();
    const { status, body } = await run(rigged, { starter: STARTER, requestId: ID });
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, code: "workspace.create_failed" });
  });

  test("an id the program does not list is refused here, before anything reaches it", async () => {
    const rigged = await rig();
    const { status, body } = await run(rigged, { starter: "rm -rf", requestId: ID });
    expect(status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "launch.not_allowlisted" });
    expect(posts(rigged.program)).toEqual([]);
    expect(rigged.receipts.get(ID)).toBeUndefined();
  });

  test("a bridge on another multiplexer refuses a starter body", async () => {
    const rigged = await rig();
    // SAFETY: a stub with no starter methods, as every non-durable adapter is; the starter path reads nothing else.
    const other = { mux: "herdr" } as MuxAdapter;
    const res = await launch(other, engine(), post({ starter: STARTER, requestId: ID }), new AuditLog(() => {}), "phone", "default", () => Promise.resolve([]));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "launch.not_allowlisted" });
    expect(rigged.program.requests).toEqual([]);
  });

  test("the request id is required, and must be a UUID", async () => {
    const rigged = await rig();
    expect((await run(rigged, { starter: STARTER })).status).toBe(400);
    expect((await run(rigged, { starter: STARTER, requestId: "not-a-uuid" })).status).toBe(400);
    expect(rigged.program.requests).toEqual([]);
  });
});

describe("durable: a starter takes no text", () => {
  const stray: Array<[string, JsonObject]> = [
    ["a prompt", { prompt: "do the thing" }],
    ["text", { text: "hello" }],
    ["a command", { command: "htop" }],
    ["a one-off run", { run: "ls" }],
    ["a harness", { harness: "claude" }],
    ["a shell", { shell: true }],
    ["an empty prompt", { prompt: "" }],
  ];
  for (const [name, extra] of stray) {
    test(`${name} beside a starter is refused in the house error shape, and nothing reaches the program`, async () => {
      const rigged = await rig();
      const { status, body } = await run(rigged, { starter: STARTER, requestId: ID, ...extra });
      expect(status).toBe(400);
      expect(body).toMatchObject({ ok: false, code: "launch.bad_line", detail: { problem: "a starter takes no text" } });
      expect(rigged.program.requests).toEqual([]);
      expect(rigged.receipts.get(ID)).toBeUndefined();
    });
  }

  test("a folder is the one other key a starter body may carry, and it is ignored", async () => {
    const rigged = await rig();
    const { body } = await run(rigged, { starter: STARTER, requestId: ID, cwd: "/tmp" });
    expect(body?.ok).toBe(true);
  });
});

describe("durable: the starter receipt file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "collie-starter-receipts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loading writes nothing; a start writes one owner-only file, and a restart replays from it", async () => {
    const store = new StarterReceiptStore(dir, () => {});
    await store.load();
    expect(await readdir(dir)).toEqual([]);
    const rigged = await rig(store);
    const first = await run(rigged, { starter: STARTER, requestId: ID });
    expect(await readdir(dir)).toEqual([STARTER_RECEIPTS_FILE]);
    const mode = (await Bun.file(join(dir, STARTER_RECEIPTS_FILE)).stat()).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);

    // A new bridge process reads the file and answers the same id without calling the program.
    const reborn = new StarterReceiptStore(dir, () => {});
    await reborn.load();
    const before = rigged.program.requests.length;
    const again = await run({ ...rigged, receipts: reborn }, { starter: STARTER, requestId: ID });
    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect(paneOf(first.body)).toEqual(paneOf(again.body));
    expect(rigged.program.requests.length).toBe(before);
  });

  test("an unfinished receipt survives a restart as unfinished, so it still runs again with the same id", async () => {
    const store = new StarterReceiptStore(dir, () => {});
    const at = Date.now();
    await store.record({ requestId: ID, at, starterId: STARTER, digest: starterDigest(STARTER), pane: null });
    const reborn = new StarterReceiptStore(dir, () => {});
    await reborn.load();
    expect(reborn.get(ID)).toEqual({ requestId: ID, at, starterId: STARTER, digest: starterDigest(STARTER), pane: null });
    const rigged = await rig(reborn);
    expect((await run(rigged, { starter: STARTER, requestId: ID })).body?.ok).toBe(true);
    expect(rigged.program.starts).toHaveLength(1);
  });

  test("the same request id for another starter is refused with 409 and starts nothing", async () => {
    const store = new StarterReceiptStore(dir, () => {});
    const rigged = await rig(store);
    rigged.program.snapshot.starters.push({ id: "review", label: "Review" });
    rigged.program.touch();
    expect((await run(rigged, { starter: STARTER, requestId: ID })).body?.ok).toBe(true);
    const reused = await run(rigged, { starter: "review", requestId: ID });
    expect(reused.status).toBe(409);
    expect(JSON.stringify(reused.body)).toContain("request-id-reused");
    expect(rigged.program.starts).toHaveLength(1);
  });

  test("receipts older than a week go, an unfinished one younger than a day stays past the count cap", async () => {
    let now = 10 * 24 * 60 * 60 * 1000;
    const store = new StarterReceiptStore(dir, () => {}, () => now);
    const digest = starterDigest(STARTER);
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await store.record({ requestId: id(0), at: now - 8 * 24 * 60 * 60 * 1000, starterId: STARTER, digest, pane: { paneId: "p", workspaceId: "w", workspaceLabel: "w", tabId: "t", cwd: "" } });
    expect(store.get(id(0))).toBeUndefined();
    // The oldest receipt is unfinished and an hour old: the thousand newer ones do not push it out.
    await store.record({ requestId: id(1), at: now - 60 * 60 * 1000, starterId: STARTER, digest, pane: null });
    for (let n = 2; n <= 1001; n += 1) {
      now += 1;
      await store.record({ requestId: id(n), at: now, starterId: STARTER, digest, pane: { paneId: "p", workspaceId: "w", workspaceLabel: "w", tabId: "t", cwd: "" } });
    }
    expect(store.get(id(1))).toBeDefined();
    expect(store.get(id(2))).toBeUndefined();
    expect(store.get(id(1001))).toBeDefined();
    const reborn = new StarterReceiptStore(dir, () => {}, () => now);
    await reborn.load();
    expect(reborn.get(id(1))).toBeDefined();
    expect(reborn.get(id(3))).toBeDefined();
  });

  test("an entry that is not a receipt is dropped", () => {
    expect(coerceStarterReceipt({ requestId: "x", at: 1 })).toBeNull();
    expect(coerceStarterReceipt({ requestId: ID, at: 1, starterId: STARTER, pane: null })).toBeNull();
    expect(coerceStarterReceipt({ requestId: ID, at: 1, starterId: STARTER, pane: { paneId: 1 } })).toBeNull();
    expect(coerceStarterReceipt([])).toBeNull();
  });
});
