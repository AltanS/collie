import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { durableJournal } from "../journal/durable.ts";
import { DurableMux } from "../mux/durable/adapter.ts";
import { FakeDurableProgram, type FakeEvent } from "../mux/durable/fixture.ts";
import { isOwnerOnly } from "../owner-only.ts";
import type { Ask } from "../types.ts";
import { askFloodMessage, askFloodTag, AskPush, LOCAL_ASK_HOST } from "./ask-push.ts";
import { AskGuardStore, decideAsks, GUARD_FILE } from "./guard.ts";
import { cursorFileName, DurableLogs, durableLogDir, logFileName, moveFlatLogs, sourceLogDir } from "./log.ts";

// M55 spec 01, the disk half: one Collie runs several programs, so each program's pane logs live in
// their own folder, the journal reads a pane's log by the file its ref names, and the ask guard keys
// a tool call by (host, session, toolCallId). Two programs that use the same conversation id and the
// same tool call id never read, close or silence each other.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-m55-sources-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function program(): Promise<FakeDurableProgram> {
  const fake = await FakeDurableProgram.startWire();
  cleanups.push(() => fake.close());
  return fake;
}

/**
 * A folder the bridge made is private to this user. POSIX: mode 0700. NTFS reports 666 for every folder,
 * so Windows reads the owner-only access list the folder inherits, the way the bridge's own checks do.
 */
function expectPrivateFolder(path: string): void {
  if (HOST.platform === "win32") expect(isOwnerOnly(path, HOST)).toEqual({ state: "private" });
  else expect(statSync(path).mode & 0o777).toBe(0o700);
}

const PANE = "conv-01";
const item = (id: string, text: string): FakeEvent => ({ type: "item", item: { id, kind: "reply", text } });

async function until<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  for (let tries = 0; tries < 400; tries += 1) {
    const got = await read();
    if (got !== null) return got;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("two programs with the same conversation id", () => {
  test("each keeps its own log in its own folder, and the journal reads each pane's own", async () => {
    const state = await stateDir();
    const desk = await program();
    const cloud = await program();
    desk.appendEvent(PANE, item("r1", "from the desk"));
    cloud.appendEvent(PANE, item("r1", "from the cloud"));

    const adapters = {
      desk: new DurableMux(desk.wire(), undefined, new DurableLogs(sourceLogDir(state, "desk"))),
      cloud: new DurableMux(cloud.wire(), undefined, new DurableLogs(sourceLogDir(state, "cloud"))),
    };
    const journal = durableJournal([durableLogDir(state)]);
    const read = async (adapter: DurableMux): Promise<string | null> => {
      const snapshot = await adapter.snapshot();
      await adapter.syncEvents();
      const pane = snapshot.panes.find((p) => p.paneId === PANE);
      if (pane?.agentSession === undefined) return null;
      const path = await journal.source.resolve(pane.agentSession);
      if (path === null) return null;
      const text = readFileSync(path, "utf8");
      return text.includes("from the") ? path : null;
    };

    const deskPath = await until(() => read(adapters.desk), "the desk's log");
    const cloudPath = await until(() => read(adapters.cloud), "the cloud's log");
    expect(deskPath).not.toBe(cloudPath);
    expect(deskPath.endsWith(join("desk", logFileName(PANE)))).toBe(true);
    expect(cloudPath.endsWith(join("cloud", logFileName(PANE)))).toBe(true);
    expect(readFileSync(deskPath, "utf8")).toContain("from the desk");
    expect(readFileSync(deskPath, "utf8")).not.toContain("from the cloud");
    expect(readFileSync(cloudPath, "utf8")).toContain("from the cloud");
    // Each program's folder is private, as the one folder was.
    expectPrivateFolder(sourceLogDir(state, "desk"));
  });

  test("the card reads the adapter's phase and the program's name", async () => {
    const desk = await program();
    desk.hello.host.name = "Support desk";
    const adapter = new DurableMux(desk.wire());
    expect(adapter.phase()).toBe("starting");
    expect(adapter.hostName()).toBe("");
    await adapter.snapshot();
    expect(adapter.phase()).toBe("ready");
    expect(adapter.hostName()).toBe("Support desk");
    desk.ready = false;
    await adapter.refresh();
    expect(adapter.phase()).toBe("starting");
  });
});

describe("the one-time move to one folder per program", () => {
  test("logs and cursors directly under durable/ move into durable/default/, once, with one line", async () => {
    const state = await stateDir();
    const root = durableLogDir(state);
    await mkdir(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, logFileName("conv-01")), "{}\n", { mode: 0o600 });
    writeFileSync(join(root, cursorFileName("conv-01")), "{}", { mode: 0o600 });
    const lines: string[] = [];
    expect(await moveFlatLogs(state, "default", (line) => lines.push(line))).toBe(2);
    expect(readdirSync(root)).toEqual(["default"]);
    expect(readdirSync(join(root, "default")).toSorted()).toEqual([cursorFileName("conv-01"), logFileName("conv-01")].toSorted());
    expectPrivateFolder(join(root, "default"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("moved 2 pane log file(s)");
    // A second boot finds nothing to move and says nothing.
    expect(await moveFlatLogs(state, "default", (line) => lines.push(line))).toBe(0);
    expect(lines).toHaveLength(1);
  });

  test("nothing moves when the folder is already there, or when there is no flat log", async () => {
    const state = await stateDir();
    expect(await moveFlatLogs(state, "default", () => undefined)).toBe(0);
    const root = durableLogDir(state);
    await mkdir(join(root, "default"), { recursive: true });
    writeFileSync(join(root, logFileName("conv-02")), "{}\n");
    expect(await moveFlatLogs(state, "default", () => undefined)).toBe(0);
    expect(existsSync(join(root, logFileName("conv-02")))).toBe(true);
  });
});

describe("the ask guard keys by (host, session, toolCallId)", () => {
  const START = Date.UTC(2026, 9, 13, 9, 0);
  const asks = [{ id: "ask-1", toolCallId: "call-1" }];

  test("the same tool call in two sessions is two questions, and each is pushed once", () => {
    const store = new AskGuardStore(null);
    const desk = store.observe(LOCAL_ASK_HOST, [{ paneId: PANE, asks }], START, "desk");
    const cloud = store.observe(LOCAL_ASK_HOST, [{ paneId: PANE, asks }], START + 1, "cloud");
    expect(desk.verdicts.get(PANE)?.[0]?.decision).toBe("push");
    expect(cloud.verdicts.get(PANE)?.[0]?.decision).toBe("push");
    // Seen again in either session: known, shown, never pushed twice.
    expect(store.observe(LOCAL_ASK_HOST, [{ paneId: PANE, asks }], START + 2, "desk").verdicts.get(PANE)?.[0]?.why).toBe("known");
  });

  test("one session's observation never closes another's keys", () => {
    const store = new AskGuardStore(null);
    store.observe(LOCAL_ASK_HOST, [{ paneId: PANE, asks }], START, "desk");
    store.observe(LOCAL_ASK_HOST, [], START + 1, "cloud");
    const deskEntry = store.remembered().find((entry) => entry.session === "desk");
    expect(deskEntry?.closedAt).toBeUndefined();
    store.observe(LOCAL_ASK_HOST, [], START + 2, "desk");
    expect(store.remembered().find((entry) => entry.session === "desk")?.closedAt).toBe(START + 2);
  });

  test("an entry written before M55 reads as the default session, so a durable-only re-ask is not pushed again", async () => {
    const state = await stateDir();
    writeFileSync(
      join(state, GUARD_FILE),
      JSON.stringify({ entries: [{ host: "", toolCallId: "call-1", paneId: PANE, askId: "ask-0", firstSeenAt: START, pushedAt: START }], breakers: [{ host: "", trippedAt: START }] }),
      { mode: 0o600 },
    );
    const store = new AskGuardStore(state);
    store.load();
    expect(store.remembered()[0]?.session).toBe("default");
    expect(store.trippedAt(LOCAL_ASK_HOST, "default")).toBe(START);
    expect(store.trippedAt(LOCAL_ASK_HOST, "desk")).toBeUndefined();
    expect(store.observe(LOCAL_ASK_HOST, [{ paneId: PANE, asks }], START + 5, "default").verdicts.get(PANE)?.[0]?.why).toBe("known");
    const saved: { entries: { session?: string }[]; breakers: { session?: string }[] } = JSON.parse(readFileSync(join(state, GUARD_FILE), "utf8"));
    expect(saved.entries[0]?.session).toBe("default");
    expect(saved.breakers[0]?.session).toBe("default");
  });

  test("the pure decision takes the session too, defaulting to `default`", () => {
    const result = decideAsks([], "laptop", [{ paneId: PANE, asks }], START);
    expect(result.entries[0]).toMatchObject({ host: "laptop", session: "default", toolCallId: "call-1" });
    expect(decideAsks([], "laptop", [{ paneId: PANE, asks }], START, undefined, undefined, "desk").entries[0]?.session).toBe("desk");
  });
});

describe("the ask push tag is per host and session", () => {
  test("the default session keeps its old slot; another session gets its own", () => {
    expect(askFloodTag(LOCAL_ASK_HOST)).toBe("collie:asks");
    expect(askFloodTag("laptop")).toBe("collie:asks:laptop");
    expect(askFloodTag(LOCAL_ASK_HOST, "desk")).toBe("collie:asks/desk");
    expect(askFloodTag("laptop", "desk")).toBe("collie:asks:laptop/desk");
    const msg = askFloodMessage(LOCAL_ASK_HOST, "bluefin (desk)", "desk");
    expect(msg).toMatchObject({ tag: "collie:asks/desk", session: "desk" });
    expect("session" in askFloodMessage(LOCAL_ASK_HOST, "bluefin")).toBe(false);
  });

  test("AskPush raises per session: the same tool call in two programs raises both panes", () => {
    const push = new AskPush(new AskGuardStore(null), () => Date.UTC(2026, 9, 13, 9, 0));
    const wireAsk: Ask = { id: "ask-1", kind: "permission", toolCallId: "call-1", revision: 1, title: "t", itemId: "i", options: [{ id: "allow", label: "Allow", effect: "allow" }] };
    const raised: string[] = [];
    push.observe(LOCAL_ASK_HOST, [{ paneId: PANE, asks: [wireAsk] }], () => raised.push("desk"), undefined, "desk");
    push.observe(LOCAL_ASK_HOST, [{ paneId: PANE, asks: [wireAsk] }], () => raised.push("cloud"), undefined, "cloud");
    expect(raised).toEqual(["desk", "cloud"]);
  });
});
