import type { ProcessProbe } from "../bridge/proc-probe.ts";
import { edgeModelOf } from "../bridge/beacon/parse.ts";
import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "../bridge/beacon/types.ts";
import type { JsonObject } from "../bridge/json.ts";
import { asJsonString, parseJson, parseJsonObject } from "../web/src/lib/json.ts";
import { holdInputHash, isCwd, shownInput, shownInputOf, HOLD_WIRE_VERSION, type HoldProfile, type HoldRequest } from "../web/src/lib/surface/hold.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { edgeStateDirs, promptHashOf, readEnvMarkers, writeEdge, type BeaconEmitDeps } from "./beacon.ts";
import { attributeCodexHook, forgetSession, type Attribution } from "./codex-attribution.ts";
import { BROKER_DEADLINE_MS, brokerPermission, type ProviderRun } from "./codex-broker.ts";
import { capabilityPath, capabilityVerdict, moshiArgvOf, moshiNow, type MoshiCapability } from "./codex-moshi.ts";
import { foreignPermission, hooksJsonPath } from "./codex-native.ts";
import { readRecord, recordPath, type NativeRecord } from "./codex-native-record.ts";
import type { CliContext } from "./context.ts";
import { EXIT } from "./io.ts";
import { startHoldRun, type HoldDeps } from "./hold.ts";
import type { Files } from "./sys.ts";

// `collie codex-hook`: the one command every native Codex hook entry runs (`collie hooks install codex
// --native`). Codex hands it the event as JSON on stdin; what it does depends on `hook_event_name`.
//
//  - SessionStart, UserPromptSubmit, Stop, Interrupt, SessionEnd, PostToolUse: write a hook edge for the
//    pane's Codex (cli/codex-attribution.ts says which process and why), like `collie beacon emit`
//    does for Claude. It prints NOTHING: on those events a Codex hook's stdout is read as context or as
//    a decision, and an edge is neither.
//  - PermissionRequest: the broker (cli/codex-broker.ts). It prints a decision, or `{}`.
//
// Every path exits 0 and every failure is "no edge" or "no decision", with ONE exception: Moshi-only
// routing (below) hands the permission to the original Moshi command untouched and returns ITS exit
// code, because Moshi-only means Moshi answers exactly as it did before this install, and Codex reads
// that exit code as it always has. A Moshi that cannot start is no decision, exit 0. Everywhere else
// a non-zero exit is not neutral to Codex (exit 2 with a message on stderr is a DENY on a
// PermissionRequest), so this verb never returns one, and it never prints anything but the broker's
// line. Outside a multiplexer it reads nothing and exits at once, except that a PermissionRequest still
// runs the original Moshi command when a broker took Moshi's place, because that entry was Moshi's
// before it was ours.
//
// What an edge is NOT: it is not a control channel (.adr/0024). It asks for a fresh read of the screen
// and ends a "Sent" card; it never sends a key.

/** The harness this verb speaks for, in the journal registry's vocabulary. */
export const CODEX_HARNESS = "codex";

/** The events that write an edge. */
export const CODEX_EDGE_EVENTS: readonly string[] = ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd", "PostToolUse"];

/** The most stdin read. A patch can be long; past this the request is not understood and nothing is decided. */
const STDIN_MAX = 8 * 1024 * 1024;

/** A tool name or a subagent id: printable ASCII, short. */
const TOOL_FIELD = /^[\x20-\x7e]{1,128}$/u;

export interface CodexHookDeps {
  readonly ctx: CliContext;
  readonly files: Files;
  readStdin(): Promise<string>;
  /** This process's pid and its parent as the runtime reports them. */
  readonly selfPid: number;
  readonly parentPid: number;
  readonly uid?: number | undefined;
  readonly probe: ProcessProbe;
  readonly now?: () => number;
  /** Write the line the broker decided, with its line break. */
  print(text: string): Promise<void>;
  /** How the bridges are reached (cli/hold.ts). */
  readonly wire: Pick<HoldDeps, "sockets" | "connect" | "after">;
  /** Starts the original provider command with the payload. Production: {@link spawnProvider}. */
  spawnProvider(argv: readonly string[], payload: string, cancel: MoshiCapability["cancel"]): ProviderRun;
  /** Runs the original provider untouched (Moshi-only routing) and returns its exit code. */
  passThrough(argv: readonly string[], payload: string): Promise<number>;
  readonly after?: (ms: number, run: () => void) => () => void;
  /** The process's own end (SIGTERM, SIGHUP), so a hook Codex gives up on withdraws what it started. */
  readonly signal?: AbortSignal;
}

/** The edge verb's view of the deps, for the writers cli/beacon.ts owns. */
function emitDeps(deps: CodexHookDeps, agentPid: number): BeaconEmitDeps {
  const base: BeaconEmitDeps = { ctx: deps.ctx, files: deps.files, readStdin: deps.readStdin, agentPid, uid: deps.uid, probe: deps.probe };
  return deps.now === undefined ? base : { ...base, now: deps.now };
}

/** One field, read as short printable text, or null. */
function shortField(row: JsonObject, key: string): string | null {
  const value = asJsonString(row[key]);
  return value !== undefined && TOOL_FIELD.test(value) ? value : null;
}

const timer = (ms: number, run: () => void): (() => void) => {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
};

/**
 * The hold request for a PermissionRequest payload: the tool, the input shown and the pane's Codex, in
 * the wire the bridges already speak. Null when it cannot be placed. It never invents what the payload
 * does not say: `cwd` is the hook's own folder, which Codex documents as the session's and not
 * necessarily the folder the tool runs in, so it travels only as a hint for matching a dialog's path
 * and a folder it cannot trust is left out.
 */
export function codexHoldRequest(payload: JsonObject, at: Attribution, hold: HoldProfile, now: number): HoldRequest | null {
  if (at.kind !== "attributed") return null;
  const tool = shortField(payload, "tool_name");
  if (tool === null) return null;
  const shown = shownInputOf(payload.tool_input, hold.inputShown, hold.inputDetails[tool]);
  const agent = shortField(payload, "agent_id");
  const agentType = agent === null ? null : shortField(payload, "agent_type");
  const cwd = asJsonString(payload.cwd);
  const base: HoldRequest = {
    v: HOLD_WIRE_VERSION,
    harness: CODEX_HARNESS,
    pid: at.pid,
    pidStartTime: at.pidStartTime,
    markers: at.markers,
    tool,
    input: shown.text,
    agent,
    // A cut input is answered on the screen: a person cannot judge what the card does not show.
    hold: !hold.screenOnly.includes(tool) && !shown.cut,
    at: now,
  };
  const withType = agentType === null ? base : { ...base, agentType };
  const withCwd = cwd !== undefined && isCwd(cwd) ? { ...withType, cwd } : withType;
  return shown.cut ? { ...withCwd, cut: true } : withCwd;
}

/** The edge for one event, or null when this event is not an edge. */
function edgeFor(deps: CodexHookDeps, payload: JsonObject, event: string, at: Extract<Attribution, { kind: "attributed" }>, holds: boolean, stateDir: string): EdgeRecord | null {
  const now = (deps.now ?? Date.now)();
  let record: EdgeRecord = {
    schemaVersion: EDGE_SCHEMA_VERSION,
    harness: CODEX_HARNESS,
    event,
    detail: null,
    pid: at.pid,
    pidStartTime: at.pidStartTime,
    markers: at.markers,
    at: now,
    promptHash: event === "UserPromptSubmit" ? promptHashOf(emitDeps(deps, at.pid), stateDir, payload) : null,
    holds,
  };
  if (event === "SessionStart") {
    const model = edgeModelOf(payload.model);
    if (model !== null) record = { ...record, model };
  }
  if (event === "PostToolUse") {
    const hold = loadProfiles().get(CODEX_HARNESS)?.hold;
    const tool = shortField(payload, "tool_name");
    const agent = shortField(payload, "agent_id");
    if (tool !== null) record = { ...record, tool };
    if (agent !== null) record = { ...record, agent };
    // The input shown, hashed as the hold hashed it: the bridge ends only the hold of this very call.
    if (tool !== null && hold !== undefined) record = { ...record, inputHash: holdInputHash(tool, shownInput(payload.tool_input, hold.inputShown, hold.inputDetails[tool])) };
  }
  return record;
}

/** The edge half: one event in, at most one edge per live bridge out. Prints nothing. */
function writeEdges(deps: CodexHookDeps, payload: JsonObject, event: string, record: NativeRecord | null): void {
  if (readEnvMarkers(deps.ctx.env).length === 0) return;
  const session = shortField(payload, "session_id") ?? undefined;
  const subagent = payload.agent_id !== undefined && payload.agent_id !== null;
  // A SUBAGENT IS NOT THE PANE: its turn ends are not the session's. Only its tool edges count.
  if (subagent && event !== "PostToolUse") return;
  const at = attributeCodexHook({ probe: deps.probe, files: deps.files, env: deps.ctx.env, stateDir: deps.ctx.stateDir, selfPid: deps.selfPid, parentPid: deps.parentPid, session });
  if (event === "SessionEnd") forgetSession({ files: deps.files, stateDir: deps.ctx.stateDir }, session);
  if (at.kind !== "attributed") return;
  const edge = edgeFor(deps, payload, event, at, record?.hold === true, deps.ctx.stateDir);
  if (edge === null) return;
  const emit = emitDeps(deps, at.pid);
  for (const stateDir of edgeStateDirs(emit)) {
    try {
      writeEdge(emit, stateDir, edge);
    } catch {
      // No edge for this target. The screen still reads the pane on its own poll.
    }
  }
}

/** Whether hooks.json names a Moshi `codex-hook` on PermissionRequest that is not Collie's. A file that is there and cannot be read counts as yes. */
function foreignMoshiPresent(deps: CodexHookDeps): boolean {
  const text = deps.files.read(hooksJsonPath(deps.ctx));
  if (text === null) return false;
  const document = parseJson(text);
  return document === undefined || foreignPermission(document).moshi > 0;
}

/**
 * The permission half. The voices: the original Moshi command (only when a broker took its place and
 * the capability record still describes the installed Moshi), and the Collie hold (only when this
 * install holds and the hook can be placed on a pane).
 */
async function decide(deps: CodexHookDeps, raw: string, payload: JsonObject, record: NativeRecord): Promise<number> {
  const profile = loadProfiles().get(CODEX_HARNESS)?.hold;
  let provider: ((cancel: MoshiCapability["cancel"]) => ProviderRun) | null = null;
  let cancel: MoshiCapability["cancel"] | null = null;
  if (record.moshi !== null) {
    const argv = moshiArgvOf(record.moshi.command);
    if (argv === null) {
      await deps.print("{}");
      return EXIT.OK;
    }
    const verdict = capabilityVerdict(deps.files.read(capabilityPath(deps.ctx.configDir)), record.moshi.command, moshiNow(deps.files, record.moshi.command));
    if (!verdict.ok) {
      // MOSHI-ONLY ROUTING: the proof no longer describes this Moshi (it was updated, replaced or never
      // proven), so the Collie hold stays off and Moshi answers exactly as it did before the install.
      return await deps.passThrough(argv, raw);
    }
    cancel = verdict.capability.cancel;
    const method = verdict.capability.cancel;
    provider = () => deps.spawnProvider(argv, raw, method);
  }
  const now = (deps.now ?? Date.now)();
  // A MOSHI ENTRY THAT IS NOT OURS sits on this event beside this one (Moshi, or the person, added it after
  // the install, or in a spelling the install did not take over). Its phone card is not withdrawn when
  // Collie decides first (issue #595), so the Collie hold is off while it is there, and so is the broker's
  // own start of Moshi: that other entry is Moshi, and answers by itself. No decision; Codex asks as usual.
  // A hooks.json that is present and unreadable cannot be shown to hold none, so it counts the same way.
  if (record.hold && foreignMoshiPresent(deps)) {
    await deps.print("{}");
    return EXIT.OK;
  }
  const request = record.hold && profile !== undefined
    ? codexHoldRequest(payload, attributeCodexHook({ probe: deps.probe, files: deps.files, env: deps.ctx.env, stateDir: deps.ctx.stateDir, selfPid: deps.selfPid, parentPid: deps.parentPid, session: shortField(payload, "session_id") ?? undefined }), profile, now)
    : null;
  const limit = profile?.limitMs ?? BROKER_DEADLINE_MS;
  const after = deps.after ?? timer;
  const result = await brokerPermission(
    {
      startProvider: () => (provider === null || cancel === null ? null : provider(cancel)),
      startHold: () => (request === null ? null : startHoldRun({ ...deps.wire, ctx: deps.ctx, files: deps.files, uid: deps.uid, probe: deps.probe }, request, limit)),
      after,
      denyMessage: profile?.denyMessage ?? "The person denied this from Collie.",
      deadlineMs: limit,
      graceMs: cancel?.graceMs,
    },
    deps.signal,
  );
  await deps.print(result.output);
  return EXIT.OK;
}

/** `collie codex-hook`. Returns `EXIT.OK` on every path but one: Moshi-only routing returns the original Moshi command's own exit code. */
export async function cmdCodexHook(deps: CodexHookDeps): Promise<number> {
  try {
    const raw = await deps.readStdin();
    if (raw.length > STDIN_MAX) return EXIT.OK;
    const payload = parseJsonObject(raw);
    if (payload === undefined) return EXIT.OK;
    const event = asJsonString(payload.hook_event_name);
    if (event === undefined) return EXIT.OK;
    const record = readRecord(deps.files, recordPath(deps.ctx));
    if (event === "PermissionRequest") {
      // No record: this entry is not one an install of ours wrote. Say nothing about the permission.
      if (record === null) {
        await deps.print("{}");
        return EXIT.OK;
      }
      return await decide(deps, raw, payload, record);
    }
    if (CODEX_EDGE_EVENTS.includes(event)) writeEdges(deps, payload, event, record);
    return EXIT.OK;
  } catch {
    return EXIT.OK;
  }
}

/** The verb, with its dependency construction inside the same guarantee. */
export async function runCodexHook(build: () => CodexHookDeps): Promise<number> {
  try {
    return await cmdCodexHook(build());
  } catch {
    return EXIT.OK;
  }
}
