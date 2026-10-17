import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import { apiPathFor, crewRouteFor, forwardAuditAction, forwardKind, textAnswerOf } from "./crew/forward.ts";
import { maskForwardedAnswer } from "./crew/mask.ts";
import { harnessLaunch } from "./harness-launch.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import { memoryLaunchReceipts } from "./launch-receipts.ts";
import { HerdrMux } from "./mux/herdr/adapter.ts";
import type { HerdrClient } from "./mux/herdr/client.ts";
import { muxAck, muxOk, type MuxAck, type MuxAdapter, type MuxCreatedPane, type MuxGrid, type MuxOutcome, type MuxSpaceRequest } from "./mux/types.ts";
import { DEFAULT_SWITCHES } from "./operator-launchers.ts";
import { looksSecret as recentLooksSecret } from "./recent-runs.ts";
import { redactText } from "./redact.ts";
import { looksSecret, SENT_MAX_LINE, sentLineOf } from "./secret-line.ts";
import {
  SENT_CAP,
  SENT_COMPACT_AT,
  SENT_FILE,
  SENT_MAX_AGE_MS,
  SentStore,
  askSentMember,
  formatSentRecord,
  memorySentIo,
  mergeSentAnswers,
  parseSentQuery,
  parseSentText,
  readSentReply,
  sentAnswerHere,
  sentEntries,
  sentFileIo,
  sentId,
  sentRecorder,
  type SentMember,
  type SentQuery,
  type SentRecord,
} from "./sent.ts";
import { keysPane, launch, replySendOf, replyThroughProtocol, sendRoute, serveSentRoute, type SendRouteRuntime, type SentRouteDeps } from "./server.ts";
import type { SessionRuntime } from "./sessions.ts";
import type { StateEngine } from "./state-engine.ts";
import { profileFor } from "../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../web/src/lib/surface/send.ts";
import type { ProgramDriver } from "./surface/durable-driver.ts";
import { KeyGate } from "./surface/key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./surface/protocol.ts";
import { RequestStore } from "./surface/requests.ts";
import type { Config } from "./config.ts";
import type { SentAnswer } from "./types.ts";

// Sent (ADR 0107, M61 spec 01). The claims:
//
//   1. The skip rules: a leading blank, an empty line, a line that looks secret, a line the outbound
//      mask would change, a line past 4096 characters, and the switch off keep nothing.
//   2. The store: one JSON line per record, 0600, a rewrite to the newest 5000 past 5500, no record
//      older than 365 days, a bad line skipped and another version absent.
//   3. The read: folder first, repeats merged per line, the words, `before` on the entry, newest first.
//   4. Record points: a shell pane's blind send and a one-off run, and nothing else.
//   5. The lead's merge: members asked in parallel with a budget, 404 is an older Collie.
//   6. The routes: gated, forwarded on `?host=`, audited without text.

/** An obviously fake GitHub token: the prefix and 36 `x`. */
const FAKE_GHP = `ghp_${"x".repeat(36)}`;
const HOME = "/home/op";
const DAY = 24 * 60 * 60 * 1000;

function query(over: Partial<SentQuery> = {}): SentQuery {
  return { scope: "here", cwd: null, q: "", limit: 50, before: null, ...over };
}

function record(line: string, at: number, cwd: string | null = null, kind: SentRecord["kind"] = "shell"): SentRecord {
  return { line, cwd, at, kind };
}

describe("the skip rules (bridge/secret-line.ts)", () => {
  test("a table of lines: only the plain ones are kept", () => {
    const cases: Array<[string, string | null]> = [
      [" git status", null],
      ["\tgit status", null],
      ["", null],
      ["   ", null],
      ["export AWS_SECRET_ACCESS_KEY=x", null],
      ['curl -H "Authorization: Bearer x" https://example.com', null],
      ["git clone https://op:hunter2@example.com/repo.git", null],
      [`echo ${FAKE_GHP}`, null],
      ["x".repeat(SENT_MAX_LINE + 1), null],
      ["git status", "git status"],
      ["git status   ", "git status"],
      ["make test && ls -la", "make test && ls -la"],
    ];
    for (const [raw, kept] of cases) expect([raw, sentLineOf(raw)]).toEqual([raw, kept]);
  });

  test("the fake ghp_ token is still caught by the outbound mask, not by the word list", () => {
    expect(looksSecret(`echo ${FAKE_GHP}`)).toBe(false);
    expect(redactText(`echo ${FAKE_GHP}`)).not.toBe(`echo ${FAKE_GHP}`);
  });

  test("recent-runs.ts keeps the same looksSecret, with no change in behaviour", () => {
    expect(recentLooksSecret).toBe(looksSecret);
    for (const line of ["make FOO=1", "TOKEN=abc deploy", "my password"]) expect(recentLooksSecret(line)).toBe(true);
    expect(recentLooksSecret("make test")).toBe(false);
  });
});

describe("the store", () => {
  test("a kept line is one JSON record; home is null; a skipped line writes nothing", async () => {
    const io = memorySentIo();
    const store = new SentStore(io, { home: HOME, now: () => 1000, warn: () => {} });
    expect(await store.record(" ls", "/srv", "shell")).toBe("skipped");
    expect(io.text).toBeNull();
    expect(await store.record("ls -la", HOME, "shell")).toBe("recorded");
    expect(await store.record("make test", "/srv/app", "run")).toBe("recorded");
    expect(await store.record("pwd", "relative/path", "shell")).toBe("recorded");
    expect(io.text).toBe(
      '{"v":1,"line":"ls -la","cwd":null,"at":1000,"kind":"shell"}\n' +
        '{"v":1,"line":"make test","cwd":"/srv/app","at":1000,"kind":"run"}\n' +
        '{"v":1,"line":"pwd","cwd":null,"at":1000,"kind":"shell"}\n',
    );
    expect(await store.list()).toEqual([record("ls -la", 1000), record("make test", 1000, "/srv/app", "run"), record("pwd", 1000)]);
  });

  test("COLLIE_SENT=off records nothing, and the read lists nothing; remove and clear still work", async () => {
    const io = memorySentIo(formatSentRecord(record("ls", 5)));
    const store = new SentStore(io, { off: true, now: () => 10, warn: () => {} });
    expect(await store.record("git status", "/srv", "shell")).toBe("skipped");
    const answer = await sentAnswerHere(store, query(), { id: "local", name: "desk" }, true);
    expect(answer).toEqual({ entries: [], more: false, off: true, machines: [{ host: "local", label: "desk", ok: true, off: true }] });
    expect(await store.remove(sentId("ls"))).toBe(1);
    expect(await store.clear()).toBe(0);
  });

  test("past 5500 records the file is rewritten with the newest 5000", async () => {
    const now = 10 * DAY;
    const rows = Array.from({ length: SENT_COMPACT_AT }, (_, i) => formatSentRecord(record(`echo ${i}`, now - SENT_COMPACT_AT + i)));
    const io = memorySentIo(rows.join(""));
    const store = new SentStore(io, { now: () => now, warn: () => {} });
    expect(await store.record("echo last", "/srv", "shell")).toBe("recorded");
    expect(io.replaces).toBe(1);
    const kept = parseSentText(io.text, now);
    expect(kept).toHaveLength(SENT_CAP);
    expect(kept[0]!.line).toBe(`echo ${SENT_COMPACT_AT - SENT_CAP + 1}`);
    expect(kept.at(-1)!.line).toBe("echo last");
    // Under the threshold again: the next record only appends.
    expect(await store.record("echo next", "/srv", "shell")).toBe("recorded");
    expect(io.replaces).toBe(1);
  });

  test("no record older than 365 days survives a read or a rewrite", async () => {
    const now = 400 * DAY;
    const old = formatSentRecord(record("echo old", now - SENT_MAX_AGE_MS - 1));
    const young = formatSentRecord(record("echo young", now - DAY));
    expect(parseSentText(old + young, now).map((r) => r.line)).toEqual(["echo young"]);
    const filler = Array.from({ length: SENT_COMPACT_AT - 1 }, (_, i) => formatSentRecord(record(`echo ${i}`, now - 1000 + i)));
    const io = memorySentIo(old + young + filler.join(""));
    const store = new SentStore(io, { now: () => now, warn: () => {} });
    await store.record("echo last", null, "shell");
    expect(io.text).not.toContain("echo old");
    expect(io.text).toContain("echo last");
  });

  test("a corrupt line is skipped, another version reads as absent, and a remove keeps both rows", async () => {
    const text = [
      "not json",
      '{"v":2,"line":"from a newer Collie","cwd":null,"at":5,"kind":"shell"}',
      '{"v":1,"line":"","cwd":null,"at":5,"kind":"shell"}',
      '{"v":1,"line":"ls","cwd":"relative","at":5,"kind":"shell"}',
      '{"v":1,"line":"ls","cwd":null,"at":5,"kind":"agent"}',
      '{"v":1,"line":"git log","cwd":null,"at":6,"kind":"shell"}',
      '{"v":1,"line":"git log","cwd":"/srv","at":7,"kind":"shell"}',
      "",
    ].join("\n");
    const io = memorySentIo(text);
    const store = new SentStore(io, { now: () => 10, warn: () => {} });
    expect((await store.list()).map((r) => r.line)).toEqual(["git log", "git log"]);
    expect(await store.remove(sentId("git log"))).toBe(2);
    expect(await store.remove(sentId("git log"))).toBe(0);
    expect(io.text).toContain("not json");
    expect(io.text).toContain("from a newer Collie");
    expect(io.text).not.toContain("git log");
    expect(await store.clear()).toBe(0);
    expect(io.text).toBe("");
  });

  test("on disk: the file is 0600 in a 0700 folder, and appears only with the first kept line", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-sent-"));
    const stateDir = join(root, "state");
    try {
      const store = new SentStore(sentFileIo(stateDir), { home: HOME, warn: () => {} });
      expect(await store.record(" secret-ish", null, "shell")).toBe("skipped");
      await expect(stat(stateDir)).rejects.toThrow();
      expect(await store.record("git status", "/srv", "shell")).toBe("recorded");
      const text = await readFile(join(stateDir, SENT_FILE), "utf8");
      expect(text).toContain('"line":"git status"');
      if (process.platform !== "win32") {
        expect((await stat(join(stateDir, SENT_FILE))).mode & 0o777).toBe(0o600);
        expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
        // A rewrite keeps the mode.
        await store.remove(sentId("git status"));
        expect((await stat(join(stateDir, SENT_FILE))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a write that fails is one warning with no text, and the answer says so", async () => {
    const warnings: string[] = [];
    const io = { ...memorySentIo(), append: () => Promise.reject(new Error("EACCES: permission denied")) };
    const store = new SentStore(io, { warn: (line) => void warnings.push(line) });
    expect(await store.record("git status", null, "shell")).toBe("unwritable");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("git status");
  });
});

describe("the read", () => {
  const records = [
    record("git status", 10, "/srv/app"),
    record("git status", 30, "/srv/app"),
    record("git status", 20, "/srv/other"),
    record("make test", 25, null, "run"),
    record("ls -la", 5, "/srv/app"),
  ];

  test("repeats merge per line: newest at and its folder, and the count of all", () => {
    const { entries, more } = sentEntries(records, query(), "local");
    expect(more).toBe(false);
    expect(entries).toEqual([
      { id: sentId("git status"), line: "git status", cwd: "/srv/app", at: 30, kind: "shell", count: 3, host: "local" },
      { id: sentId("make test"), line: "make test", cwd: null, at: 25, kind: "run", count: 1, host: "local" },
      { id: sentId("ls -la"), line: "ls -la", cwd: "/srv/app", at: 5, kind: "shell", count: 1, host: "local" },
    ]);
    expect(sentId("git status")).toMatch(/^[0-9a-f]{16}$/u);
  });

  test("the folder is applied before the merge, and home matches the records kept as null", () => {
    expect(sentEntries(records, query({ cwd: "/srv/other" }), "local").entries).toMatchObject([{ line: "git status", at: 20, count: 1, cwd: "/srv/other" }]);
    expect(sentEntries(records, query({ cwd: HOME }), "local", HOME).entries.map((e) => e.line)).toEqual(["make test"]);
  });

  test("q needs every word, in any case; before and limit page with more", () => {
    expect(sentEntries(records, query({ q: "STATUS git" }), "local").entries.map((e) => e.line)).toEqual(["git status"]);
    expect(sentEntries(records, query({ q: "git nope" }), "local").entries).toEqual([]);
    const first = sentEntries(records, query({ limit: 2 }), "local");
    expect(first.entries.map((e) => e.line)).toEqual(["git status", "make test"]);
    expect(first.more).toBe(true);
    const second = sentEntries(records, query({ limit: 2, before: first.entries.at(-1)!.at }), "local");
    expect(second.entries.map((e) => e.line)).toEqual(["ls -la"]);
    expect(second.more).toBe(false);
  });

  test("the query is checked: scope, cwd, limit and before", () => {
    expect(parseSentQuery(new URLSearchParams())).toEqual(query());
    expect(parseSentQuery(new URLSearchParams("scope=all&cwd=/srv&q=git&limit=200&before=99"))).toEqual(query({ scope: "all", cwd: "/srv", q: "git", limit: 200, before: 99 }));
    for (const bad of ["scope=some", "cwd=relative", "limit=0", "limit=201", "limit=x", "before=-1", "before=1.5"]) {
      expect(parseSentQuery(new URLSearchParams(bad))).toBeTypeOf("string");
    }
  });

  test("every line on the way out passes through the mask", async () => {
    // A record that predates a wider pattern list: kept then, masked now.
    const io = memorySentIo(formatSentRecord(record(`echo ${FAKE_GHP}`, 5)));
    const store = new SentStore(io, { now: () => 10, warn: () => {} });
    const masked = await sentAnswerHere(store, query(), { id: "local", name: "desk" }, true);
    expect(masked.entries[0]!.line).not.toContain(FAKE_GHP);
    expect(masked.entries[0]!.id).toBe(sentId(`echo ${FAKE_GHP}`));
    const raw = await sentAnswerHere(store, query(), { id: "local", name: "desk" }, false);
    expect(raw.entries[0]!.line).toContain(FAKE_GHP);
  });
});

// ── Record points ──────────────────────────────────────────────────────────────────────────────

const RULE = "─".repeat(40);

/** One terminal per pane: a profiled agent's box on `%1`, a bare prompt everywhere else. */
function panes() {
  const boxes = new Map<string, string>();
  const tails = new Map<string, string>();
  const written: Array<[string, string]> = [];
  const keys: Array<[string, readonly string[]]> = [];
  let revision = 1;
  const render = (paneId: string): string => {
    const box = boxes.get(paneId) ?? "";
    if (paneId === "%1") return ["> earlier", "", RULE, box === "" ? "❯ \u001b[2mTry something\u001b[0m" : `❯ ${box}`, RULE, "  status row"].join("\n");
    return [tails.get(paneId) ?? "op@desk:~$", box].join(" ");
  };
  return {
    written,
    keys,
    tails,
    readGrid: (paneId: string): Promise<MuxOutcome<MuxGrid>> => Promise.resolve(muxOk({ paneId, text: render(paneId), truncated: false, revision })),
    typeText: (paneId: string, text: string): Promise<MuxAck> => {
      written.push([paneId, text]);
      boxes.set(paneId, (boxes.get(paneId) ?? "") + text);
      revision++;
      return Promise.resolve(muxAck());
    },
    writeKeys: (paneId: string, sent: readonly string[]): Promise<MuxAck> => {
      keys.push([paneId, sent]);
      if (sent.includes("Enter")) boxes.set(paneId, "");
      revision++;
      return Promise.resolve(muxAck());
    },
  };
}

/** A session with a profiled agent `%1`, an agent with no profile `%3`, and shell panes `%7` and `%8`. */
function session(sent: SentStore) {
  const pane = panes();
  let clock = 0;
  const shellPanes = [
    { paneId: "%7", cwd: "/srv/app" },
    { paneId: "%8", cwd: HOME },
  ];
  const engine = {
    current: () => ({ agents: [{ paneId: "%1", agent: "claude" }, { paneId: "%3", agent: "mystery-agent" }], shellPanes }),
    noteInput: () => undefined,
    pokeNow: () => undefined,
  };
  const dir = { store: new RequestStore(join(tmpdir(), `collie-sent-sends-${crypto.randomUUID()}`), () => clock) };
  const send = new SendProtocol({
    mux: pane,
    gate: new KeyGate(pane, () => clock),
    store: dir.store,
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness) => Promise.resolve(profileFor(harness, "2.1.200", { log: () => undefined })),
    generation: () => "gen",
    blindSent: sentRecorder(sent, () => shellPanes),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  const rt: SendRouteRuntime = { send, engine, herdr: {}, name: "main" };
  return { rt, pane };
}

function audit() {
  const lines: string[] = [];
  return { audit: new AuditLog((line) => void lines.push(line)), lines };
}

/** A store whose records the test reads back synchronously after the fire-and-forget record lands. */
function sentStore() {
  const io = memorySentIo();
  return { io, store: new SentStore(io, { home: HOME, now: () => 1000, warn: () => {} }) };
}

/** Let a fire-and-forget record land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("record points: the Send Protocol's blind send on a shell pane", () => {
  const context = (log: AuditLog) => ({ audit: log, device: "phone", redact: true, acceptEncoding: null });

  test("a send and a reply to a shell pane are recorded with the pane's folder, kind shell", async () => {
    const { io, store } = sentStore();
    const { rt } = session(store);
    const { audit: log } = audit();
    const sent = await (await sendRoute(rt, { id: "sent-shell-0001", pane: "%7", text: "git status" }, context(log))).json();
    expect(sent.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    const reply = await (await replyThroughProtocol(replySendOf(rt), "%8", "main", { text: "ls -la", submit: true, id: "sent-shell-0002" }, context(log))).json();
    expect(reply).toMatchObject({ ok: true, send: { receipt: { outcome: "sent" } } });
    await settle();
    expect(parseSentText(io.text, 1000)).toEqual([record("git status", 1000, "/srv/app"), record("ls -la", 1000, null)]);
  });

  test("a replay of the same request id records nothing more", async () => {
    const { io, store } = sentStore();
    const { rt } = session(store);
    const { audit: log } = audit();
    await sendRoute(rt, { id: "sent-shell-0003", pane: "%7", text: "git status" }, context(log));
    const again = await (await sendRoute(rt, { id: "sent-shell-0003", pane: "%7", text: "git status" }, context(log))).json();
    expect(again.replayed).toBe(true);
    await settle();
    expect(parseSentText(io.text, 1000)).toHaveLength(1);
  });

  test("an agent pane, a pane whose agent has no profile, and a skipped line are not recorded", async () => {
    const { io, store } = sentStore();
    const { rt, pane } = session(store);
    const { audit: log } = audit();
    const agent = await (await sendRoute(rt, { id: "sent-agent-0001", pane: "%1", text: "please run the tests" }, context(log))).json();
    expect(agent.receipt).toMatchObject({ outcome: "sent" });
    const unprofiled = await (await sendRoute(rt, { id: "sent-agent-0002", pane: "%3", text: "hello there" }, context(log))).json();
    expect(unprofiled.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"], profileId: null });
    const spaced = await (await sendRoute(rt, { id: "sent-shell-0004", pane: "%7", text: " export TOKEN=abc" }, context(log))).json();
    expect(spaced.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.written.map(([id]) => id)).toEqual(["%1", "%3", "%7"]);
    await settle();
    expect(io.text).toBeNull();
  });

  test("a refused send on a shell pane (a password prompt) is not recorded", async () => {
    const { io, store } = sentStore();
    const { rt, pane } = session(store);
    pane.tails.set("%7", "[sudo] password for op:");
    const { audit: log } = audit();
    const refused = await (await sendRoute(rt, { id: "sent-shell-0005", pane: "%7", text: "hunter2" }, context(log))).json();
    expect(refused.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    await settle();
    expect(io.text).toBeNull();
  });

  test("a program session's send goes through its driver and is never recorded", async () => {
    const { io, store } = sentStore();
    const { rt } = session(store);
    const answer: SendAnswer = { offers: [] };
    const driver: Pick<ProgramDriver, "handle" | "recent"> = { handle: () => Promise.resolve(answer), recent: () => [] };
    // SAFETY: `sendRoute` reaches only `driver.handle` on a program session; the fake answers it.
    const program: SendRouteRuntime = { ...rt, driver: driver as ProgramDriver };
    const { audit: log } = audit();
    expect((await sendRoute(program, { id: "sent-prog-0001", pane: "%7", text: "git status" }, context(log))).status).toBe(200);
    await settle();
    expect(io.text).toBeNull();
  });

  test("keys never record: Type mode's characters and Enter on a shell pane leave Sent empty", async () => {
    const { io, store } = sentStore();
    session(store);
    const typed: Array<[string, string[]]> = [];
    const client: Partial<HerdrClient> = {
      sendPaneKeys: (paneId: string, keys: string[]) => {
        typed.push([paneId, keys]);
        return Promise.resolve();
      },
    };
    // SAFETY: the keys route reaches only `sendPaneKeys` with no `expected_prompt`; the fake implements it.
    const mux = new HerdrMux(client as HerdrClient, () => []);
    const { audit: log } = audit();
    const req = new Request("http://x/api/pane/%257/keys", { method: "POST", body: JSON.stringify({ keys: ["g", "i", "t", "Enter"] }) });
    // SAFETY: the keys route reads no field of the config without `expected_prompt`.
    const res = await keysPane(mux, {} as Config, "%7", req, log, "phone", "main");
    expect(res.status).toBe(200);
    expect(typed).toEqual([["%7", ["g", "i", "t", "Enter"]]]);
    await settle();
    expect(io.text).toBeNull();
  });
});

// ── The run-once record point ──────────────────────────────────────────────────────────────────

class FakeMux {
  readonly texts: Array<[string, string]> = [];
  private n = 0;
  createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    this.n++;
    return Promise.resolve(muxOk({ paneId: `w${this.n}:p1`, spaceId: `w${this.n}`, spaceLabel: request.label ?? "shell", tabId: `w${this.n}:t1`, cwd: request.cwd ?? "/" }));
  }
  readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
    return Promise.resolve(muxOk({ paneId, text: "$ ", truncated: false, revision: 1 }));
  }
  typeText(paneId: string, text: string): Promise<MuxAck> {
    this.texts.push([paneId, text]);
    return Promise.resolve(muxAck());
  }
  writeKeys(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  closePane(): Promise<MuxAck> {
    return Promise.resolve(muxAck());
  }
  refresh(): Promise<void> {
    return Promise.resolve();
  }
}

function runEngine(): StateEngine {
  const stub: Partial<StateEngine> = {
    pokeNow: () => {},
    current: () => ({ agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: `launch` reaches only `current()` and `pokeNow()` here.
  return stub as StateEngine;
}

async function runOnce(body: JsonObject, sent: SentStore, mux = new FakeMux()) {
  let ms = 0;
  const fakeClock = {
    now: () => ms,
    sleep: (by: number): Promise<void> => {
      ms += by;
      return Promise.resolve();
    },
  };
  const fake: Partial<MuxAdapter> = mux;
  // SAFETY: a launch with no folder name to give a tab reaches createSpace, readGrid, typeText,
  // writeKeys, closePane and refresh: FakeMux has all six.
  const adapter = fake as MuxAdapter;
  const res = await launch(
    adapter,
    runEngine(),
    new Request("http://x/api/launch", { method: "POST", body: JSON.stringify(body) }),
    new AuditLog(() => {}),
    "phone",
    "default",
    () => Promise.resolve([{ command: "htop", label: "htop" }]),
    fakeClock,
    {
      harnesses: { launch: harnessLaunch },
      home: HOME,
      fs: { isDirectory: () => Promise.resolve(true) },
      switches: () => Promise.resolve(DEFAULT_SWITCHES),
      receipts: memoryLaunchReceipts(),
      sent,
    },
  );
  return { status: res.status, mux };
}

describe("record points: a one-off run", () => {
  test("a run that worked is recorded as kind run in its folder; a row launch is not recorded", async () => {
    const { io, store } = sentStore();
    expect((await runOnce({ run: "make test", cwd: "/srv/app" }, store)).status).toBe(200);
    // A row in `/` gives its tab no folder name, so the fake needs no rename capability.
    expect((await runOnce({ command: "htop", cwd: "/" }, store)).status).toBe(200);
    expect(parseSentText(io.text, 1000)).toEqual([record("make test", 1000, "/srv/app", "run")]);
  });

  test("a run with a leading space, or one that looks secret, runs and is not recorded", async () => {
    const { io, store } = sentStore();
    const spaced = await runOnce({ run: " make deploy" }, store);
    expect(spaced.status).toBe(200);
    expect(spaced.mux.texts).toEqual([["w1:p1", "make deploy"]]);
    expect((await runOnce({ run: "TOKEN=abc deploy" }, store)).status).toBe(200);
    expect(io.text).toBeNull();
  });
});

// ── The lead's merge ───────────────────────────────────────────────────────────────────────────

function answerOf(entries: Array<Partial<SentAnswer["entries"][number]> & { line: string; at: number }>, more = false): SentAnswer {
  return {
    entries: entries.map((e) => ({ id: sentId(e.line), cwd: null, kind: "shell", count: 1, host: "member-host", ...e })),
    more,
    off: false,
    machines: [{ host: "member-host", label: "member", ok: true }],
  };
}

const jsonResponse = (body: SentAnswer | JsonValue, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the lead's merge", () => {
  const local = answerOf([{ line: "git status", at: 30, host: "lead" }]);
  local.machines = [{ host: "lead", label: "desk", ok: true }];

  test("one member answers, one 404s, one times out: merged by at, each machine named", async () => {
    const asked: string[] = [];
    const members: SentMember[] = [
      {
        host: "laptop",
        label: "laptop",
        ask: (params) => {
          asked.push(params.toString());
          return Promise.resolve(jsonResponse(answerOf([{ line: "make test", at: 40 }, { line: `echo ${FAKE_GHP}`, at: 10 }], true)));
        },
      },
      { host: "old", label: "old", ask: () => Promise.resolve(new Response('{"error":"not found"}', { status: 404 })) },
      { host: "slow", label: "slow", ask: () => new Promise<Response>(() => {}) },
    ];
    const merged = await mergeSentAnswers(local, members, query({ cwd: "/srv", q: "git", limit: 2, before: 99 }), true, 20);
    expect(asked).toEqual(["scope=here&limit=2&cwd=%2Fsrv&q=git&before=99"]);
    expect(merged.entries.map((e) => [e.line, e.host])).toEqual([
      ["make test", "laptop"],
      ["git status", "lead"],
    ]);
    expect(merged.more).toBe(true);
    expect(merged.off).toBe(false);
    expect(merged.machines).toEqual([
      { host: "lead", label: "desk", ok: true },
      { host: "laptop", label: "laptop", ok: true },
      { host: "old", label: "old", ok: false, reason: "old_version" },
      { host: "slow", label: "slow", ok: false, reason: "timeout" },
    ]);
  });

  test("a member's line is masked again on the lead, and a member that is off says so", async () => {
    const off: SentAnswer = { entries: [], more: false, off: true, machines: [] };
    const members: SentMember[] = [
      { host: "laptop", label: "laptop", ask: () => Promise.resolve(jsonResponse(answerOf([{ line: `echo ${FAKE_GHP}`, at: 50 }]))) },
      { host: "quiet", label: "quiet", ask: () => Promise.resolve(jsonResponse(off)) },
    ];
    const merged = await mergeSentAnswers(local, members, query(), true, 50);
    expect(merged.entries[0]!.line).not.toContain(FAKE_GHP);
    expect(merged.entries[0]!.id).toBe(sentId(`echo ${FAKE_GHP}`));
    expect(merged.machines[2]).toEqual({ host: "quiet", label: "quiet", ok: true, off: true });
  });

  test("a crew error is read: timed out is timeout, anything else unreachable, a throw unreachable", async () => {
    expect(await readSentReply(jsonResponse({ ok: false, code: "host_unreachable", error: "host slow: sent: timed out after 1200ms" }, 503), "slow")).toEqual({ ok: false, reason: "timeout" });
    expect(await readSentReply(jsonResponse({ ok: false, code: "host_unreachable", error: "host gone: sent: connection refused" }, 503), "gone")).toEqual({ ok: false, reason: "unreachable" });
    expect(await readSentReply(new Response("not json", { status: 200 }), "odd")).toEqual({ ok: false, reason: "unreachable" });
    const throws: SentMember = { host: "x", label: "x", ask: () => Promise.reject(new Error("boom")) };
    expect(await askSentMember(throws, new URLSearchParams(), 50)).toEqual({ ok: false, reason: "unreachable" });
  });

  test("the crew link carries the three routes: a read, and two writes audited by name", () => {
    expect(crewRouteFor("/api/sent")).toBe("sent");
    expect(crewRouteFor("/api/sent/remove")).toBe("sent/remove");
    expect(crewRouteFor("/api/sent/clear")).toBe("sent/clear");
    expect(apiPathFor("sent")).toBe("/api/sent");
    expect(crewRouteFor("/api/sent/other")).toBeNull();
    expect(forwardKind("sent")).toBe("read");
    expect(forwardKind("sent/remove")).toBe("write");
    expect(forwardKind("sent/clear")).toBe("write");
    expect(forwardAuditAction("sent")).toBeNull();
    expect(forwardAuditAction("sent/remove")).toBe("sent.remove");
    expect(forwardAuditAction("sent/clear")).toBe("sent.clear");
    expect(textAnswerOf("sent")).toBe("sent");
    // A `?host=` read is masked on the lead too, and an answer it cannot read is not passed on.
    const raw = JSON.stringify(answerOf([{ line: `echo ${FAKE_GHP}`, at: 1 }]));
    expect(maskForwardedAnswer("sent", raw)).not.toContain(FAKE_GHP);
    expect(maskForwardedAnswer("sent", '{"entries":[{"line":5}]}')).toBeNull();
  });
});

// ── The routes ─────────────────────────────────────────────────────────────────────────────────

function caller(over: { resolved?: Response; denied?: Response } = {}) {
  const lines: string[] = [];
  const named: Pick<SessionRuntime, "name"> = { name: "main" };
  // SAFETY: the Sent routes read only `name` off the runtime.
  const rt = named as SessionRuntime;
  return {
    lines,
    caller: {
      gate: () => over.denied ?? null,
      resolve: () => Promise.resolve(over.resolved ?? rt),
      device: () => "phone",
      audit: new AuditLog((line) => void lines.push(line)),
    },
  };
}

function deps(store: SentStore, members: SentRouteDeps["members"] = null): SentRouteDeps {
  return { sent: store, self: () => ({ id: "local", name: "desk" }), redact: true, home: HOME, members };
}

describe("the routes", () => {
  test("GET answers this machine's page; a bad query is a 400; a solo scope=all is here", async () => {
    const io = memorySentIo(formatSentRecord(record("git status", 5, "/srv")));
    const store = new SentStore(io, { now: () => 10, warn: () => {} });
    const { caller: c } = caller();
    const res = await serveSentRoute(new Request("http://x/api/sent?scope=all"), new URL("http://x/api/sent?scope=all"), c, deps(store));
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      entries: [{ id: sentId("git status"), line: "git status", cwd: "/srv", at: 5, kind: "shell", count: 1, host: "local" }],
      more: false,
      off: false,
      machines: [{ host: "local", label: "desk", ok: true }],
    });
    const bad = await serveSentRoute(new Request("http://x/api/sent?limit=0"), new URL("http://x/api/sent?limit=0"), c, deps(store));
    expect(bad?.status).toBe(400);
    expect(await serveSentRoute(new Request("http://x/api/other"), new URL("http://x/api/other"), c, deps(store))).toBeNull();
  });

  test("a lead's scope=all merges its members; a `?host=` read is the member's own answer", async () => {
    const store = new SentStore(memorySentIo(), { now: () => 10, warn: () => {} });
    const members = () => [{ host: "laptop", label: "laptop", ask: () => Promise.resolve(jsonResponse(answerOf([{ line: "make", at: 3 }]))) }];
    const { caller: c } = caller();
    const merged = await serveSentRoute(new Request("http://x/api/sent?scope=all"), new URL("http://x/api/sent?scope=all"), c, deps(store, members));
    if (merged === null) throw new Error("the read answered nothing");
    const body: SentAnswer = await merged.json();
    expect(body.machines.map((m) => m.host)).toEqual(["local", "laptop"]);
    const forwarded = new Response("from the member", { status: 200 });
    const { caller: remote } = caller({ resolved: forwarded });
    expect(await serveSentRoute(new Request("http://x/api/sent?host=laptop"), new URL("http://x/api/sent?host=laptop"), remote, deps(store, members))).toBe(forwarded);
  });

  test("the read needs the read gate, the writes the write gate", async () => {
    const store = new SentStore(memorySentIo(), { warn: () => {} });
    const levels: string[] = [];
    const { caller: base } = caller();
    const gated = { ...base, gate: (level: string) => (levels.push(level), new Response("device not paired", { status: 403 })) };
    const post = (path: string) => new Request(`http://x${path}`, { method: "POST", body: "{}" });
    expect((await serveSentRoute(new Request("http://x/api/sent"), new URL("http://x/api/sent"), gated, deps(store)))?.status).toBe(403);
    expect((await serveSentRoute(post("/api/sent/clear"), new URL("http://x/api/sent/clear"), gated, deps(store)))?.status).toBe(403);
    expect(levels).toEqual(["read", "write"]);
  });

  test("remove and clear are idempotent, and the audit line holds no text and no id", async () => {
    const io = memorySentIo(formatSentRecord(record("git status", 5)) + formatSentRecord(record("git status", 6)) + formatSentRecord(record("ls", 7)));
    const store = new SentStore(io, { now: () => 10, warn: () => {} });
    const { caller: c, lines } = caller();
    const post = (path: string, body: JsonValue) => serveSentRoute(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }), new URL(`http://x${path}`), c, deps(store));
    const id = sentId("git status");
    expect(await (await post("/api/sent/remove", { id, requestId: "req-1" }))?.json()).toEqual({ ok: true, removed: 2 });
    expect(await (await post("/api/sent/remove", { id, requestId: "req-2" }))?.json()).toEqual({ ok: true, removed: 0 });
    expect((await post("/api/sent/remove", { requestId: "req-3" }))?.status).toBe(400);
    expect(await (await post("/api/sent/clear", { requestId: "req-4" }))?.json()).toEqual({ ok: true, removed: 1 });
    expect(await (await post("/api/sent/clear", { requestId: "req-5" }))?.json()).toEqual({ ok: true, removed: 0 });
    expect(lines).toHaveLength(4);
    // SAFETY: each line is one `formatAuditLine` JSON object.
    expect(lines.map((l) => (JSON.parse(l) as JsonObject).action)).toEqual(["sent.remove", "sent.remove", "sent.clear", "sent.clear"]);
    for (const line of lines) {
      expect(line).not.toContain("git status");
      expect(line).not.toContain(id);
      expect(line).not.toContain('"ls"');
    }
  });
});
