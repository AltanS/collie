// pi's door binds a pane only where pi's session file is the one the pane names (ADR 0141 point 3,
// SPEC V10), finds the pane's socket by the markers it reports (point 7, V11), and reads pi's answers
// the way the seam needs them: what ran nothing refuses, anything else that is not a hint is uncertain.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import { parseInboxHello } from "../beacon/parse.ts";
import { beaconKey, inboxSocketName } from "../beacon/paths.ts";
import type { BeaconMarker } from "../beacon/types.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import { tryDoor, type DoorAnswer, type Preflight } from "./door.ts";
import { HELLO_MS, piDoor, SYSTEM_INBOX_IO, type InboxIo, type InboxReply } from "./pi.ts";

const DIR = "/state/collie/inbox";
const SCOPE = "/run/herdr.sock";
const PANE = "w1:p1";
const FILE = "/home/u/.pi/agent/sessions/--home-u-work--/2026-11-09T12-57-34-640Z_01a1.jsonl";
const TARGET = { session: "main", paneId: PANE, harness: "pi" };
const SEND = { requestId: "req_door_pi_0001", text: "hello pi" };
const never = new AbortController().signal;

const MATCHER: BeaconMatcher = {
  namespace: "herdr",
  scope: () => Promise.resolve(SCOPE),
  matches: (pane, marker, scope) => marker.pane === pane.paneId && marker.scope === scope,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};

const markersOf = (pane: string, ...nested: BeaconMarker[]): BeaconMarker[] => [{ namespace: "herdr", scope: SCOPE, pane }, ...nested];
const nameOf = (markers: readonly BeaconMarker[]): string => inboxSocketName(beaconKey(markers));
const helloText = (markers: readonly BeaconMarker[], sessionFile: string | null = FILE, agent = "pi"): string => JSON.stringify({ agent, inbox: 1, pid: 42, sessionFile, markers });

/** One socket in the fake folder: its `/hello` and `/send` answers, or a fault that refuses a connect. */
interface FakeSocket {
  readonly hello?: InboxReply | "hang";
  readonly send?: InboxReply | "drop";
  readonly problem?: string;
}

/** The fake inbox folder: socket names to sockets. */
type Sockets = Record<string, FakeSocket>;

interface Fake {
  readonly io: InboxIo;
  readonly sent: { path: string; body: string }[];
  readonly listed: string[];
}

function fakeIo(sockets: Sockets): Fake {
  const sent: { path: string; body: string }[] = [];
  const listed: string[] = [];
  const at = (path: string): FakeSocket => sockets[path.slice(DIR.length + 1)] ?? {};
  const io: InboxIo = {
    list: (dir) => {
      listed.push(dir);
      return Promise.resolve(Object.keys(sockets));
    },
    problem: (path) => Promise.resolve(at(path).problem ?? null),
    request: (path, route, body, signal) => {
      const socket = at(path);
      if (route === "/hello") {
        if (socket.hello === "hang") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
        return socket.hello === undefined ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve(socket.hello);
      }
      sent.push({ path, body: body ?? "" });
      if (socket.send === "drop" || socket.send === undefined) return Promise.reject(new Error("socket closed"));
      return Promise.resolve(socket.send);
    },
  };
  return { io, sent, listed };
}

/** The pane's own socket, answering `/hello` with `sessionFile`, and `/send` with `send`. */
function paneSocket(sessionFile: string | null = FILE, send: InboxReply | "drop" = { status: 202, text: '{"state":"taken"}' }) {
  const markers = markersOf(PANE);
  return { [nameOf(markers)]: { hello: { status: 200, text: helloText(markers, sessionFile) }, send } } satisfies Sockets;
}

/** One preflight on the fake folder, and the fake it ran on. */
interface Attempt {
  readonly fake: Fake;
  readonly result: Promise<Preflight>;
}

/** `ref` null: the pane names no session. */
function preflight(sockets: Sockets, ref: AgentSessionRef | null = { kind: "path", value: FILE }): Attempt {
  const fake = fakeIo(sockets);
  const door = piDoor({ dir: DIR, matcher: MATCHER, sessionOf: (paneId) => (paneId === PANE ? (ref ?? undefined) : undefined), io: fake.io });
  return { fake, result: door.preflight(TARGET, never) };
}

async function why(result: Promise<Preflight>): Promise<string> {
  const answer = await result;
  if (answer.ok) throw new Error("the door bound");
  return answer.why;
}

async function submitted(send: InboxReply | "drop"): Promise<{ fake: Fake; answer: Promise<DoorAnswer> }> {
  const { fake, result } = preflight(paneSocket(FILE, send));
  const answer = await result;
  if (!answer.ok) throw new Error(answer.why);
  return { fake, answer: answer.door.submit(SEND, never) };
}

describe("pi's door binds by the session file (V10)", () => {
  test("pi's session file equal to the pane's binds the door, and the text goes to that socket", async () => {
    const { fake, answer } = await submitted({ status: 202, text: '{"state":"taken"}' });
    expect(await answer).toEqual({ kind: "taken" });
    expect(fake.sent).toEqual([{ path: join(DIR, nameOf(markersOf(PANE))), body: JSON.stringify({ text: SEND.text, requestId: SEND.requestId }) }]);
  });

  test("another session file refuses, and the seam falls back to the screen", async () => {
    expect(await why(preflight(paneSocket("/home/u/.pi/agent/sessions/other.jsonl")).result)).toBe("pi's session file is not the one the pane names");
    // Byte for byte: a spelling that names the same file still refuses.
    expect(await why(preflight(paneSocket(`${FILE}/`)).result)).toBe("pi's session file is not the one the pane names");
    const fake = fakeIo(paneSocket("/elsewhere.jsonl"));
    const door = piDoor({ dir: DIR, matcher: MATCHER, sessionOf: () => ({ kind: "path", value: FILE }), io: fake.io });
    expect((await tryDoor(door, TARGET, SEND, 1000)).kind).toBe("refused");
    expect(fake.sent).toEqual([]);
  });

  test("a pane that names no session file refuses before any socket is asked", async () => {
    for (const ref of [null, { kind: "id", value: FILE } as const]) {
      const { fake, result } = preflight(paneSocket(), ref);
      expect(await why(result)).toBe("the pane names no pi session file");
      expect(fake.listed).toEqual([]);
    }
  });

  test("a pi session with no file refuses", async () => {
    expect(await why(preflight(paneSocket(null)).result)).toBe("pi's session has no file");
  });

  test("an inbox that is not pi's refuses", async () => {
    const markers = markersOf(PANE);
    const sockets = { [nameOf(markers)]: { hello: { status: 200, text: helloText(markers, FILE, "omp") } } };
    expect(await why(preflight(sockets).result)).toBe("the inbox is omp's, not pi's");
  });
});

describe("pi's door finds the pane's socket by its markers (V11)", () => {
  test("a nested pane binds: the join reads this multiplexer's marker, the name is every marker's digest", async () => {
    const markers = markersOf(PANE, { namespace: "tmux", scope: "/tmp/tmux-501/default", pane: "%3" });
    const { result } = preflight({ [nameOf(markers)]: { hello: { status: 200, text: helloText(markers) } } });
    expect((await result).ok).toBe(true);
  });

  test("no socket, or only another pane's, refuses", async () => {
    expect(await why(preflight({}).result)).toBe("no pi inbox is open");
    const other = markersOf("w1:p2");
    expect(await why(preflight({ [nameOf(other)]: { hello: { status: 200, text: helloText(other) } } }).result)).toBe("no pi inbox names this pane");
  });

  test("two sockets that name the pane refuse: ambiguity is absence", async () => {
    const one = markersOf(PANE);
    const two = markersOf(PANE, { namespace: "zellij", scope: "s", pane: "3" });
    const sockets = { [nameOf(one)]: { hello: { status: 200, text: helloText(one) } }, [nameOf(two)]: { hello: { status: 200, text: helloText(two) } } };
    expect(await why(preflight(sockets).result)).toBe("more than one pi inbox names this pane");
  });

  test("a socket that fails the path check, or whose name is not its markers' digest, is not asked or not believed", async () => {
    const markers = markersOf(PANE);
    expect(await why(preflight({ [nameOf(markers)]: { problem: "the socket's folder is a link", hello: { status: 200, text: helloText(markers) } } }).result)).toBe("no pi inbox names this pane");
    const squatter = nameOf(markersOf("w9:p9"));
    expect(await why(preflight({ [squatter]: { hello: { status: 200, text: helloText(markers) } } }).result)).toBe("no pi inbox names this pane");
  });

  test("a name still being bound, or another file, is not a socket", async () => {
    const markers = markersOf(PANE);
    const key = beaconKey(markers);
    expect(await why(preflight({ [`${key}-ab12.sock`]: { hello: { status: 200, text: helloText(markers) } }, [`${key}.json`]: {} }).result)).toBe("no pi inbox is open");
  });

  test("a wedged pi in another pane does not hold up this one", async () => {
    const other = markersOf("w1:p2");
    const started = Date.now();
    const { result } = preflight({ ...paneSocket(), [nameOf(other)]: { hello: "hang" } });
    expect((await result).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(HELLO_MS + 1000);
  });
});

describe("pi's answers", () => {
  test("taken, queued and a replay are hints", async () => {
    expect(await (await submitted({ status: 202, text: '{"state":"queued"}' })).answer).toEqual({ kind: "queued" });
    expect(await (await submitted({ status: 202, text: '{"state":"taken","replayed":true}' })).answer).toEqual({ kind: "replayed" });
  });

  test("what ran nothing refuses", async () => {
    for (const status of [400, 404, 409, 413]) {
      expect(await (await submitted({ status, text: '{"code":"not-taken"}' })).answer).toEqual({ kind: "refused", why: `pi answered ${String(status)}` });
    }
  });

  test("anything else may have reached pi, so it throws and the seam calls it uncertain (V23)", async () => {
    for (const send of [{ status: 500, text: "" }, { status: 202, text: "{}" }, { status: 202, text: '{"state":"steered"}' }, "drop"] as const) {
      await expect((await submitted(send)).answer).rejects.toThrow();
    }
    const fake = fakeIo(paneSocket(FILE, "drop"));
    const door = piDoor({ dir: DIR, matcher: MATCHER, sessionOf: () => ({ kind: "path", value: FILE }), io: fake.io });
    expect((await tryDoor(door, TARGET, SEND, 1000)).kind).toBe("uncertain");
  });
});

describe("parseInboxHello", () => {
  test("reads the session file raw, and skips another wire version or no markers", () => {
    const markers = markersOf(PANE);
    expect(parseInboxHello(helloText(markers, ` ${FILE}`))?.sessionFile).toBe(` ${FILE}`);
    expect(parseInboxHello(JSON.stringify({ agent: "pi", inbox: 2, sessionFile: FILE, markers }))).toBeNull();
    expect(parseInboxHello(JSON.stringify({ agent: "pi", inbox: 1, sessionFile: FILE, markers: [] }))).toBeNull();
    expect(parseInboxHello(JSON.stringify({ agent: "pi", inbox: 1, sessionFile: 7, markers }))).toBeNull();
  });
});

describe("SYSTEM_INBOX_IO", () => {
  // `/tmp` directly: a unix socket path must fit in 104 bytes on macOS, and `$TMPDIR` does not.
  const dir = mkdtempSync("/tmp/cpi-");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a GET and a POST reach a unix socket, and a missing folder lists nothing", async () => {
    const path = join(dir, "a.sock");
    const server = Bun.serve({
      unix: path,
      fetch: async (request) => (request.method === "POST" ? Response.json({ got: await request.json() }, { status: 202 }) : Response.json({ route: new URL(request.url).pathname })),
    });
    try {
      expect(await SYSTEM_INBOX_IO.request(path, "/hello", undefined, never)).toEqual({ status: 200, text: '{"route":"/hello"}' });
      expect(await SYSTEM_INBOX_IO.request(path, "/send", '{"text":"x"}', never)).toEqual({ status: 202, text: '{"got":{"text":"x"}}' });
    } finally {
      await server.stop(true);
    }
    expect(await SYSTEM_INBOX_IO.list(join(dir, "missing"))).toEqual([]);
  });
});
