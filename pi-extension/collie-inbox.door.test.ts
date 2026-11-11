import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { inboxDir } from "../bridge/beacon/paths.ts";
import { tryDoor, type DoorTry } from "../bridge/door/door.ts";
import { piDoor } from "../bridge/door/pi.ts";
import type { TmuxExec } from "../bridge/mux/tmux/exec.ts";
import { tmuxBeaconMatcher } from "../bridge/mux/tmux/markers.ts";
import { activate, type InboxApi, type InboxContext, type SessionEvent } from "./collie-inbox.ts";

// The bridge's pi door against the real inbox extension, over a real unix socket, with a fake pi. The
// extension's tests drive the socket by hand and the door's tests fake the socket; this is where the two
// meet: the extension's env markers must digest to the name the door finds, through tmux's own beacon
// matcher (ADR 0141 point 7), and the door must read every answer the extension gives.

const SCOPE = "/tmp/tmux-501/default";
const PANE = "%98";
const HOME = "/home/nobody";
const TARGET = { session: "main", paneId: PANE, harness: "pi" };
const BUDGET_MS = 3000;

// The real path of /tmp: the door walks every path part with lstat, and macOS's /tmp is a link. It is a
// literal /tmp too, because macOS's $TMPDIR is long enough to push a socket path past sun_path.
const temps: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(realpathSync("/tmp"), "cpj-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** tmux as the matcher asks it: one question, the server's socket path. */
const tmuxAt = (scope: string): TmuxExec => ({
  run: () => Promise.resolve({ code: 0, stdout: `${scope}\n`, stderr: "" }),
  control: () => {
    throw new Error("the matcher opens no control client");
  },
});

type Handler = (event: SessionEvent, ctx: InboxContext | undefined) => Promise<void> | void;

/** pi in a tmux pane with the inbox loaded and its session started, and the bridge's door for that pane. */
async function piInPane(state: { idle: boolean; file: string | undefined; throws?: string }, paneSession: { file: string | undefined }) {
  const dir = stateDir();
  const env = { TMUX_PANE: PANE, TMUX: `${SCOPE},123,0`, XDG_STATE_HOME: dir };
  const handlers = new Map<string, Handler>();
  const sent: [string, unknown][] = [];
  const pi: InboxApi = {
    on: (event, handler) => void handlers.set(event, handler),
    sendUserMessage(text, options) {
      if (state.throws !== undefined) throw new Error(state.throws);
      sent.push([text, options]);
    },
  };
  const ctx: InboxContext = { mode: "tui", isIdle: () => state.idle, sessionManager: { getSessionFile: () => state.file } };
  expect(activate(pi, env, HOME)).toBe(true);
  await handlers.get("session_start")?.({}, ctx);
  const door = piDoor({
    dir: inboxDir(env, HOME),
    matcher: tmuxBeaconMatcher("tmux", tmuxAt(SCOPE)),
    sessionOf: (paneId) => (paneId === PANE && paneSession.file !== undefined ? { kind: "path", value: paneSession.file } : undefined),
  });
  const send = (text: string, requestId: string, target = TARGET): Promise<DoorTry> => tryDoor(door, target, { text, requestId }, BUDGET_MS);
  const shutdown = async () => {
    await handlers.get("session_shutdown")?.({}, undefined);
  };
  return { sent, send, shutdown, state, paneSession };
}

describe("the bridge's pi door and the real inbox", () => {
  test("the pane's own pi takes the text: idle starts a turn, busy queues a follow-up, the same id replays", async () => {
    const pi = await piInPane({ idle: true, file: "/s/one.jsonl" }, { file: "/s/one.jsonl" });
    try {
      expect(await pi.send("phone one", "req-join-0001")).toEqual({ kind: "submitted", answer: { kind: "taken" } });
      pi.state.idle = false;
      expect(await pi.send("phone two", "req-join-0002")).toEqual({ kind: "submitted", answer: { kind: "queued" } });
      expect(await pi.send("phone one", "req-join-0001")).toEqual({ kind: "submitted", answer: { kind: "replayed" } });
      // Never a steer: the door asks for none, so even a busy pi gets a follow-up of its own (V13).
      expect(pi.sent).toEqual([
        ["phone one", { deliverAs: "followUp" }],
        ["phone two", { deliverAs: "followUp" }],
      ]);
    } finally {
      await pi.shutdown();
    }
  });

  test("another session file refuses before anything is sent, and the new session binds after pi's /new", async () => {
    const pi = await piInPane({ idle: true, file: "/s/one.jsonl" }, { file: "/s/other.jsonl" });
    try {
      expect(await pi.send("phone one", "req-join-0003")).toEqual({ kind: "refused", why: "pi's session file is not the one the pane names" });
      // pi moved to a new session; the multiplexer names it too.
      pi.state.file = "/s/new.jsonl";
      pi.paneSession.file = "/s/new.jsonl";
      expect(await pi.send("phone one", "req-join-0003")).toEqual({ kind: "submitted", answer: { kind: "taken" } });
      expect(pi.sent).toEqual([["phone one", { deliverAs: "followUp" }]]);
    } finally {
      await pi.shutdown();
    }
  });

  test("another pane, an in-memory session, or a pane that names none refuses", async () => {
    const pi = await piInPane({ idle: true, file: undefined }, { file: "/s/one.jsonl" });
    try {
      expect(await pi.send("x", "req-join-0004", { ...TARGET, paneId: "%99" })).toEqual({ kind: "refused", why: "the pane names no pi session file" });
      expect(await pi.send("x", "req-join-0004")).toEqual({ kind: "refused", why: "pi's session has no file" });
      pi.paneSession.file = undefined;
      expect(await pi.send("x", "req-join-0004")).toEqual({ kind: "refused", why: "the pane names no pi session file" });
      expect(pi.sent).toEqual([]);
    } finally {
      await pi.shutdown();
    }
  });

  test("a message pi does not take is a refusal, so the send falls back to the screen; the id is free again", async () => {
    const pi = await piInPane({ idle: true, file: "/s/one.jsonl", throws: "pi is compacting" }, { file: "/s/one.jsonl" });
    try {
      expect(await pi.send("phone one", "req-join-0005")).toEqual({ kind: "refused", why: "pi answered 409" });
      pi.state.throws = undefined;
      expect(await pi.send("phone one", "req-join-0005")).toEqual({ kind: "submitted", answer: { kind: "taken" } });
    } finally {
      await pi.shutdown();
    }
  });

  test("pi gone: no socket is left, and the door refuses", async () => {
    const pi = await piInPane({ idle: true, file: "/s/one.jsonl" }, { file: "/s/one.jsonl" });
    await pi.shutdown();
    expect(await pi.send("phone one", "req-join-0006")).toEqual({ kind: "refused", why: "no pi inbox is open" });
  });
});
