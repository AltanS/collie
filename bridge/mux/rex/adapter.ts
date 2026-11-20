// REX, BEHIND THE CONTRACT — driving Superlogical's Rex terminal multiplexer through its `rex` CLI.
//
// Everything above this file talks the mux port (../types.ts); everything below it — exec.ts,
// protocol.ts, keys.ts, watch.ts — talks rex. So this module is the whole translation. Every fact
// cited here was probed on rex 0.0.1795019727 (API revision 18), the Linux server, on 2026-11-19
// (MUX_CONTRACT.md, source **RX**). Rex is a beta and says its commands may change; the adapter is
// marked experimental for that reason.
//
// ── THE MAPPING ─────────────────────────────────────────────────────────────────────────────────
//
//   rex session  →  Collie SPACE   (`session:<uuid>`)
//   rex window   →  Collie TAB     (`window:<uuid>`)
//   rex block    →  Collie PANE    (`block:<uuid>`, terminal blocks only)
//
// Every id is a UUID the server mints and keeps across a rename, so each is carried through
// unchanged (identity rule 2). A block that is not a terminal (Rex lets programs place other kinds)
// has no screen to read and is not a pane. Labels are what the operator can change: a window labelled
// `Window <last 8 of its id>` is rex's own default and reads as unnamed.
//
// ── AGENTS ──────────────────────────────────────────────────────────────────────────────────────
//
// Rex keeps what a program reports about itself with OSC 7501 (`program_status`): a state and the
// program's name for itself. Claude Code sends it unprompted — probed, a fresh `claude` in a block
// reported `{ state: "blocked", kind: "permission", app: "claude-code" }` at its trust dialog, and the
// record was removed when it exited. So `agentDetection` is declared with no beacon decorator for the
// agent; the hooks add only the conversation id (markers.ts, session-only mode).
//
// ── FOCUS ───────────────────────────────────────────────────────────────────────────────────────
//
// Rex keeps an active window per session and a focused block per window ON THE SERVER, whether or not
// anyone is looking. `MuxPane.focused` means the pane a person's terminal SHOWS, so a pane is focused
// only when a client is attached to its session (`rex client ls -s <session>`), its window is the
// active one, and it is that window's focused block. With no Rex app attached, which is every
// headless server, no pane is focused, and that is the honest answer (MuxPane.focused).

import { MUX_AGENT_NAMES } from "../agents.ts";
import type { AgentStatus } from "../../types.ts";
import { declareCapabilities } from "../capabilities.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
  muxUnconfirmed,
  muxUnreachable,
  muxUnsupported,
  requestedCwd,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxPane,
  type MuxRefusalOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTab,
  type MuxTabRequest,
  type MuxWatchOptions,
} from "../types.ts";
import {
  noRexBinaryMessage,
  resolveRexBinary,
  rexBinaryCandidates,
  SpawnRexExec,
  TIMED_OUT_CODE,
  type RexExec,
  type RexRunResult,
} from "./exec.ts";
import { REX_UNSENDABLE_KEYS, toRexKey } from "./keys.ts";
import { REX_LOGO_SVG } from "./logo.ts";
import { rexBeaconMatcher } from "./markers.ts";
import {
  isDefaultWindowLabel,
  keepSgrOnly,
  parseClientCount,
  parseCreated,
  parseProcess,
  parseProgramStatus,
  parseRows,
  parseSessions,
  parseApiRevision,
  parseBlobPart,
  parseFormatted,
  parseTitle,
  parseView,
  REX_TERMINAL_CREATOR,
  saysNotFound,
  saysUnreachable,
  stripEscapes,
  untestedRevisionNote,
  type RexBlobPart,
  type RexCreated,
  type RexFormatted,
  type RexProcess,
  type RexSession,
  type RexStatusRecord,
  type RexView,
} from "./protocol.ts";
import { RexWatch } from "./watch.ts";

export const REX_MUX = "rex";

/** `MuxTarget.options` key carrying the rex binary's absolute path. Opaque to the registry, by rule. */
export const REX_BINARY_OPTION = "rexBin";

/** Per-call budget when the target names none. */
export const DEFAULT_REX_TIMEOUT_MS = 5000;

/**
 * The lines a read can reach. Rex keeps about 64 MiB of scrollback per terminal, which its own help
 * puts at roughly 100,000 lines of 80 columns.
 */
export const REX_READABLE_LINES = 100_000;

/**
 * A tail read asks for this many bytes per row it needs, and never fewer than the minimum: a styled row
 * runs 70 to 300 bytes. The maximum keeps the JSON form of the tail inside one `blob_read`, whose own
 * ceiling is 960 KiB counted as a JSON string, even when every byte is an escape (`\u001b`, 6 bytes).
 */
/** At most one "the read moved the whole output" line in this long; the next one counts the rest. */
const FALLBACK_LOG_EVERY_MS = 10 * 60_000;

/** What a {@link RexMux} takes besides its `rex`: where its log lines go, and its clock. */
export interface RexMuxOptions {
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

const TAIL_BYTES_PER_ROW = 512;
const TAIL_MIN_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 160 * 1024;
const BLOB_READ_MAX = 983_040;
/** How a VT row that holds anything opens (probed on API revision 19). */
const VT_ROW_START = "\u001b[0m";

/** What a read of a block's output gave: VT text, and whether older rows were left on the server. */
interface RexCapture {
  readonly text: string;
  readonly cut: boolean;
}

/** How many per-block reads one snapshot runs at once: each is one short `rex` process. */
const BLOCK_READ_CONCURRENCY = 8;

/**
 * The Collie harness name for each name a program reports for itself, where Collie has that harness.
 *
 * Claude Code reports `claude-code` (probed). The others are each harness's own binary name, which is
 * what a program that reports at all is expected to call itself; a name missing here reads as a
 * shell rather than passing rex's word on (../agents.ts).
 */
const AGENT_BY_APP = new Map<string, string>([
  ["claude-code", "claude"],
  ["claude", "claude"],
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["pi", "pi"],
  ["omp", "omp"],
  ["grok", "grok"],
  ["hermes", "hermes"],
]);

// A load-time tie: every name above must be one the contract accepts.
for (const name of AGENT_BY_APP.values()) {
  if (!MUX_AGENT_NAMES.includes(name)) throw new Error(`rex adapter maps to ${name}, which is not a Collie harness`);
}

/** OSC 7501's states in the contract's words. `error` has no word of its own, so it says unknown. */
function agentStatus(state: string): AgentStatus {
  switch (state) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "idle":
      return "idle";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

/** Which agent runs in a block, and how it is doing: the two pane facts `agentDetection` owes. */
interface PaneAgent {
  readonly agent: string;
  readonly status: AgentStatus;
}

/**
 * The agent a block's status records name, and how it is doing. The root record (no id) is the
 * program's own; a record with an id is a child task it reports beside it, so the root wins.
 *
 * A record is what the program in the block says about itself, and any program can print one. Rex
 * drops a record when the process that wrote it exits, so a record outlives its writer only when the
 * writer is the block's own login shell (a `printf` at the prompt). No agent is that shell, so such a
 * record is not read: an agent started from the shell has a pid of its own, and an agent that is the
 * block's program is not a login shell.
 */
function agentOf(allRecords: readonly RexStatusRecord[], loginShellPid: number | null): PaneAgent {
  const records = allRecords.filter((record) => loginShellPid === null || record.ownerPid !== loginShellPid);
  const root = records.find((record) => record.id === "") ?? records[0];
  const agent = root ? AGENT_BY_APP.get(root.app.trim().toLowerCase()) : undefined;
  if (!root || agent === undefined) return { agent: "shell", status: "unknown" };
  return { agent, status: agentStatus(root.state) };
}

/** What the per-block reads found, for one terminal block. */
interface BlockFacts {
  readonly process: RexProcess;
  readonly records: readonly RexStatusRecord[];
  readonly title: string;
}

/** One session's whole answer: its view, whether anyone is attached, and every terminal's facts. */
interface SessionReading {
  readonly session: RexSession;
  readonly view: RexView;
  readonly attached: boolean;
  readonly facts: ReadonlyMap<string, BlockFacts>;
}

interface RevisionEntry {
  revision: number;
  variants: Map<string, string>;
}

export class RexMux implements MuxAdapter {
  readonly mux = REX_MUX;
  readonly logo = REX_LOGO_SVG;

  readonly capabilities = declareCapabilities({
    supports: [
      "paneGrid",
      "gridScrollback",
      "agentDetection",
      "typeText",
      "sendKeys",
      "closePane",
      "createTab",
      "renameTab",
      "closeTab",
      "createSpace",
      "pushTopologyEvents",
      "pushPaneEvents",
    ],
    spaces: "many",
    topologyLatency: { kind: "push" },
    unsupportedKeys: [...REX_UNSENDABLE_KEYS],
    notes: {
      renamePane:
        "Rex blocks carry a label, but Rex fills it with its own defaults (`shell`, `Block <id>`), so a name the operator chose cannot be told from one Rex chose. Not declared until it can.",
      agentSessionRef:
        "Rex keeps an agent's status, not its conversation id. With `collie hooks install claude`, the hooks name the session.",
      listSessions: "A Rex server holds every session; one adapter reads them all as spaces.",
      setFocus:
        "`rex focus` moves a session's active window and block, but a screen follows only where a Rex app shows that session, and Rex has no screen client on Linux. Never probed with a Rex app attached, so not declared until it is.",
    },
  });

  private readonly revisions = new Map<string, RevisionEntry>();
  /** Whether the server's API revision was asked: once per adapter, on the first good snapshot. */
  private revisionAsked = false;

  /** Captures still running, by pane, rows and unwrap: a second ask for the same tail shares the first. */
  private readonly capturesInFlight = new Map<string, Promise<MuxOutcome<RexCapture>>>();
  /** When the last fallback line was written, and how many viewport fallbacks it has not named. */
  private lastFallbackLine = Number.NEGATIVE_INFINITY;
  private fallbacksUnlogged = 0;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(
    private readonly exec: RexExec,
    options: RexMuxOptions = {},
  ) {
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? Date.now;
  }

  async reachable(): Promise<boolean> {
    try {
      const res = await this.exec.run(["ls", "--json", "--short=false"]);
      return res.code === 0;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<MuxSnapshot> {
    const res = await this.attemptSnapshot();
    if (!res.ok) {
      if (res.reason === "unreachable") throw new Error(res.detail);
      throw new Error(`failed to read the rex snapshot: ${res.detail}`);
    }
    if (!this.revisionAsked) {
      this.revisionAsked = true;
      await this.noteApiRevision();
    }
    return res.value;
  }

  /** Every snapshot is a fresh round of `rex` calls, so there is no clock to move. */
  async refresh(): Promise<void> {
    return Promise.resolve();
  }

  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    if (!isRexId("block", paneId)) return notRexId("block", paneId);
    // Rex's output is always screen AND scrollback, so a viewport read keeps the last screenful,
    // sized by the terminal's own rows, and every read takes only the tail it needs (captureTail).
    const [captured, sized] = await Promise.all([
      // Every read but Load older (`purpose: "older"`) is one the phone repeats on each poll.
      this.sharedCapture(paneId, request.lines, false, request.purpose !== "older"),
      request.scope === "viewport" ? this.attemptRun(["block", "call", "-b", paneId, "size"]) : Promise.resolve(null),
    ]);
    if (!captured.ok) return captured;
    const raw = keepSgrOnly(captured.value.text);
    const styled = request.styling === "strip" ? stripEscapes(raw) : raw;
    let rows = styled.split("\n");
    if (sized !== null && sized.ok) {
      const screen = safeRows(sized.value.stdout);
      if (screen !== null) rows = rows.slice(Math.max(0, rows.length - screen));
    }
    const kept = rows.slice(Math.max(0, rows.length - request.lines));
    const text = kept.join("\n");
    return muxOk({
      paneId,
      text,
      truncated: captured.value.cut || rows.length > kept.length,
      revision: this.advanceRevision(paneId, `${request.scope}|${request.styling}|${String(request.lines)}`, text),
    });
  }

  /** The same rows with soft wraps joined: `--unwrap`, probed, joins lines the terminal wrapped. */
  async readLogicalText(paneId: string, lines: number): Promise<MuxOutcome<string>> {
    if (!isRexId("block", paneId)) return notRexId("block", paneId);
    const result = await this.sharedCapture(paneId, lines, true, false);
    if (!result.ok) return result;
    const captured = keepSgrOnly(result.value.text).split("\n");
    return muxOk(captured.slice(Math.max(0, captured.length - lines)).join("\n"));
  }

  /**
   * The last `rows` rows of a block's output as VT text, without moving the whole scrollback.
   *
   * `rex capture` has no line limit, so on a block with 96,000 lines of scrollback every read moved
   * 7 MB and cost the server about 240 ms of CPU (measured on API revision 19). `format` with
   * `max_bytes` answers the start, the byte `total` and an `id`; one `blob_read` from `total` minus
   * the budget then gives the end: 17 kB and about 70 ms of server CPU on that block. A small output
   * fits the first reply and costs one call, as the capture did.
   *
   * The cut lands inside a row, so everything up to the first row break is dropped, and the first row
   * kept must open with `ESC [ 0 m`, as every VT row that holds anything does (probed). Whenever the
   * tail cannot be trusted to hold what was asked, the read falls back to the whole capture: the
   * server kept only a few results and dropped this one, the part did not reach the end, the rows do
   * not start where a row starts, or there are fewer rows than asked (Load older).
   */
  /**
   * One capture per pane, rows and unwrap at a time. Two phones on one pane, or a poll beside the state
   * engine's read, would otherwise each start their own two `rex` calls and their own server render
   * of the whole output. Nothing is kept once the capture ends: the next ask reads afresh.
   */
  private sharedCapture(paneId: string, rows: number, unwrap: boolean, logFallback: boolean): Promise<MuxOutcome<RexCapture>> {
    const key = `${paneId}\n${String(rows)}\n${String(unwrap)}`;
    const running = this.capturesInFlight.get(key);
    if (running !== undefined) return running;
    const capture = this.captureTail(paneId, rows, unwrap, logFallback).finally(() => this.capturesInFlight.delete(key));
    this.capturesInFlight.set(key, capture);
    return capture;
  }

  private async captureTail(paneId: string, rows: number, unwrap: boolean, viewport: boolean): Promise<MuxOutcome<RexCapture>> {
    const fallBack = (reason: string): Promise<MuxOutcome<RexCapture>> => {
      if (viewport) this.noteFallback(reason);
      return this.captureWhole(paneId, unwrap);
    };
    const budget = Math.min(TAIL_MAX_BYTES, Math.max(TAIL_MIN_BYTES, rows * TAIL_BYTES_PER_ROW));
    const first = await this.attemptRun(["block", "call", "-b", paneId, "format", JSON.stringify({ format: "vt", unwrap, max_bytes: budget })]);
    if (!first.ok) return first;
    let head: RexFormatted;
    try {
      head = parseFormatted(first.value.stdout);
    } catch (err) {
      return muxRefused(err instanceof Error ? err.message : String(err));
    }
    if (head.id === null) return muxOk({ text: head.content, cut: false });
    const offset = Math.max(0, head.total - budget);
    const read = await this.attemptRun(["block", "call", "-b", paneId, "blob_read", JSON.stringify({ id: head.id, offset, max_bytes: BLOB_READ_MAX })]);
    const part = read.ok ? safeBlobPart(read.value.stdout) : null;
    if (!read.ok) return fallBack("the stored result was not there to read");
    if (part === null) return fallBack("the stored result did not parse");
    if (!part.eof) return fallBack("the tail did not reach the end of the output");
    const rowStart = offset === 0 ? 0 : part.data.indexOf("\r\n") + 2;
    if (rowStart < 2 && offset > 0) return fallBack("the tail held no row break");
    const text = part.data.slice(rowStart);
    const tailRows = text.split("\r\n");
    const firstFilled = tailRows.find((row) => row !== "");
    if (firstFilled !== undefined && !firstFilled.startsWith(VT_ROW_START)) return fallBack("the first row of the tail did not open with ESC [ 0 m");
    if (offset > 0 && tailRows.length < rows) return fallBack(`the tail held ${String(tailRows.length)} rows of the ${String(rows)} asked`);
    return muxOk({ text, cut: offset > 0 });
  }

  /**
   * One log line when a screen read had to move the whole output, at most one every ten minutes. A
   * Rex update that breaks the tail's row check would bring back the multi-megabyte reads without a
   * word otherwise. Load older and the unwrapped text are left out: they ask for more rows than a short
   * output holds, and fall back by design.
   */
  private noteFallback(reason: string): void {
    const now = this.now();
    if (now - this.lastFallbackLine < FALLBACK_LOG_EVERY_MS) {
      this.fallbacksUnlogged += 1;
      return;
    }
    const held = this.fallbacksUnlogged > 0 ? ` (${String(this.fallbacksUnlogged)} more since the last such line)` : "";
    this.log(`[mux] a Rex screen read moved the whole output, because ${reason}${held}`);
    this.lastFallbackLine = now;
    this.fallbacksUnlogged = 0;
  }

  /** The whole screen and scrollback, the read every tail falls back to. */
  private async captureWhole(paneId: string, unwrap: boolean): Promise<MuxOutcome<RexCapture>> {
    const args = ["capture", "-b", paneId, "--format=vt"];
    if (unwrap) args.push("--unwrap");
    const res = await this.attemptRun(args);
    if (!res.ok) return res;
    // The CLI ends what it prints with one `\n` that is no row of the output (probed).
    return muxOk({ text: res.value.stdout.replace(/\n$/u, ""), cut: false });
  }

  /**
   * Whether the block's program still runs. Probed: a `--keep-open` block whose program exited takes
   * `rex send` and `rex send-key` with exit 0 and delivers nothing, so a write asks first, and a
   * pane with nothing to read the input answers `gone` as the contract says.
   */
  private async ensureAlive(paneId: string): Promise<MuxAck> {
    if (!isRexId("block", paneId)) return notRexId("block", paneId);
    const res = await this.attemptRun(["block", "call", "-b", paneId, "process"]);
    if (!res.ok) return res;
    try {
      if (!parseProcess(res.value.stdout).alive) return muxGone(`the program in ${paneId} has exited`);
    } catch (err) {
      return muxRefused(err instanceof Error ? err.message : String(err));
    }
    return muxAck();
  }

  async typeText(paneId: string, text: string): Promise<MuxAck> {
    if (text.length === 0) return muxAck();
    const alive = await this.ensureAlive(paneId);
    if (!alive.ok) return alive;
    // On stdin, written verbatim as tmux's `send-keys -l` and zellij's `write-chars` are: a newline
    // in the text is the Enter key. Probed: `printf 'multi\nline' | rex send` ran `multi` and left
    // `line` at the prompt, and a text that starts with `--` is typed, not read as a flag.
    const res = await this.attemptWrite(["send", "-b", paneId], text, (detail) =>
      muxUnconfirmed(`Rex did not confirm the text written to ${paneId} in time (${detail}). It may still arrive, so it was not written again.`),
    );
    if (!res.ok) return res;
    return muxAck();
  }

  async writeKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const translated: string[] = [];
    for (const key of keys) {
      const res = toRexKey(key);
      if (!res.ok) {
        if (res.reason === "meta") return muxRefused("Rex cannot send meta chords: it delivers nothing for them");
        if (res.reason === "undeliverable") return muxRefused(`${key} does not reach a Rex pane as itself, so it is refused rather than mis-sent`);
        return muxRefused(`Rex cannot send key: ${key}`);
      }
      translated.push(res.key);
    }
    const alive = await this.ensureAlive(paneId);
    if (!alive.ok) return alive;
    // `--` so a key spelled with a leading dash is a key. One call: rex refuses the whole batch when
    // one key is unknown to it (probed), so nothing half-arrives.
    const res = await this.attemptWrite(["send-key", "-b", paneId, "--", ...translated], undefined, (detail) =>
      muxUnconfirmed(`Rex did not confirm the keys on ${paneId} in time (${detail}). They may still arrive, so they were not sent again.`),
    );
    if (!res.ok) return res;
    return muxAck();
  }

  async renamePane(_paneId: string, _label: string | null): Promise<MuxAck> {
    return muxUnsupported("renamePane", "Rex fills a block's label with its own defaults, so an operator's name cannot be told from one");
  }

  // Every positional that names something goes after `--`: an id from the phone's URL or a label it
  // typed is a name, never an option (`rex block close -h` prints help and exits 0).
  async closePane(paneId: string): Promise<MuxAck> {
    if (!isRexId("block", paneId)) return notRexId("block", paneId);
    const res = await this.attemptRun(["block", "close", "--", paneId]);
    if (!res.ok) return res;
    return muxAck();
  }

  async setFocus(_paneId: string): Promise<MuxAck> {
    return muxUnsupported("setFocus", "a screen follows a Rex focus only where a Rex app shows the session, and that was never probed");
  }

  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    if (request.spaceId && !isRexId("session", request.spaceId)) return notRexId("session", request.spaceId);
    const looked = await this.attemptSnapshot();
    if (!looked.ok) return looked;
    const space = request.spaceId
      ? looked.value.spaces.find((s) => s.spaceId === request.spaceId)
      : (looked.value.spaces.find((s) => s.focused) ?? looked.value.spaces[0]);
    // Without a session, rex picks one itself; a phone tap must land where it was aimed.
    if (!space) return muxGone(request.spaceId ? `space ${request.spaceId} is gone` : "rex has no session to open a tab in");
    const args = ["window", "new"];
    const label = request.label?.trim();
    if (label && !looksLikeFlag(label)) args.push(label);
    args.push("-s", space.spaceId, "--focus=false", "--json");
    const cwd = requestedCwd(request.cwd);
    if (cwd) args.push("--cwd", cwd);
    const made = await this.attemptCreate(args);
    if (!made.ok) return made;
    if (label && looksLikeFlag(label)) {
      const windowId = createdIds(made.value.stdout).windowId;
      if (windowId !== null) await this.attemptRun(["window", "rename", "-s", space.spaceId, "--", windowId, label]);
    }
    return this.confirmCreated(made.value.stdout, "tab");
  }

  async renameTab(tabId: string, label: string): Promise<MuxAck> {
    if (!isRexId("window", tabId)) return notRexId("window", tabId);
    const looked = await this.attemptSnapshot();
    if (!looked.ok) return looked;
    const tab = looked.value.tabs.find((t) => t.tabId === tabId);
    if (!tab) return muxGone(`tab ${tabId} is gone`);
    const res = await this.attemptRun(["window", "rename", "-s", tab.spaceId, "--", tabId, label]);
    if (!res.ok) return res;
    return muxAck();
  }

  async closeTab(tabId: string): Promise<MuxAck> {
    if (!isRexId("window", tabId)) return notRexId("window", tabId);
    const looked = await this.attemptSnapshot();
    if (!looked.ok) return looked;
    const tab = looked.value.tabs.find((t) => t.tabId === tabId);
    if (!tab) return muxGone(`tab ${tabId} is gone`);
    const res = await this.attemptRun(["window", "close", "-s", tab.spaceId, "--", tabId]);
    if (!res.ok) return res;
    return muxAck();
  }

  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const args = ["new"];
    const label = request.label?.trim();
    if (label && !looksLikeFlag(label)) args.push(label);
    args.push("--json");
    const cwd = requestedCwd(request.cwd);
    if (cwd) args.push("--cwd", cwd);
    const made = await this.attemptCreate(args);
    if (!made.ok) return made;
    if (label && looksLikeFlag(label)) {
      const sessionId = createdIds(made.value.stdout).sessionId;
      if (sessionId !== null) await this.attemptRun(["session", "rename", "--", sessionId, label]);
    }
    return this.confirmCreated(made.value.stdout, "space");
  }

  async listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return muxUnsupported("listSessions", "a Rex server holds every session, and this adapter reads them all as spaces");
  }

  watch(options: MuxWatchOptions): MuxSubscription {
    return new RexWatch(this.exec, options);
  }

  // ── the snapshot ──────────────────────────────────────────────────────────────────────────────

  /**
   * The snapshot as an outcome, so a write that must look first answers `unreachable` like any other
   * write and never throws past the port. One `ls`, then per session its view and its clients, then
   * per terminal block its process, its status records and its title — every one a short `rex` call
   * (about 20 ms each, probed), the per-block ones run a few at a time.
   */
  private async attemptSnapshot(): Promise<MuxOutcome<MuxSnapshot>> {
    const listed = await this.attemptRun(["ls", "--json", "--short=false"]);
    if (!listed.ok) return listed;
    let sessions: RexSession[];
    try {
      sessions = parseSessions(listed.value.stdout);
    } catch (err) {
      return muxRefused(err instanceof Error ? err.message : String(err));
    }

    const readings: SessionReading[] = [];
    for (const session of sessions) {
      const [viewed, clients] = await Promise.all([
        this.attemptRun(["window", "ls", "-s", session.sessionId, "--json"]),
        this.attemptRun(["client", "ls", "-s", session.sessionId, "--json"]),
      ]);
      if (!viewed.ok) {
        // A session destroyed between `ls` and this call is simply not in the snapshot.
        if (viewed.reason === "gone") continue;
        return viewed;
      }
      let view: RexView;
      try {
        view = parseView(viewed.value.stdout);
      } catch (err) {
        return muxRefused(err instanceof Error ? err.message : String(err));
      }
      const attached = clients.ok ? safeClientCount(clients.value.stdout) > 0 : false;
      const terminals = view.windows.flatMap((w) => w.blocks).filter((b) => b.creator === REX_TERMINAL_CREATOR);
      const facts = await this.readBlocks(terminals.map((b) => b.blockId));
      readings.push({ session, view, attached, facts });
    }
    return muxOk(buildSnapshot(readings));
  }

  /** Each block's process, status records and title. A block that vanished mid-read is left out. */
  private async readBlocks(blockIds: readonly string[]): Promise<Map<string, BlockFacts>> {
    const facts = new Map<string, BlockFacts>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < blockIds.length) {
        const blockId = blockIds[next++];
        if (blockId === undefined) return;
        const [process, status, title] = await Promise.all([
          this.attemptRun(["block", "call", "-b", blockId, "process"]),
          this.attemptRun(["block", "call", "-b", blockId, "program_status"]),
          this.attemptRun(["block", "call", "-b", blockId, "title"]),
        ]);
        if (!process.ok) continue;
        try {
          facts.set(blockId, {
            process: parseProcess(process.value.stdout),
            records: status.ok ? parseProgramStatus(status.value.stdout) : [],
            title: title.ok ? parseTitle(title.value.stdout) : "",
          });
        } catch {
          // An answer that did not parse leaves this block out of one snapshot; the next asks again.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BLOCK_READ_CONCURRENCY, blockIds.length) }, worker));
    return facts;
  }

  /**
   * After a create: find the fresh pane in a new snapshot. The create already happened, so a snapshot
   * that cannot be read, or does not show the pane yet, is `unconfirmed` and never a failure — the
   * route looks before anything is said or made again (bridge/create-confirm.ts).
   */
  private async confirmCreated(stdout: string, what: "tab" | "space"): Promise<MuxOutcome<MuxCreatedPane>> {
    let blockId: string | null;
    try {
      blockId = parseCreated(stdout).blockId;
    } catch {
      blockId = null;
    }
    if (blockId === null) return muxUnconfirmed(`the ${what} was created, but rex did not name its pane`);
    const after = await this.attemptSnapshot();
    if (!after.ok) return muxUnconfirmed(after.detail);
    const pane = after.value.panes.find((p) => p.paneId === blockId);
    if (!pane) return muxUnconfirmed(`the ${what} was created, but its pane ${blockId} is not listed yet`);
    return muxOk({ paneId: pane.paneId, spaceId: pane.spaceId, spaceLabel: pane.spaceLabel, tabId: pane.tabId, cwd: pane.cwd });
  }

  // ── running rex ───────────────────────────────────────────────────────────────────────────────

  /**
   * A create's own run. One killed on its budget may still have made the tab or the session, so it is
   * `unconfirmed`, not `unreachable`: the route looks before it says anything (bridge/create-confirm.ts).
   */
  private async attemptCreate(args: readonly string[]): Promise<MuxOutcome<RexRunResult>> {
    let result: RexRunResult;
    try {
      result = await this.exec.run(args);
    } catch (err) {
      return muxUnreachable(err instanceof Error ? err.message : String(err));
    }
    if (result.code === TIMED_OUT_CODE) return muxUnconfirmed(result.stderr.trim());
    return result.code === 0 ? muxOk(result) : refusalFor(result);
  }

  /**
   * One look at the server's API revision. A revision the adapter was not probed on is no refusal:
   * Rex is in beta and most revisions keep the calls this adapter makes, so the bridge only says so,
   * once. A server that does not answer is left to the snapshot's own error.
   */
  private async noteApiRevision(): Promise<void> {
    const res = await this.attemptRun(["api", "call", "server.status"]);
    if (!res.ok) return;
    const revision = parseApiRevision(res.value.stdout);
    const note = revision === null ? null : untestedRevisionNote(revision);
    if (note !== null) this.log(`[mux] ${note}`);
  }

  private async attemptRun(args: readonly string[]): Promise<MuxOutcome<RexRunResult>> {
    let result: RexRunResult;
    try {
      result = await this.exec.run(args);
    } catch (err) {
      return muxUnreachable(err instanceof Error ? err.message : String(err));
    }
    return result.code === 0 ? muxOk(result) : refusalFor(result);
  }

  /**
   * One run that writes into a pane (M100 spec 03). A rex killed on its time budget is no refusal: it
   * may have taken the text or the keys before it hung, so it answers `unconfirmed` with the caller's
   * sentence, and the Send Protocol's next read decides. Every other answer is {@link attemptRun}'s.
   */
  private async attemptWrite(
    args: readonly string[],
    stdin: string | undefined,
    unconfirmed: (detail: string) => MuxRefusalOutcome,
  ): Promise<MuxOutcome<RexRunResult>> {
    let result: RexRunResult;
    try {
      result = await this.exec.run(args, stdin);
    } catch (err) {
      return muxUnreachable(err instanceof Error ? err.message : String(err));
    }
    if (result.code === TIMED_OUT_CODE) return unconfirmed(result.stderr.trim() || `rex exited ${String(result.code)}`);
    return result.code === 0 ? muxOk(result) : refusalFor(result);
  }

  private advanceRevision(paneId: string, variant: string, text: string): number {
    const tracked = this.revisions.get(paneId) ?? { revision: 1, variants: new Map<string, string>() };
    this.revisions.set(paneId, tracked);
    const digest = contentDigest(text);
    const previous = tracked.variants.get(variant);
    if (previous === undefined) {
      if (tracked.variants.size > 0) tracked.revision += 1;
    } else if (previous !== digest) {
      tracked.revision += 1;
    }
    tracked.variants.delete(variant);
    tracked.variants.set(variant, digest);
    return tracked.revision;
  }
}

/** Sessions, windows and terminal blocks, as the contract's spaces, tabs and panes. */
function buildSnapshot(readings: readonly SessionReading[]): MuxSnapshot {
  const spaces: MuxSpace[] = [];
  const tabs: MuxTab[] = [];
  const panes: MuxPane[] = [];

  readings.forEach((reading, index) => {
    const { session, view, attached, facts } = reading;
    const spaceId = session.sessionId;
    const spaceLabel = view.label || session.label;
    const spaceNumber = index + 1;
    const spacePanes: MuxPane[] = [];

    view.windows.forEach((window, windowIndex) => {
      const named = !isDefaultWindowLabel(window.windowId, window.label);
      const shown = window.windowId === view.activeWindowId;
      const windowPanes: MuxPane[] = [];
      for (const block of window.blocks) {
        const fact = facts.get(block.blockId);
        if (block.creator !== REX_TERMINAL_CREATOR || fact === undefined) continue;
        const { agent, status } = agentOf(fact.records, fact.process.loginShellPid);
        windowPanes.push({
          paneId: block.blockId,
          spaceId,
          spaceLabel,
          spaceNumber,
          tabId: window.windowId,
          tabLabel: named ? window.label : undefined,
          tabNamed: named ? true : undefined,
          cwd: fact.process.cwd,
          focused: attached && shown && window.focusedBlockId === block.blockId,
          alive: fact.process.alive,
          agent,
          status,
          terminalTitle: fact.title.trim() || undefined,
          foregroundCommand: fact.process.foreground ?? undefined,
          readableLines: REX_READABLE_LINES,
        });
      }
      tabs.push({
        tabId: window.windowId,
        spaceId,
        number: windowIndex + 1,
        // The bare number for an unnamed tab, as Herdr labels one: the web hides a positional label.
        label: named ? window.label : String(windowIndex + 1),
        focused: shown,
        paneCount: windowPanes.length,
      });
      spacePanes.push(...windowPanes);
    });

    spaces.push({
      spaceId,
      number: spaceNumber,
      label: spaceLabel,
      focused: attached,
      activeTabId: view.activeWindowId ?? view.windows[0]?.windowId ?? "",
      tabCount: view.windows.length,
      paneCount: spacePanes.length,
    });
    panes.push(...spacePanes);
  });

  return { panes, spaces, tabs };
}

/**
 * Only an id Rex itself handed out reaches `rex`. Rex reads a target as a full id, then a label, then
 * a one-based position, then an id suffix (probed on API revision 19), so `shell` or `1` from a
 * phone's URL would name whichever block happens to carry that label or sit in that place. Every
 * id Rex prints is `<kind>:<uuid>`, and anything else is no pane, tab or space Collie listed.
 */
const ISSUED_REX_ID = /^(?:block|window|session):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isRexId(kind: "block" | "window" | "session", id: string): boolean {
  return id.startsWith(`${kind}:`) && ISSUED_REX_ID.test(id);
}

function notRexId(kind: "block" | "window" | "session", id: string): MuxRefusalOutcome {
  return muxGone(`no rex ${kind} has the id ${id}`);
}

/**
 * Whether rex would read this text as an option rather than a name. A create takes its label as the
 * one positional before `--`, and `--` there starts the COMMAND, so a label like `--keep-open` cannot
 * be quoted past the parser: probed on API revision 19, `rex new --keep-open` made a session with a
 * random name and kept its block open, and `rex new -h` printed help and exited 0. Such a label is
 * left off the create and set by a rename after `--`, where it is only a name.
 */
function looksLikeFlag(label: string): boolean {
  return label.startsWith("-");
}

/** The ids a create answered with, or nulls when the answer did not parse. */
function createdIds(stdout: string): RexCreated {
  try {
    return parseCreated(stdout);
  } catch {
    return { sessionId: null, windowId: null, blockId: null };
  }
}

/** A part read of `blob_read`, or null when its answer did not parse. */
function safeBlobPart(stdout: string): RexBlobPart | null {
  try {
    return parseBlobPart(stdout);
  } catch {
    return null;
  }
}

function safeClientCount(stdout: string): number {
  try {
    return parseClientCount(stdout);
  } catch {
    return 0;
  }
}

function safeRows(stdout: string): number | null {
  try {
    return parseRows(stdout);
  } catch {
    return null;
  }
}

function refusalFor(result: RexRunResult): MuxRefusalOutcome {
  const detail = firstLine(result.stderr) || `rex exited ${String(result.code)}`;
  if (saysUnreachable(result.code, result.stderr)) return muxUnreachable(detail);
  if (saysNotFound(result.code, result.stderr)) return muxGone(detail);
  return muxRefused(detail);
}

/** Rex follows an error with its usage text; the sentence is the first line. */
function firstLine(stderr: string): string {
  return (stderr.trim().split("\n")[0] ?? "").replace(/^Error:\s*/u, "").trim();
}

function contentDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function execFor(target: MuxTarget): SpawnRexExec {
  const configured = target.options[REX_BINARY_OPTION] ?? "";
  const candidates = rexBinaryCandidates();
  const binary = resolveRexBinary(configured, undefined, candidates);
  return new SpawnRexExec(binary, target.endpoint, target.timeoutMs || DEFAULT_REX_TIMEOUT_MS, noRexBinaryMessage(configured, candidates));
}

export const rexMuxFactory: MuxAdapterFactory = {
  mux: REX_MUX,
  create(target: MuxTarget) {
    return new RexMux(execFor(target));
  },
  beaconMatcher(target: MuxTarget) {
    return rexBeaconMatcher(REX_MUX, execFor(target));
  },
  describeTarget(endpoint: string) {
    return endpoint.trim() ? `server ${endpoint.trim()}` : "its default server";
  },
};
