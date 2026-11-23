import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { memoryHillReceipts } from "../bridge/hill/receipts.ts";
import { AskRemindBook } from "../bridge/hill/remind.ts";
import { HillService } from "../bridge/hill/service.ts";
import { HillStore } from "../bridge/hill/store.ts";
import { HillSwitch, writeHillSwitch } from "../bridge/hill/switch.ts";
import { walkyPlace } from "../bridge/hill/walky.ts";
import { HOST } from "../bridge/host.ts";
import { unknownOp } from "../bridge/walky/refusals.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import type { JsonObject } from "../bridge/json.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { HILL_ASK_CLEARED } from "../web/src/lib/hill/wire.ts";
import { cmdAskCancel, cmdWalkyAsk } from "./ask.ts";
import { ASKS_LIMIT_MS, asksOfPayload, cmdBeaconAsks, fullReminder, shortReminder, shownQuestion, socketAsk, type BeaconAsksDeps } from "./beacon-asks.ts";
import { promptHashOf } from "./beacon.ts";
import { capture, context, fakeFiles } from "./fakes.ts";
import type { HillDeps } from "./hill.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import { askSocket } from "./walky.ts";

// `collie beacon asks` (.adr/0178): every gate with a fake payload, each SessionStart source, the time
// limit, the exact one line it prints, and the whole round over a real bridge socket.

const MARKERS = { TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: "%1" };
const PROMPT = { session_id: "s1", transcript_path: "/x.jsonl", cwd: "/repo", permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: "go on" };
const START = (source: string) => ({ session_id: "s1", transcript_path: "/x.jsonl", cwd: "/repo", hook_event_name: "SessionStart", source });
const LIST = { ok: true, remind: "full", asks: [{ id: "ak_aaaaaaaaaaaa", title: "Ship the retry fix before the migration?" }] };
const BIN = "/home/someone/.local/bin/collie";
const FULL_TEXT = [
  "Collie: your open asks.",
  '  ak_aaaaaaaaaaaa "Ship the retry fix before the migration?"',
  "If this message or your work settles one, close it with your next command:",
  `  ${BIN} walky cancel <id>... --answered   (or --because "<reason>", or ask --replaces <id>)`,
  "Still true: do nothing.",
].join("\n");

interface Fake {
  deps: BeaconAsksDeps;
  files: ReturnType<typeof fakeFiles>;
  printed: string[];
  asked: string[];
}

function fake(over: { payload?: string; env?: Record<string, string>; answers?: Record<string, string | null | "hang">; fire?: boolean } = {}): Fake {
  const printed: string[] = [];
  const asked: string[] = [];
  const answers = over.answers ?? { "/s/one": JSON.stringify(LIST) };
  const files = fakeFiles({});
  files.entryTypes.set("/", "directory");
  files.entryTypes.set("/s", "directory");
  for (const path of Object.keys(answers)) files.entryTypes.set(path, "other");
  const deps: BeaconAsksDeps = {
    ctx: context(over.env ?? MARKERS),
    files,
    uid: undefined,
    readStdin: async () => over.payload ?? JSON.stringify(PROMPT),
    bridges: () => Object.keys(answers).map((socket) => ({ socket, stateDir: `/state${socket}` })),
    ask: (path, line) => {
      asked.push(`${path} ${line}`);
      const answer = answers[path];
      return answer === "hang" ? new Promise(() => undefined) : Promise.resolve(answer ?? null);
    },
    print: async (text) => void printed.push(text),
    binary: () => BIN,
    now: () => 5_000_000,
    // The time limit fires at once only when asked to; else never.
    after: (_ms, run) => {
      if (over.fire === true) queueMicrotask(run);
      return () => undefined;
    },
  };
  return { deps, files, printed, asked };
}

async function silent(f: Fake): Promise<void> {
  expect(await cmdBeaconAsks(f.deps)).toBe(EXIT.OK);
  expect(f.printed).toEqual([]);
}

function lineOf(asked: string): JsonObject {
  return parseJsonObject(asked.slice(asked.indexOf(" ") + 1)) ?? {};
}

describe("the gates, each silent with exit 0", () => {
  test("a payload that is not JSON, or not an object", async () => {
    for (const payload of ["", "not json", "[1,2]", "null", '{"hook_event_name":']) {
      const f = fake({ payload });
      await silent(f);
      expect(f.asked).toEqual([]);
    }
  });

  test("an event that is neither UserPromptSubmit nor SessionStart: no bridge is asked", async () => {
    for (const event of ["Stop", "SubagentStop", "PreToolUse", "SessionEnd", "Notification", "userpromptsubmit"]) {
      const f = fake({ payload: JSON.stringify({ ...PROMPT, hook_event_name: event }) });
      await silent(f);
      expect(f.asked).toEqual([]);
    }
  });

  test("a subagent's or a teammate's payload (agent_id): no output, no bridge asked", async () => {
    for (const payload of [{ ...PROMPT, agent_id: "def456" }, { ...PROMPT, agent_id: "t1", agent_type: "teammate" }, { ...START("compact"), agent_id: "def456" }, { ...START("clear"), agent_id: "x" }]) {
      const f = fake({ payload: JSON.stringify(payload) });
      await silent(f);
      expect(f.asked).toEqual([]);
    }
    // `agent_type` alone is `claude --agent`: the main session, which is asked.
    expect(asksOfPayload({ ...PROMPT, agent_type: "reviewer" })).toEqual({ event: "UserPromptSubmit" });
  });

  test("SessionStart: startup and any unknown source ask no bridge; clear, compact, resume and fork do", async () => {
    for (const source of ["startup", "Startup", "", "clear ", "other"]) {
      const f = fake({ payload: JSON.stringify(START(source)) });
      await silent(f);
      expect(f.asked).toEqual([]);
    }
    const f = fake({ payload: JSON.stringify({ hook_event_name: "SessionStart" }) });
    await silent(f);
    expect(f.asked).toEqual([]);
    for (const source of ["clear", "compact", "resume", "fork"]) expect(asksOfPayload(START(source))).toEqual({ event: "SessionStart", source });
  });

  test("no multiplexer markers", async () => {
    const f = fake({ env: {} });
    await silent(f);
    expect(f.asked).toEqual([]);
  });

  test("no bridge lists asks: no answer, garbage, a refusal, none, a bad list, no bridge at all", async () => {
    await silent(fake({ answers: { "/s/one": null } }));
    await silent(fake({ answers: { "/s/one": "garbage" } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: false, error: "bad request" }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: false, error: unknownOp("ask.remind") }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "none" }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "full", asks: [] }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "full", asks: [{ id: "../../x", title: "x" }] }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "full", asks: [{ id: "dc_aaaaaaaaaaaa", title: "x" }] }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "loud", asks: LIST.asks }) } }));
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `ak_aaaaaaaaaaa${String(i)}`, title: "x?" }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "full", asks: six }) } }));
    await silent(fake({ answers: {} }));
  });

  test("a bridge that does not answer: the time limit ends in silence", async () => {
    await silent(fake({ answers: { "/s/one": "hang" }, fire: true }));
  });

  test("the real time limit, 1 s, ends the whole verb in silence", async () => {
    expect(ASKS_LIMIT_MS).toBe(1000);
    const f = fake({ answers: { "/s/one": "hang", "/s/two": JSON.stringify(LIST) } });
    const started = Date.now();
    expect(await cmdBeaconAsks({ ...f.deps, after: undefined, now: undefined })).toBe(EXIT.OK);
    expect(Date.now() - started).toBeLessThan(ASKS_LIMIT_MS + 500);
    expect(f.printed).toEqual([]);
  });

  test("a throw anywhere is silence and exit 0", async () => {
    const f = fake();
    f.deps.readStdin = () => Promise.reject(new Error("stdin"));
    await silent(f);
    const g = fake();
    g.deps.binary = () => {
      throw new Error("boom");
    };
    await silent(g);
    const h = fake();
    h.deps.print = () => Promise.reject(new Error("closed"));
    expect(await cmdBeaconAsks(h.deps)).toBe(EXIT.OK);
  });
});

describe("what it prints", () => {
  test("UserPromptSubmit: exactly one line, the JSON with hookSpecificOutput and nothing else", async () => {
    const f = fake();
    expect(await cmdBeaconAsks(f.deps)).toBe(EXIT.OK);
    expect(f.printed).toHaveLength(1);
    expect(f.printed[0]).not.toContain("\n");
    expect(f.printed[0]).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: FULL_TEXT } }));
    const out = JSON.parse(f.printed[0]!);
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(f.printed[0]).not.toContain("decision");
  });

  test("SessionStart: the same, with its event name", async () => {
    const f = fake({ payload: JSON.stringify(START("compact")) });
    expect(await cmdBeaconAsks(f.deps)).toBe(EXIT.OK);
    expect(f.printed).toEqual([JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: FULL_TEXT } })]);
    expect(lineOf(f.asked[0]!)).toEqual({ v: 1, markers: [{ namespace: "tmux", pane: "%1", scope: "/tmp/tmux-1/default" }], op: "ask.remind", event: "start", source: "compact" });
  });

  test("the short form", async () => {
    const two = [...LIST.asks, { id: "ak_bbbbbbbbbbbb", title: "Which disk?" }];
    const f = fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "short", asks: two }) } });
    await cmdBeaconAsks(f.deps);
    expect(JSON.parse(f.printed[0]!).hookSpecificOutput.additionalContext).toBe("Collie: open asks ak_aaaaaaaaaaaa, ak_bbbbbbbbbbbb.");
    expect(shortReminder(LIST.asks)).toBe("Collie: open ask ak_aaaaaaaaaaaa.");
  });

  test("shortReminder: one id, two ids, five ids; six given, five listed", () => {
    const ask = (n: number) => ({ id: `ak_aaaaaaaaaaa${String(n)}`, title: "x?" });
    const six = [1, 2, 3, 4, 5, 6].map(ask);
    expect(shortReminder(six.slice(0, 1))).toBe("Collie: open ask ak_aaaaaaaaaaa1.");
    expect(shortReminder(six.slice(0, 2))).toBe("Collie: open asks ak_aaaaaaaaaaa1, ak_aaaaaaaaaaa2.");
    const five = "Collie: open asks ak_aaaaaaaaaaa1, ak_aaaaaaaaaaa2, ak_aaaaaaaaaaa3, ak_aaaaaaaaaaa4, ak_aaaaaaaaaaa5.";
    expect(shortReminder(six.slice(0, 5))).toBe(five);
    expect(shortReminder(six)).toBe(five);
  });

  test("the prompt goes as its hash only, salted with each bridge's own salt; never the prompt text", async () => {
    const salted = fakeFiles({ "/state/s/one/sends/.salt": "salt-one\n", "/state/s/two/sends/.salt": "salt-two\n" });
    const f = fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "none" }), "/s/two": JSON.stringify(LIST) } });
    for (const [path, type] of f.files.entryTypes) salted.entryTypes.set(path, type);
    const deps = { ...f.deps, files: salted };
    await cmdBeaconAsks(deps);
    const [one, two] = f.asked.map(lineOf);
    expect(one).toMatchObject({ op: "ask.remind", event: "prompt", at: 5_000_000, promptHash: promptHashOf(deps, "/state/s/one", PROMPT) });
    expect(two?.promptHash).toBe(promptHashOf(deps, "/state/s/two", PROMPT));
    expect(one?.promptHash).not.toBe(two?.promptHash);
    expect(f.asked.join("\n")).not.toContain("go on");
    // No salt: the hash is null, and the bridge pairs nothing with it.
    const bare = fake();
    await cmdBeaconAsks(bare.deps);
    expect(lineOf(bare.asked[0]!).promptHash).toBeNull();
  });

  test("several bridges: a refusal, not here, none and a bad list each lead to the next; the first list ends the walk", async () => {
    const f = fake({
      answers: {
        "/s/one": JSON.stringify({ ok: false, error: "not here", hill: true }),
        "/s/two": JSON.stringify({ ok: false, error: unknownOp("ask.remind") }),
        "/s/three": JSON.stringify({ ok: true, remind: "none" }),
        "/s/four": JSON.stringify(LIST),
        "/s/five": JSON.stringify(LIST),
      },
    });
    await cmdBeaconAsks(f.deps);
    expect(f.printed).toHaveLength(1);
    expect(f.asked.map((line) => line.split(" ")[0])).toEqual(["/s/one", "/s/two", "/s/three", "/s/four"]);
  });

  test("slow bridges share one deadline: the walk ends, silent, at the limit", async () => {
    const f = fake({ answers: { "/s/one": JSON.stringify({ ok: true, remind: "none" }), "/s/two": JSON.stringify({ ok: true, remind: "none" }), "/s/three": JSON.stringify(LIST) } });
    let clock = 0;
    const budgets: number[] = [];
    const inner = f.deps.ask;
    const deps: BeaconAsksDeps = {
      ...f.deps,
      now: () => clock,
      ask: (path, line, ms) => {
        budgets.push(ms);
        clock += ASKS_LIMIT_MS / 2;
        return inner(path, line, ms);
      },
    };
    expect(await cmdBeaconAsks(deps)).toBe(EXIT.OK);
    expect(f.printed).toEqual([]);
    expect(budgets).toEqual([ASKS_LIMIT_MS, ASKS_LIMIT_MS / 2]);
  });

  test("the question is cleaned and cut; five asks stay small", () => {
    expect(shownQuestion('Ship\u0007 it\n\u001b[31mnow "today"?')).toBe("Ship it [31mnow 'today'?");
    expect([...shownQuestion(`${"x".repeat(120)}?`)]).toHaveLength(60);
    const five = [1, 2, 3, 4, 5].map((n) => ({ id: `ak_aaaaaaaaaaa${String(n)}`, title: `${"x".repeat(58)}?` }));
    expect(fullReminder([...five, ...five], BIN).split("\n").filter((line) => line.startsWith("  ak_"))).toHaveLength(5);
  });

  test("shownQuestion: 60 code points stay, 61 are cut to 59 and an ellipsis", () => {
    expect(shownQuestion("x".repeat(60))).toBe("x".repeat(60));
    expect(shownQuestion("x".repeat(61))).toBe(`${"x".repeat(59)}…`);
    expect([...shownQuestion("x".repeat(61))]).toHaveLength(60);
  });

  test("shownQuestion: a cut never splits a surrogate pair or a combined emoji", () => {
    // 59 letters then an astral character at the cut: the pair is dropped whole, never half of it.
    const pair = shownQuestion(`${"x".repeat(59)}\u{1F600}${"y".repeat(5)}`);
    expect(pair).toBe(`${"x".repeat(59)}…`);
    expect(pair).not.toMatch(/[\ud800-\udfff]/u);
    // An astral character that ends exactly at 59 code points stays whole.
    const kept = shownQuestion(`${"x".repeat(58)}\u{1F600}${"y".repeat(5)}`);
    expect(kept).toBe(`${"x".repeat(58)}\u{1F600}…`);
    // A combined emoji (a family: several code points joined) is cut between code points, each one whole.
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    const cut = shownQuestion(`${"x".repeat(57)}${family}${"y".repeat(5)}`);
    expect(cut).not.toMatch(/[\ud800-\udfff]/u);
    expect([...cut]).toHaveLength(60);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("shownQuestion: control characters and quotes at the cut", () => {
    expect(shownQuestion(`${"x".repeat(56)}\n\n\u0007"q"${"y".repeat(10)}`)).toBe(`${"x".repeat(56)} 'q…`);
    expect(shownQuestion('"a"\tb\u202ec')).toBe("'a' b c");
  });

  test("fullReminder: the exact text for one ask and for five; five stay under 1,000 bytes", () => {
    expect(fullReminder(LIST.asks, BIN)).toBe(FULL_TEXT);
    const long = "x".repeat(59);
    const five = [1, 2, 3, 4, 5].map((n) => ({ id: `ak_aaaaaaaaaaa${String(n)}`, title: `${long}y?` }));
    const path = `/${"p".repeat(59)}`;
    const text = fullReminder(five, path);
    expect(text.split("\n")).toEqual([
      "Collie: your open asks.",
      ...[1, 2, 3, 4, 5].map((n) => `  ak_aaaaaaaaaaa${String(n)} "${long}…"`),
      "If this message or your work settles one, close it with your next command:",
      `  ${path} walky cancel <id>... --answered   (or --because "<reason>", or ask --replaces <id>)`,
      "Still true: do nothing.",
    ]);
    expect(Buffer.byteLength(text)).toBeLessThan(1000);
  });
});

// ── Over a real bridge socket ─────────────────────────────────────────────────────────────────────────

const socketTest = test.skipIf(HOST.platform === "win32");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

const SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1"] };
const panes: WalkyPane[] = [{ session: "main", paneId: "%1", agent: true, harness: "claude", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SPACE }];

function dir(prefix: string): string {
  const made = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

async function bridge(clock: { now: number }): Promise<{ readonly socket: string; readonly stateDir: string; readonly hill: HillService }> {
  const stateDir = dir("beacon-asks-");
  mkdirSync(join(stateDir, "sends"), { recursive: true });
  writeFileSync(join(stateDir, "sends", ".salt"), "rig-salt\n");
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  writeHillSwitch(stateDir, true);
  let n = 0;
  const hill = new HillService({
    store: new HillStore(null, () => clock.now),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, null),
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => clock.now,
    mintAskId: () => `ak_rmnd${String((n += 1)).padStart(8, "0")}`,
    hillSwitch: new HillSwitch(stateDir, null, () => undefined),
    reminders: new AskRemindBook(() => clock.now),
    paneAddress: (session, paneId) => (session === "main" && paneId === "%1" ? walky.addressOf("%1", "aaaa") : null),
  });
  const server = new WalkyServer({ socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined, hill });
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { socket: walkySocketPath(stateDir), stateDir, hill };
}

function cliDeps(socket: string, clock: { now: number }): HillDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  let n = 0;
  return {
    ctx: context(MARKERS, { stateDir: dir("beacon-asks-own-") }),
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line) => askSocket(path, line, 2000),
    sockets: () => [socket],
    mintRequestId: () => `0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e${String((n += 1)).padStart(2, "0")}`,
    now: () => clock.now,
    cwd: () => "/",
    io,
  };
}

function hookDeps(b: { readonly socket: string; readonly stateDir: string }, payload: JsonObject, printed: string[], clock: { now: number }): BeaconAsksDeps {
  return {
    ctx: context(MARKERS, { stateDir: dir("beacon-asks-hook-") }),
    files: realFiles,
    uid: process.getuid?.(),
    readStdin: async () => JSON.stringify(payload),
    bridges: () => [{ socket: b.socket, stateDir: b.stateDir }],
    ask: socketAsk,
    print: async (text) => void printed.push(text),
    binary: () => BIN,
    now: () => clock.now,
  };
}

const ASK = (n: number) => [`Ship the fix on Edge first, round ${String(n)}?`, "--option", "edge=Ship it on Edge", "--option", "stable=Ship it on Stable", "--request-id", `00000000-0000-4000-8000-00000000000${String(n)}`];

function contextOf(printed: string): string {
  return String(JSON.parse(printed).hookSpecificOutput.additionalContext);
}

describe("the whole round over the socket", () => {
  socketTest("two asks: the prompt lists both, its stop carries them, the next prompt is short, compact is full, clear closes", async () => {
    const clock = { now: 1_000_000 };
    const b = await bridge(clock);
    for (const n of [1, 2]) expect(await cmdWalkyAsk(cliDeps(b.socket, clock), ASK(n))).toBe(EXIT.OK);
    clock.now += 60_000;

    const printed: string[] = [];
    expect(await cmdBeaconAsks(hookDeps(b, PROMPT, printed, clock))).toBe(EXIT.OK);
    expect(printed).toHaveLength(1);
    expect(contextOf(printed[0]!)).toContain('ak_rmnd00000001 "Ship the fix on Edge first, round 1?"');
    expect(contextOf(printed[0]!)).toContain("ak_rmnd00000002");
    // The emitter's edges for that prompt and its stop, with the same salted hash.
    const hash = promptHashOf({ files: realFiles }, b.stateDir, PROMPT);
    b.hill.askEdge({ session: "main", paneId: "%1" }, "prompt", clock.now, hash);
    b.hill.askEdge({ session: "main", paneId: "%1" }, "stop", clock.now + 3000, null);
    for (const ask of b.hill.list().open) expect(ask.ask).toMatchObject({ mark: "carried", confirmedAt: clock.now + 3000 });

    clock.now += 10_000;
    const second: string[] = [];
    await cmdBeaconAsks(hookDeps(b, { ...PROMPT, prompt: "and then?" }, second, clock));
    expect(contextOf(second[0]!)).toBe("Collie: open asks ak_rmnd00000001, ak_rmnd00000002.");

    const compact: string[] = [];
    await cmdBeaconAsks(hookDeps(b, START("compact"), compact, clock));
    expect(contextOf(compact[0]!)).toContain("Collie: your open asks.");

    const cleared: string[] = [];
    await cmdBeaconAsks(hookDeps(b, START("clear"), cleared, clock));
    expect(cleared).toEqual([]);
    expect(b.hill.list().open).toEqual([]);
    for (const id of ["ak_rmnd00000001", "ak_rmnd00000002"]) expect(b.hill.list().closed.find((decision) => decision.id === id)).toMatchObject({ state: "withdrawn", closedReason: HILL_ASK_CLEARED });
  });

  socketTest("a closed ask: two asks, full; one is taken back; the next prompt is short with the one id", async () => {
    const clock = { now: 1_000_000 };
    const b = await bridge(clock);
    for (const n of [1, 2]) expect(await cmdWalkyAsk(cliDeps(b.socket, clock), ASK(n))).toBe(EXIT.OK);
    clock.now += 60_000;
    const first: string[] = [];
    await cmdBeaconAsks(hookDeps(b, PROMPT, first, clock));
    expect(contextOf(first[0]!)).toContain("Collie: your open asks.");
    expect(await cmdAskCancel(cliDeps(b.socket, clock), ["ak_rmnd00000002", "--answered"])).toBe(EXIT.OK);
    clock.now += 10_000;
    const second: string[] = [];
    await cmdBeaconAsks(hookDeps(b, { ...PROMPT, prompt: "next" }, second, clock));
    expect(contextOf(second[0]!)).toBe("Collie: open ask ak_rmnd00000001.");
  });

  socketTest("a stopped bridge: silent, exit 0, within the limit", async () => {
    const gone = dir("beacon-asks-gone-");
    const printed: string[] = [];
    const started = Date.now();
    expect(await cmdBeaconAsks(hookDeps({ socket: walkySocketPath(gone), stateDir: gone }, PROMPT, printed, { now: Date.now() }))).toBe(EXIT.OK);
    expect(printed).toEqual([]);
    expect(Date.now() - started).toBeLessThan(ASKS_LIMIT_MS);
  });
});
