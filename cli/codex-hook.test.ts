import { describe, expect, test } from "bun:test";

import { createHash } from "node:crypto";
import { parseBeacon, parseEdge } from "../bridge/beacon/parse.ts";
import { EDGE_FILE } from "../bridge/beacon/paths.ts";
import type { BeaconRecord, EdgeRecord } from "../bridge/beacon/types.ts";
import type { JsonObject } from "../bridge/json.ts";
import { kindOfEdge } from "../bridge/surface/edges.ts";
import type { ProcessInfo } from "./beacon.ts";
import { CODEX_HOOK_EVENTS, cmdCodexHook, codexHostOf, type CodexHookDeps, runCodexHook } from "./codex-hook.ts";
import type { Environment } from "./context.ts";
import { context, fakeFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";

// `collie beacon codex-hook`, driven through its seams: a fake process table for the climb and the
// arguments, a fake `/proc/<pid>/stat` for the start time, and a fake state dir. The process shapes are
// the ones probed on 2026-11-06 (Codex 0.167.0, hc 0.1.16): `codex --no-daemon` runs a hook as its own
// child with its own environment; plain `codex` runs it from a shared `codex app-server` daemon.
//
// As in cli/beacon.test.ts, the assertion under every test is that the verb returns `EXIT.OK`.

const TUI = 4400;
const SHELL = 4500;
const DAEMON = 4600;
const EXEC = 4700;
const START = 1_793_960_000;
const SOCKET = "/Users/pat/.local/state/herdr-core/default/default.sock";
const CORE: Environment = { HC_TERMINAL_ID: "t1kh", HC_TERMINAL_SOCKET: SOCKET, HC_SCOPE: "default", CODEX_HOME: "/Users/pat/.codex" };
const HERDR: Environment = { HERDR_PANE_ID: "w54:pW", HERDR_SOCKET_PATH: "/home/pat/.config/herdr/herdr.sock" };
const TMUX: Environment = { TMUX_PANE: "%7", TMUX: "/tmp/tmux-1000/default,3311,0" };
const SESSION = "01a1b0a5-b1ce-7951-953b-cd404f5b8c7d";
const SALT = "0123456789abcdef0123456789abcdef";

/** One row of the process table: its name and parent for the climb, its arguments for the host check. */
interface FakeProcess {
  readonly info: ProcessInfo;
  readonly args: readonly string[];
}

const PROCESSES = new Map<number, FakeProcess>([
  [TUI, { info: { comm: "codex", ppid: 4000 }, args: ["/opt/homebrew/bin/codex", "--no-daemon"] }],
  [SHELL, { info: { comm: "zsh", ppid: TUI }, args: ["/bin/zsh", "-lc", "collie beacon codex-hook"] }],
  [DAEMON, { info: { comm: "codex", ppid: 1 }, args: ["/opt/homebrew/bin/codex", "app-server", "--listen", "unix://", "--manage"] }],
  [EXEC, { info: { comm: "codex", ppid: 4000 }, args: ["codex", "exec", "summarise the diff"] }],
]);

/** A `/proc/<pid>/stat` line with the start time in field 22. */
const statOf = (pid: number, start: number): string => `${String(pid)} (codex) S 1 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} ${String(start)} 0 0`;

/** The fields one event adds to the common ones, as probed. */
function eventFields(event: string): JsonObject {
  switch (event) {
    case "SessionStart":
      return { source: "startup" };
    case "UserPromptSubmit":
      return { turn_id: "019a-turn", prompt: "fix the parser" };
    case "Stop":
      return { turn_id: "019a-turn", stop_hook_active: false, last_assistant_message: "done" };
    default:
      return {};
  }
}

/** One hook payload, as Codex 0.167.0 hands it. */
function payload(event: string, over: JsonObject = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: `/Users/pat/.codex/sessions/2026/11/06/rollout-2026-11-06T10-00-00-${SESSION}.jsonl`,
    cwd: "/Users/pat/work",
    hook_event_name: event,
    model: "gpt-6-luna",
    permission_mode: "default",
    ...eventFields(event),
    ...over,
  });
}

function rig(over: { env?: Environment; stdin?: string; parent?: number; args?: (pid: number) => readonly string[] | null } = {}): CodexHookDeps & {
  files: ReturnType<typeof fakeFiles>;
  stdinRead: () => boolean;
} {
  const files = fakeFiles({ [`/proc/${String(TUI)}/stat`]: statOf(TUI, START), [`/proc/${String(DAEMON)}/stat`]: statOf(DAEMON, START), [`/proc/${String(EXEC)}/stat`]: statOf(EXEC, START) });
  let read = false;
  return {
    ctx: context(over.env ?? CORE),
    files,
    readStdin: () => {
      read = true;
      return Promise.resolve(over.stdin ?? payload("SessionStart"));
    },
    parentPid: over.parent ?? TUI,
    readProcess: (pid) => PROCESSES.get(pid)?.info ?? null,
    readArgs: over.args ?? ((pid) => PROCESSES.get(pid)?.args ?? null),
    now: () => 1_793_960_100_000,
    uid: 1000,
    // Linux's probe, so no run of this file forks `ps`, on a Mac either.
    pidProbe: { platform: "linux" },
    stdinRead: () => read,
  };
}

function beacons(files: ReturnType<typeof fakeFiles>): BeaconRecord[] {
  return [...files.entries]
    .filter(([path]) => path.startsWith(`${STATE}/beacons/`) && path.endsWith(".json") && !path.includes("/."))
    .map(([, entry]) => parseBeacon(entry.text))
    .filter((record) => record !== null);
}

function edges(files: ReturnType<typeof fakeFiles>): EdgeRecord[] {
  return [...files.entries]
    .filter(([path]) => path.startsWith(`${STATE}/edges/`) && EDGE_FILE.test(path.slice(`${STATE}/edges/`.length)))
    .map(([, entry]) => parseEdge(entry.text))
    .filter((record) => record !== null);
}

describe("codex: which process a native hook speaks for", () => {
  test("codex: the hook's own parent, when it is the Codex window", () => {
    expect(codexHostOf(rig())).toBe(TUI);
  });

  test("codex: a shell between the window and the hook is climbed past", () => {
    expect(codexHostOf(rig({ parent: SHELL }))).toBe(TUI);
  });

  test("codex: the shared app-server, a `codex exec` run and an unreadable process are no host", () => {
    expect(codexHostOf(rig({ parent: DAEMON }))).toBeNull();
    expect(codexHostOf(rig({ parent: EXEC }))).toBeNull();
    expect(codexHostOf(rig({ args: () => null }))).toBeNull();
  });
});

describe("codex: the gates, in order", () => {
  test("codex: outside every multiplexer nothing is read and nothing is written", async () => {
    const d = rig({ env: { CODEX_HOME: "/Users/pat/.codex" } });
    expect(await cmdCodexHook(d)).toBe(EXIT.OK);
    expect(d.stdinRead()).toBe(false);
    expect(d.files.entries.size).toBe(3);
  });

  test("codex: a hook run by the shared daemon writes nothing, not even an edge", async () => {
    const d = rig({ parent: DAEMON });
    expect(await cmdCodexHook(d)).toBe(EXIT.OK);
    expect(beacons(d.files)).toEqual([]);
    expect(edges(d.files)).toEqual([]);
  });

  test("codex: a hook under `codex exec` writes nothing: that run has no pane of its own", async () => {
    const d = rig({ parent: EXEC });
    expect(await cmdCodexHook(d)).toBe(EXIT.OK);
    expect(beacons(d.files)).toEqual([]);
    expect(edges(d.files)).toEqual([]);
  });

  test("codex: a payload naming a sub-agent writes nothing; the probed payloads name none and write", async () => {
    const sub = rig({ stdin: payload("Stop", { agent_id: "019a-sub" }) });
    expect(await cmdCodexHook(sub)).toBe(EXIT.OK);
    expect(beacons(sub.files)).toEqual([]);
    expect(edges(sub.files)).toEqual([]);
    for (const row of CODEX_HOOK_EVENTS) {
      const main = rig({ stdin: payload(row.event) });
      expect(await cmdCodexHook(main)).toBe(EXIT.OK);
      expect(beacons(main.files).map((b) => b.status)).toEqual([row.status]);
    }
  });

  test("codex: an event the verb does not keep, garbage and a payload with no session id write no beacon", async () => {
    for (const stdin of [payload("PreToolUse"), payload("PermissionRequest"), "not json", "[]", payload("Stop", { session_id: "../../etc" })]) {
      const d = rig({ stdin });
      expect(await cmdCodexHook(d)).toBe(EXIT.OK);
      expect(beacons(d.files)).toEqual([]);
    }
  });

  test("codex: a host whose start time cannot be read writes nothing", async () => {
    const d = rig();
    d.files.remove(`/proc/${String(TUI)}/stat`);
    expect(await cmdCodexHook(d)).toBe(EXIT.OK);
    expect(d.files.entries.size).toBe(2);
  });

  test("codex: a build that throws is still silent and exit 0", async () => {
    expect(
      await runCodexHook(() => {
        throw new Error("no context");
      }),
    ).toBe(EXIT.OK);
  });
});

describe("codex: what it writes on herdr-core", () => {
  test("codex: SessionStart names the core terminal's session, keyed to the Codex window", async () => {
    const d = rig();
    expect(await cmdCodexHook(d)).toBe(EXIT.OK);
    expect(beacons(d.files)).toEqual([
      {
        schemaVersion: 1,
        harness: "codex",
        session: { kind: "id", value: SESSION },
        status: "idle",
        pid: TUI,
        pidStartTime: START,
        markers: [{ namespace: "herdr-core", scope: SOCKET, pane: "t1kh" }],
        heartbeatMs: 1_793_960_100_000,
      },
    ]);
  });

  test("codex: each event's status, the Claude emitter's map: a prompt works, the rest are idle", async () => {
    const statuses: Record<string, string> = {};
    for (const row of CODEX_HOOK_EVENTS) {
      const d = rig({ stdin: payload(row.event) });
      await cmdCodexHook(d);
      statuses[row.event] = beacons(d.files)[0]?.status ?? "none";
    }
    expect(statuses).toEqual({ SessionStart: "idle", UserPromptSubmit: "working", Stop: "idle", SessionEnd: "idle" });
  });

  test("codex: a new session in the same pane (`/new`) overwrites the one beacon file", async () => {
    const d = rig();
    await cmdCodexHook(d);
    const next = "01a1b0a6-0000-7000-8000-000000000001";
    await cmdCodexHook({ ...d, readStdin: () => Promise.resolve(payload("SessionStart", { session_id: next })) });
    expect(beacons(d.files).map((b) => b.session)).toEqual([{ kind: "id", value: next }]);
  });

  test("codex: each event is an edge of the kind the Codex profile maps, the start carrying its model", async () => {
    const kinds: string[] = [];
    for (const row of CODEX_HOOK_EVENTS) {
      const d = rig({ stdin: payload(row.event) });
      await cmdCodexHook(d);
      const [edge] = edges(d.files);
      expect(edge).toMatchObject({ harness: "codex", event: row.event, pid: TUI, pidStartTime: START });
      expect(edge?.model).toBe(row.event === "SessionStart" ? "gpt-6-luna" : undefined);
      if (edge !== undefined) kinds.push(kindOfEdge(edge));
    }
    expect(kinds).toEqual(["start", "prompt", "stop", "end"]);
  });

  test("codex: a prompt edge holds the salted hash of the prompt, never the text", async () => {
    const d = rig({ stdin: payload("UserPromptSubmit") });
    d.files.write(`${STATE}/sends/.salt`, `${SALT}\n`);
    await cmdCodexHook(d);
    const expected = createHash("sha256").update(SALT).update("\u0000").update("fix the parser").digest("hex");
    expect(edges(d.files)[0]?.promptHash).toBe(expected);
    const raw = [...d.files.entries].filter(([path]) => path.startsWith(STATE)).map(([, entry]) => entry.text).join("\n");
    expect(raw).not.toContain("fix the parser");
  });
});

describe("codex: on the other multiplexers", () => {
  test("codex: a Herdr TUI pane gets the edge and no beacon: Herdr names the session itself", async () => {
    const d = rig({ env: HERDR });
    expect(await cmdCodexHook(d)).toBe(EXIT.OK);
    expect(edges(d.files)).toHaveLength(1);
    expect(beacons(d.files)).toEqual([]);
  });

  test("codex: a tmux pane gets both, as Claude's does", async () => {
    const d = rig({ env: TMUX, stdin: payload("UserPromptSubmit") });
    expect(await cmdCodexHook(d)).toBe(EXIT.OK);
    expect(edges(d.files)).toHaveLength(1);
    expect(beacons(d.files).map((b) => [b.markers[0]?.namespace, b.status])).toEqual([["tmux", "working"]]);
  });

  test("codex: a core terminal started inside the Herdr TUI carries both markers and gets the beacon", async () => {
    const d = rig({ env: { ...CORE, ...HERDR } });
    await cmdCodexHook(d);
    expect(beacons(d.files)[0]?.markers.map((m) => m.namespace)).toEqual(["herdr", "herdr-core"]);
  });
});
