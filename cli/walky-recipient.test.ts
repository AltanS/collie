import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { HOST } from "../bridge/host.ts";
import type { JsonObject } from "../bridge/json.ts";
import type { SendResult, WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { spaceOf } from "../bridge/walky/space.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { UNANSWERED_WINDOW_MS } from "../bridge/walky/types.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import { askSocket, cmdWalkyReply, cmdWalkySend, recipientLine, type WalkyDeps } from "./walky.ts";

// The two lines `collie walky send` prints after the pane line and at the end: `to: <NAME> · <SPACE> · <MACHINE>`
// and `note: <id> from <NAME> is not answered. ...` (the pick tests of 2026-11-23). Names are made up.

const POSIX_ONLY = HOST.platform === "win32";
const socketTest = test.skipIf(POSIX_ONLY);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

const ORCHID = spaceOf({ memberId: "local", spaceId: "s1", spaceLabel: "orchid", spaceNamed: true });
const UNNAMED = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const START = 1_700_000_000_000;
const MINUTE = 60_000;

const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1", "%2", "%3"] };
const inPane = (pane: string) => ({ TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: pane });

function fakePane(paneId: string, instance: string, over: Partial<WalkyPane> = {}): WalkyPane {
  return { session: "main", paneId, agent: true, harness: "agent-x", label: `repo#${paneId.slice(1)}`, state: "idle", activeAt: null, instance, terminal: true, off: false, space: ORCHID, ...over };
}

interface Bridge {
  readonly stateDir: string;
  clock: number;
}

/** A real bridge socket over three fake panes: %1 asks, %2 is named, %3 has a name of its own. A fake clock. */
async function bridge(): Promise<Bridge> {
  const stateDir = mkdtempSync(join(tmpdir(), "walky-recipient-cli-"));
  const state: Bridge = { stateDir, clock: START };
  const panes = [fakePane("%1", "aaaa"), fakePane("%2", "bbbb", { name: "tern review", nameBy: "collie" }), fakePane("%3", "cccc", { name: "api docs", nameBy: "tab" })];
  const host: WalkyHost = { panes: () => panes, send: async (): Promise<SendResult> => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const service = new WalkyService({ log: new WalkyLog(join(stateDir, "walky"), () => state.clock), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null, now: () => state.clock });
  const server = new WalkyServer({ socketPath: walkySocketPath(stateDir), service, targets: () => [target], log: () => undefined });
  expect(await server.start()).toBe(true);
  cleanups.push(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return state;
}

/** A bridge that answers every send with a fixed JSON object, as an older or a newer bridge would. A real socket. */
async function fixedBridge(answer: JsonObject): Promise<string> {
  const stateDir = mkdtempSync(join(tmpdir(), "walky-fixed-"));
  const path = walkySocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      const request = parseJsonObject(chunk) ?? {};
      socket.end(`${JSON.stringify(request.op === "send" ? answer : { ok: true, receipts: [], message: null, elsewhere: [] })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return stateDir;
}

function deps(stateDir: string, env: Record<string, string>, ids: string[], over: Partial<WalkyDeps> = {}): WalkyDeps & { readonly io: ReturnType<typeof capture> } {
  const io = capture();
  return {
    ctx: context(env, { stateDir }),
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line) => askSocket(path, line, 2000),
    sockets: () => [walkySocketPath(stateDir)],
    mintId: () => ids.shift() ?? "wt_zzzzzzzzzzzz",
    sleep: async () => undefined,
    ...over,
    io,
  };
}

const accepted = (id: string, to: string) => ({ id, target: to, state: "delivered", verified: "local", at: START, by: "solo" });

describe("the `to:` line", () => {
  socketTest("names the NAME, SPACE and MACHINE of the pane the bridge resolved, after the pane line", async () => {
    const b = await bridge();
    const d = deps(b.stateDir, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to local/%2#bbbb, agent-x, repo#2", "to: tern review · orchid · desk", "typed into the pane"]);
  });

  socketTest("a pane with no NAME prints `-`", async () => {
    const b = await bridge();
    // %1 has no name: %3 sends to it, and the line says `-`.
    const d = deps(b.stateDir, inPane("%3"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(d, ["local/%1", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout[2]).toBe("to: - · orchid · desk");
  });

  socketTest("is absent for `here` and for `reply`", async () => {
    const b = await bridge();
    const here = deps(b.stateDir, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(here, ["here", "hello"])).toBe(EXIT.OK);
    expect(here.io.stdout.some((line) => line.startsWith("to:"))).toBe(false);
    const first = deps(b.stateDir, inPane("%2"), ["wt_bbbbbbbbbbbb"]);
    expect(await cmdWalkySend(first, ["local/%1", "question"])).toBe(EXIT.OK);
    const reply = deps(b.stateDir, inPane("%1"), ["wt_aaaaaaaaaaa2"]);
    expect(await cmdWalkyReply(reply, ["wt_bbbbbbbbbbbb", "answer"])).toBe(EXIT.OK);
    expect(reply.io.stdout.some((line) => line.startsWith("to:"))).toBe(false);
    expect(reply.io.stdout.some((line) => line.startsWith("note:"))).toBe(false);
  });

  socketTest("the line of a space with no name of its own says it is this machine's", async () => {
    const stateDir = await fixedBridge({ ok: true, receipts: [accepted("wt_aaaaaaaaaaa1", "local/%2")], recipient: { name: "tern review", space: { key: "local\u0000w1", named: false, label: "w1" }, machine: "far-desk" } });
    const d = deps(stateDir, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to local/%2", "to: tern review · w1 (this machine) · far-desk", "typed into the pane"]);
  });

  socketTest("an older bridge's answer, with neither field, prints the old output unchanged", async () => {
    const stateDir = await fixedBridge({ ok: true, receipts: [accepted("wt_aaaaaaaaaaa1", "local/%2")] });
    const d = deps(stateDir, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to local/%2", "typed into the pane"]);
  });

  socketTest("a field that is not well formed prints nothing, never half a line", async () => {
    for (const recipient of [{ name: "tern review", machine: "desk" }, { space: { key: "orchid", named: true, label: "orchid" } }, { space: "orchid", machine: "desk" }, "tern review", 7]) {
      const stateDir = await fixedBridge({ ok: true, receipts: [accepted("wt_aaaaaaaaaaa1", "local/%2")], recipient, unanswered: { id: "not an id", from: "x" } });
      const d = deps(stateDir, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
      expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
      expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to local/%2", "typed into the pane"]);
    }
  });

  test("control characters in a name never reach the terminal", () => {
    expect(recipientLine({ name: "tern\u001b[31m review", space: ORCHID, machine: "desk" })).toBe("to: tern?[31m review · orchid · desk");
    expect(recipientLine({ space: UNNAMED, machine: "desk" })).toBe("to: - · w1 (this machine) · desk");
  });

  socketTest("`--json` carries the recipient and the notice only when the bridge named them", async () => {
    const note = { id: "wt_cccccccccccc", from: "api docs" };
    const named = await fixedBridge({ ok: true, receipts: [accepted("wt_aaaaaaaaaaa1", "local/%2")], recipient: { name: "tern review", space: { key: "orchid", named: true, label: "orchid" }, machine: "desk" }, unanswered: note });
    const d = deps(named, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(d, ["local/%2", "--json", "hi"])).toBe(EXIT.OK);
    expect(parseJsonObject(d.io.stdout[0]!)).toMatchObject({ id: "wt_aaaaaaaaaaa1", recipient: { name: "tern review", machine: "desk" }, unanswered: note });
    const older = await fixedBridge({ ok: true, receipts: [accepted("wt_aaaaaaaaaaa1", "local/%2")] });
    const o = deps(older, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(o, ["local/%2", "--json", "hi"])).toBe(EXIT.OK);
    expect(Object.keys(parseJsonObject(o.io.stdout[0]!) ?? {}).toSorted()).toEqual(["id", "receipts"]);
  });
});

describe("the `note:` line", () => {
  socketTest("names a message from another session that waits for a `reply`, last, with the command that answers it", async () => {
    const b = await bridge();
    const c = deps(b.stateDir, inPane("%3"), ["wt_cccccccccccc"]);
    expect(await cmdWalkySend(c, ["local/%1", "question"])).toBe(EXIT.OK);
    b.clock += 2 * MINUTE;
    const d = deps(b.stateDir, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(d, ["local/%2", "something else"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "wt_aaaaaaaaaaa1",
      "to local/%2#bbbb, agent-x, repo#2",
      "to: tern review · orchid · desk",
      "typed into the pane",
      'note: wt_cccccccccccc from api docs is not answered. To answer it: collie walky reply wt_cccccccccccc "<text>"',
    ]);
  });

  socketTest("is absent when the recipient is that message's sender, after a `reply` to it, and after 10 minutes", async () => {
    const b = await bridge();
    await cmdWalkySend(deps(b.stateDir, inPane("%3"), ["wt_cccccccccccc"]), ["local/%1", "question"]);
    const toSender = deps(b.stateDir, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(toSender, ["local/%3", "to the sender"])).toBe(EXIT.OK);
    expect(toSender.io.stdout.some((line) => line.startsWith("note:"))).toBe(false);
    const reply = deps(b.stateDir, inPane("%1"), ["wt_aaaaaaaaaaa2"]);
    expect(await cmdWalkyReply(reply, ["wt_cccccccccccc", "answer"])).toBe(EXIT.OK);
    const after = deps(b.stateDir, inPane("%1"), ["wt_aaaaaaaaaaa3"]);
    expect(await cmdWalkySend(after, ["local/%2", "next"])).toBe(EXIT.OK);
    expect(after.io.stdout.some((line) => line.startsWith("note:"))).toBe(false);
    // A second message waits; past the window it is not named.
    await cmdWalkySend(deps(b.stateDir, inPane("%3"), ["wt_dddddddddddd"]), ["local/%1", "again"]);
    b.clock += UNANSWERED_WINDOW_MS + 1;
    const late = deps(b.stateDir, inPane("%1"), ["wt_aaaaaaaaaaa4"]);
    expect(await cmdWalkySend(late, ["local/%2", "later"])).toBe(EXIT.OK);
    expect(late.io.stdout.some((line) => line.startsWith("note:"))).toBe(false);
  });

  socketTest("prints a name with control characters as `?`, and an answer with no notice prints none", async () => {
    const stateDir = await fixedBridge({ ok: true, receipts: [accepted("wt_aaaaaaaaaaa1", "local/%2")], unanswered: { id: "wt_cccccccccccc", from: "api\u001b[2J docs" } });
    const d = deps(stateDir, inPane("%1"), ["wt_aaaaaaaaaaa1"]);
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout.at(-1)).toBe('note: wt_cccccccccccc from api?[2J docs is not answered. To answer it: collie walky reply wt_cccccccccccc "<text>"');
  });
});
