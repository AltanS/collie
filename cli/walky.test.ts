import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BeaconMatcher } from "../bridge/beacon/decorate.ts";
import type { SendResult, WalkyHost, WalkyPane } from "../bridge/walky/deliver.ts";
import { WalkyLog } from "../bridge/walky/log.ts";
import { WalkyService } from "../bridge/walky/service.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../bridge/walky/socket.ts";
import { capture, context } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { realFiles } from "./sys.ts";
import {
  askSocket,
  cmdWalky,
  cmdWalkyInbox,
  cmdWalkyReply,
  cmdWalkySend,
  cmdWalkyStatus,
  cmdWalkyWho,
  NO_SOCKET_TEXT,
  parseSendArgs,
  type WalkyDeps,
} from "./walky.ts";

// The CLI against a real bridge socket in a temp state dir: the socket, the request lines and the
// answers are the real ones, and only the panes and the Send Protocol are fakes.

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
}

async function bridge(over: Partial<ConstructorParameters<typeof WalkyService>[0]> = {}): Promise<Bridge> {
  const stateDir = mkdtempSync(join(tmpdir(), "walky-cli-"));
  const panes: WalkyPane[] = [
    { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", terminal: true },
    { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "working", terminal: true },
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
  const server = new WalkyServer({ socketPath: walkySocketPath(stateDir), service, targets: () => [target], log: () => undefined });
  expect(await server.start()).toBe(true);
  cleanups.push(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return state;
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
  test("positional: the address, then the text; it waits for the receipt and prints one line", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkySend(d, ["local/%2", "Tests", "are", "green."])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["delivered wt_aaaaaaaaaaa1"]);
    expect(b.sent).toEqual(["[walky-talky wt_aaaaaaaaaaa1] from agent local/%1 (agent-x, repo#one)\nTests are green."]);
  });

  test("`--to` is an alias, and `--` keeps a text that starts with a dash", async () => {
    const b = await bridge();
    const d = deps(b);
    expect(await cmdWalkySend(d, ["--to", "local/%2", "--", "--not-a-flag"])).toBe(EXIT.OK);
    expect(b.sent).toEqual(["[walky-talky wt_aaaaaaaaaaa1] from operator (cli)\n--not-a-flag"]);
  });

  test("no text reads the body from stdin", async () => {
    const b = await bridge();
    const d = deps(b, {}, { stdinIsTty: false, readStdin: async () => "line one\nline two\n" });
    expect(await cmdWalkySend(d, ["local/%2"])).toBe(EXIT.OK);
    expect(b.sent[0]).toBe("[walky-talky wt_aaaaaaaaaaa1] from operator (cli)\nline one\nline two");
  });

  test("a refusal prints its reason and exits REFUSED", async () => {
    const b = await bridge();
    const d = deps(b);
    expect(await cmdWalkySend(d, ["local/%9", "hi"])).toBe(EXIT.REFUSED);
    expect(d.io.stdout).toEqual(["refused wt_aaaaaaaaaaa1 (no such pane)"]);
  });

  test("a pane that cannot take it now leaves the message in the inbox", async () => {
    const b = await bridge();
    b.answer = { outcome: "refused", reason: "not_free" };
    const d = deps(b);
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["inbox-only wt_aaaaaaaaaaa1 (dialog open)"]);
  });

  test("`all` prints one line per pane, with its address", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkySend(d, ["all", "standup"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["delivered wt_aaaaaaaaaaa1 local/%2"]);
  });

  test("usage errors: no address, a bad address, no text on a terminal", async () => {
    const b = await bridge();
    expect(await cmdWalkySend(deps(b), [])).toBe(EXIT.USAGE);
    expect(await cmdWalkySend(deps(b), ["../etc", "x"])).toBe(EXIT.USAGE);
    expect(await cmdWalkySend(deps(b), ["local/%2"])).toBe(EXIT.USAGE);
  });

  test("a pane no bridge drives is named, not silently sent as the operator", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%7"));
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.STATE);
    expect(d.io.stderr.join("\n")).toContain("no Collie bridge on this machine knows this pane");
    expect(b.sent).toEqual([]);
  });

  test("no bridge at all is UNREACHABLE", async () => {
    const b = await bridge();
    const d = deps(b, {}, { sockets: () => [join(b.stateDir, "nowhere", "sock")] });
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.UNREACHABLE);
  });

  test("on Windows it says why and exits STATE", async () => {
    const b = await bridge();
    const d = deps(b, {}, { platform: "win32" });
    expect(await cmdWalkySend(d, ["local/%2", "hi"])).toBe(EXIT.STATE);
    expect(d.io.stderr).toEqual([NO_SOCKET_TEXT]);
  });
});

describe("reply, inbox, status, who", () => {
  test("reply goes to the pane the message came from, as a reply to it", async () => {
    const b = await bridge();
    await cmdWalkySend(deps(b, inPane("%1"), { mintId: () => "wt_aaaaaaaaaaa1" }), ["local/%2", "question?"]);
    const d = deps(b, inPane("%2"), { mintId: () => "wt_bbbbbbbbbbb2" });
    expect(await cmdWalkyReply(d, ["wt_aaaaaaaaaaa1", "answer."])).toBe(EXIT.OK);
    expect(b.sent[1]).toBe("[walky-talky wt_bbbbbbbbbbb2] from agent local/%2 (agent-y, repo#two) reply to wt_aaaaaaaaaaa1\nanswer.");
  });

  test("a reply to an operator's message is refused: it has no address", async () => {
    const b = await bridge();
    await cmdWalkySend(deps(b), ["local/%2", "from the desk"]);
    const d = deps(b, inPane("%2"), { mintId: () => "wt_bbbbbbbbbbb2" });
    expect(await cmdWalkyReply(d, ["wt_aaaaaaaaaaa1", "ok"])).toBe(EXIT.STATE);
    expect(d.io.stderr.join("\n")).toContain("came from an operator");
  });

  test("inbox shows the pane's unread messages as envelopes; --ack marks them read", async () => {
    const b = await bridge();
    b.answer = { outcome: "refused", reason: "not_free" };
    await cmdWalkySend(deps(b), ["local/%2", "while you were busy"]);
    const d = deps(b, inPane("%2"));
    expect(await cmdWalkyInbox(d, ["--ack"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["[walky-talky wt_aaaaaaaaaaa1] from operator (cli)", "while you were busy", "-- inbox-only wt_aaaaaaaaaaa1 local/%2 (dialog open)"]);
    const again = deps(b, inPane("%2"));
    await cmdWalkyInbox(again, []);
    expect(again.io.stdout).toEqual(["no messages"]);
  });

  test("inbox outside a pane needs --all", async () => {
    const b = await bridge();
    expect(await cmdWalkyInbox(deps(b), [])).toBe(EXIT.STATE);
    expect(await cmdWalkyInbox(deps(b), ["--all"])).toBe(EXIT.OK);
  });

  test("status prints the receipt; an id no bridge knows is `unknown`", async () => {
    const b = await bridge();
    await cmdWalkySend(deps(b), ["local/%2", "hi"]);
    const d = deps(b);
    expect(await cmdWalkyStatus(d, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["delivered wt_aaaaaaaaaaa1"]);
    const none = deps(b);
    expect(await cmdWalkyStatus(none, ["wt_zzzzzzzzzzzz"])).toBe(EXIT.STATE);
    expect(none.io.stdout).toEqual(["unknown wt_zzzzzzzzzzzz"]);
    expect(await cmdWalkyStatus(deps(b), ["../x"])).toBe(EXIT.USAGE);
  });

  test("who lists the panes and marks the asking one", async () => {
    const b = await bridge();
    const d = deps(b, inPane("%1"));
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([
      "ADDRESS   MACHINE  HARNESS  LABEL     STATE",
      "local/%1  desk     agent-x  repo#one  idle  (you)",
      "local/%2  desk     agent-y  repo#two  working",
    ]);
  });

  test("a bare `walky` prints the sub-verbs and exits USAGE", () => {
    const io = capture();
    expect(cmdWalky({ io }, [])).toBe(EXIT.USAGE);
    expect(io.stderr[0]).toBe("usage: collie walky {who|send|reply|inbox|status}");
  });
});

describe("the send arguments", () => {
  test("flags before the text, the text after the address", () => {
    expect(parseSendArgs(["local/%2", "a", "--b"])).toEqual({ to: "local/%2", replyTo: null, text: "a --b", json: false });
    expect(parseSendArgs(["--json", "--to", "all", "x"])).toEqual({ to: "all", replyTo: null, text: "x", json: true });
    expect(parseSendArgs(["--reply-to", "bad"])).toEqual({ error: "`bad` is not a message id" });
    expect(parseSendArgs(["--nope"])).toEqual({ error: "unknown flag `--nope`" });
  });
});

describe("on a crew member (CREW_PROTOCOL §21)", () => {
  const member = () =>
    bridge({
      memberId: "laptop",
      outcomesOnLead: true,
      routeRemote: async (message) => [{ id: message.id, target: message.to, state: "accepted", verified: "origin", at: 1, by: "desk" }],
    });

  test("a message for another machine prints `accepted` and says the lead knows the outcome, without waiting", async () => {
    const b = await member();
    let polls = 0;
    const d = deps(b, {}, { sleep: async () => void (polls += 1) });
    expect(await cmdWalkySend(d, ["desk/w2:p2", "hi"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual(["accepted wt_aaaaaaaaaaa1 (outcome known on the lead)"]);
    expect(polls).toBe(1);
    const status = deps(b);
    expect(await cmdWalkyStatus(status, ["wt_aaaaaaaaaaa1"])).toBe(EXIT.OK);
    expect(status.io.stdout).toEqual(["accepted wt_aaaaaaaaaaa1 (outcome known on the lead)"]);
  });

  test("who lists this machine's panes and says the other machines are the lead's to list", async () => {
    const b = await member();
    const d = deps(b);
    expect(await cmdWalkyWho(d, [])).toBe(EXIT.OK);
    expect(d.io.stdout.at(-1)).toBe("other machines: ask the lead (collie walky who there, or the phone)");
  });
});
