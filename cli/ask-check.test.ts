import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { AskCheckBook } from "../bridge/hill/check.ts";
import { memoryHillReceipts } from "../bridge/hill/receipts.ts";
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
import { CHECK_LIMIT_MS, checkablePayload, checkReason, cmdBeaconCheck, openFor, shownQuestion, socketAsk, type BeaconCheckDeps } from "./ask-check.ts";
import { cmdAskKeep, cmdWalkyAsk } from "./ask.ts";
import { capture, context, fakeFiles } from "./fakes.ts";
import type { HillDeps } from "./hill.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import { askSocket } from "./walky.ts";
import type { JsonObject } from "../bridge/json.ts";
import { asJsonString, parseJsonObject } from "../web/src/lib/json.ts";

// `collie beacon check` (.adr/0177): every gate with a fake payload, the time limit, the one line it prints,
// and the whole round over a real bridge socket.

const MARKERS = { TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: "%1" };
const STOP = { session_id: "s1", transcript_path: "/x.jsonl", cwd: "/repo", permission_mode: "default", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done." };
const CHECK = { ok: true, check: "check", asks: [{ id: "ak_aaaaaaaaaaaa", title: "Ship the retry fix before the migration?", at: 0 }] };
const BIN = "/home/someone/.local/bin/collie";

interface Fake {
  deps: BeaconCheckDeps;
  printed: string[];
  asked: string[];
}

function fake(over: { payload?: string; env?: Record<string, string>; answers?: Record<string, string | null | "hang">; sockets?: string[]; fire?: boolean } = {}): Fake {
  const printed: string[] = [];
  const asked: string[] = [];
  const answers = over.answers ?? { "/s/one": JSON.stringify(CHECK) };
  const deps: BeaconCheckDeps = {
    ctx: context(over.env ?? MARKERS),
    files: fakeFiles({}),
    readStdin: async () => over.payload ?? JSON.stringify(STOP),
    sockets: () => over.sockets ?? Object.keys(answers),
    ask: (path, line) => {
      asked.push(`${path} ${line}`);
      const answer = answers[path];
      return answer === "hang" ? new Promise(() => undefined) : Promise.resolve(answer ?? null);
    },
    print: async (text) => void printed.push(text),
    binary: () => BIN,
    now: () => 3 * 86_400_000,
    // The time limit fires at once only when asked to; else never.
    after: (_ms, run) => {
      if (over.fire === true) queueMicrotask(run);
      return () => undefined;
    },
  };
  // The fake files say every socket is safe: a socket in two private folders.
  const files = fakeFiles({});
  files.entryTypes.set("/", "directory");
  files.entryTypes.set("/s", "directory");
  for (const path of over.sockets ?? Object.keys(answers)) files.entryTypes.set(path, "other");
  return { deps: { ...deps, files, uid: undefined }, printed, asked };
}

async function silent(f: Fake): Promise<void> {
  expect(await cmdBeaconCheck(f.deps)).toBe(EXIT.OK);
  expect(f.printed).toEqual([]);
}

describe("the gates, each silent with exit 0", () => {
  test("a stop hook already continued this stop: no bridge is asked", async () => {
    for (const value of [true, "true", 1, null]) {
      const f = fake({ payload: JSON.stringify({ ...STOP, stop_hook_active: value }) });
      await silent(f);
      expect(f.asked).toEqual([]);
    }
  });

  test("a subagent's or a teammate's stop, and any other event", async () => {
    for (const payload of [{ ...STOP, agent_id: "def456" }, { ...STOP, hook_event_name: "SubagentStop", agent_id: "def456", agent_type: "Explore" }, { ...STOP, hook_event_name: "UserPromptSubmit" }]) {
      const f = fake({ payload: JSON.stringify(payload) });
      await silent(f);
      expect(f.asked).toEqual([]);
    }
    expect(checkablePayload(STOP)).toBe(true);
    expect(checkablePayload({ ...STOP, stop_hook_active: undefined })).toBe(true);
  });

  test("a payload that is not JSON, or not an object", async () => {
    for (const payload of ["", "not json", "[1,2]", "null", '{"hook_event_name":'] ) await silent(fake({ payload }));
  });

  test("no multiplexer markers", async () => {
    const f = fake({ env: {} });
    await silent(f);
    expect(f.asked).toEqual([]);
  });

  test("no bridge answers, a bad answer, a refusal, or a none", async () => {
    await silent(fake({ answers: { "/s/one": null } }));
    await silent(fake({ answers: { "/s/one": "garbage" } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: false, error: "bad request: unknown op ask.check" }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, check: "none" }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, check: "check", asks: [] }) } }));
    await silent(fake({ answers: { "/s/one": JSON.stringify({ ok: true, check: "check", asks: [{ id: "../../x", title: "x", at: 0 }] }) } }));
    await silent(fake({ sockets: [] }));
  });

  test("the time limit: a bridge that never answers ends in silence", async () => {
    await silent(fake({ answers: { "/s/one": "hang" }, fire: true }));
  });

  test("the real time limit is below the hook timeout the install writes (10 s)", async () => {
    expect(CHECK_LIMIT_MS).toBeLessThan(10_000);
    const f = fake({ answers: { "/s/one": "hang" } });
    const started = Date.now();
    const real = { ...f.deps, after: undefined };
    expect(await cmdBeaconCheck(real)).toBe(EXIT.OK);
    expect(Date.now() - started).toBeLessThan(CHECK_LIMIT_MS + 1000);
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
  });
});

describe("what it prints", () => {
  test("exactly one line: the block JSON, with the reason", async () => {
    const f = fake();
    expect(await cmdBeaconCheck(f.deps)).toBe(EXIT.OK);
    expect(f.printed).toHaveLength(1);
    expect(f.printed[0]).not.toContain("\n");
    const out = JSON.parse(f.printed[0]!);
    expect(Object.keys(out)).toEqual(["decision", "reason"]);
    expect(out.decision).toBe("block");
    expect(out.reason).toBe(
      [
        "Collie: you have 1 open ask. Check each one now.",
        '  ak_aaaaaaaaaaaa  "Ship the retry fix before the migration?"  open 3 days',
        "For each ask do one thing:",
        `  still true            ${BIN} walky keep <id>`,
        `  changed               ${BIN} walky ask "..." --replaces <id> ...`,
        `  no longer true        ${BIN} walky cancel <id>`,
        `  answered in this session   ${BIN} walky cancel <id> --answered`,
        "Did your reply or your notes leave a question to your operator? Send it as an ask.",
        "Then stop. Write no other text.",
      ].join("\n"),
    );
  });

  test("a bridge that does not hold the pane sends it to the next", async () => {
    const f = fake({ answers: { "/s/one": JSON.stringify({ ok: false, error: "not here", hill: true }), "/s/two": JSON.stringify(CHECK) } });
    expect(await cmdBeaconCheck(f.deps)).toBe(EXIT.OK);
    expect(f.printed).toHaveLength(1);
    expect(f.asked.map((line) => line.split(" ")[0])).toEqual(["/s/one", "/s/two"]);
    expect(JSON.parse(f.asked[0]!.slice("/s/one ".length))).toEqual({ v: 1, markers: [{ namespace: "tmux", pane: "%1", scope: "/tmp/tmux-1/default" }], op: "ask.check" });
  });

  test("a bridge that does not know the op, or answers none, sends it to the next (several releases on one machine)", async () => {
    const check = JSON.stringify(CHECK);
    const first: Array<[string, string]> = [
      ["a bare refusal of an older bridge", JSON.stringify({ ok: false, error: "bad request" })],
      ["the unknown-op sentence", JSON.stringify({ ok: false, error: unknownOp("ask.check") })],
      ["none: no asks here, or the switch is off", JSON.stringify({ ok: true, check: "none" })],
    ];
    for (const [, answer] of first) {
      const f = fake({ answers: { "/s/one": answer, "/s/two": check } });
      expect(await cmdBeaconCheck(f.deps)).toBe(EXIT.OK);
      expect(f.printed).toHaveLength(1);
      expect(JSON.parse(f.printed[0]!).reason).toContain("ak_aaaaaaaaaaaa");
      expect(f.asked.map((line) => line.split(" ")[0])).toEqual(["/s/one", "/s/two"]);
    }
  });

  test("a malformed check list goes on, and a second bridge's none ends in silence", async () => {
    const bad = JSON.stringify({ ok: true, check: "check", asks: [{ id: "../../x", title: "x", at: 0 }] });
    const f = fake({ answers: { "/s/one": bad, "/s/two": JSON.stringify({ ok: true, check: "none" }) } });
    await silent(f);
    expect(f.asked.map((line) => line.split(" ")[0])).toEqual(["/s/one", "/s/two"]);
  });

  test("every bridge answers none: silence, and every one was asked", async () => {
    const none = JSON.stringify({ ok: true, check: "none" });
    const f = fake({ answers: { "/s/one": none, "/s/two": none, "/s/three": none } });
    await silent(f);
    expect(f.asked.map((line) => line.split(" ")[0])).toEqual(["/s/one", "/s/two", "/s/three"]);
  });

  test("slow bridges that together pass the one deadline: the walk ends, silent, within the limit", async () => {
    const f = fake({ answers: { "/s/one": JSON.stringify({ ok: false, error: "bad request" }), "/s/two": JSON.stringify({ ok: true, check: "none" }), "/s/three": JSON.stringify(CHECK) } });
    let clock = 0;
    const budgets: number[] = [];
    const inner = f.deps.ask;
    const deps: BeaconCheckDeps = {
      ...f.deps,
      now: () => clock,
      ask: (path, line, ms) => {
        budgets.push(ms);
        clock += CHECK_LIMIT_MS / 2;
        return inner(path, line, ms);
      },
    };
    expect(await cmdBeaconCheck(deps)).toBe(EXIT.OK);
    expect(f.printed).toEqual([]);
    // The deadline is one for the whole verb: the second bridge got what was left, the third was never asked.
    expect(budgets).toEqual([CHECK_LIMIT_MS, CHECK_LIMIT_MS / 2]);
    expect(f.asked.map((line) => line.split(" ")[0])).toEqual(["/s/one", "/s/two"]);
    expect(clock).toBe(CHECK_LIMIT_MS);
  });

  test("the question is cleaned and cut; five asks stay under 1,200 bytes", () => {
    expect(shownQuestion('Ship\u0007 it\n\u001b[31mnow "today"?')).toBe("Ship it [31mnow 'today'?");
    expect([...shownQuestion(`${"x".repeat(120)}?`)]).toHaveLength(90);
    const five = [1, 2, 3, 4, 5].map((n) => ({ id: `ak_aaaaaaaaaaa${String(n)}`, title: `${"x".repeat(88)}?`, at: 0 }));
    expect(Buffer.byteLength(checkReason(five, BIN, 40 * 86_400_000))).toBeLessThan(1200);
    expect(checkReason([...five, ...five], BIN, 0).split("\n").filter((line) => line.startsWith("  ak_"))).toHaveLength(5);
  });

  test("the age of an ask", () => {
    expect([0, 59_000, 40 * 60_000, 3 * 3_600_000, 3 * 86_400_000].map(openFor)).toEqual(["1 min", "1 min", "40 min", "3 hours", "3 days"]);
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

async function bridge(clock: { now: number }): Promise<{ readonly socket: string; readonly hill: HillService; readonly book: AskCheckBook }> {
  const stateDir = dir("ask-check-");
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  writeHillSwitch(stateDir, true);
  let n = 0;
  const book = new AskCheckBook(() => clock.now);
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
    mintAskId: () => `ak_chck${String((n += 1)).padStart(8, "0")}`,
    hillSwitch: new HillSwitch(stateDir, null, () => undefined),
    checks: book,
  });
  const server = new WalkyServer({ socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined, hill });
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { socket: walkySocketPath(stateDir), hill, book };
}

function cliDeps(socket: string, clock: { now: number }): HillDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  let n = 0;
  return {
    ctx: context(MARKERS, { stateDir: dir("ask-check-own-") }),
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

function hookDeps(socket: string, payload: JsonObject, printed: string[], clock: { now: number } = { now: Date.now() }): BeaconCheckDeps {
  return {
    ctx: context(MARKERS, { stateDir: dir("ask-check-hook-") }),
    files: realFiles,
    uid: process.getuid?.(),
    readStdin: async () => JSON.stringify(payload),
    sockets: () => [socket],
    ask: socketAsk,
    print: async (text) => void printed.push(text),
    binary: () => BIN,
    now: () => clock.now,
  };
}

const ASK = (n: number) => [`Ship the fix on Edge first, round ${String(n)}?`, "--fact", "The fix is green.", "--words", "--request-id", `00000000-0000-4000-8000-00000000000${String(n)}`];

describe("the whole round over the socket", () => {
  socketTest("two asks, two hooks at once: one block; the same turn again: silence; keep marks it", async () => {
    const clock = { now: 1_000_000 };
    const b = await bridge(clock);
    for (const n of [1, 2]) expect(await cmdWalkyAsk(cliDeps(b.socket, clock), ASK(n))).toBe(EXIT.OK);
    clock.now += 60_000;
    b.book.edge("main", "%1", "prompt", clock.now);
    clock.now += 10_000;

    const printed: string[] = [];
    const codes = await Promise.all([cmdBeaconCheck(hookDeps(b.socket, STOP, printed, clock)), cmdBeaconCheck(hookDeps(b.socket, STOP, printed, clock))]);
    expect(codes).toEqual([EXIT.OK, EXIT.OK]);
    expect(printed).toHaveLength(1);
    const reason = asJsonString(parseJsonObject(printed[0]!)?.reason) ?? "";
    expect(reason).toContain('ak_chck00000001  "Ship the fix on Edge first, round 1?"  open 1 min');
    expect(reason).toContain("ak_chck00000002");
    expect(b.book.lifting("main", "%1")).toBe(true);

    const again: string[] = [];
    await cmdBeaconCheck(hookDeps(b.socket, STOP, again));
    await cmdBeaconCheck(hookDeps(b.socket, { ...STOP, stop_hook_active: true }, again));
    expect(again).toEqual([]);

    const keep = cliDeps(b.socket, clock);
    expect(await cmdAskKeep(keep, ["ak_chck00000001"])).toBe(EXIT.OK);
    expect(keep.io.stdout).toEqual(["ak_chck00000001 kept: Ship the fix on Edge first, round 1?"]);
    expect(b.hill.list().open.find((decision) => decision.id === "ak_chck00000001")?.ask?.confirmedAt).toBe(clock.now);

    const foreign = cliDeps(b.socket, clock);
    expect(await cmdAskKeep(foreign, ["ak_zzzzzzzzzzzz"])).not.toBe(EXIT.OK);
    expect(foreign.io.stderr[0]).toContain("ak_zzzzzzzzzzzz is not an ask of this session");
  });

  socketTest("keep refuses a bad id before it asks a bridge", async () => {
    const clock = { now: 1000 };
    const d = cliDeps("/nowhere/sock", clock);
    expect(await cmdAskKeep(d, [])).toBe(EXIT.USAGE);
    expect(await cmdAskKeep(d, ["wt_aaaaaaaaaaaa"])).toBe(EXIT.USAGE);
    expect(await cmdAskKeep(d, ["--all"])).toBe(EXIT.USAGE);
  });
});
