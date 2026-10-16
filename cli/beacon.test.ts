import { describe, expect, test } from "bun:test";

import { createHash } from "node:crypto";
import { join } from "node:path";
import { holdInputHash } from "../web/src/lib/surface/hold.ts";
import { HOST } from "../bridge/host.ts";
import { managedSettingsPath } from "./hold-entry.ts";

import { parseBeacon, parseEdge } from "../bridge/beacon/parse.ts";
import { beaconFileName, beaconKey, EDGE_FILE, EDGE_MAX_AGE_MS, EDGE_SPOOL_MAX } from "../bridge/beacon/paths.ts";
import { hookTargetFileName } from "../bridge/beacon/hook-targets.ts";
import { BEACON_SCHEMA_VERSION, type EdgeRecord } from "../bridge/beacon/types.ts";
import { BEACON_HARNESS, BEACON_HOOKS, type BeaconEmitDeps, cmdBeaconEmit, readEnvMarkers, runBeaconEmit, unwrapPrompt } from "./beacon.ts";
import { context, fakeFiles, HOME, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import type { Environment } from "./context.ts";
import type { JsonObject } from "../bridge/json.ts";

// `collie beacon emit`. Everything here is driven through the two seams (`cli/sys.ts`), so no test
// reads a real `/proc`, writes a real state dir, or touches stdin.
//
// The load-bearing assertion in this file is the boring one: EVERY path returns `EXIT.OK`. A hook
// that exits non-zero blocks the operator's prompt, so a beacon that cannot be written must be a
// beacon that is simply absent.

/** The pid the fake `/proc` knows about, and the start time it reports for it. */
const AGENT_PID = 4242;
const START_TIME = 987_654;
const PROC = `/proc/${AGENT_PID}/stat`;
/** A real `/proc/<pid>/stat` shape: the comm field carries spaces AND brackets on purpose. */
const STAT = `${AGENT_PID} (claude (dev)) S 4200 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} ${START_TIME} 0 0`;

const TMUX: Environment = { TMUX_PANE: "%7", TMUX: "/tmp/tmux-1000/default,3311,0" };
const SESSION = "ff2dd3c2-e3d5-40db-9474-eea02e606c6c";

function payload(over: JsonObject = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: "/home/pat/.claude/projects/-x/y.jsonl",
    cwd: "/home/pat/work",
    hook_event_name: "UserPromptSubmit",
    ...over,
  });
}

function deps(
  over: { env?: Environment; stdin?: string; proc?: string | null; pid?: number } = {},
): BeaconEmitDeps & { files: ReturnType<typeof fakeFiles> } {
  const files = fakeFiles(over.proc === null ? {} : { [PROC]: over.proc ?? STAT });
  return {
    ctx: context(over.env ?? TMUX),
    files,
    readStdin: () => Promise.resolve(over.stdin ?? payload()),
    agentPid: over.pid ?? AGENT_PID,
    now: () => 1_700_000_000_000,
    uid: 1000,
  };
}

/** The beacon files a run left behind, by name. */
function beacons(files: ReturnType<typeof fakeFiles>): Map<string, string> {
  const found = new Map<string, string>();
  for (const [path, entry] of files.entries) {
    if (path.startsWith(`${STATE}/beacons/`) && path.endsWith(".json")) {
      found.set(path.slice(`${STATE}/beacons/`.length), entry.text);
    }
  }
  return found;
}

describe("the environment gate", () => {
  test("reads tmux's pane raw, and the SOCKET out of $TMUX — never the server pid with it", () => {
    expect(readEnvMarkers(TMUX)).toEqual([
      { namespace: "tmux", scope: "/tmp/tmux-1000/default", pane: "%7" },
    ]);
  });

  test("reads zellij's pane raw — the `terminal_` prefix belongs to the join, not here", () => {
    expect(readEnvMarkers({ ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "herd" })).toEqual([
      { namespace: "zellij", scope: "herd", pane: "3" },
    ]);
  });

  test("records BOTH when the pane is nested — the emitter cannot know which one Collie drives", () => {
    expect(readEnvMarkers({ ...TMUX, ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "herd" })).toHaveLength(2);
  });

  test("skips a namespace with no scope: `%7` on another server is another pane", () => {
    expect(readEnvMarkers({ TMUX_PANE: "%7" })).toEqual([]);
    expect(readEnvMarkers({ ZELLIJ_PANE_ID: "3" })).toEqual([]);
  });

  test("a plain terminal has nothing at all", () => {
    expect(readEnvMarkers({ HOME: "/home/pat" })).toEqual([]);
  });
});

describe("the status map", () => {
  test("is paseo's four rows, plus `SessionStart` → idle so a launched agent is not a shell", () => {
    expect(BEACON_HOOKS.map((r) => [r.event, r.matcher, r.status])).toEqual([
      ["SessionStart", undefined, "idle"],
      ["UserPromptSubmit", undefined, "working"],
      ["Stop", undefined, "idle"],
      ["SessionEnd", undefined, "idle"],
      ["Notification", undefined, "waiting"],
    ]);
    // The idle kind writes `waiting`; the permission and question kinds write an edge and no beacon.
    expect(BEACON_HOOKS.at(-1)?.details).toEqual({ idle_prompt: "waiting", permission_prompt: null, elicitation_dialog: null });
  });

  test("each event writes its own status", async () => {
    for (const registration of BEACON_HOOKS) {
      const d = deps({ stdin: payload({ hook_event_name: registration.event, notification_type: "idle_prompt" }) });
      expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
      const [text] = [...beacons(d.files).values()];
      expect(parseBeacon(text ?? "")?.status).toBe(registration.status);
    }
  });

  test("`SessionStart` writes an idle beacon before the first prompt, whatever its `source`", async () => {
    for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
      const d = deps({ stdin: payload({ hook_event_name: "SessionStart", source }) });
      expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
      const written = beacons(d.files);
      expect(written.size).toBe(1);
      const [text] = [...written.values()];
      const record = parseBeacon(text ?? "");
      expect(record?.status).toBe("idle");
      // The session ref is set from the first moment — that is what the journal looks history up by.
      expect(record?.session).toEqual({ kind: "id", value: SESSION });
    }
  });

  test("`SessionEnd` with reason `clear` is not the agent leaving — it is an ordinary overwrite", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "SessionEnd", reason: "clear" }) });
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    const [name] = [...beacons(d.files).keys()];
    // Same pane, so the same file the `UserPromptSubmit` above wrote: the next prompt re-keys it.
    const fresh = deps();
    await cmdBeaconEmit(fresh);
    expect([...beacons(fresh.files).keys()]).toEqual([name!]);
  });
});

describe("the beacon it writes", () => {
  test("is one file, named by the digest of its own markers, and the reader accepts it", async () => {
    const d = deps();
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    const written = beacons(d.files);
    expect(written.size).toBe(1);
    const [name, text] = [...written.entries()][0]!;
    const record = parseBeacon(text)!;
    expect(record).toEqual({
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: BEACON_HARNESS,
      session: { kind: "id", value: SESSION },
      status: "working",
      pid: AGENT_PID,
      pidStartTime: START_TIME,
      markers: [{ namespace: "tmux", scope: "/tmp/tmux-1000/default", pane: "%7" }],
      heartbeatMs: 1_700_000_000_000,
    });
    // The reader refuses a record whose name is not its markers' digest, so this is the join working.
    expect(name).toBe(beaconFileName(beaconKey(record.markers)));
  });

  test("carries the session ID, never the payload's transcript_path (.adr/0024)", async () => {
    const d = deps();
    await cmdBeaconEmit(d);
    const [text] = [...beacons(d.files).values()];
    expect(text).not.toContain("transcript_path");
    expect(text).not.toContain(".jsonl");
  });

  test("lands by rename, not by writing the live file — and the temp file does not survive", async () => {
    const d = deps();
    await cmdBeaconEmit(d);
    const renames = d.files.ops.filter((op) => op.startsWith("mv ") && op.includes(`${STATE}/beacons/`));
    expect(renames).toHaveLength(1);
    expect([...d.files.entries.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
  });

  test("the directory is owner-only — anything that can write one can name a pane's agent", async () => {
    const modes: number[] = [];
    const d = deps();
    const spy = { ...d, files: { ...d.files, mkdirp: (_p: string, mode?: number) => void modes.push(mode ?? -1) } };
    await cmdBeaconEmit(spy);
    // The edge spool first, then the beacons directory: both owner-only.
    expect(modes).toEqual([0o700, 0o700]);
  });
});

describe("it never fails, and it never speaks", () => {
  const silent = async (over: Parameters<typeof deps>[0]): Promise<Map<string, string>> => {
    const d = deps(over);
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    return beacons(d.files);
  };

  test("outside a multiplexer it writes nothing — and does not even read stdin", async () => {
    let read = false;
    const d = {
      ...deps({ env: {} }),
      readStdin: () => {
        read = true;
        return Promise.resolve(payload());
      },
    };
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    expect(read).toBe(false);
    expect(beacons(d.files).size).toBe(0);
  });

  test("garbage on stdin is exit 0 and no file", async () => {
    for (const junk of ["not json", "", "[]", "null", '"a string"', "{", '{"a":']) {
      expect((await silent({ stdin: junk })).size).toBe(0);
    }
  });

  test("a subagent's payload is ignored — its session id is not the pane's", async () => {
    expect((await silent({ stdin: payload({ agent_id: "sub-1", agent_type: "explore" }) })).size).toBe(0);
  });

  test("an unregistered event writes nothing", async () => {
    for (const event of ["SessionResume", "PreToolUse", "StopFailure", ""]) {
      expect((await silent({ stdin: payload({ hook_event_name: event }) })).size).toBe(0);
    }
  });

  test("a missing or unusable session id writes nothing", async () => {
    for (const id of [undefined, "", "../../etc/passwd", "a/b", { kind: "id" }, false, 12]) {
      expect((await silent({ stdin: payload({ session_id: id }) })).size).toBe(0);
    }
  });

  test("an unreadable pid start time writes nothing rather than a beacon that reads dead", async () => {
    expect((await silent({ proc: null })).size).toBe(0);
    expect((await silent({ proc: "not a stat line" })).size).toBe(0);
  });

  test("an unwritable state dir is exit 0, not a blocked prompt", async () => {
    const d = deps();
    const boom = {
      ...d,
      files: {
        ...d.files,
        write: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      },
    };
    expect(await cmdBeaconEmit(boom)).toBe(EXIT.OK);
  });

  test("a context that cannot even be resolved is exit 0", async () => {
    expect(
      await runBeaconEmit(() => {
        throw new Error('COLLIE_INSTANCE="v1" needs an explicit COLLIE_PORT');
      }),
    ).toBe(EXIT.OK);
  });

  test("stdin that never resolves as text is exit 0", async () => {
    const d = { ...deps(), readStdin: () => Promise.reject(new Error("EIO")) };
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
  });
});

describe("the hook edges it writes (M56 spec 11)", () => {
  const HERDR: Environment = { HERDR_PANE_ID: "w54:pW", HERDR_SOCKET_PATH: "/home/pat/.config/herdr/herdr.sock" };
  const SALT = "0123456789abcdef0123456789abcdef";

  function edges(files: ReturnType<typeof fakeFiles>): EdgeRecord[] {
    const out: EdgeRecord[] = [];
    for (const [path, entry] of files.entries) {
      const name = path.slice(`${STATE}/edges/`.length);
      if (path.startsWith(`${STATE}/edges/`) && EDGE_FILE.test(name)) {
        const record = parseEdge(entry.text);
        if (record !== null) out.push(record);
      }
    }
    return out;
  }

  test("reads Herdr's pane and socket raw, so a Herdr pane gets edges too", () => {
    expect(readEnvMarkers(HERDR)).toEqual([{ namespace: "herdr", scope: "/home/pat/.config/herdr/herdr.sock", pane: "w54:pW" }]);
  });

  test("each registered event writes one edge with the agent pid, its start time and the markers", async () => {
    for (const registration of BEACON_HOOKS) {
      const d = deps({ env: HERDR, stdin: payload({ hook_event_name: registration.event, notification_type: "idle_prompt" }) });
      expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
      const [edge, ...rest] = edges(d.files);
      expect(rest).toEqual([]);
      expect(edge?.event).toBe(registration.event);
      expect(edge?.pid).toBe(AGENT_PID);
      expect(edge?.pidStartTime).toBe(START_TIME);
      expect(edge?.markers).toEqual(readEnvMarkers(HERDR));
      expect(edge?.at).toBe(1_700_000_000_000);
    }
  });

  test("a permission notification writes an edge with its kind, and no beacon", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" }) });
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    expect(edges(d.files).map((edge) => [edge.event, edge.detail])).toEqual([["Notification", "permission_prompt"]]);
    expect(beacons(d.files).size).toBe(0);
  });

  test("a notification kind it does not list writes nothing at all", async () => {
    for (const kind of ["auth_success", undefined, "Bad Kind"]) {
      const d = deps({ stdin: payload({ hook_event_name: "Notification", notification_type: kind }) });
      expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
      expect(edges(d.files)).toEqual([]);
      expect(beacons(d.files).size).toBe(0);
    }
  });

  test("a tool edge names the tool, the subagent and the hash of the input shown, never the input", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "PostToolUse", tool_name: "Bash", agent_id: "sub-1", tool_input: { command: "touch secret-ish.txt" } }) });
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    const [edge] = edges(d.files);
    expect(edge).toMatchObject({ event: "PostToolUse", tool: "Bash", agent: "sub-1", inputHash: holdInputHash("Bash", "touch secret-ish.txt") });
    const raw = [...d.files.entries].find(([path]) => path.startsWith(`${STATE}/edges/`))?.[1].text ?? "";
    expect(raw).not.toContain("secret");
  });

  test("an edge says holds only when the settings the agent reads hold permissions and no file turns hooks off", async () => {
    const HOLD_ENTRY = JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "/opt/collie beacon hold # collie-beacon v1" }] }] } });
    const userFile = join(HOME, ".claude", "settings.json");
    const run = async (files: Record<string, string>): Promise<boolean | undefined> => {
      const d = deps({ stdin: payload({ hook_event_name: "Stop", cwd: "/work/project" }) });
      for (const [path, text] of Object.entries(files)) d.files.write(path, text);
      await cmdBeaconEmit(d);
      return edges(d.files)[0]?.holds;
    };
    expect(await run({ [userFile]: HOLD_ENTRY })).toBe(true);
    expect(await run({ "/work/project/.claude/settings.json": HOLD_ENTRY })).toBe(true);
    expect(await run({ [userFile]: HOLD_ENTRY, "/work/project/.claude/settings.local.json": '{"disableAllHooks":true}' })).toBeUndefined();
    expect(await run({ [userFile]: HOLD_ENTRY, [managedSettingsPath(HOST.platform)]: '{"allowManagedHooksOnly":true}' })).toBeUndefined();
    expect(await run({ [userFile]: HOLD_ENTRY, [managedSettingsPath(HOST.platform)]: '{"disableAllHooks":true}' })).toBeUndefined();
    expect(await run({})).toBeUndefined();
  });

  test("an edge needs no session id: the pid places it", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "Stop", session_id: undefined }) });
    await cmdBeaconEmit(d);
    expect(edges(d.files)).toHaveLength(1);
    expect(beacons(d.files).size).toBe(0);
  });

  test("a prompt edge holds the salted hash of the prompt, never the text", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "UserPromptSubmit", prompt: "  ship the secret-ish thing \n" }) });
    d.files.write(`${STATE}/sends/.salt`, `${SALT}\n`);
    await cmdBeaconEmit(d);
    const [edge] = edges(d.files);
    const expected = createHash("sha256").update(SALT).update("\u0000").update("ship the secret-ish thing").digest("hex");
    expect(edge?.promptHash).toBe(expected);
    const raw = [...d.files.entries].find(([path]) => path.startsWith(`${STATE}/edges/`))?.[1].text ?? "";
    expect(raw).not.toContain("secret");
  });

  test("a collapsed paste is unwrapped before the hash, so it matches the text the send typed", () => {
    const wrapped = '\n\n<pasted_content id="f27a">\nline 1\nline 2\n</pasted_content id="f27a">\n';
    expect(unwrapPrompt(wrapped).trim()).toBe("line 1\nline 2");
  });

  test("no salt, no hash: the send store never ran here", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "UserPromptSubmit", prompt: "hello" }) });
    await cmdBeaconEmit(d);
    expect(edges(d.files)[0]?.promptHash).toBeNull();
  });

  test("a full spool of fresh edges takes no more: no bridge is taking them", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "Stop" }) });
    d.files.mkdirp(`${STATE}/edges`, 0o700);
    for (let i = 0; i < EDGE_SPOOL_MAX; i++) d.files.write(`${STATE}/edges/1700000000000-1-${i.toString(16)}.json`, "{}");
    await cmdBeaconEmit(d);
    expect(edges(d.files)).toEqual([]);
    expect(beacons(d.files).size).toBe(1);
  });

  test("a full spool first loses its edges older than the bridge would take, then takes the new one", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "Stop" }) });
    d.files.mkdirp(`${STATE}/edges`, 0o700);
    const old = 1_700_000_000_000 - EDGE_MAX_AGE_MS - 1;
    for (let i = 0; i < EDGE_SPOOL_MAX; i++) d.files.write(`${STATE}/edges/${String(i < 10 ? old : 1_700_000_000_000)}-1-${i.toString(16)}.json`, "{}");
    await cmdBeaconEmit(d);
    const names = [...d.files.entries.keys()].filter((path) => path.startsWith(`${STATE}/edges/`));
    expect(names.filter((path) => path.includes(`/${String(old)}-`))).toEqual([]);
    expect(edges(d.files)).toHaveLength(1);
  });

  test("a spool folder another user can write into takes no edge", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "Stop" }) });
    d.files.mkdirp(`${STATE}/edges`, 0o777);
    await cmdBeaconEmit(d);
    expect(edges(d.files)).toEqual([]);
    const owned = deps({ stdin: payload({ hook_event_name: "Stop" }) });
    owned.files.mkdirp(`${STATE}/edges`, 0o700);
    owned.files.rootOwned.add(`${STATE}/edges`);
    await cmdBeaconEmit(owned);
    expect(edges(owned.files)).toEqual([]);
  });

  test("a Herdr pane gets the edge and no beacon file: Herdr names its agents itself", async () => {
    const d = deps({ env: HERDR, stdin: payload({ hook_event_name: "UserPromptSubmit" }) });
    await cmdBeaconEmit(d);
    expect(edges(d.files)).toHaveLength(1);
    expect(beacons(d.files).size).toBe(0);
    const nested = deps({ env: { ...HERDR, ...TMUX }, stdin: payload({ hook_event_name: "UserPromptSubmit" }) });
    await cmdBeaconEmit(nested);
    expect(beacons(nested.files).size).toBe(1);
  });

  test("a subagent's event writes no edge", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "Stop", agent_id: "sub-1" }) });
    await cmdBeaconEmit(d);
    expect(edges(d.files)).toEqual([]);
  });
});

describe("the hook target registry (M56 spec 11)", () => {
  const REGISTRY = "/home/pat/.local/state/collie/hook-targets";
  const A = { dir: "/srv/collie-a", pid: 5001, start: 11, salt: "a".repeat(32) };
  const B = { dir: "/srv/collie-b", pid: 5002, start: 22, salt: "b".repeat(32) };
  const statOf = (pid: number, start: number): string => `${String(pid)} (bun) S 1 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} ${String(start)} 0 0`;

  function withTargets(targets: { dir: string; pid: number; start: number; salt: string; alive?: boolean; file?: string }[], env: Environment = TMUX) {
    const d = deps({ env, stdin: payload({ hook_event_name: "UserPromptSubmit", prompt: "fix the parser" }) });
    d.files.mkdirp(REGISTRY, 0o700);
    for (const t of targets) {
      d.files.write(`${REGISTRY}/${t.file ?? hookTargetFileName(t.dir)}`, JSON.stringify({ schemaVersion: 1, stateDir: t.dir, pid: t.pid, pidStartTime: t.start, bootedAt: 1 }), 0o600);
      d.files.write(`${t.dir}/sends/.salt`, t.salt);
      if (t.alive !== false) d.files.write(`/proc/${String(t.pid)}/stat`, statOf(t.pid, t.start));
    }
    return d;
  }
  function edgesIn(files: ReturnType<typeof fakeFiles>, dir: string): EdgeRecord[] {
    return [...files.entries]
      .filter(([path]) => path.startsWith(`${dir}/edges/`) && EDGE_FILE.test(path.slice(`${dir}/edges/`.length)))
      .flatMap(([, entry]) => {
        const record = parseEdge(entry.text);
        return record === null ? [] : [record];
      });
  }
  const hash = (salt: string): string => createHash("sha256").update(salt).update("\u0000").update("fix the parser").digest("hex");

  test("two live targets: each gets the edge, its prompt hashed with that target's own salt", async () => {
    const d = withTargets([A, B]);
    await cmdBeaconEmit(d);
    expect(edgesIn(d.files, A.dir).map((edge) => edge.promptHash)).toEqual([hash(A.salt)]);
    expect(edgesIn(d.files, B.dir).map((edge) => edge.promptHash)).toEqual([hash(B.salt)]);
    // The default state dir is not a target while bridges are registered and none names it.
    expect(edgesIn(d.files, STATE)).toEqual([]);
  });

  test("a dead target is skipped and its file deleted; a reused pid counts as dead", async () => {
    const d = withTargets([A, { ...B, alive: false }]);
    await cmdBeaconEmit(d);
    expect(edgesIn(d.files, A.dir)).toHaveLength(1);
    expect(edgesIn(d.files, B.dir)).toEqual([]);
    expect(d.files.read(`${REGISTRY}/${hookTargetFileName(B.dir)}`)).toBeNull();
    const reused = withTargets([A]);
    reused.files.write(`/proc/${String(A.pid)}/stat`, statOf(A.pid, 999));
    await cmdBeaconEmit(reused);
    expect(edgesIn(reused.files, A.dir)).toEqual([]);
    expect(edgesIn(reused.files, STATE)).toHaveLength(1);
  });

  test("no registry: the edge goes to the emitter's own state dir, as before", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "Stop" }) });
    await cmdBeaconEmit(d);
    expect(edgesIn(d.files, STATE)).toHaveLength(1);
  });

  test("an explicit COLLIE_STATE_DIR is always a target, beside the registered ones", async () => {
    const d = withTargets([A], { ...TMUX, COLLIE_STATE_DIR: STATE });
    await cmdBeaconEmit(d);
    expect(edgesIn(d.files, A.dir)).toHaveLength(1);
    expect(edgesIn(d.files, STATE)).toHaveLength(1);
  });

  test("XDG_STATE_HOME moves the registry", async () => {
    const d = deps({ env: { ...TMUX, XDG_STATE_HOME: "/xdg" }, stdin: payload({ hook_event_name: "Stop" }) });
    d.files.mkdirp("/xdg/collie/hook-targets", 0o700);
    d.files.write(`/xdg/collie/hook-targets/${hookTargetFileName(A.dir)}`, JSON.stringify({ schemaVersion: 1, stateDir: A.dir, pid: A.pid, pidStartTime: A.start, bootedAt: 1 }));
    d.files.write(`/proc/${String(A.pid)}/stat`, statOf(A.pid, A.start));
    await cmdBeaconEmit(d);
    expect(edgesIn(d.files, A.dir)).toHaveLength(1);
  });
});
