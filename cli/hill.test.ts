import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { decision as storedDecision } from "../bridge/hill/fixtures.ts";
import { deniedFoldersSync, HillMediaStore } from "../bridge/hill/media.ts";
import { HOST } from "../bridge/host.ts";
import { memoryHillReceipts } from "../bridge/hill/receipts.ts";
import { CREW_HILL_MEDIA_ROUTE, CREW_HILL_POST_ROUTE, HillCrewLead, HillHeldMedia, HillMemberForward, type HillLeadLink } from "../bridge/hill/crew.ts";
import { HillService, type HillServiceDeps } from "../bridge/hill/service.ts";
import { HillStore } from "../bridge/hill/store.ts";
import { HillSwitch, readHillSwitch, writeHillSwitch } from "../bridge/hill/switch.ts";
import { walkyPlace } from "../bridge/hill/walky.ts";
import type { WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { unknownOp } from "../bridge/walky/refusals.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { capture, context } from "./fakes.ts";
import {
  ASKS_SUBCOMMANDS,
  asksHelp,
  clearedWords,
  cmdAsks,
  cmdHillClear,
  cmdHillOn,
  cmdHillSwitch,
  HILL_OFF_WORDS,
  HILL_ON_WORDS,
  HILL_NOT_HERE,
  HILL_UNKNOWN,
  OLD_HILL_VERBS,
  oldHillLine,
  refusalExit,
  statusLines,
  type HillDeps,
} from "./hill.ts";
import { cmdAskCancel, cmdAskStatus, cmdWalkyAsk, cmdWalkyAsks } from "./ask.ts";
import { hillWordingWarnings, sentenceCount } from "./hill-rules.ts";
import { EXIT } from "./io.ts";
import { run } from "./program.ts";
import { realFiles } from "./sys.ts";
import { askSocket } from "./walky.ts";

import { spaceOf } from "../bridge/walky/space.ts";

/** One unnamed space on one machine: every fixture pane shares it, and no rule reads it yet. */
const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });

// `collie asks` and the socket walk against a real bridge socket in a temp state dir, as cli/walky.test.ts drives walky: the
// socket, the request lines and the answers are the real ones; only the panes and the send are fakes.
const socketTest = test.skipIf(HOST.platform === "win32");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1", "%2"] };
const inPane = (pane: string) => ({ TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: pane });

const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "working", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
];

interface Bridge {
  readonly stateDir: string;
  readonly hill: HillService;
}

/** A bridge with the hill on a real socket. `withHill: false` is a bridge built without it. POSIX only. */
async function bridge(withHill = true, extra: Partial<HillServiceDeps> = {}): Promise<Bridge> {
  const stateDir = mkdtempSync(join(tmpdir(), "hill-cli-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
  let n = 0;
  // The Hill is off until switched on (2026-11-13): this rig is a bridge whose person switched it on.
  writeHillSwitch(stateDir, true);
  const hill = new HillService({
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, null),
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => 1000,
    mintId: () => {
      n += 1;
      return `ak_cli${String(n).padStart(9, "0")}`;
    },
    mintAskId: () => {
      n += 1;
      return `ak_cli${String(n).padStart(9, "0")}`;
    },
    media: new HillMediaStore(join(stateDir, "hill"), deniedFoldersSync([stateDir])),
    // The real switch on this bridge's own state folder, so `collie hill on|off` moves it.
    hillSwitch: new HillSwitch(stateDir, null, () => undefined),
    ...extra,
  });
  const base = { socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined };
  const server = withHill ? new WalkyServer({ ...base, hill }) : new WalkyServer(base);
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { stateDir, hill };
}

/**
 * A bridge of today's release, as far as an op it does not know goes: `readWalkyRequest` refuses it
 * with `unknownOp`, and `answerUnread` answers that reason to markers that name its pane. `bare`: a
 * bridge before 2026-10-30, which answers the bare `bad request` to every line it cannot read.
 */
async function olderBridge(bare = false): Promise<{ readonly path: string; readonly lines: string[] }> {
  const stateDir = mkdtempSync(join(tmpdir(), "hill-older-"));
  const path = walkySocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      lines.push(chunk);
      const op = String(parseJsonObject(chunk)?.op ?? "");
      socket.end(`${JSON.stringify({ ok: false, error: bare ? "bad request" : unknownOp(op) })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { path, lines };
}

function deps(sockets: string[], env: Record<string, string> = inPane("%1"), over: Partial<HillDeps> = {}): HillDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  // A picture under /tmp is copied for the bridge; the fake home is not writable, so the copy goes to a folder of the test's own.
  const staging = mkdtempSync(join(tmpdir(), "hill-stage-"));
  cleanups.push(() => rmSync(staging, { recursive: true, force: true }));
  return {
    ctx: context(env, { stateDir: mkdtempSync(join(tmpdir(), "hill-own-")) }),
    stagingRoot: () => staging,
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line) => askSocket(path, line, 2000),
    sockets: () => sockets,
    mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    now: () => 1000,
    ...over,
    io,
  };
}

/** The second line of a refused ask that a retry can pass (exit 3 but not `hill_off`, and exit 5): it names the request id. */
function retryLine(id = "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f"): string {
  return `ask: send it again with --request-id ${id}`;
}

/** One ask, as `collie walky ask` sends it. */
const ASK = ["Ship the zoom fix in 1.28.1?", "--option", "yes=Ship it to Edge first", "--option", "no=Wait for 1.29.0"];

describe("clear", () => {
  /** Send three asks from pane %1, answer one and cancel one: two closed, one open. */
  async function threeAsks(b: Bridge): Promise<void> {
    const sock = [walkySocketPath(b.stateDir)];
    for (const rid of ["0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e71", "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e72", "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e73"]) {
      expect(await cmdWalkyAsk(deps(sock, inPane("%1"), { mintRequestId: () => rid }), [...ASK, "--request-id", rid])).toBe(EXIT.OK);
    }
    await b.hill.answer({ rid: "11111111-1111-4111-8111-111111111111", node: "hill/ak_cli000000001", intent: "yes", value: { text: null } }, "ak_cli000000001", "Pixel 9");
    expect(await cmdAskCancel(deps(sock), ["ak_cli000000002", "--because", "not needed"])).toBe(EXIT.OK);
  }

  socketTest("removes every closed ask, keeps the open one, and prints one line with the count", async () => {
    const b = await bridge();
    await threeAsks(b);
    const d = deps([walkySocketPath(b.stateDir)], {});
    expect(await cmdHillClear(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["Cleared 2 closed asks."]);
    expect(b.hill.list().open.map((x) => x.id)).toEqual(["ak_cli000000003"]);
    expect(b.hill.list().closed).toEqual([]);
    const again = deps([walkySocketPath(b.stateDir)], {});
    expect(await cmdHillClear(again, [])).toBe(EXIT.OK);
    expect(again.io.stdout).toEqual(["Nothing to clear: no closed asks."]);
  });

  socketTest("needs no pane: it runs from a pane too, and --json prints the count", async () => {
    const b = await bridge();
    await threeAsks(b);
    const d = deps([walkySocketPath(b.stateDir)], inPane("%2"));
    expect(await cmdHillClear(d, ["--json"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(['{"cleared":2}']);
  });

  socketTest("an older bridge first leads to the next socket; with none that knows Asks, it says so", async () => {
    const older = await olderBridge();
    const b = await bridge();
    await threeAsks(b);
    const d = deps([older.path, walkySocketPath(b.stateDir)], {});
    expect(await cmdHillClear(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["Cleared 2 closed asks."]);
    const none = deps([older.path], {});
    expect(await cmdHillClear(none, [])).toBe(EXIT.UNREACHABLE);
    expect(none.io.stderr).toEqual([`asks: ${HILL_UNKNOWN}`]);
  });

  test("the words, an unknown argument and Windows", async () => {
    expect(clearedWords(0)).toBe("Nothing to clear: no closed asks.");
    expect(clearedWords(1)).toBe("Cleared 1 closed ask.");
    expect(clearedWords(7)).toBe("Cleared 7 closed asks.");
    const d = deps([]);
    expect(await cmdHillClear(d, ["--all"])).toBe(EXIT.USAGE);
    expect(d.io.stderr[0]).toBe("error: unknown argument `--all`");
    expect(await cmdHillClear(deps([], {}, { platform: "win32" }), [])).toBe(EXIT.STATE);
  });

  test("`collie asks clear` is a verb of the program, and `collie asks --help` lists it", async () => {
    const help = capture();
    expect(await run(["asks", "--help"], help)).toBe(EXIT.OK);
    expect(help.stdout.join("\n")).toContain("clear [--spoken]");
  });
});

describe("the switch of Asks", () => {
  socketTest("off: an ask is refused with the way back on and exits STATE; status, the list and cancel keep working; on again: it asks", async () => {
    const b = await bridge();
    const sock = [walkySocketPath(b.stateDir)];
    expect(await cmdWalkyAsk(deps(sock), ASK)).toBe(EXIT.OK);
    const own = { ctx: context({}, { stateDir: b.stateDir }), now: () => 1000, followSkill: null };
    const off = { ...own, io: capture() };
    expect(cmdHillSwitch(off, "off", [])).toBe(EXIT.OK);
    expect(off.io.stdout).toEqual([HILL_OFF_WORDS]);
    expect(readHillSwitch(b.stateDir)).toEqual({ on: false, problem: null });

    const refused = deps(sock, inPane("%1"), { mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e71" });
    expect(await cmdWalkyAsk(refused, ASK)).toBe(EXIT.STATE);
    // One line: a retry cannot pass until the person switches Asks on, so no request id is offered.
    expect(refused.io.stderr).toEqual(["asks: Asks is off on this Collie; your person can switch it on in Settings, Tricks, on the phone, or with: collie asks on (hill_off)"]);
    // The open ask is still there, and its sender can read, list and cancel it while Asks is off.
    const status = deps(sock);
    expect(await cmdAskStatus(status, ["ak_cli000000001"])).toBe(EXIT.OK);
    expect(status.io.stdout[0]).toBe("ak_cli000000001 open");
    const list = deps(sock);
    expect(await cmdWalkyAsks(list, [])).toBe(EXIT.OK);
    expect(list.io.stdout.map((line) => line.split(" ")[0])).toEqual(["ak_cli000000001"]);
    const cancel = deps(sock);
    expect(await cmdAskCancel(cancel, ["ak_cli000000001", "--because", "not needed"])).toBe(EXIT.OK);
    expect(cancel.io.stdout[0]).toStartWith("ak_cli000000001 withdrawn");

    const on = { ...own, io: capture() };
    expect(cmdHillSwitch(on, "on", [])).toBe(EXIT.OK);
    expect(on.io.stdout).toEqual([HILL_ON_WORDS]);
    const again = deps(sock, inPane("%1"), { mintRequestId: () => "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e72" });
    expect(await cmdWalkyAsk(again, ASK)).toBe(EXIT.OK);
    expect(again.io.stdout[0]).toBe("ak_cli000000002");
  });

  test("a switch already in place says so and writes nothing; --json prints the value; another argument is a usage error", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hill-switch-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const own = { ctx: context({}, { stateDir }), now: () => 1000, followSkill: null };
    // No file is off (2026-11-13): "on" writes, and only the second "on" finds it in place.
    const first = { ...own, io: capture() };
    expect(cmdHillSwitch(first, "on", [])).toBe(EXIT.OK);
    expect(first.io.stdout).toEqual([HILL_ON_WORDS]);
    const already = { ...own, io: capture() };
    expect(cmdHillSwitch(already, "on", [])).toBe(EXIT.OK);
    expect(already.io.stdout).toEqual(["Asks is already on."]);
    expect(readHillSwitch(stateDir)).toEqual({ on: true, problem: null });
    const json = { ...own, io: capture() };
    expect(cmdHillSwitch(json, "off", ["--json"])).toBe(EXIT.OK);
    expect(json.io.stdout).toEqual(['{"on":false}']);
    const twice = { ...own, io: capture() };
    expect(cmdHillSwitch(twice, "off", [])).toBe(EXIT.OK);
    expect(twice.io.stdout).toEqual(["Asks is already off."]);
    const bad = { ...own, io: capture() };
    expect(cmdHillSwitch(bad, "on", ["now"])).toBe(EXIT.USAGE);
    expect(bad.io.stderr[0]).toBe("error: unknown argument `now`");
  });

  test("asks on in an agent's pane is refused with the person-only sentence and writes nothing; a shell pane writes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hill-switch-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const ctx = context({ HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/run/user/1000/herdr.sock" }, { stateDir });
    const agent = { ctx, now: () => 1000, followSkill: null, paneKind: async () => "agent" as const, io: capture() };
    expect(await cmdHillOn(agent, [])).toBe(EXIT.REFUSED);
    expect(agent.io.stderr[0]).toBe("error: collie asks on is your person's choice, and this runs in a pane where an agent works.");
    expect(readHillSwitch(stateDir).on).toBe(false);
    const shell = { ...agent, paneKind: async () => "shell" as const, io: capture() };
    expect(await cmdHillOn(shell, [])).toBe(EXIT.OK);
    expect(readHillSwitch(stateDir).on).toBe(true);
  });

  test("counsel A2: asks on fails closed in a pane the bridge does not prove a shell; a bare terminal still writes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hill-switch-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const ctx = context({ HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/run/user/1000/herdr.sock" }, { stateDir });
    const base = { ctx, now: () => 1000, followSkill: null };
    const thrown = { ...base, paneKind: async (): Promise<"agent"> => Promise.reject(new Error("socket gone")), io: capture() };
    expect(await cmdHillOn(thrown, [])).toBe(EXIT.REFUSED);
    expect(thrown.io.stderr[0]).toBe("error: collie asks on is your person's choice, and this runs in a pane where an agent works.");
    const unknown = { ...base, paneKind: async () => "unknown" as const, io: capture() };
    expect(await cmdHillOn(unknown, [])).toBe(EXIT.REFUSED);
    expect(unknown.io.stderr).toEqual(thrown.io.stderr);
    expect(readHillSwitch(stateDir).on).toBe(false);
    // No pane markers: a person's own terminal, the bridge is not asked and the verb writes.
    const bare = { ...base, ctx: context({}, { stateDir }), paneKind: async (): Promise<"agent"> => Promise.reject(new Error("never asked")), io: capture() };
    expect(await cmdHillOn(bare, [])).toBe(EXIT.OK);
    expect(readHillSwitch(stateDir).on).toBe(true);
  });

  test("the WalkyTalky skill follows a real change only, and a sync fault is one line that does not change the exit (M96 spec 12)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hill-switch-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const followed: boolean[] = [];
    const own = { ctx: context({}, { stateDir }), now: () => 1000, followSkill: (on: boolean) => void followed.push(on) };
    // No file reads off, so a first "off" is no change: it writes the file and syncs nothing.
    expect(cmdHillSwitch({ ...own, io: capture() }, "off", [])).toBe(EXIT.OK);
    expect(followed).toEqual([]);
    expect(cmdHillSwitch({ ...own, io: capture() }, "on", [])).toBe(EXIT.OK);
    expect(cmdHillSwitch({ ...own, io: capture() }, "on", [])).toBe(EXIT.OK);
    expect(cmdHillSwitch({ ...own, io: capture() }, "off", ["--json"])).toBe(EXIT.OK);
    expect(followed).toEqual([true, false]);
    const broken = { ...own, followSkill: () => { throw new Error("disk full"); }, io: capture() };
    expect(cmdHillSwitch(broken, "on", ["--json"])).toBe(EXIT.OK);
    expect(broken.io.stdout).toEqual(['{"on":true}']);
    expect(broken.io.stderr).toEqual(["asks: the WalkyTalky skill did not follow the switch: disk full"]);
    expect(readHillSwitch(stateDir)).toEqual({ on: true, problem: null });
  });

  test("`hill_off` exits STATE, apart from a post refused for its content (REFUSED)", () => {
    expect(refusalExit("hill_off")).toBe(EXIT.STATE);
    expect(refusalExit(null)).toBe(EXIT.STATE);
    expect(refusalExit("bad_title")).toBe(EXIT.REFUSED);
    expect(refusalExit("walky_off")).toBe(EXIT.REFUSED);
    // A member's lead that did not answer: a retry with the same request id may pass (CREW_PROTOCOL §22).
    expect(refusalExit("lead_unreachable")).toBe(EXIT.UNREACHABLE);
    expect(refusalExit("not_on_lead")).toBe(EXIT.REFUSED);
  });

  test("`collie asks on` and `off` are verbs of the tree", async () => {
    const help = capture();
    expect(await run(["asks", "--help"], help)).toBe(EXIT.OK);
    expect(help.stdout).toEqual(asksHelp());
    expect(help.stdout).toContain("  on");
    expect(help.stdout).toContain("  off");
  });
});

describe("an older bridge on the same machine", () => {
  socketTest("an older bridge asked first that does not know the op leads the CLI to the next socket, the pane's own", async () => {
    const older = await olderBridge();
    const bare = await olderBridge(true);
    const b = await bridge();
    const d = deps([older.path, bare.path, walkySocketPath(b.stateDir)]);
    expect(await cmdWalkyAsk(d, ASK)).toBe(EXIT.OK);
    expect(d.io.stdout[0]).toBe("ak_cli000000001");
    expect(older.lines).toHaveLength(1);
    expect(bare.lines).toHaveLength(1);
  });

  socketTest("a real bridge built without asks also leads to the next socket", async () => {
    const without = await bridge(false);
    const b = await bridge();
    const d = deps([walkySocketPath(without.stateDir), walkySocketPath(b.stateDir)]);
    expect(await cmdWalkyAsk(d, ASK)).toBe(EXIT.OK);
    expect(d.io.stdout[0]).toBe("ak_cli000000001");
  });

  socketTest("when no bridge knows asks, the CLI says so and exits non-zero", async () => {
    const older = await olderBridge();
    const bare = await olderBridge(true);
    const without = await bridge(false);
    for (const verb of [(x: HillDeps) => cmdWalkyAsk(x, ASK), (x: HillDeps) => cmdAskStatus(x, ["ak_k3m9x2p7q1ab"]), (x: HillDeps) => cmdWalkyAsks(x, [])]) {
      const d = deps([older.path, bare.path, walkySocketPath(without.stateDir)]);
      expect(await verb(d)).toBe(EXIT.UNREACHABLE);
      expect(d.io.stderr[0]).toBe(`asks: ${HILL_UNKNOWN}`);
    }
  });

  test("no bridge at all: the same words", async () => {
    const d = deps([join(tmpdir(), "no-such-dir", "walky", "sock")]);
    expect(await cmdWalkyAsk(d, ASK)).toBe(EXIT.UNREACHABLE);
    // Exit 5: a retry can pass, so the second line names the request id. The command is not echoed.
    expect(d.io.stderr).toEqual([`asks: ${HILL_UNKNOWN}`, retryLine()]);
    expect(d.io.stderr.join("\n")).not.toContain("collie walky ask");
  });

  socketTest("a bridge that knows asks but not this pane says it does not know the pane", async () => {
    const b = await bridge();
    const d = deps([walkySocketPath(b.stateDir)], inPane("%9"));
    expect(await cmdWalkyAsk(d, ASK)).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual([`asks: ${HILL_NOT_HERE}`, retryLine()]);
  });

  test("Windows has no walky socket", async () => {
    const d = deps([], inPane("%1"), { platform: "win32" });
    expect(await cmdWalkyAsk(d, ASK)).toBe(EXIT.STATE);
  });
});

describe("help, and the old `collie hill`", () => {
  test("`collie asks --help` says in one line what it is, apart from `collie walky asks`, and exits 0; a bare `collie asks` exits 2", async () => {
    const help = capture();
    expect(await run(["asks", "--help"], help)).toBe(EXIT.OK);
    expect(help.stdout[0]).toBe("usage: collie asks {clear|state|on|off} [--json]");
    expect(help.stdout[1]).toContain("collie walky asks");
    const bare = capture();
    expect(cmdAsks({ io: bare }, [])).toBe(EXIT.USAGE);
    expect(bare.stderr).toEqual(asksHelp());
    const wrong = capture();
    expect(cmdAsks({ io: wrong }, ["post"])).toBe(EXIT.USAGE);
    expect(wrong.stderr[0]).toBe("error: unknown asks command `post`");
    expect(ASKS_SUBCOMMANDS).toEqual(["clear", "state", "on", "off"]);
  });

  test("`collie walky asks --help` names the agent's own list and points to `collie asks`", async () => {
    const io = capture();
    expect(await run(["walky", "asks", "--help"], io)).toBe(EXIT.OK);
    expect(io.stdout.join("\n")).toContain("your person's verbs are `collie asks`");
  });

  test("every old `collie hill` verb fails with exit 2 and one line that names the new verb; nothing runs", async () => {
    const lines = {
      post: "collie hill post is now: collie walky ask",
      status: "collie hill status is now: collie walky status",
      withdraw: "collie hill withdraw is now: collie walky cancel",
      list: "collie hill list is now: collie walky asks",
      clear: "collie hill clear is now: collie asks clear",
      state: "collie hill state is now: collie asks state",
      on: "collie hill on is now: collie asks on",
      off: "collie hill off is now: collie asks off",
    };
    expect(Object.keys(OLD_HILL_VERBS)).toEqual(Object.keys(lines));
    for (const [verb, line] of Object.entries(lines)) {
      for (const argv of [["hill", verb], ["hill", verb, "--help"], ["hill", verb, "--title", "x"]]) {
        const io = capture();
        expect(await run(argv, io), argv.join(" ")).toBe(EXIT.USAGE);
        expect(io.stderr, argv.join(" ")).toEqual([line]);
        expect(io.stdout, argv.join(" ")).toEqual([]);
      }
    }
    const whole = "collie hill is now: collie asks (your verbs) and collie walky ask (an agent's)";
    for (const argv of [["hill"], ["hill", "--help"], ["hill", "nope"]]) {
      const io = capture();
      expect(await run(argv, io)).toBe(EXIT.USAGE);
      expect(io.stderr).toEqual([whole]);
    }
    expect(oldHillLine(undefined)).toBe(whole);
  });

  test("the usage list names `asks` and hides `hill`", async () => {
    const io = capture();
    await run(["--help"], io);
    const text = [...io.stdout, ...io.stderr].join("\n");
    expect(text).toMatch(/\basks\b/u);
    expect(text).not.toMatch(/^\s*hill\b/mu);
  });
});

describe("the wording warnings", () => {
  const GOOD = { title: "Ship 1.28.1 to Stable now?", summary: "Stable users get the fix today. CI and the browser leg are green.", options: [{ intent: "ship", label: "Ship it" }, { intent: "hold", label: "Hold until CI" }] };

  test("a card worded by the rules gets none", () => {
    expect(hillWordingWarnings(GOOD)).toEqual([]);
  });

  test("a long title, a title that asks nothing, a long summary and a bare Yes each get one sentence", () => {
    const out = hillWordingWarnings({
      title: "The five new view kinds, and what they look like on the phone",
      summary: "One. Two. Three.",
      options: [{ intent: "yes", label: "Yes" }, { intent: "no", label: " no. " }, { intent: "ok", label: "OK!" }, { intent: "later", label: "Yes, after CI" }],
    });
    expect(out).toEqual([
      "the title has 61 characters. Keep it to 60: the ask as a short question.",
      "the title asks no question. Write the ask as a question the options answer.",
      "the summary has 3 sentences. Keep it to two: what the recommended option does, then the fact that decides it.",
      'option "yes" says only "Yes". Start it with a verb that says what happens, such as "Ship it".',
      'option "no" says only "no.". Start it with a verb that says what happens, such as "Ship it".',
      'option "ok" says only "OK!". Start it with a verb that says what happens, such as "Ship it".',
    ]);
  });

  test("a summary past 200 characters is long even in two sentences; a question mark anywhere in the title counts", () => {
    const summary = `${"a".repeat(150)}. ${"b".repeat(60)}.`;
    expect(hillWordingWarnings({ ...GOOD, title: "Post reply to #712? (dry run)", summary })).toEqual(["the summary has 213 characters. Keep it under 200, and put the evidence in the view or the body."]);
  });

  test("sentences split after an end mark and white space, never inside a version or a path", () => {
    expect(sentenceCount("Ship v1.28.1 to Stable. The leg is green.")).toBe(2);
    expect(sentenceCount("It reads web/src/app.tsx and stops")).toBe(1);
    expect(sentenceCount('He said "go." Then it ran! Done?')).toBe(3);
    expect(sentenceCount("")).toBe(0);
  });

});

/**
 * A crew member's bridge on a real socket, whose forward dials a lead in this process through a link
 * that answers after `delayMs`: the slow relayed link of CREW_PROTOCOL §22.
 */
async function slowCrew(delayMs: number): Promise<{ readonly sock: string[]; readonly lead: HillService; readonly leadStore: HillStore }> {
  const stateDir = mkdtempSync(join(tmpdir(), "hill-member-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const leadStore = new HillStore(null, () => 1000);
  let n = 0;
  const lead = new HillService({
    store: leadStore,
    receipts: memoryHillReceipts(),
    place: (address) => (address.startsWith("laptop/%1") ? { address: "laptop/%1#aaaa", label: "repo#one", host: "laptop", unattended: false } : null),
    send: async () => "typed",
    crewMode: () => "lead",
    walkyOn: () => true,
    memberId: "m_lead000000",
    machine: "desk",
    now: () => 1000,
    mintId: () => {
      n += 1;
      return `ak_lead${String(n).padStart(8, "0")}`;
    },
    mintAskId: () => {
      n += 1;
      return `ak_lead${String(n).padStart(8, "0")}`;
    },
  });
  const crewLead = new HillCrewLead({ hill: lead, held: new HillHeldMedia(() => 1000) });
  const link: HillLeadLink = {
    leadName: () => "desk",
    leadOlder: () => false,
    leadAtFloor: () => true,
    call: async (route, payload) => {
      await Bun.sleep(delayMs);
      const handle = route === CREW_HILL_POST_ROUTE ? crewLead.post.bind(crewLead) : route === CREW_HILL_MEDIA_ROUTE ? crewLead.media.bind(crewLead) : crewLead.op.bind(crewLead);
      const answer = await handle(parseJsonObject(payload), "laptop");
      return { kind: "answer", status: answer.status, body: JSON.parse(JSON.stringify(answer.body)) };
    },
  };
  const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: "laptop", enabled: () => true, machine: "laptop", keyPem: () => null });
  const member = new HillService({
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, "laptop"),
    send: async () => "typed",
    crewMode: () => "peer",
    walkyOn: () => true,
    memberId: "m_laptop0000",
    machine: "laptop",
    now: () => 1000,
    forward: new HillMemberForward(link),
  });
  const server = new WalkyServer({ socketPath: walkySocketPath(stateDir), service: walky, targets: () => [target], log: () => undefined, hill: member });
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return { sock: [walkySocketPath(stateDir)], lead, leadStore };
}

describe("status of Collie's own card, from the session it tells", () => {
  const COLLIE = { kind: "collie" as const, ref: { type: "proposal" as const, id: "legs", hash: "a".repeat(64) }, label: "Collie" };
  const CARD = { requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f", title: "Switch on the trick legs?", summary: "A session on desk proposes it.", options: [{ intent: "on", label: "Switch it on" }, { intent: "later", label: "Not now" }], text: "none" as const, recommends: null, view: [{ kind: "diff" as const, text: "@@ -0,0 +1 @@\n+console.log(1);", attrs: { file: "program.ts" } }] };

  socketTest("the proposing session reads the card before and after the answer; another pane does not", async () => {
    const b = await bridge(true, { onCollieAnswer: async () => ({ ok: true }) });
    const sock = [walkySocketPath(b.stateDir)];
    const posted = b.hill.postCollie(COLLIE, CARD, { tellOf: "local/%1#aaaa" });
    expect(posted.ok).toBe(true);
    const before = deps(sock);
    expect(await cmdAskStatus(before, ["ak_cli000000001"])).toBe(EXIT.OK);
    expect(before.io.stdout).toEqual(["ak_cli000000001 open", "title: Switch on the trick legs?"]);
    // A phone that showed the card's code to its end (C-A2): a trick card's yes needs it.
    await b.hill.answer({ rid: "11111111-1111-4111-8111-111111111111", node: "hill/ak_cli000000001", intent: "on", value: { text: null }, group: { digest: COLLIE.ref.hash, opened: [1] } }, "ak_cli000000001", "Pixel 9");
    const after = deps(sock);
    expect(await cmdAskStatus(after, ["ak_cli000000001"])).toBe(EXIT.OK);
    expect(after.io.stdout).toEqual(["ak_cli000000001 answered", "title: Switch on the trick legs?", "answer: on (Switch it on)", "by: Pixel 9", "delivery: typed"]);
    // Nobody else reads it, and the proposer cannot take it back.
    const other = deps(sock, inPane("%2"));
    expect(await cmdAskStatus(other, ["ak_cli000000001"])).not.toBe(EXIT.OK);
    expect(await cmdAskCancel(deps(sock), ["ak_cli000000001"])).not.toBe(EXIT.OK);
  });

  socketTest("on a crew member, the proposing session reads its lead's card", async () => {
    const { sock, lead } = await slowCrew(0);
    expect(lead.postCollie(COLLIE, CARD, { tellOf: "laptop/%1#aaaa" }).ok).toBe(true);
    const reader = deps(sock);
    expect(await cmdAskStatus(reader, ["ak_lead00000001"])).toBe(EXIT.OK);
    expect(reader.io.stdout).toEqual(["ak_lead00000001 open", "title: Switch on the trick legs?"]);
  });
});

describe("status from the session an answer goes to", () => {
  socketTest("an old dc_ id gets one line: that ask is gone", async () => {
    const d = deps([]);
    expect(await cmdAskStatus(d, ["dc_cli000000001"])).toBe(EXIT.USAGE);
    expect(d.io.stderr).toEqual(["ask: dc_cli000000001 is an old id: that ask is gone. An ask id is ak_ and 12 characters."]);
    const c = deps([]);
    expect(await cmdAskCancel(c, ["dc_cli000000001"])).toBe(EXIT.USAGE);
    expect(c.io.stderr).toEqual(["ask: dc_cli000000001 is an old id: that ask is gone. An ask id is ak_ and 12 characters."]);
  });
});

describe("the session's name in status", () => {
  test("status names where the answer goes as the bridge served it, the session's name and its machine", () => {
    const decision = storedDecision("ak_named0000001", { target: { label: "concept hill v2", host: "lodge", unattended: false } });
    expect(statusLines(decision)).toEqual(["ak_named0000001 open", "title: Ship it?", "goes to: concept hill v2 on lodge"]);
    expect(statusLines({ ...decision, target: { label: "lead", host: null, unattended: false } })).toEqual(["ak_named0000001 open", "title: Ship it?", "goes to: lead"]);
    expect(statusLines({ ...decision, target: null })).toEqual(["ak_named0000001 open", "title: Ship it?"]);
  });
});
