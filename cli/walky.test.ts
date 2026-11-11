import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import { HOST } from "../bridge/host.ts";
import type { SendResult, WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { WalkyOff } from "../bridge/walky/off.ts";
import { unknownOp, UNREAD_BY_OLDER_BRIDGE } from "../bridge/walky/refusals.ts";
import { SENDER_OFF, WALKY_OFF } from "../bridge/walky/types.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import {
  askPaneKind,
  askPanePlace,
  askSocket,
  cmdWalky,
  cmdWalkyCancel,
  cmdWalkyInbox,
  cmdWalkyOff,
  cmdWalkyOn,
  cmdWalkyReply,
  cmdWalkySend,
  cmdWalkyStatus,
  cmdWalkyWho,
  NO_SOCKET_TEXT,
  OFF_WORDS,
  OLDER_BRIDGE_SWITCH,
  ON_WORDS,
  OUTSIDE_NEEDS_A_PANE,
  OUTSIDE_SPACE_WORDS,
  outsideLine,
  SENDER_OFF_WORDS,
  WALKY_OFF_WORDS,
  YOU_ARE_OFF_WORDS,
  parseSendArgs,
  receiptLine,
  shown,
  stateWords,
  verifiedWords,
  type WalkyDeps,
} from "./walky.ts";

import { spaceOf } from "../bridge/walky/space.ts";

/** One named space: every fixture pane shares it, as the panes of one tmux session or Herdr workspace do. */
const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "work", spaceNamed: true });

// The CLI against a real bridge socket in a temp state dir: the socket, the request lines and the
// answers are the real ones, and only the panes and the Send Protocol are fakes.
//
// Windows has no walky socket, so a test that talks to the real one is POSIX only (`socketTest`). A test
// that never reaches the socket, a usage error, no bridge at all, the Windows answer, runs on both: it
// takes a `scratch()`, a state dir with no server in it.
const POSIX_ONLY = HOST.platform === "win32";
const socketTest = test.skipIf(POSIX_ONLY);

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

interface Bridge {
  readonly stateDir: string;
  readonly sent: string[];
  answer: SendResult;
  service?: WalkyService;
}

/** A state dir and a service over fake panes, with no socket server. Nothing listens on this machine. */
function scratch(over: Partial<ConstructorParameters<typeof WalkyService>[0]> = {}): Bridge {
  const stateDir = mkdtempSync(join(tmpdir(), "walky-cli-"));
  const panes: WalkyPane[] = [
    { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
    { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "working", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
  ];
  const state: Bridge = { stateDir, sent: [], answer: { outcome: "sent" } };
  const host: WalkyHost = {
    panes: () => panes,
    send: async (_pane, _id, text) => {
      state.sent.push(text);
      return state.answer;
    },
    sendState: () => state.answer,
    cancelHeld: () => undefined,
  };
  const service = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null, ...over });
  state.service = service;
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  return state;
}

/** `scratch()` with a real server on the walky socket. POSIX only: Windows cannot bind it. */
async function bridge(over: Partial<ConstructorParameters<typeof WalkyService>[0]> = {}): Promise<Bridge> {
  const state = scratch(over);
  const { stateDir, service } = state;
  if (service === undefined) throw new Error("scratch() builds a service");
  const server = new WalkyServer({ socketPath: walkySocketPath(stateDir), service, targets: () => [target], log: () => undefined });
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.stop());
  return state;
}

/**
 * A bridge before 2026-10-30, as far as a request it cannot read goes: it answers the bare
 * `bad request` to every line, before it looks at the markers. A real socket in a private dir, so the
 * CLI's socket checks pass. POSIX only.
 */
async function olderBridge(): Promise<{ readonly path: string; readonly lines: string[] }> {
  const stateDir = mkdtempSync(join(tmpdir(), "walky-older-"));
  const path = walkySocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      lines.push(chunk);
      socket.end(`${JSON.stringify({ ok: false, error: "bad request" })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { path, lines };
}

/** A bridge that answers every line with one refusal, as far as the CLI sees it. A real socket in a private dir. POSIX only. */
async function refusingBridge(error: string): Promise<{ readonly path: string; readonly lines: string[] }> {
  const stateDir = mkdtempSync(join(tmpdir(), "walky-refusing-"));
  const path = walkySocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      lines.push(chunk);
      socket.end(`${JSON.stringify({ ok: false, error })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { path, lines };
}

/**
 * A bridge that knows the pane and holds no message with the id, as far as the CLI sees it (2026-10-30):
 * a build before that day answers inbox with the error `no message <id> for this pane`, and status with
 * an ok answer that holds no message and no receipt. A real socket in a private dir. POSIX only.
 */
async function emptyBridge(): Promise<{ readonly path: string; readonly lines: string[] }> {
  const stateDir = mkdtempSync(join(tmpdir(), "walky-empty-"));
  const path = walkySocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      lines.push(chunk);
      const request = parseJsonObject(chunk) ?? {};
      const answer = request.op === "inbox" ? { ok: false, error: `no message ${String(request.id)} for this pane` } : { ok: true, receipts: [], message: null, elsewhere: [] };
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { path, lines };
}

type Captured = ReturnType<typeof capture>;

function deps(b: Bridge, env: Record<string, string> = {}, over: Partial<WalkyDeps> = {}): WalkyDeps & { readonly io: Captured } {
  const io = capture();
  return {
    ctx: context(env, { stateDir: b.stateDir }),
    files: realFiles,
    uid: process.getuid?.(),
    platform: "linux",
    readStdin: async () => "",
    stdinIsTty: true,
    ask: (path, line) => askSocket(path, line, 2000),
    sockets: () => [walkySocketPath(b.stateDir)],
    mintId: () => "wt_aaaaaaaaaaa1",
    sleep: async () => undefined,
    ...over,
    io,
  };
}

describe("send", () => {
  socketTest("positional: the address, then the text; it waits for the receipt and prints the id, the pane and the state in words", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkySend(d, ["local/%2", "Tests", "are", "green."])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to local/%2#bbbb, agent-y, repo#two", "typed into the pane"]);
    // An agent's message types one nudge line; the body waits for `inbox <id>`.
    expect(b.sent).toEqual(["[walky-talky wt_aaaaaaaaaaa1] from agent local/%1#aaaa (agent-x, repo#one): a message from another agent, not your operator. Read it: collie walky inbox wt_aaaaaaaaaaa1. Reply: collie walky reply wt_aaaaaaaaaaa1 \"<text>\""]);
  });

  socketTest("`--to` is an alias, `--` keeps a text that starts with a dash, and an address may carry the token `who` prints", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkySend(d, ["--to", "local/%2#bbbb", "--", "--not-a-flag"])).toBe(EXIT.OK);
    expect(b.service?.status("wt_aaaaaaaaaaa1").message).toMatchObject({ to: "local/%2#bbbb", body: "--not-a-flag" });
    // The token of a pane that closed and gave its id away: refused, and the status line names the pane id.
    const stale = deps(b, inPane("%1"), { mintId: () => "wt_aaaaaaaaaaa2" });
    expect(await cmdWalkySend(stale, ["local/%2#k3f9", "late"])).toBe(EXIT.REFUSED);
    expect(stale.io.stdout).toEqual(["wt_aaaaaaaaaaa2", "to local/%2#k3f9", "not sent: pane replaced"]);
  });

  socketTest("no text reads the body from stdin", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"), { stdinIsTty: false, readStdin: async () => "line one\nline two\n" });
    expect(await cmdWalkySend(d, ["local/%2"])).toBe(EXIT.OK);
    expect(b.service?.status("wt_aaaaaaaaaaa1").message?.body).toBe("line one\nline two");
  });

  socketTest("outside any pane a send is refused: the operator sends from the phone", async () => {
    const b = await bridge();
    const d = deps(b);
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual(["walky talky: run this inside a pane, or send from the phone"]);
    expect(b.sent).toEqual([]);
  });

  socketTest("a refusal prints its reason and exits REFUSED", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkySend(d, ["local/%9", "hi"])).toBe(EXIT.REFUSED);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to local/%9", "not sent: no such pane"]);
  });

  socketTest("a pane that cannot take it now leaves the message in the inbox", async () => {
    const b = await bridge();
    b.answer = { outcome: "refused", reason: "not_free" };
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "wt_aaaaaaaaaaa1",
      "to local/%2#bbbb, agent-y, repo#two",
      "waiting in the inbox, not typed: box not free",
      "check later: collie walky status wt_aaaaaaaaaaa1",
    ]);
  });

  socketTest("a held send (M62 spec 02) prints `held: <reason>` and when it will be typed, in `send` and in `status`", async () => {
    // The bridge's watch of the hold never wakes here: the receipt stays where the hold put it.
    const b = await bridge({ sleep: () => new Promise<void>(() => undefined) });
    b.answer = { outcome: "held", reason: "draft_present" };
    let at = 0;
    const d = deps(b, inPane("%1"), {
      now: () => at,
      sleep: async (ms: number) => {
        at += ms;
      },
    });
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "wt_aaaaaaaaaaa1",
      "to local/%2#bbbb, agent-y, repo#two",
      "held: draft present",
      "typed when the box clears or the turn ends, up to 60 minutes. Do not send it again.",
      "check later: collie walky status wt_aaaaaaaaaaa1",
    ]);
    const status = deps(b);
    expect(await cmdWalkyStatus(status, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(status.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "local/%2: held: draft present (this machine)", "typed when the box clears or the turn ends, up to 60 minutes. Do not send it again."]);
  });

  socketTest("cancel (M62 spec 03): the sender takes a held message back; another pane is refused; a typed one is left alone", async () => {
    const states = new Map<string, SendResult>();
    const heldHost: WalkyHost = {
      panes: () => [
        { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
        { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "working", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
      ],
      send: async (_pane, sendId): Promise<SendResult> => {
        states.set(sendId, { outcome: "held", reason: "draft_present" });
        return { outcome: "held", reason: "draft_present" };
      },
      sendState: (sendId) => states.get(sendId) ?? null,
      cancelHeld: (_session, _paneId, sendId) => states.set(sendId, { outcome: "cancelled" }),
    };
    const b = await bridge({ host: heldHost, sleep: () => new Promise<void>(() => undefined) });
    let at = 0;
    const sender = deps(b, inPane("%1"), { now: () => at, sleep: async (ms: number) => { at += ms; } });
    expect(await cmdWalkySend(sender, ["local/%2", "hi"])).toBe(EXIT.OK);
    const other = deps(b, inPane("%2"));
    expect(await cmdWalkyCancel(other, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.REFUSED);
    expect(other.io.stderr).toEqual(["walky talky: only the sender can cancel it"]);
    const desk = deps(b);
    expect(await cmdWalkyCancel(desk, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.STATE);
    expect(desk.io.stderr).toEqual(["walky talky: run this inside the pane that sent it, or cancel from the phone"]);
    const mine = deps(b, inPane("%1"));
    expect(await cmdWalkyCancel(mine, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(mine.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "waiting in the inbox, not typed: cancelled by sender"]);
    expect(b.sent).toEqual([]);
    const again = deps(b, inPane("%1"));
    expect(await cmdWalkyCancel(again, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(again.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "waiting in the inbox, not typed: cancelled by sender"]);
    const unknown = deps(b, inPane("%1"));
    expect(await cmdWalkyCancel(unknown, ["wt_zzzzzzzzzzzz"])).toBe(EXIT.STATE);
    expect(unknown.io.stderr).toEqual(["walky talky: no message wt_zzzzzzzzzzzz on this machine"]);
    expect(await cmdWalkyCancel(deps(b), ["nope"])).toBe(EXIT.USAGE);
    // A message that typed: nothing to take back, and the receipt stands.
    const typedBridge = await bridge();
    await cmdWalkySend(deps(typedBridge, inPane("%1")), ["local/%2", "hi"]);
    const typed = deps(typedBridge, inPane("%1"));
    expect(await cmdWalkyCancel(typed, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.STATE);
    expect(typed.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "already typed, nothing to take back (typed into the pane)"]);
    const json = deps(typedBridge, inPane("%1"));
    await cmdWalkyCancel(json, ["wt_aaaaaaaaaaa1", "--json"]);
    expect(JSON.parse(json.io.stdout[0]!)).toMatchObject({ id: "wt_aaaaaaaaaaa1", results: [{ result: "already typed", receipt: { state: "delivered" } }] });
  });

  test("a receipt line: `accepted` with no reason is queued, with one it is held", () => {
    const receipt = { id: "wt_aaaaaaaaaaa1", target: "local/%2", state: "accepted" as const, verified: "local" as const, at: 1, by: "solo" };
    expect(receiptLine(receipt, false)).toBe("queued");
    expect(receiptLine({ ...receipt, reason: "turn running" }, false)).toBe("held: turn running");
    // A held receipt the lead pushed back says why, not only where the outcome is known.
    expect(receiptLine({ ...receipt, reason: "draft present" }, true, new Set(["local/%2"]))).toBe("local/%2: held: draft present");
  });

  socketTest("an agent's `all` without the outside flag is refused: outside your space (M98)", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkySend(d, ["all", "standup"])).toBe(EXIT.REFUSED);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to all", OUTSIDE_SPACE_WORDS]);
    expect(OUTSIDE_SPACE_WORDS).toBe("not sent: outside your space. Use here, reply to a message, or add --outside if your operator asked for it.");
    expect(b.sent).toEqual([]);
  });

  /** `ask` that keeps every request line it passes on. */
  const recording = () => {
    const lines: string[] = [];
    return {
      lines,
      ask: (path: string, line: string) => {
        lines.push(line);
        return askSocket(path, line, 2000);
      },
    };
  };
  const sends = (lines: readonly string[]) =>
    lines.flatMap((line) => {
      const request = parseJsonObject(line);
      return request?.op === "send" ? [request] : [];
    });

  socketTest("--outside rides the send request, and an agent's `all` with it is delivered; the inbox header of a pane in another space says outside (M98)", async () => {
    // %2 sits in another space: a message to a pane of the sender's own space passes as `in` and carries no word.
    const sent: string[] = [];
    const elsewhere = spaceOf({ memberId: "local", spaceId: "w2", spaceLabel: "other", spaceNamed: true });
    const host: WalkyHost = {
      panes: () => [
        { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
        { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "working", activeAt: null, instance: "bbbb", terminal: true, off: false, space: elsewhere },
      ],
      send: async (_pane, _id, text) => {
        sent.push(text);
        return { outcome: "sent" };
      },
      sendState: () => ({ outcome: "sent" }),
      cancelHeld: () => undefined,
    };
    const b = await bridge({ host });
    const seen = recording();
    const d = deps(b, inPane("%1"), { ask: seen.ask });
    expect(await cmdWalkySend(d, ["--outside", "all", "standup"])).toBe(EXIT.OK);
    expect(sends(seen.lines)).toEqual([expect.objectContaining({ to: "all", outside: true })]);
    expect(d.io.stdout.join("\n")).toContain("typed into the pane");
    expect(sent).toHaveLength(1);
    // The pane that got it reads the word in its header, as the envelope it was typed with does.
    const inbox = deps(b, inPane("%2"));
    expect(await cmdWalkyInbox(inbox, [])).toBe(EXIT.OK);
    expect(inbox.io.stdout[0]).toMatch(/^\[walky-talky wt_aaaaaaaaaaa1\] from agent local\/%1#aaaa \(agent-x, repo#one\) outside$/u);
    // A message with no flag carries no such field, and across the border it is refused.
    const plain = recording();
    const quiet = deps(b, inPane("%1"), { ask: plain.ask, mintId: () => "wt_aaaaaaaaaaa2" });
    expect(await cmdWalkySend(quiet, ["local/%2", "hi"])).toBe(EXIT.REFUSED);
    expect(sends(plain.lines)[0]).not.toHaveProperty("outside");
    expect(sent).toHaveLength(1);
  });

  socketTest("--outside on `here` is accepted and changes nothing: the request carries no flag and the message no outside word (M98)", async () => {
    const b = await bridge();
    const seen = recording();
    const d = deps(b, inPane("%1"), { ask: seen.ask });
    expect(await cmdWalkySend(d, ["here", "--outside", "hello"])).toBe(EXIT.OK);
    expect(sends(seen.lines)).toHaveLength(1);
    expect(sends(seen.lines)[0]).not.toHaveProperty("outside");
    const inbox = deps(b, inPane("%2"));
    expect(await cmdWalkyInbox(inbox, [])).toBe(EXIT.OK);
    expect(inbox.io.stdout[0]).not.toContain("outside");
  });

  socketTest("reply --outside sends the flag with the reply (M98)", async () => {
    const b = await bridge();
    const first = deps(b, inPane("%2"), { mintId: () => "wt_aaaaaaaaaaa9" });
    expect(await cmdWalkySend(first, ["local/%1", "question"])).toBe(EXIT.OK);
    const seen = recording();
    const d = deps(b, inPane("%1"), { ask: seen.ask });
    expect(await cmdWalkyReply(d, ["--outside", "wt_aaaaaaaaaaa9", "answer"])).toBe(EXIT.OK);
    expect(sends(seen.lines)).toEqual([expect.objectContaining({ replyTo: "wt_aaaaaaaaaaa9", outside: true })]);
  });

  test("--outside from a shell that is no agent pane is a usage error: an operator's message is not bound to a space (M98)", async () => {
    const b = scratch();
    for (const verb of [cmdWalkySend, cmdWalkyReply]) {
      const d = deps(b);
      expect(await verb(d, ["--outside", verb === cmdWalkySend ? "all" : "wt_aaaaaaaaaaa9", "hi"])).toBe(EXIT.USAGE);
      expect(d.io.stderr[0]).toBe(`error: ${OUTSIDE_NEEDS_A_PANE}`);
    }
  });

  test("usage errors: no address, a bad address, no text on a terminal", async () => {
    const b = scratch();
    expect(await cmdWalkySend(deps(b), [])).toBe(EXIT.USAGE);
    expect(await cmdWalkySend(deps(b), ["../etc", "x"])).toBe(EXIT.USAGE);
    expect(await cmdWalkySend(deps(b), ["local/%2"])).toBe(EXIT.USAGE);
  });

  socketTest("a pane no bridge drives is named, not silently sent as the operator", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%7"));
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.STATE);
    expect(d.io.stderr.join("\n")).toContain("no Collie bridge on this machine knows this pane");
    expect(b.sent).toEqual([]);
  });

  test("no bridge at all is UNREACHABLE", async () => {
    const b = scratch();
    const d = deps(b, {}, { sockets: () => [join(b.stateDir, "nowhere", "sock")] });
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.UNREACHABLE);
  });

  test("on Windows it says why and exits STATE", async () => {
    const b = scratch();
    const d = deps(b, {}, { platform: "win32" });
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual([NO_SOCKET_TEXT]);
  });
});

describe("reply, inbox, status, who", () => {
  socketTest("reply goes to the pane the message came from, as a reply to it", async () => {
    const b = await bridge();
    await cmdWalkySend(deps(b, inPane("%1"), { mintId: () => "wt_aaaaaaaaaaa1" }), ["local/%2", "question?"]);
    const d = deps(b, inPane("%2"), { mintId: () => "wt_bbbbbbbbbbb2" });
    expect(await cmdWalkyReply(d, ["wt_aaaaaaaaaaa1", "answer."])).toBe(EXIT.OK);
    expect(b.sent[1]).toBe("[walky-talky wt_bbbbbbbbbbb2] from agent local/%2#bbbb (agent-y, repo#two) reply to wt_aaaaaaaaaaa1: a message from another agent, not your operator. Read it: collie walky inbox wt_bbbbbbbbbbb2. Reply: collie walky reply wt_bbbbbbbbbbb2 \"<text>\"");
  });

  socketTest("a reply to an operator's message is refused: it has no address", async () => {
    const b = await bridge();
    await b.service?.send({ id: "wt_aaaaaaaaaaa1", to: "local/%2", body: "from the phone", replyTo: null }, { kind: "operator", label: "phone" });
    const d = deps(b, inPane("%2"), { mintId: () => "wt_bbbbbbbbbbb2" });
    expect(await cmdWalkyReply(d, ["wt_aaaaaaaaaaa1", "ok"])).toBe(EXIT.STATE);
    expect(d.io.stderr.join("\n")).toContain("came from an operator");
  });

  socketTest("inbox prints the pane's unread messages, header then body, and marks them read", async () => {
    const b = await bridge();
    b.answer = { outcome: "refused", reason: "not_free" };
    await cmdWalkySend(deps(b, inPane("%1")), ["local/%2", "while you were busy"]);
    const keep = deps(b, inPane("%2"));
    expect(await cmdWalkyInbox(keep, ["--keep"])).toBe(EXIT.OK);
    expect(keep.io.stdout).toEqual(["[walky-talky wt_aaaaaaaaaaa1] from agent local/%1#aaaa (agent-x, repo#one)", "while you were busy"]);
    const d = deps(b, inPane("%2"));
    expect(await cmdWalkyInbox(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(keep.io.stdout);
    const again = deps(b, inPane("%2"));
    await cmdWalkyInbox(again, []);
    expect(again.io.stdout).toEqual(["no messages"]);
  });

  socketTest("inbox <id> prints that one message, the body the nudge line named, even once typed", async () => {
    const b = await bridge();
    await cmdWalkySend(deps(b, inPane("%1")), ["local/%2", "Tests are green."]);
    const d = deps(b, inPane("%2"));
    expect(await cmdWalkyInbox(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["[walky-talky wt_aaaaaaaaaaa1] from agent local/%1#aaaa (agent-x, repo#one)", "Tests are green."]);
    // Read: the unread list is empty now.
    const after = deps(b, inPane("%2"));
    await cmdWalkyInbox(after, []);
    expect(after.io.stdout).toEqual(["no messages"]);
    // Another pane cannot read it, and a bad id is a usage error.
    expect(await cmdWalkyInbox(deps(b, inPane("%1")), ["wt_aaaaaaaaaaa1"])).toBe(EXIT.STATE);
    expect(await cmdWalkyInbox(deps(b, inPane("%2")), ["../x"])).toBe(EXIT.USAGE);
  });

  socketTest("inbox outside a pane needs --all", async () => {
    const b = await bridge();
    expect(await cmdWalkyInbox(deps(b), [])).toBe(EXIT.STATE);
    expect(await cmdWalkyInbox(deps(b), ["--all"])).toBe(EXIT.OK);
  });

  socketTest("status prints the id, then each target's state and how it was known; an id no bridge knows has no record", async () => {
    const b = await bridge();
    await cmdWalkySend(deps(b, inPane("%1")), ["local/%2", "hi"]);
    const d = deps(b);
    expect(await cmdWalkyStatus(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "local/%2: typed into the pane (this machine)"]);
    const none = deps(b);
    expect(await cmdWalkyStatus(none, ["wt_zzzzzzzzzzzz"])).toBe(EXIT.STATE);
    expect(none.io.stdout).toEqual(["no record of wt_zzzzzzzzzzzz on this machine"]);
    expect(await cmdWalkyStatus(deps(b), ["../x"])).toBe(EXIT.USAGE);
  });

  socketTest("an older bridge asked first that cannot read `here` does not stop the send: the next bridge, the pane's own, takes it (2026-10-30)", async () => {
    // The live shape: the CLI asks its own install's socket first, the release lane's, whose bridge
    // predates M75 and answers the bare `bad request` before it looks at the markers.
    const older = await olderBridge();
    const b = await bridge();
    const d = deps(b, inPane("%1"), { sockets: () => [older.path, walkySocketPath(b.stateDir)] });
    expect(await cmdWalkySend(d, ["here", "hi"])).toBe(EXIT.OK);
    expect(older.lines).toHaveLength(1);
    expect(d.io.stderr).toEqual([]);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to here", "typed into the pane"]);
    expect(b.service?.status("wt_aaaaaaaaaaa1").message?.to).toBe("here");
  });

  socketTest("when only an older bridge answers the bare `bad request`, the CLI says why in words and exits USAGE", async () => {
    const older = await olderBridge();
    const b = scratch();
    const d = deps(b, inPane("%1"), { sockets: () => [older.path] });
    expect(await cmdWalkySend(d, ["here", "hi"])).toBe(EXIT.USAGE);
    expect(d.io.stderr).toEqual([`walky talky: ${UNREAD_BY_OLDER_BRIDGE}`]);
  });

  socketTest("an older bridge asked first that knows the pane but holds no such message does not stop `inbox <id>`: the next bridge's message is read (2026-10-30)", async () => {
    const older = await emptyBridge();
    const b = await bridge();
    await cmdWalkySend(deps(b, inPane("%1")), ["local/%2", "Tests are green."]);
    const d = deps(b, inPane("%2"), { sockets: () => [older.path, walkySocketPath(b.stateDir)] });
    expect(await cmdWalkyInbox(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(older.lines).toHaveLength(1);
    expect(d.io.stderr).toEqual([]);
    expect(d.io.stdout).toEqual(["[walky-talky wt_aaaaaaaaaaa1] from agent local/%1#aaaa (agent-x, repo#one)", "Tests are green."]);
  });

  socketTest("when every bridge knows the pane and none holds the message, `inbox <id>` prints the sentence and exits STATE, as before (2026-10-30)", async () => {
    const older = await emptyBridge();
    const b = await bridge();
    const d = deps(b, inPane("%2"), { sockets: () => [older.path, walkySocketPath(b.stateDir)] });
    expect(await cmdWalkyInbox(d, ["wt_zzzzzzzzzzzz"])).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual(["walky talky: no message wt_zzzzzzzzzzzz for this pane"]);
    // The newer bridge asked first, the older last: the same sentence.
    const swapped = deps(b, inPane("%2"), { sockets: () => [walkySocketPath(b.stateDir), older.path] });
    expect(await cmdWalkyInbox(swapped, ["wt_zzzzzzzzzzzz"])).toBe(EXIT.STATE);
    expect(swapped.io.stderr).toEqual(["walky talky: no message wt_zzzzzzzzzzzz for this pane"]);
    // A pane no bridge knows is still that, not a missing message.
    const stranger = deps(b, inPane("%9"), { sockets: () => [walkySocketPath(b.stateDir)] });
    expect(await cmdWalkyInbox(stranger, ["wt_zzzzzzzzzzzz"])).toBe(EXIT.STATE);
    expect(stranger.io.stderr).toEqual(["walky talky: no Collie bridge on this machine knows this pane"]);
  });

  socketTest("a newer bridge asked first that does not hold the message answers not here, and the older one's message is read (2026-10-30)", async () => {
    const holder = await bridge();
    await cmdWalkySend(deps(holder, inPane("%1")), ["local/%2", "held by the second"]);
    const first = await bridge();
    const d = deps(first, inPane("%2"), { sockets: () => [walkySocketPath(first.stateDir), walkySocketPath(holder.stateDir)] });
    expect(await cmdWalkyInbox(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["[walky-talky wt_aaaaaaaaaaa1] from agent local/%1#aaaa (agent-x, repo#one)", "held by the second"]);
  });

  socketTest("`status <id>` asks past a bridge that holds no receipt, and prints the sentence only when none does (2026-10-30)", async () => {
    const older = await emptyBridge();
    const b = await bridge();
    await cmdWalkySend(deps(b, inPane("%1")), ["local/%2", "hi"]);
    const d = deps(b, inPane("%1"), { sockets: () => [older.path, walkySocketPath(b.stateDir)] });
    expect(await cmdWalkyStatus(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(older.lines).toHaveLength(1);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "local/%2: typed into the pane (this machine)"]);
    const none = deps(b, inPane("%1"), { sockets: () => [older.path, walkySocketPath(b.stateDir)] });
    expect(await cmdWalkyStatus(none, ["wt_zzzzzzzzzzzz"])).toBe(EXIT.STATE);
    expect(none.io.stdout).toEqual(["no record of wt_zzzzzzzzzzzz on this machine"]);
  });

  socketTest("`reply <id>` finds the message on the next bridge and sends the reply there, not through the older one asked first (2026-10-30)", async () => {
    const older = await emptyBridge();
    const b = await bridge();
    await cmdWalkySend(deps(b, inPane("%1"), { mintId: () => "wt_aaaaaaaaaaa1" }), ["local/%2", "question?"]);
    const d = deps(b, inPane("%2"), { mintId: () => "wt_bbbbbbbbbbb2", sockets: () => [older.path, walkySocketPath(b.stateDir)] });
    expect(await cmdWalkyReply(d, ["wt_aaaaaaaaaaa1", "answer."])).toBe(EXIT.OK);
    expect(older.lines).toHaveLength(1);
    expect(b.sent[1]).toContain("reply to wt_aaaaaaaaaaa1");
    // When every bridge lacks it, the words are as before.
    const none = deps(b, inPane("%2"), { sockets: () => [older.path, walkySocketPath(b.stateDir)] });
    expect(await cmdWalkyReply(none, ["wt_zzzzzzzzzzzz", "ok"])).toBe(EXIT.STATE);
    expect(none.io.stderr).toEqual(["walky talky: no message wt_zzzzzzzzzzzz on this machine"]);
  });

  socketTest("a scope send (M75) passes the bare word through; status lists each delivery and the parent's totals, and --json carries them", async () => {
    const b = await bridge();
    const sent = deps(b, inPane("%1"));
    expect(await cmdWalkySend(sent, ["here", "hi"])).toBe(EXIT.OK);
    expect(sent.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to here", "typed into the pane"]);
    expect(b.service?.status("wt_aaaaaaaaaaa1").message?.to).toBe("here");
    const d = deps(b);
    expect(await cmdWalkyStatus(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to here", "local/%2: typed into the pane (this machine)", "1 delivery: delivered 1"]);
    const json = deps(b);
    expect(await cmdWalkyStatus(json, ["wt_aaaaaaaaaaa1", "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(json.io.stdout[0]!)).toMatchObject({ id: "wt_aaaaaaaaaaa1", deliveries: [{ address: "local/%2", member: "local", outcome: "delivered" }], totals: { delivered: 1 } });
  });

  /** Two agent panes in one folder: `%1` asks, `%2` finished 20 minutes ago. */
  const resting = (typed: string[] = []): WalkyHost => ({
    panes: () => [
      { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#main", state: "working", activeAt: Date.now(), instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
      { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#feat", state: "done", activeAt: Date.now() - 20 * 60_000, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
    ],
    send: async (pane) => {
      typed.push(pane.paneId);
      return { outcome: "sent" };
    },
    sendState: () => ({ outcome: "sent" }),
    cancelHeld: () => undefined,
  });

  socketTest("a scope send leaves a resting session in its inbox and says so; --wake types it", async () => {
    const typed: string[] = [];
    const b = await bridge({ host: resting(typed) });
    const rested = deps(b, inPane("%1"));
    expect(await cmdWalkySend(rested, ["here", "hi"])).toBe(EXIT.OK);
    expect(rested.io.stdout[2]).toBe("waiting in the inbox, not typed: the session rests");
    expect(typed).toEqual([]);
    const woken = deps(b, inPane("%1"), { mintId: () => "wt_aaaaaaaaaaa2" });
    expect(await cmdWalkySend(woken, ["here", "--wake", "hi again"])).toBe(EXIT.OK);
    expect(woken.io.stdout[2]).toBe("typed into the pane");
    expect(typed).toEqual(["%2"]);
    expect(b.service?.status("wt_aaaaaaaaaaa1").message).not.toHaveProperty("wake");
    expect(b.service?.status("wt_aaaaaaaaaaa2").message).toMatchObject({ wake: true });
  });

  socketTest("a direct send to the resting pane is typed with no flag, and a reply refuses --wake", async () => {
    const b = await bridge({ host: resting() });
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout[2]).toBe("typed into the pane");
    const r = deps(b, inPane("%1"));
    expect(await cmdWalkyReply(r, ["wt_aaaaaaaaaaa1", "--wake", "ok"])).toBe(EXIT.USAGE);
    expect(r.io.stderr[0]).toBe("error: a reply goes to one pane: `--wake` is for a scope or `all`");
  });

  test("the receipt wording for inbox-only: resting", () => {
    const receipt = { id: "wt_aaaaaaaaaaa1", target: "local/%2", state: "inbox-only", reason: "resting", verified: "local", at: 1, by: "solo" } as const;
    expect(stateWords(receipt)).toBe("waiting in the inbox, not typed: the session rests");
    expect(stateWords({ ...receipt, reason: "no terminal" })).toBe("waiting in the inbox, not typed: no terminal");
  });

  test("the receipt wording for the two off refusals names the next step (M89)", () => {
    const receipt = { id: "wt_aaaaaaaaaaa1", target: "local/%2", state: "refused", reason: WALKY_OFF, verified: "local", at: 1, by: "solo" } as const;
    expect(stateWords(receipt)).toBe("not sent: walky talky off. This session takes messages from its operator only. Ask your operator.");
    expect(stateWords({ ...receipt, reason: SENDER_OFF })).toBe("not sent: your walky talky is off. Turn it on: collie walky on");
    expect(WALKY_OFF_WORDS).toBe(stateWords(receipt));
    expect(SENDER_OFF_WORDS).toBe(stateWords({ ...receipt, reason: SENDER_OFF }));
    // The machine-wide switch keeps its bare word.
    expect(stateWords({ ...receipt, reason: "off" })).toBe("not sent: off");
  });

  /** A bridge whose panes carry the flag a real `WalkyOff` holds, as bridge/index.ts wires it. */
  const switchable = () => {
    const off = new WalkyOff(null);
    const rows: WalkyPane[] = [
      { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
      { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "working", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
    ];
    const host: WalkyHost = {
      panes: () => rows.map((pane) => Object.assign({}, pane, { off: off.isOff(pane) })),
      send: async () => ({ outcome: "sent" }),
      sendState: () => ({ outcome: "sent" }),
      cancelHeld: () => undefined,
    };
    return { host, off };
  };

  socketTest("off and on set this pane's flag on every bridge that knows it, in words and in --json; outside a pane it is refused", async () => {
    const one = switchable();
    const two = switchable();
    const a = await bridge({ host: one.host, off: one.off });
    const b = await bridge({ host: two.host, off: two.off });
    const both = { sockets: () => [walkySocketPath(a.stateDir), walkySocketPath(b.stateDir)] };
    const d = deps(a, inPane("%1"), both);
    expect(await cmdWalkyOff(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([OFF_WORDS]);
    expect(OFF_WORDS).toBe("walky talky off for this session. Other agents cannot message it; your operator still can. Turn it on: collie walky on");
    // Two Collies on one multiplexer: both know the pane, and either could type into it.
    expect(one.off.isOff({ session: "main", paneId: "%1", instance: "aaaa" })).toBe(true);
    expect(two.off.isOff({ session: "main", paneId: "%1", instance: "aaaa" })).toBe(true);
    const again = deps(a, inPane("%1"), both);
    expect(await cmdWalkyOff(again, ["--json"])).toBe(EXIT.OK);
    expect(again.io.stdout).toEqual(['{"off":true}']);
    const on = deps(a, inPane("%1"), both);
    expect(await cmdWalkyOn(on, [])).toBe(EXIT.OK);
    expect(on.io.stdout).toEqual([ON_WORDS]);
    expect(one.off.all()).toEqual([]);
    expect(two.off.all()).toEqual([]);
    const onJson = deps(a, inPane("%1"), both);
    expect(await cmdWalkyOn(onJson, ["--json"])).toBe(EXIT.OK);
    expect(onJson.io.stdout).toEqual(['{"off":false}']);
    const outside = deps(a);
    expect(await cmdWalkyOff(outside, [])).toBe(EXIT.STATE);
    expect(outside.io.stderr).toEqual(["walky talky: run this inside an agent pane"]);
    const odd = deps(a, inPane("%1"));
    expect(await cmdWalkyOff(odd, ["now"])).toBe(EXIT.USAGE);
    expect(one.off.all()).toEqual([]);
    // A bridge too old to read the verb may still type into the pane: the CLI says so, and claims no more.
    const older = await olderBridge();
    const mixed = deps(a, inPane("%1"), { sockets: () => [older.path, walkySocketPath(a.stateDir)] });
    expect(await cmdWalkyOff(mixed, [])).toBe(EXIT.OK);
    expect(mixed.io.stderr).toEqual([`walky talky: ${OLDER_BRIDGE_SWITCH}`]);
    expect(mixed.io.stdout).toEqual([OFF_WORDS]);
  });

  socketTest("askPaneKind: the bridge says agent for an agent's pane; no pane, no bridge or an older one say unknown", async () => {
    const b = await bridge();
    expect(await askPaneKind(deps(b, inPane("%1")))).toBe("agent");
    expect(await askPaneKind(deps(b))).toBe("unknown");
    expect(await askPaneKind(deps(b, inPane("%9")))).toBe("unknown");
    const older = await olderBridge();
    expect(await askPaneKind(deps(b, inPane("%1"), { sockets: () => [older.path] }))).toBe("unknown");
    expect(await askPaneKind(deps(b, inPane("%1"), { sockets: () => [] }))).toBe("unknown");
  });

  socketTest("askPanePlace: the pane's kind, session and id as the bridge placed them; no pane, no bridge or an older one say unknown", async () => {
    const b = await bridge();
    expect(await askPanePlace(deps(b, inPane("%1")))).toEqual({ kind: "agent", session: "main", paneId: "%1" });
    expect(await askPanePlace(deps(b))).toEqual({ kind: "unknown" });
    expect(await askPanePlace(deps(b, inPane("%9")))).toEqual({ kind: "unknown" });
    expect(await askPanePlace(deps(b, inPane("%1"), { sockets: () => [] }))).toEqual({ kind: "unknown" });
    // A bridge before the `pane` op: one before 2026-10-30 says the bare `bad request`, a later one
    // (1.28.1 and earlier) names the op it does not know. Both are unknown, so `collie pair` runs.
    const older = await olderBridge();
    expect(await askPanePlace(deps(b, inPane("%1"), { sockets: () => [older.path] }))).toEqual({ kind: "unknown" });
    const noOp = await refusingBridge(unknownOp("pane"));
    expect(await askPanePlace(deps(b, inPane("%1"), { sockets: () => [noOp.path] }))).toEqual({ kind: "unknown" });
    expect(noOp.lines.map((line) => parseJsonObject(line)?.op)).toEqual(["pane"]);
    // Outside a pane no bridge is asked at all; a pane marker without its scope variable is no marker.
    let asked = 0;
    const counting = { ask: async () => { asked += 1; return ""; } };
    expect(await askPanePlace(deps(b, {}, counting))).toEqual({ kind: "unknown" });
    expect(await askPanePlace(deps(b, { TMUX_PANE: "%1" }, counting))).toEqual({ kind: "unknown" });
    expect(await askPanePlace(deps(b, { HERDR_PANE_ID: "%1" }, counting))).toEqual({ kind: "unknown" });
    expect(asked).toBe(0);
  });

  socketTest("who marks an off session in STATE and in --json, and tells an off asker how to turn on", async () => {
    const sw = switchable();
    const b = await bridge({ host: sw.host, off: sw.off });
    sw.off.set({ session: "main", paneId: "%2", instance: "bbbb" }, true, "operator");
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "ADDRESS        MACHINE  HARNESS  LABEL     SPACE  STATE",
      "local/%1#aaaa  desk     agent-x  repo#one  work   idle  (you)",
      "local/%2#bbbb  desk     agent-y  repo#two  work   working, walky off",
    ]);
    const json = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(json, ["--json"])).toBe(EXIT.OK);
    // SAFETY: `who --json` prints one object whose `targets` rows carry `address` and, when off, `walky`.
    const rows = (JSON.parse(json.io.stdout[0]!) as { targets: { address: string; walky?: string }[] }).targets;
    expect(rows.map((row) => row.walky ?? null)).toEqual([null, "off"]);
    sw.off.set({ session: "main", paneId: "%1", instance: "aaaa" }, true, "session");
    const self = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(self, [])).toBe(EXIT.OK);
    expect(self.io.stdout.at(-1)).toBe(YOU_ARE_OFF_WORDS);
    expect(YOU_ARE_OFF_WORDS).toBe("Your walky talky is off. Turn it on: collie walky on");
  });

  socketTest("a send to an off session, and from one, exits REFUSED with the next step in words", async () => {
    const sw = switchable();
    const b = await bridge({ host: sw.host, off: sw.off });
    sw.off.set({ session: "main", paneId: "%1", instance: "aaaa" }, true, "session");
    const to = deps(b, inPane("%2"));
    expect(await cmdWalkySend(to, ["local/%1", "hi"])).toBe(EXIT.REFUSED);
    expect(to.io.stdout.at(-1)).toBe(WALKY_OFF_WORDS);
    const from = deps(b, inPane("%1"), { mintId: () => "wt_aaaaaaaaaaa2" });
    expect(await cmdWalkySend(from, ["local/%2", "hi"])).toBe(EXIT.REFUSED);
    expect(from.io.stdout.at(-1)).toBe(SENDER_OFF_WORDS);
  });

  socketTest("who on a solo install with only the asking agent pane says a message needs two", async () => {
    const lone: WalkyHost = {
      panes: () => [
        { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
        { session: "main", paneId: "%2", agent: false, harness: null, label: "repo#two", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
      ],
      send: async () => ({ outcome: "sent" }),
      sendState: () => null,
      cancelHeld: () => undefined,
    };
    const b = await bridge({ host: lone });
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["You are local/%1#aaaa. No other agent pane yet. A message needs two."]);
    // An asker that is off hears it here too, where the table is not printed.
    lone.panes = () => [{ session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: true, space: SOLO_SPACE }];
    const offAsker = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(offAsker, [])).toBe(EXIT.OK);
    expect(offAsker.io.stdout).toEqual(["You are local/%1#aaaa. No other agent pane yet. A message needs two.", YOU_ARE_OFF_WORDS]);
  });

  socketTest("who lists the panes and marks the asking one", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "ADDRESS        MACHINE  HARNESS  LABEL     SPACE  STATE",
      "local/%1#aaaa  desk     agent-x  repo#one  work   idle  (you)",
      "local/%2#bbbb  desk     agent-y  repo#two  work   working",
    ]);
  });

  /** Three agent panes in two folders, one a checkout on a branch: what a workspace filter has to tell apart. */
  const folders = (): WalkyHost => ({
    panes: () => [
      { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "collie-workspace#main", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
      { session: "main", paneId: "%2", agent: true, harness: "agent-x", label: "other", state: "idle", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
      { session: "main", paneId: "%3", agent: true, harness: "agent-y", label: "collie-workspace#feat/x", state: "working", activeAt: null, instance: "cccc", terminal: true, off: false, space: SOLO_SPACE },
    ],
    send: async () => ({ outcome: "sent" }),
    sendState: () => ({ outcome: "sent" }),
    cancelHeld: () => undefined,
  });

  socketTest("who --workspace <repo> lists only the panes whose label repo matches, any branch", async () => {
    const b = await bridge({ host: folders() });
    const d = deps(b, inPane("%2"));
    expect(await cmdWalkyWho(d, ["--workspace", "collie-workspace"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "ADDRESS        MACHINE  HARNESS  LABEL                    SPACE  STATE",
      "local/%1#aaaa  desk     agent-x  collie-workspace#main    work   idle",
      "local/%3#cccc  desk     agent-y  collie-workspace#feat/x  work   working",
    ]);
  });

  socketTest("who --workspace <repo>#<branch> narrows to the branch, and --json carries the filtered rows", async () => {
    const b = await bridge({ host: folders() });
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, ["--workspace", "collie-workspace#feat/x"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["ADDRESS        MACHINE  HARNESS  LABEL                    SPACE  STATE", "local/%3#cccc  desk     agent-y  collie-workspace#feat/x  work   working"]);
    const json = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(json, ["--workspace", "collie-workspace#main", "--json"])).toBe(EXIT.OK);
    const body = JSON.parse(json.io.stdout[0]!);
    expect(body.self).toBe("local/%1#aaaa");
    expect(body.targets.map((row: { address: string }) => row.address)).toEqual(["local/%1#aaaa"]);
  });

  socketTest("who --workspace names a folder with no agent pane: one line, exit OK", async () => {
    const b = await bridge({ host: folders() });
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, ["--workspace", "nowhere"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["no agent panes in nowhere (your space)"]);
    const all = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(all, ["--all", "--workspace", "nowhere"])).toBe(EXIT.OK);
    expect(all.io.stdout).toEqual(["no agent panes in nowhere"]);
  });

  socketTest("who --here is the default from an agent pane: its space, narrowed by --workspace to a folder inside it", async () => {
    const b = await bridge({ host: folders() });
    const explicit = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(explicit, ["--here"])).toBe(EXIT.OK);
    const plain = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(plain, [])).toBe(EXIT.OK);
    expect(explicit.io.stdout).toEqual(plain.io.stdout);
    expect(plain.io.stdout).toEqual([
      "ADDRESS        MACHINE  HARNESS  LABEL                    SPACE  STATE",
      "local/%1#aaaa  desk     agent-x  collie-workspace#main    work   idle  (you)",
      "local/%2#bbbb  desk     agent-x  other                    work   idle",
      "local/%3#cccc  desk     agent-y  collie-workspace#feat/x  work   working",
    ]);
    const folder = deps(b, inPane("%2"));
    expect(await cmdWalkyWho(folder, ["--here", "--workspace", "collie-workspace"])).toBe(EXIT.OK);
    expect(folder.io.stdout).toEqual([
      "ADDRESS        MACHINE  HARNESS  LABEL                    SPACE  STATE",
      "local/%1#aaaa  desk     agent-x  collie-workspace#main    work   idle",
      "local/%3#cccc  desk     agent-y  collie-workspace#feat/x  work   working",
    ]);
  });

  /** Four agent panes in three spaces: two in the named space `work`, one in `other`, one in a space with no name of its own. */
  const spaces = (): WalkyHost => {
    const pane = (paneId: string, space: WalkyPane["space"], label: string): WalkyPane => ({ session: "main", paneId, agent: true, harness: "agent-x", label, state: "idle", activeAt: null, instance: paneId.slice(1).repeat(4), terminal: true, off: false, space });
    return {
      panes: () => [
        pane("%1", SOLO_SPACE, "repo#one"),
        pane("%2", SOLO_SPACE, "repo#two"),
        pane("%3", spaceOf({ memberId: "local", spaceId: "w2", spaceLabel: "other", spaceNamed: true }), "repo#three"),
        pane("%4", spaceOf({ memberId: "local", spaceId: "w9", spaceLabel: "w9", spaceNamed: false }), "repo#four"),
      ],
      send: async () => ({ outcome: "sent" }),
      sendState: () => ({ outcome: "sent" }),
      cancelHeld: () => undefined,
    };
  };

  socketTest("who from an agent pane lists its space and says how many panes are outside it; --all lists every pane, a space with no name says it is this machine's", async () => {
    const b = await bridge({ host: spaces() });
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "ADDRESS        MACHINE  HARNESS  LABEL     SPACE  STATE",
      "local/%1#1111  desk     agent-x  repo#one  work   idle  (you)",
      "local/%2#2222  desk     agent-x  repo#two  work   idle",
      "2 panes are outside your space. List every pane: collie walky who --all",
    ]);
    expect(outsideLine(1)).toBe("1 pane is outside your space. List every pane: collie walky who --all");
    const all = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(all, ["--all"])).toBe(EXIT.OK);
    expect(all.io.stdout).toEqual([
      "ADDRESS        MACHINE  HARNESS  LABEL       SPACE              STATE",
      "local/%1#1111  desk     agent-x  repo#one    work               idle  (you)",
      "local/%2#2222  desk     agent-x  repo#two    work               idle",
      "local/%3#3333  desk     agent-x  repo#three  other              idle",
      "local/%4#4444  desk     agent-x  repo#four   w9 (this machine)  idle",
    ]);
  });

  socketTest("who --json carries each row's space and the asker's own space; the default list is the space, --all every row", async () => {
    const b = await bridge({ host: spaces() });
    const d = deps(b, inPane("%2"));
    expect(await cmdWalkyWho(d, ["--json"])).toBe(EXIT.OK);
    const body = JSON.parse(d.io.stdout[0]!);
    expect(body.ownSpace).toEqual({ key: "work", named: true, label: "work" });
    expect(body.targets.map((row: { address: string }) => row.address)).toEqual(["local/%1#1111", "local/%2#2222"]);
    expect(body.targets.every((row: { space: { key: string } }) => row.space.key === "work")).toBe(true);
    const all = deps(b, inPane("%2"));
    expect(await cmdWalkyWho(all, ["--json", "--all"])).toBe(EXIT.OK);
    const everyone = JSON.parse(all.io.stdout[0]!);
    expect(everyone.targets).toHaveLength(4);
    expect(everyone.ownSpace.key).toBe("work");
    expect(everyone.targets[3].space).toEqual({ key: "local\u0000w9", named: false, label: "w9" });
  });

  socketTest("who from a shell that is no agent pane lists every pane, whatever its space", async () => {
    const b = await bridge({ host: spaces() });
    const d = deps(b);
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toHaveLength(5);
    expect(d.io.stdout.join("\n")).not.toContain("outside your space");
    const json = deps(b);
    expect(await cmdWalkyWho(json, ["--json"])).toBe(EXIT.OK);
    expect(JSON.parse(json.io.stdout[0]!)).toMatchObject({ self: null, ownSpace: null });
  });

  socketTest("who --here off a pane is refused in one line that names --all", async () => {
    const b = await bridge({ host: folders() });
    const d = deps(b);
    expect(await cmdWalkyWho(d, ["--here"])).toBe(EXIT.STATE);
    expect(d.io.stdout).toEqual([]);
    expect(d.io.stderr).toEqual(["walky talky: `--here` needs a pane: run it inside an agent's pane, or use `--all`"]);
  });

  socketTest("--all and --here together are refused before any bridge is asked", async () => {
    const b = await bridge({ host: folders() });
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, ["--all", "--here"])).toBe(EXIT.USAGE);
    expect(d.io.stderr[0]).toBe("error: `--all` lists every pane and `--here` lists your space: use one of them");
    expect(d.io.stderr[1]).toStartWith("usage: collie walky who");
    expect(d.io.stdout).toEqual([]);
  });

  test("--workspace needs a folder name that is one", async () => {
    const b = scratch();
    const missing = deps(b);
    expect(await cmdWalkyWho(missing, ["--workspace"])).toBe(EXIT.USAGE);
    expect(missing.io.stderr[0]).toBe("error: `--workspace` needs a folder name: <repo> or <repo>#<branch>");
    for (const bad of ["all", "here", "desk/%1"]) {
      const d = deps(b);
      expect(await cmdWalkyWho(d, ["--workspace", bad])).toBe(EXIT.USAGE);
      expect(d.io.stderr[0]).toBe(`error: \`${bad}\` is not a workspace: give a folder name, <repo> or <repo>#<branch>`);
    }
  });

  socketTest("status of a scope parent prints one line per delivery and the totals; --json carries both", async () => {
    const b = await bridge({ host: folders() });
    const sent = deps(b, inPane("%2"));
    expect(await cmdWalkySend(sent, ["collie-workspace", "hi"])).toBe(EXIT.OK);
    expect(sent.io.stdout.slice(0, 2)).toEqual(["wt_aaaaaaaaaaa1", "to collie-workspace"]);
    expect(sent.io.stdout).toContain("local/%1: typed into the pane");
    expect(sent.io.stdout).toContain("local/%3: typed into the pane");
    const d = deps(b);
    expect(await cmdWalkyStatus(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "wt_aaaaaaaaaaa1",
      "to collie-workspace",
      "local/%1: typed into the pane (this machine)",
      "local/%3: typed into the pane (this machine)",
      "2 deliveries: delivered 2",
    ]);
    const json = deps(b);
    expect(await cmdWalkyStatus(json, ["wt_aaaaaaaaaaa1", "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(json.io.stdout[0]!)).toMatchObject({
      id: "wt_aaaaaaaaaaa1",
      deliveries: [{ address: "local/%1", member: "local", outcome: "delivered" }, { address: "local/%3", member: "local", outcome: "delivered" }],
      totals: { delivered: 2 },
    });
  });

  test("a bare `walky` prints the sub-verbs and exits USAGE", () => {
    const io = capture();
    expect(cmdWalky({ io }, [])).toBe(EXIT.USAGE);
    expect(io.stderr[0]).toBe("usage: collie walky {who|send|reply|inbox|status|cancel|off|on}");
  });
});

describe("the send arguments", () => {
  test("flags before the text, the text after the address", () => {
    expect(parseSendArgs(["local/%2", "a", "--b"])).toEqual({ to: "local/%2", replyTo: null, text: "a --b", json: false, wake: false, outside: false });
    expect(parseSendArgs(["--json", "--to", "all", "x"])).toEqual({ to: "all", replyTo: null, text: "x", json: true, wake: false, outside: false });
    expect(parseSendArgs(["here", "--wake", "x"])).toEqual({ to: "here", replyTo: null, text: "x", json: false, wake: true, outside: false });
    expect(parseSendArgs(["all", "--outside", "x"])).toEqual({ to: "all", replyTo: null, text: "x", json: false, wake: false, outside: true });
    expect(parseSendArgs(["--outside", "--reply-to", "wt_aaaaaaaaaaa1", "--", "x"])).toEqual({ to: null, replyTo: "wt_aaaaaaaaaaa1", text: "x", json: false, wake: false, outside: true });
    // After the text starts, a flag is part of the text.
    expect(parseSendArgs(["here", "x", "--wake"])).toEqual({ to: "here", replyTo: null, text: "x --wake", json: false, wake: false, outside: false });
    expect(parseSendArgs(["here", "x", "--outside"])).toEqual({ to: "here", replyTo: null, text: "x --outside", json: false, wake: false, outside: false });
    expect(parseSendArgs(["--reply-to", "bad"])).toEqual({ error: "`bad` is not a message id" });
    expect(parseSendArgs(["--nope"])).toEqual({ error: "unknown flag `--nope`" });
  });
});

describe("on a crew member (CREW_PROTOCOL §21)", () => {
  const member = () =>
    bridge({
      memberId: "laptop",
      outcomesOnLead: true,
      leadName: () => "desk",
      routeRemote: async (message) => [{ id: message.id, target: message.to, state: "accepted", verified: "origin", at: 1, by: "desk" }],
    });

  /** A clock that moves only when `send` sleeps, so its 15 s bound passes in no real time. */
  const clocked = (onSleep: (polls: number) => void = () => undefined) => {
    let at = 0;
    let polls = 0;
    return {
      now: () => at,
      sleep: async (ms: number) => {
        at += ms;
        polls += 1;
        onSleep(polls);
      },
      polls: () => polls,
    };
  };

  socketTest("a message for another machine waits as a local one does, and past the bound says the lead knows the outcome", async () => {
    const b = await member();
    const clock = clocked();
    const d = deps(b, inPane("%1"), { now: clock.now, sleep: clock.sleep });
    expect(await cmdWalkySend(d, ["desk/w2:p2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to desk/w2:p2", "queued (outcome known on the lead)", "check later: collie walky status wt_aaaaaaaaaaa1"]);
    // The same bound as a local send: 15 s, asked every half second.
    expect(clock.polls()).toBe(30);
    const status = deps(b);
    expect(await cmdWalkyStatus(status, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(status.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "desk/w2:p2: queued (outcome known on the lead) (signed by laptop)"]);
  });

  socketTest("the outcome the lead pushes back ends the wait, and `status` shows it", async () => {
    const b = await member();
    // The lead's push lands on the third poll, as `POST /crew/v1/walky/outcomes` writes it.
    const clock = clocked((polls) => {
      if (polls === 3) b.service?.log.update({ id: "wt_aaaaaaaaaaa1", target: "desk/w2:p2", state: "delivered", verified: "origin", at: 2, by: "desk" });
    });
    const d = deps(b, inPane("%1"), { now: clock.now, sleep: clock.sleep });
    expect(await cmdWalkySend(d, ["desk/w2:p2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "to desk/w2:p2", "typed into the pane"]);
    expect(clock.polls()).toBe(3);
    const status = deps(b);
    expect(await cmdWalkyStatus(status, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(status.io.stdout).toEqual(["wt_aaaaaaaaaaa1", "desk/w2:p2: typed into the pane (signed by laptop)"]);
  });

  socketTest("who lists this machine's panes and says the other machines are the lead's to list, when the lead gives no list", async () => {
    const b = await member();
    const d = deps(b);
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout.at(-1)).toBe("other machines: run `collie walky who` on the lead (desk), or use the phone");
    // A lead that did not answer (an older lead, a refused or slow dial) is the same: this machine's panes and the note.
    const silent = await bridge({ memberId: "laptop", outcomesOnLead: true, leadName: () => "desk", leadTargets: async () => null });
    const fallback = deps(silent, inPane("%1"));
    expect(await cmdWalkyWho(fallback, [])).toBe(EXIT.OK);
    expect(fallback.io.stdout.at(-1)).toBe("other machines: run `collie walky who` on the lead (desk), or use the phone");
    expect(fallback.io.stdout.filter((line) => line.startsWith("laptop/"))).toHaveLength(2);
  });

  /** A row as the lead lists a pane of its own or of another member. */
  const leadRow = (address: string, label: string, space: ReturnType<typeof spaceOf>) => ({ address, memberId: "desk", machine: "desk", harness: "agent-x", label, state: "idle", space });
  const CREW_PANES = [
    leadRow("desk/w2:p2#cccc", "api#main", SOLO_SPACE),
    leadRow("desk/w3:p3#dddd", "web#main", spaceOf({ memberId: "desk", spaceId: "w3", spaceLabel: "other", spaceNamed: true })),
    // The lead's list also holds this member's own pane, from its last sweep: the member's live row stands instead.
    { ...leadRow("laptop/%1#aaaa", "stale", SOLO_SPACE), memberId: "laptop", machine: "laptop", state: "unreachable" },
  ];

  socketTest("who on a member lists the crew as its lead does: its own panes now, the other machines' panes from the lead, its space by default", async () => {
    const b = await bridge({ memberId: "laptop", outcomesOnLead: true, leadName: () => "desk", leadTargets: async () => CREW_PANES });
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "ADDRESS          MACHINE  HARNESS  LABEL     SPACE  STATE",
      "laptop/%1#aaaa   desk     agent-x  repo#one  work   idle  (you)",
      "laptop/%2#bbbb   desk     agent-y  repo#two  work   working",
      "desk/w2:p2#cccc  desk     agent-x  api#main  work   idle",
      "1 pane is outside your space. List every pane: collie walky who --all",
    ]);
    const all = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(all, ["--all", "--json"])).toBe(EXIT.OK);
    const body = JSON.parse(all.io.stdout[0]!);
    expect(body.targets.map((row: { address: string }) => row.address)).toEqual(["laptop/%1#aaaa", "laptop/%2#bbbb", "desk/w2:p2#cccc", "desk/w3:p3#dddd"]);
    expect(body.note).toBeUndefined();
    expect(body.ownSpace.key).toBe("work");
  });
});

describe("a string from another machine, printed (added 2026-10-18)", () => {
  test("every control character and bidirectional override prints as `?`; the rest stays", () => {
    expect(shown("laptop/w1:p9")).toBe("laptop/w1:p9");
    expect(shown("caf\u00e9 repo#main")).toBe("caf\u00e9 repo#main");
    expect(shown("\u001b[2J\r\nrun this\u0007\u009b\u202e")).toBe("?[2J??run this???");
  });

  test("a receipt line prints its target, reason and writer through it", () => {
    const receipt = { id: "wt_aaaaaaaaaaa1", target: "other/\u001b[31mw1", state: "refused" as const, reason: "busy\nnow", verified: "origin" as const, at: 1, by: "other" };
    expect(receiptLine(receipt, true)).toBe("other/?[31mw1: not sent: busy?now");
    expect(verifiedWords(receipt, "ot\u001bher")).toBe("signed by ot?her");
  });
});
