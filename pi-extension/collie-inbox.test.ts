import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { beaconKey, INBOX_SUBDIR as BRIDGE_INBOX_SUBDIR, inboxSocketPath } from "../bridge/beacon/paths.ts";
import { INBOX_VERSION as BRIDGE_INBOX_VERSION } from "../bridge/beacon/types.ts";
import { readEnvMarkers } from "../cli/beacon.ts";
import { parseJsonObject, type JsonObject } from "../web/src/lib/json.ts";
import { REQUEST_ID as PHONE_REQUEST_ID } from "../web/src/lib/surface/send.ts";
import {
  activate,
  INBOX_SUBDIR,
  INBOX_VERSION,
  KEEP_REQUEST_IDS,
  MAX_BODY_BYTES,
  markersOf,
  paneKey,
  REQUEST_ID,
  socketPathOf,
  type InboxApi,
  type InboxContext,
  type SessionEvent,
} from "./collie-inbox.ts";

// The pi inbox driven by a fake pi: no pi process. Its sends are recorded, and its idleness is a switch.

const TMUX_ENV = { TMUX_PANE: "%98", TMUX: "/tmp/tmux-501/default,123,0" };

// A literal /tmp: macOS's tmpdir is long enough to push a socket path past sun_path.
const temps: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync("/tmp/collie-inbox-");
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Handler = (event: SessionEvent, ctx: InboxContext | undefined) => Promise<void> | void;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const sent: [string, unknown][] = [];
  const pi: InboxApi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendUserMessage(text, options) {
      sent.push([text, options]);
    },
  };
  const emit = async (event: string, ctx?: InboxContext) => {
    await handlers.get(event)?.({}, ctx);
  };
  return { pi, sent, emit };
}

function context(state: { idle: boolean; file?: string | undefined; mode?: string }): InboxContext {
  return { mode: state.mode ?? "tui", isIdle: () => state.idle, sessionManager: { getSessionFile: () => state.file } };
}

async function call(sock: string, method: string, url: string, body?: string): Promise<[number, JsonObject | undefined]> {
  const res = await fetch(`http://inbox${url}`, { unix: sock, method, body });
  return [res.status, parseJsonObject(await res.text())];
}

const send = (sock: string, body: JsonObject) => call(sock, "POST", "/send", JSON.stringify(body));

/** An inbox opened in a fresh state dir, in a tmux pane. */
async function opened(state: { idle: boolean; file?: string | undefined } = { idle: true, file: "/s/one.jsonl" }) {
  const dir = stateDir();
  const env = { ...TMUX_ENV, XDG_STATE_HOME: dir };
  const fake = fakePi();
  expect(activate(fake.pi, env, "/home/nobody")).toBe(true);
  await fake.emit("session_start", context(state));
  const sock = socketPathOf(env, "/home/nobody")!;
  return { ...fake, env, dir, sock, state };
}

describe("the socket's name is the bridge's", () => {
  const envs = {
    tmux: TMUX_ENV,
    herdr: { HERDR_PANE_ID: "w5:p2", HERDR_SOCKET_PATH: "/run/herdr.sock" },
    "herdr-core": { HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/run/hc.sock" },
    zellij: { ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "work" },
    tern: { TERN_PANE: "4", TERN_PANE_SOCKET: "/run/tern.sock" },
    nested: { ...TMUX_ENV, ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "work" },
  };
  for (const [name, env] of Object.entries(envs)) {
    test(`${name}: the markers, the key and the path match the beacon's and the bridge's`, () => {
      const withState = { ...env, XDG_STATE_HOME: "/tmp/s" };
      expect(markersOf(withState)).toEqual(readEnvMarkers(withState));
      expect(paneKey(markersOf(withState))).toBe(beaconKey(readEnvMarkers(withState)));
      expect(socketPathOf(withState, "/home/x")).toBe(inboxSocketPath(beaconKey(readEnvMarkers(withState)), withState, "/home/x"));
      // With no XDG_STATE_HOME both sides use ~/.local/state, and a bridge's own state dir moves neither.
      expect(socketPathOf(env, "/home/x")).toBe(inboxSocketPath(beaconKey(readEnvMarkers(env)), env, "/home/x"));
      expect(socketPathOf({ ...env, COLLIE_STATE_DIR: "/srv/herdr-collie" }, "/home/x")).toBe(inboxSocketPath(beaconKey(readEnvMarkers(env)), { COLLIE_STATE_DIR: "/srv/elsewhere" }, "/home/x"));
    });
  }

  test("the folder, the wire version and the request-id rule are Collie's", () => {
    expect(INBOX_SUBDIR).toBe(BRIDGE_INBOX_SUBDIR);
    expect(INBOX_VERSION).toBe(BRIDGE_INBOX_VERSION);
    expect(REQUEST_ID.source).toBe(PHONE_REQUEST_ID.source);
  });

  test("outside a multiplexer, or past sun_path, there is no socket and no hook", () => {
    expect(socketPathOf({}, "/home/x")).toBeUndefined();
    expect(socketPathOf({ TMUX_PANE: "%1" }, "/home/x")).toBeUndefined();
    expect(socketPathOf({ ...TMUX_ENV, XDG_STATE_HOME: `/tmp/${"d".repeat(90)}` }, "/home/x")).toBeUndefined();
    const fake = fakePi();
    expect(activate(fake.pi, {}, "/home/x")).toBe(false);
  });
});

describe("opening and closing", () => {
  test("TUI only: print, json and rpc open nothing", async () => {
    const dir = stateDir();
    const env = { ...TMUX_ENV, XDG_STATE_HOME: dir };
    for (const mode of ["print", "json", "rpc"]) {
      const fake = fakePi();
      activate(fake.pi, env, "/home/x");
      await fake.emit("session_start", context({ idle: true, mode }));
      expect(existsSync(socketPathOf(env, "/home/x")!)).toBe(false);
    }
  });

  test("the socket is 0600 in a 0700 folder", async () => {
    const { sock, emit } = await opened();
    expect(lstatSync(sock).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(sock, "..")).mode & 0o777).toBe(0o700);
    await emit("session_shutdown");
  });

  test("a folder that is a link opens nothing", async () => {
    const dir = stateDir();
    const elsewhere = stateDir();
    mkdirSync(join(dir, "collie"));
    symlinkSync(elsewhere, join(dir, "collie", INBOX_SUBDIR));
    const env = { ...TMUX_ENV, XDG_STATE_HOME: dir };
    const fake = fakePi();
    activate(fake.pi, env, "/home/x");
    await fake.emit("session_start", context({ idle: true }));
    expect(existsSync(socketPathOf(env, "/home/x")!)).toBe(false);
  });

  test("shutdown removes the socket; an older instance never removes a newer one's", async () => {
    const first = await opened();
    const second = fakePi();
    activate(second.pi, first.env, "/home/nobody");
    await second.emit("session_start", context({ idle: true, file: "/s/two.jsonl" }));
    // The old instance shuts down after the new one listened (a reload in either order).
    await first.emit("session_shutdown");
    expect(existsSync(first.sock)).toBe(true);
    expect(await call(first.sock, "GET", "/hello")).toMatchObject([200, { sessionFile: "/s/two.jsonl" }]);
    await second.emit("session_shutdown");
    expect(existsSync(first.sock)).toBe(false);
  });
});

describe("/hello", () => {
  test("names pi, the live session file, the pid and the raw markers", async () => {
    const { sock, state, env, emit } = await opened();
    const [status, body] = await call(sock, "GET", "/hello");
    expect(status).toBe(200);
    expect(body).toMatchObject({ agent: "pi", inbox: 1, pid: process.pid, sessionFile: "/s/one.jsonl" });
    expect(body?.markers).toEqual(markersOf(env)); // = readEnvMarkers(env), pinned above
    state.file = "/s/moved.jsonl";
    expect((await call(sock, "GET", "/hello"))[1]?.sessionFile).toBe("/s/moved.jsonl");
    await emit("session_shutdown");
  });

  test("an in-memory session has a null session file", async () => {
    const { sock, emit } = await opened({ idle: true, file: undefined });
    expect((await call(sock, "GET", "/hello"))[1]?.sessionFile).toBeNull();
    await emit("session_shutdown");
  });
});

describe("/send", () => {
  test("idle: taken, delivered once as its own message", async () => {
    const { sock, sent, emit } = await opened();
    expect(await send(sock, { text: "phone one", requestId: "req-00001" })).toEqual([202, { state: "taken" }]);
    expect(sent).toEqual([["phone one", { deliverAs: "followUp" }]]);
    await emit("session_shutdown");
  });

  test("busy: queued as a follow-up; steer only when asked", async () => {
    const { sock, sent, state, emit } = await opened();
    state.idle = false;
    expect(await send(sock, { text: "two", requestId: "req-00002" })).toEqual([202, { state: "queued" }]);
    expect(await send(sock, { text: "three", requestId: "req-00003", steer: true })).toEqual([202, { state: "steered" }]);
    expect(sent).toEqual([
      ["two", { deliverAs: "followUp" }],
      ["three", { deliverAs: "steer" }],
    ]);
    await emit("session_shutdown");
  });

  test("the same request id replays what it answered and runs nothing", async () => {
    const { sock, sent, state, emit } = await opened();
    await send(sock, { text: "once", requestId: "req-00004" });
    state.idle = false;
    expect(await send(sock, { text: "once", requestId: "req-00004" })).toEqual([202, { state: "taken", replayed: true }]);
    expect(sent).toHaveLength(1);
    await emit("session_shutdown");
  });

  test(`only the last ${String(KEEP_REQUEST_IDS)} ids are kept`, async () => {
    const { sock, sent, emit } = await opened();
    for (let i = 0; i <= KEEP_REQUEST_IDS; i++) await send(sock, { text: "x", requestId: `req-${String(i).padStart(5, "0")}` });
    expect(sent).toHaveLength(KEEP_REQUEST_IDS + 1);
    expect((await send(sock, { text: "x", requestId: `req-${String(KEEP_REQUEST_IDS).padStart(5, "0")}` }))[1]?.replayed).toBe(true);
    expect((await send(sock, { text: "x", requestId: "req-00000" }))[1]?.replayed).toBeUndefined();
    await emit("session_shutdown");
  });

  test("a throw from pi is not-taken, runs nothing, and is not kept for replay", async () => {
    const fake = fakePi();
    let fail = true;
    const pi: InboxApi = {
      on: fake.pi.on,
      sendUserMessage(text, options) {
        if (fail) throw new Error("compacting");
        fake.pi.sendUserMessage(text, options);
      },
    };
    const env = { ...TMUX_ENV, XDG_STATE_HOME: stateDir() };
    activate(pi, env, "/home/x");
    await fake.emit("session_start", context({ idle: true }));
    const path = socketPathOf(env, "/home/x")!;
    expect(await send(path, { text: "t", requestId: "req-00005" })).toEqual([409, { code: "not-taken", why: "compacting" }]);
    fail = false;
    expect(await send(path, { text: "t", requestId: "req-00005" })).toEqual([202, { state: "taken" }]);
    expect(fake.sent).toHaveLength(1);
    await fake.emit("session_shutdown");
  });

  test("a bad body runs nothing", async () => {
    const { sock, sent, emit } = await opened();
    for (const body of ['{"text":"no id"}', '{"text":"","requestId":"req-00006"}', '{"text":"x","requestId":"short"}', '{"text":"x","requestId":"req-00006","steer":"yes"}', "not json", "null"]) {
      expect(await call(sock, "POST", "/send", body)).toEqual([400, { code: "bad-request" }]);
    }
    expect(await call(sock, "POST", "/send", JSON.stringify({ text: "x".repeat(MAX_BODY_BYTES), requestId: "req-00007" }))).toEqual([413, { code: "too-large" }]);
    expect(await call(sock, "GET", "/send")).toEqual([404, { code: "not-found" }]);
    expect(sent).toEqual([]);
    await emit("session_shutdown");
  });
});
