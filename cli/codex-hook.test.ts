import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { EDGE_FILE } from "../bridge/beacon/paths.ts";
import { HoldBook } from "../bridge/surface/hold.ts";
import { kindOfEdge } from "../bridge/surface/edges.ts";
import type { EdgeRecord } from "../bridge/beacon/types.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import type { ProcessProbe } from "../bridge/proc-probe.ts";
import { holdInputHash, shownInput } from "../web/src/lib/surface/hold.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import type { ProviderEnd, ProviderRun } from "./codex-broker.ts";
import { cmdCodexHook, codexHoldRequest, type CodexHookDeps } from "./codex-hook.ts";
import { CAPABILITY_FILE, MOSHI_ENTRY_COMMAND, type MoshiCapability } from "./codex-moshi.ts";
import { recordPath, serializeRecord, type NativeRecord } from "./codex-native-record.ts";
import { context, fakeFiles, HOME, STATE, type FakeFiles } from "./fakes.ts";
import { holdSocketPath, type HoldSocket } from "./hold.ts";
import { EXIT } from "./io.ts";

// `collie codex-hook` end to end over fakes: a process table, a bridge socket, a provider. Each test is
// about a thing the operator would see go wrong: a card on the wrong pane, a decision nobody gave, a
// request left open on a phone, or a hook that exits non-zero (to Codex, exit 2 is a deny).

const CODEX_PID = 100;
const CODEX_START = 300;
const MOSHI = "/opt/homebrew/bin/moshi";
const MOSHI_REAL = "/opt/homebrew/Cellar/moshi/1.0.0/bin/moshi";
const SOCKET = holdSocketPath(STATE);
const ENV = { HERDR_PANE_ID: "w1:pA", HERDR_SOCKET_PATH: "/run/herdr.sock" };

interface Proc {
  readonly ppid: number;
  readonly startTime: number;
  readonly comm: string;
  readonly args: readonly string[];
}
const TUI: Proc = { ppid: 1, startTime: CODEX_START, comm: "codex", args: ["codex", "--yolo"] };

function probeOf(rows: Record<number, Proc>): ProcessProbe & { calls: number } {
  const probe = {
    calls: 0,
    startTimeOf: (pid: number) => rows[pid]?.startTime ?? null,
    identityOf(pid: number) {
      probe.calls += 1;
      return rows[pid] === undefined ? null : { pid, ppid: rows[pid].ppid, startTime: rows[pid].startTime, comm: rows[pid].comm };
    },
    argsOf: (pid: number) => (rows[pid] === undefined ? null : [...rows[pid].args]),
  };
  return probe;
}

/** A bridge's end of the hold socket: what the hook sent, and the answers a test sends back. */
interface FakeBridge {
  socket: HoldSocket;
  sent: string[];
  reply(line: string): void;
  hangUp(): void;
  closed: () => boolean;
}

function bridge(): FakeBridge {
  const lines: ((line: string) => void)[] = [];
  const closes: (() => void)[] = [];
  const sent: string[] = [];
  let closed = false;
  return {
    sent,
    closed: () => closed,
    reply: (line) => lines.forEach((listener) => listener(line)),
    hangUp: () => closes.forEach((listener) => listener()),
    socket: {
      send: (line) => void sent.push(line),
      onLine: (listener) => void lines.push(listener),
      onClose: (listener) => void closes.push(listener),
      close: () => {
        closed = true;
        closes.forEach((listener) => listener());
      },
    },
  };
}

/** A provider the test controls: answers when told, records how it was cancelled. */
interface Spawned {
  argv: readonly string[];
  payload: string;
  cancel: MoshiCapability["cancel"];
}

interface FakeProvider {
  run: ProviderRun;
  answer(end: ProviderEnd): void;
  cancels: number[];
  spawned: Spawned[];
}

function provider(): FakeProvider {
  const settled = Promise.withResolvers<ProviderEnd>();
  const cancels: number[] = [];
  return {
    cancels,
    spawned: [],
    answer: settled.resolve,
    run: {
      settled: settled.promise,
      cancel: (graceMs) => {
        cancels.push(graceMs);
        return Promise.resolve("exited");
      },
    },
  };
}

const sha = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const PROOF = JSON.stringify({
  schema: 1,
  provider: "moshi",
  command: MOSHI_ENTRY_COMMAND,
  executable: MOSHI_REAL,
  digest: sha("moshi 1.0.0"),
  cancel: { method: "sigint", graceMs: 2500 },
  proof: { kind: "runtime-withdrawal", remoteWithdrawn: true, observer: "root", observedAt: "2026-10-25T18:00:00Z", detail: "Cancelled the loser on a phone; the pending prompt left the phone within 2 s." },
});

const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
const MOSHI_DENY: ProviderEnd = { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "from phone" } } }) };

interface Rig {
  readonly deps: CodexHookDeps;
  readonly files: FakeFiles;
  readonly printed: string[];
  readonly bridge: ReturnType<typeof bridge>;
  readonly probe: ReturnType<typeof probeOf>;
  readonly provider: ReturnType<typeof provider>;
  readonly passed: { argv: readonly string[]; payload: string }[];
  readonly timers: number[];
  readonly stop: AbortController;
  edges(): EdgeRecord[];
}

function rig(opts: { stdin: string; record?: Partial<NativeRecord> | null; proven?: boolean; env?: Record<string, string>; procs?: Record<number, Proc>; connect?: boolean }): Rig {
  const files = fakeFiles();
  files.mkdirp(STATE, 0o700);
  files.mkdirp(join(STATE, "hold"), 0o700);
  files.entryTypes.set(SOCKET, "other");
  if (opts.record !== null) {
    const record: NativeRecord = {
      hooksPath: join(HOME, ".codex", "hooks.json"),
      binary: "/opt/collie/bin/collie",
      hold: true,
      moshi: null,
      ...opts.record,
    };
    files.write(recordPath({ home: HOME, env: {} }), serializeRecord(record));
  }
  files.write(MOSHI_REAL, "moshi 1.0.0");
  files.realPaths.set(MOSHI, MOSHI_REAL);
  files.write(MOSHI, "moshi 1.0.0");
  if (opts.proven === true) files.write(join("/cfg", CAPABILITY_FILE), PROOF);
  const b = bridge();
  const p = provider();
  const printed: string[] = [];
  const passed: { argv: readonly string[]; payload: string }[] = [];
  const timers: number[] = [];
  const stop = new AbortController();
  const rows = opts.procs ?? { 9000: { ppid: 8000, startTime: 500, comm: "collie", args: ["collie", "codex-hook"] }, 8000: { ppid: CODEX_PID, startTime: 400, comm: "zsh", args: ["zsh", "-lc", "x"] }, [CODEX_PID]: TUI };
  const probe = probeOf(rows);
  const deps: CodexHookDeps = {
    ctx: context(opts.env ?? ENV),
    files,
    readStdin: () => Promise.resolve(opts.stdin),
    selfPid: 9000,
    parentPid: 8000,
    probe,
    now: () => 1_000_000,
    print: (text) => {
      printed.push(text);
      return Promise.resolve();
    },
    wire: {
      sockets: () => [SOCKET],
      connect: () => Promise.resolve(opts.connect === false ? null : b.socket),
      after: (ms, run) => {
        timers.push(ms);
        const handle = setTimeout(run, ms);
        return () => clearTimeout(handle);
      },
    },
    spawnProvider: (argv, payload, cancel) => {
      p.spawned.push({ argv, payload, cancel });
      return p.run;
    },
    passThrough: (argv, payload) => {
      passed.push({ argv, payload });
      return Promise.resolve(0);
    },
    after: (ms, run) => {
      timers.push(ms);
      const handle = setTimeout(run, ms);
      return () => clearTimeout(handle);
    },
    signal: stop.signal,
  };
  return {
    deps,
    files,
    printed,
    bridge: b,
    probe,
    provider: p,
    passed,
    timers,
    stop,
    edges: () =>
      files
        .list(join(STATE, "edges"))
        .filter((name) => EDGE_FILE.test(name))
        .map((name): EdgeRecord => JSON.parse(files.read(join(STATE, "edges", name)) ?? "{}")),
  };
}

const permission = (over: Record<string, JsonValue> = {}): string =>
  JSON.stringify({
    session_id: "0199a111-aaaa-7bbb-8ccc-000000000001",
    turn_id: "t1",
    transcript_path: null,
    cwd: "/work/proj",
    hook_event_name: "PermissionRequest",
    model: "gpt-6",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command: "git push --force" },
    ...over,
  });

/** The permission payload as the object the request builder reads. */
function payloadOf(over: Record<string, JsonValue> = {}): JsonObject {
  const parsed = parseJsonObject(permission(over));
  if (parsed === undefined) throw new Error("the fixture is not an object");
  return parsed;
}

interface DecisionBody {
  behavior?: string;
  message?: string;
}

/** Lets the hook reach the point where it waits on the bridge and the provider. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await Bun.sleep(5);
};

describe("hook edges", () => {
  test("a SessionStart from the pane's Codex writes one edge with its pid, start, markers and model, and prints nothing", async () => {
    const r = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "SessionStart", model: "gpt-6", source: "startup" }) });
    expect(await cmdCodexHook(r.deps)).toBe(EXIT.OK);
    expect(r.printed).toEqual([]);
    expect(r.edges()).toMatchObject([{ harness: "codex", event: "SessionStart", pid: CODEX_PID, pidStartTime: CODEX_START, model: "gpt-6", holds: true, markers: [{ namespace: "herdr", pane: "w1:pA" }] }]);
  });

  test("each native event is an edge; a subagent's turn events are not, but its tool events are, with its id", async () => {
    const events = ["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"];
    for (const event of events) {
      const r = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: event, prompt: "hi" }) });
      await cmdCodexHook(r.deps);
      expect(r.edges().map((edge) => edge.event)).toEqual([event]);
    }
    const sub = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "Stop", agent_id: "sub-1", agent_type: "explorer" }) });
    await cmdCodexHook(sub.deps);
    expect(sub.edges()).toEqual([]);
    const tool = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "PostToolUse", agent_id: "sub-1", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "x" }) });
    await cmdCodexHook(tool.deps);
    expect(tool.edges()).toMatchObject([{ event: "PostToolUse", tool: "Bash", agent: "sub-1" }]);
  });

  test("a tool edge carries the hash of the input the hold showed, so only that call's hold ends", async () => {
    const hold = loadProfiles().get("codex")!.hold!;
    const input = { command: "git push --force" };
    const r = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: input }) });
    await cmdCodexHook(r.deps);
    expect(r.edges()[0]?.inputHash).toBe(holdInputHash("Bash", shownInput(input, hold.inputShown, hold.inputDetails.Bash)));
  });

  test("outside a multiplexer nothing is read: no probe call, no edge", async () => {
    const r = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "Stop" }), env: {} });
    await cmdCodexHook(r.deps);
    expect(r.probe.calls).toBe(0);
    expect(r.edges()).toEqual([]);
  });

  test("a hook the shared app-server daemon runs is no edge: its markers are another pane's", async () => {
    const daemon = { 9000: { ppid: CODEX_PID, startTime: 500, comm: "collie", args: ["collie"] }, [CODEX_PID]: { ppid: 1, startTime: 300, comm: "codex", args: ["codex", "app-server"] } } satisfies Record<number, Proc>;
    const r = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "Stop" }), procs: daemon });
    await cmdCodexHook({ ...r.deps, parentPid: CODEX_PID });
    expect(r.edges()).toEqual([]);
  });

  test("garbage on stdin, an unknown event and a missing record are all exit 0 and silent", async () => {
    for (const stdin of ["", "not json", "[]", JSON.stringify({ hook_event_name: "PreToolUse" }), JSON.stringify({ nothing: true })]) {
      const r = rig({ stdin });
      expect(await cmdCodexHook(r.deps)).toBe(EXIT.OK);
      expect(r.printed).toEqual([]);
      expect(r.edges()).toEqual([]);
    }
  });
});

describe("PermissionRequest: the Collie hold", () => {
  test("the request on the wire names Codex's own pid and start, the pane's markers, the tool and the input shown", async () => {
    const r = rig({ stdin: permission({ agent_id: "sub-9", agent_type: "worker" }) });
    const done = cmdCodexHook(r.deps);
    await settle();
    const request = JSON.parse(r.bridge.sent[0]!);
    expect(request).toMatchObject({
      v: 1,
      harness: "codex",
      pid: CODEX_PID,
      pidStartTime: CODEX_START,
      markers: [{ namespace: "herdr", scope: "/run/herdr.sock", pane: "w1:pA" }],
      tool: "Bash",
      input: "git push --force",
      agent: "sub-9",
      agentType: "worker",
      cwd: "/work/proj",
      hold: true,
      at: 1_000_000,
    });
    r.bridge.reply(JSON.stringify({ decision: "allow" }));
    expect(await done).toBe(EXIT.OK);
    expect(r.printed).toEqual([ALLOW]);
    expect(r.bridge.closed()).toBe(true);
  });

  test("a tap to deny prints a deny with the profile's message and nothing Codex fails closed on", async () => {
    const r = rig({ stdin: permission() });
    const done = cmdCodexHook(r.deps);
    await settle();
    r.bridge.reply(JSON.stringify({ decision: "deny" }));
    await done;
    const out: { hookSpecificOutput: { hookEventName: string; decision: DecisionBody } } = JSON.parse(r.printed[0]!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(out.hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "The person denied this from Collie." });
  });

  test("an MCP tool is held with its whole input as JSON, since no field of it is a command", async () => {
    const r = rig({ stdin: permission({ tool_name: "mcp__db__drop_table", tool_input: { table: "users", cascade: true } }) });
    const done = cmdCodexHook(r.deps);
    await settle();
    expect(JSON.parse(r.bridge.sent[0]!)).toMatchObject({ tool: "mcp__db__drop_table", input: '{"table":"users","cascade":true}', hold: true });
    r.bridge.hangUp();
    await done;
  });

  test("a bridge that hangs up, or none that answers, is no decision: `{}` and Codex asks the person", async () => {
    const hang = rig({ stdin: permission() });
    const done = cmdCodexHook(hang.deps);
    await settle();
    hang.bridge.hangUp();
    expect(await done).toBe(EXIT.OK);
    expect(hang.printed).toEqual(["{}"]);
    const offline = rig({ stdin: permission(), connect: false });
    await cmdCodexHook(offline.deps);
    expect(offline.printed).toEqual(["{}"]);
  });

  test("a hook that cannot be placed on a pane is never held, and still prints `{}`", async () => {
    const detached = rig({ stdin: permission(), env: {} });
    await cmdCodexHook(detached.deps);
    expect(detached.bridge.sent).toEqual([]);
    expect(detached.printed).toEqual(["{}"]);
    const daemon = rig({ stdin: permission(), procs: { 9000: { ppid: 100, startTime: 500, comm: "collie", args: ["collie"] }, 100: { ppid: 1, startTime: 300, comm: "codex", args: ["codex", "app-server"] } } });
    await cmdCodexHook({ ...daemon.deps, parentPid: 100 });
    expect(daemon.bridge.sent).toEqual([]);
    expect(daemon.printed).toEqual(["{}"]);
  });

  test("an input too long to show is an edge only: the bridge is told, nothing is held, nothing is decided", async () => {
    const r = rig({ stdin: permission({ tool_input: { command: `echo ${"x".repeat(2000)}` } }) });
    await cmdCodexHook(r.deps);
    expect(JSON.parse(r.bridge.sent[0]!)).toMatchObject({ hold: false, cut: true });
    expect(r.printed).toEqual(["{}"]);
  });

  test("the hold lasts the profile's 290 s, inside the 300 s Codex gives the hook", async () => {
    const r = rig({ stdin: permission() });
    const done = cmdCodexHook(r.deps);
    await settle();
    expect(r.timers).toContain(290_000);
    expect(loadProfiles().get("codex")!.hold!.hookTimeoutS).toBe(300);
    r.bridge.hangUp();
    await done;
  });

  test("the process being ended withdraws the hold: the bridge is told another answer won", async () => {
    const r = rig({ stdin: permission() });
    const done = cmdCodexHook(r.deps);
    await settle();
    r.stop.abort();
    await done;
    expect(r.printed).toEqual(["{}"]);
    expect(r.bridge.sent.at(-1)).toBe('{"done":"elsewhere"}\n');
    expect(r.bridge.closed()).toBe(true);
  });

  test("a record that says no hold prints `{}` and opens no socket; so does an entry with no record at all", async () => {
    const off = rig({ stdin: permission(), record: { hold: false } });
    await cmdCodexHook(off.deps);
    expect(off.bridge.sent).toEqual([]);
    expect(off.printed).toEqual(["{}"]);
    const none = rig({ stdin: permission(), record: null });
    await cmdCodexHook(none.deps);
    expect(none.printed).toEqual(["{}"]);
  });
});

describe("PermissionRequest: the broker beside Moshi", () => {
  const moshi = (): Partial<NativeRecord> => ({ moshi: { original: { command: MOSHI_ENTRY_COMMAND, type: "command" }, command: MOSHI_ENTRY_COMMAND, group: 0, handler: 0 } });

  test("Moshi is started with the unchanged payload and the recorded cancellation, next to the hold", async () => {
    const stdin = `  ${permission()}\n\n`;
    const r = rig({ stdin, record: moshi(), proven: true });
    const done = cmdCodexHook(r.deps);
    await settle();
    expect(r.provider.spawned).toEqual([{ argv: [MOSHI, "codex-hook"], payload: stdin, cancel: { method: "sigint", graceMs: 2500 } }]);
    expect(r.bridge.sent).toHaveLength(1);
    r.bridge.hangUp();
    r.provider.answer({ exitCode: 0, stdout: "{}" });
    await done;
  });

  test("Collie answers first: Moshi is withdrawn with the recorded grace, and its late deny is ignored", async () => {
    const r = rig({ stdin: permission(), record: moshi(), proven: true });
    const done = cmdCodexHook(r.deps);
    await settle();
    r.bridge.reply(JSON.stringify({ decision: "allow" }));
    await done;
    expect(r.printed).toEqual([ALLOW]);
    expect(r.provider.cancels).toEqual([2500]);
    r.provider.answer(MOSHI_DENY);
    await settle();
    expect(r.printed).toEqual([ALLOW]);
  });

  test("Moshi answers first: Collie's bridges are told another answer won, and a late tap is ignored", async () => {
    const r = rig({ stdin: permission(), record: moshi(), proven: true });
    const done = cmdCodexHook(r.deps);
    await settle();
    r.provider.answer(MOSHI_DENY);
    await done;
    expect(JSON.parse(r.printed[0]!).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "from phone" });
    expect(r.bridge.sent.at(-1)).toBe('{"done":"elsewhere"}\n');
    r.bridge.reply(JSON.stringify({ decision: "allow" }));
    await settle();
    expect(r.printed).toHaveLength(1);
  });

  test("a pane Collie cannot place is still answered by Moshi alone", async () => {
    const r = rig({ stdin: permission(), record: moshi(), proven: true, env: {} });
    const done = cmdCodexHook(r.deps);
    await settle();
    expect(r.bridge.sent).toEqual([]);
    r.provider.answer({ exitCode: 0, stdout: ALLOW });
    await done;
    expect(r.printed).toEqual([ALLOW]);
  });

  test("with no valid proof the broker is Moshi-only: Moshi runs untouched, Collie opens nothing, and nothing is printed by the broker", async () => {
    const stdin = permission();
    const unproven = rig({ stdin, record: moshi() });
    expect(await cmdCodexHook(unproven.deps)).toBe(EXIT.OK);
    expect(unproven.passed).toEqual([{ argv: [MOSHI, "codex-hook"], payload: stdin }]);
    expect(unproven.bridge.sent).toEqual([]);
    expect(unproven.provider.spawned).toEqual([]);
    expect(unproven.printed).toEqual([]);
  });

  test("a Moshi that updated after the proof is Moshi-only from that moment, with no reinstall", async () => {
    const stdin = permission();
    const r = rig({ stdin, record: moshi(), proven: true });
    r.files.write(MOSHI_REAL, "moshi 1.1.0");
    await cmdCodexHook(r.deps);
    expect(r.passed).toHaveLength(1);
    expect(r.bridge.sent).toEqual([]);
    expect(r.provider.spawned).toEqual([]);
  });
});

describe("codexHoldRequest", () => {
  const hold = loadProfiles().get("codex")!.hold!;
  const at = { kind: "attributed", pid: 7, pidStartTime: 8, markers: [{ namespace: "herdr", scope: "s", pane: "p" }], via: "parent" } as const;

  test("keeps the hook's cwd as a hint only, and drops one that is not an absolute single-line path", () => {
    expect(codexHoldRequest(payloadOf({ cwd: "relative/dir" }), at, hold, 5)?.cwd).toBeUndefined();
    expect(codexHoldRequest(payloadOf(), at, hold, 5)?.cwd).toBe("/work/proj");
  });

  test("is null for a tool name that is not printable text, and for an unattributed hook", () => {
    expect(codexHoldRequest(payloadOf({ tool_name: "Ba\u0000sh" }), at, hold, 5)).toBeNull();
    expect(codexHoldRequest(payloadOf(), { kind: "unattributed", reason: "no-markers" }, hold, 5)).toBeNull();
  });

  test("the subagent type travels only with a subagent id", () => {
    expect(codexHoldRequest(payloadOf({ agent_type: "worker" }), at, hold, 5)).not.toHaveProperty("agentType");
  });
});

// The two halves of a hold live in different processes and meet only through what this verb writes:
// the request the bridge opens a hold from, and the PostToolUse edge that closes it. They must agree.
describe("the bridge's side of a Codex hold", () => {
  const profile = loadProfiles().get("codex")!.hold!;
  const attributed = { kind: "attributed", pid: CODEX_PID, pidStartTime: CODEX_START, markers: [{ namespace: "herdr", scope: "/run/herdr.sock", pane: "w1:pA" }], via: "parent" } as const;

  function open(input: JsonObject) {
    const book = new HoldBook({ now: () => 2_000_000, salt: "s", log: () => undefined, schedule: () => () => undefined });
    const conn = { released: 0, reply: () => true, release() { this.released += 1; } };
    const request = codexHoldRequest(payloadOf({ tool_input: input }), attributed, profile, 1_000_000)!;
    book.open("w1:pA", "codex:g1", request, conn, profile);
    return { book, conn, pane: "w1:pA" };
  }

  test("with no dialog on the screen (Codex draws none while the hook waits) the hold offers Yes and No and maps them to allow and deny", () => {
    const { book, pane } = open({ command: "git push --force" });
    const ask = book.claim(pane, "codex:g1", null);
    expect(ask?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    expect(ask?.channel).toBe("hook");
    expect(profile.options.map((option) => option.decision)).toEqual(["allow", "deny"]);
  });

  test("the PostToolUse edge this verb writes ends exactly the hold of that call, and another call's edge does not", async () => {
    const { book, conn, pane } = open({ command: "git push --force" });
    book.claim(pane, "codex:g1", null);
    const other = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git status" } }) });
    await cmdCodexHook(other.deps);
    const same = rig({ stdin: JSON.stringify({ session_id: "s1", cwd: "/work", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push --force" } }) });
    await cmdCodexHook(same.deps);
    const info = (edge: EdgeRecord) => ({ tool: edge.tool ?? null, agent: edge.agent ?? null, at: 2_000_000, inputHash: edge.inputHash ?? null });
    book.edge(pane, "tool", info(other.edges()[0]!));
    expect(conn.released).toBe(0);
    book.edge(pane, "tool", info(same.edges()[0]!));
    expect(conn.released).toBe(1);
  });

  test("every native event the verb writes has a kind under the Codex profile, and the turn events end a pane's hold", () => {
    const record = (event: string): EdgeRecord => ({ schemaVersion: 1, harness: "codex", event, detail: null, pid: 1, pidStartTime: 1, markers: [], at: 1, promptHash: null });
    expect(["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd", "PostToolUse"].map((event) => kindOfEdge(record(event)))).toEqual(["start", "prompt", "stop", "stop", "end", "tool"]);
  });
});
