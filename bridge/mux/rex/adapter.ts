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
import { resolveRexBinary, SpawnRexExec, TIMED_OUT_CODE, type RexExec, type RexRunResult } from "./exec.ts";
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
  parseTitle,
  parseView,
  REX_TERMINAL_CREATOR,
  saysNotFound,
  saysUnreachable,
  stripEscapes,
  type RexCreated,
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
 */
function agentOf(records: readonly RexStatusRecord[]): PaneAgent {
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
      "setFocus",
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
    },
  });

  private readonly revisions = new Map<string, RevisionEntry>();

  constructor(private readonly exec: RexExec) {}

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
    return res.value;
  }

  /** Every snapshot is a fresh round of `rex` calls, so there is no clock to move. */
  async refresh(): Promise<void> {
    return Promise.resolve();
  }

  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    if (!isRexId("block", paneId)) return notRexId("block", paneId);
    // Rex's capture is always screen AND scrollback (its help: "Print the screen and scrollback"),
    // so a viewport read keeps the last screenful, sized by the terminal's own rows.
    const [captured, sized] = await Promise.all([
      this.attemptRun(["capture", "-b", paneId, "--format=vt"]),
      request.scope === "viewport" ? this.attemptRun(["block", "call", "-b", paneId, "size"]) : Promise.resolve(null),
    ]);
    if (!captured.ok) return captured;
    const raw = keepSgrOnly(captured.value.stdout).replace(/\n$/u, "");
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
      truncated: rows.length > kept.length,
      revision: this.advanceRevision(paneId, `${request.scope}|${request.styling}|${String(request.lines)}`, text),
    });
  }

  /** The same rows with soft wraps joined: `--unwrap`, probed, joins lines the terminal wrapped. */
  async readLogicalText(paneId: string, lines: number): Promise<MuxOutcome<string>> {
    if (!isRexId("block", paneId)) return notRexId("block", paneId);
    const result = await this.attemptRun(["capture", "-b", paneId, "--format=vt", "--unwrap"]);
    if (!result.ok) return result;
    const captured = keepSgrOnly(result.value.stdout).replace(/\n$/u, "").split("\n");
    return muxOk(captured.slice(Math.max(0, captured.length - lines)).join("\n"));
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

  /** `rex focus <block>`: probed, it makes the block's window active and focuses the block. */
  async setFocus(paneId: string): Promise<MuxAck> {
    if (!isRexId("block", paneId)) return notRexId("block", paneId);
    const res = await this.attemptRun(["focus", "--", paneId]);
    if (!res.ok) return res;
    return muxAck();
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
        const { agent, status } = agentOf(fact.records);
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
  const binary = resolveRexBinary(target.options[REX_BINARY_OPTION] ?? "");
  return new SpawnRexExec(binary, target.endpoint, target.timeoutMs || DEFAULT_REX_TIMEOUT_MS);
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
