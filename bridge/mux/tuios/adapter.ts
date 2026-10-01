// TUIOS, BEHIND THE CONTRACT — the fourth adapter, over the tuios daemon's JSON verb socket.
//
// Everything above this file talks the mux port (../types.ts); everything below it — client.ts,
// keys.ts, events.ts, watch.ts — talks tuios. So this module is the whole translation, as
// `herdr/adapter.ts` is for Herdr, and the only file holding both vocabularies at once. Every fact
// cited below was probed against a tuios daemon built from main on 2026-09-30, in its own runtime,
// state and config directories (MUX_CONTRACT.md, source **TU**).
//
// ── THE MAPPING ─────────────────────────────────────────────────────────────────────────────────
//
//   tuios session    →  Collie SPACE   (the session's `id`)
//   tuios workspace  →  Collie TAB     (`<session id>:<workspace number>`)
//   tuios window     →  Collie PANE    (the window's `window_id`, carried through unchanged)
//
// tuios's three levels are Collie's three levels, as on tmux. The ids are the part worth stating:
//
//  • A window id is a UUID that survives a rename, a move between workspaces AND a daemon restart
//    (probed: `tuios kill-server`, `tuios start-server`, every window came back under its old id).
//    That is identity rule 2 held by tuios itself, so the pane id is carried unchanged.
//  • A session is addressed by NAME on the wire, and its name is the one thing the operator can
//    change (`rename-session`). So the space id is the session's `id`, which a rename leaves alone
//    and which a daemon restart restores (probed on tuios main `c24cbc80`).
//  • A workspace is a numbered slot, 1 to 9 by default, and its number is its address, so a tab id
//    is the space id plus that number. A workspace can carry a name (`set-workspace-name`), and a
//    change to it raises `workspace-renamed`.
//
// Every write names the session explicitly. A verb with no session acts on "the most recently
// active one", and a phone tap must never land wherever the daemon guesses. So a pane-addressed call
// first finds the pane's session in one `list-sessions`; a pane that listing does not carry is
// `gone` before anything is sent.
//
// ── WHAT A TAB IS HERE ──────────────────────────────────────────────────────────────────────────
//
// tuios lists every workspace, empty ones included. A tab strip of nine chips with seven empty is
// noise, so a workspace is a tab only while it holds a pane on this machine.
//
// ── AGENTS ──────────────────────────────────────────────────────────────────────────────────────
//
// tuios knows what an agent is: detection, hook reports and harness manifests (tuios's
// docs/AGENT_STATE.md). `list-agents` says which harness is in a pane, what state it is in, and
// which conversation it runs. So `agentDetection` and `agentSessionRef` are declared, with no beacon
// decorator: like Herdr's, this adapter already has a stronger source than a beacon. The first
// version reads three things and no more: the agent's name, its status and its session ref. The
// needs-you text and tuios's approval verbs wait for a contract change.
//
// ── THE DAEMON IS PINNED ────────────────────────────────────────────────────────────────────────
//
// `hello` names protocol 1, and the daemon must also send `workspace-renamed`, which a protocol-1
// daemon older than tuios 0.8.3 (the first release with tuios main `c24cbc80`) does not. Either gap makes `reachable()` false and the
// snapshot throw a sentence that says what to update.

import { meaningfulTerminalTitle } from "../../activity.ts";
import { MUX_AGENT_NAMES } from "../agents.ts";
import type { AgentStatus } from "../../types.ts";
import { declareCapabilities } from "../capabilities.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
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
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeScope,
} from "../types.ts";
import {
  defaultTuiosSocket,
  DEFAULT_TUIOS_TIMEOUT_MS,
  TuiosClient,
  TuiosError,
  TUIOS_PROTOCOL,
  TUIOS_REQUIRED_EVENT,
  type StreamResume,
  type TuiosRpc,
  type WireAgent,
  type WireSession,
  type WireWindow,
  type WireWindowList,
  type WireWorkspace,
} from "./client.ts";
import { routeEvent, subscriptionTypes } from "./events.ts";
import { toTuiosKey, TUIOS_UNSENDABLE_KEYS } from "./keys.ts";
import { TUIOS_LOGO_SVG } from "./logo.ts";

/** The registry name this adapter answers to, and the value of {@link TuiosMux.mux}. */
export const TUIOS_MUX = "tuios";

/**
 * What tuios can do, read off the methods in this file and off the probe that proved each one.
 *
 * Declined, each for a reason in the notes: the three worktree verbs, and `listSessions`.
 */
const TUIOS_CAPABILITIES = declareCapabilities({
  supports: [
    "paneGrid",
    "gridScrollback",
    "agentDetection",
    "agentSessionRef",
    "typeText",
    "sendKeys",
    "renamePane",
    "closePane",
    "setFocus",
    "createTab",
    "renameTab",
    "closeTab",
    "createSpace",
    "pushTopologyEvents",
    "pushPaneEvents",
  ],
  unsupportedKeys: TUIOS_UNSENDABLE_KEYS,
  // The event stream announces every structure change Collie shows: windows and sessions
  // appearing, closing, moving and being renamed, and workspaces being renamed. So there is no
  // census and no number to state.
  topologyLatency: { kind: "push" },
  notes: {
    agentDetection:
      "tuios names the agent in a pane from its harness. An agent Collie has no harness for reads as a shell.",
    sendKeys: "tuios has no Super or Command key for a pane, so a `meta` chord is refused.",
    setFocus:
      "tuios has no command that moves an attached terminal to another session. When no terminal shows this pane's session, Show in terminal is refused and says which session the terminal shows.",
    createTab:
      "A new tab is a new window on the lowest empty workspace. A session has nine workspaces by default, so a tenth tab is refused.",
    closeTab: "Closing a tab closes every pane on that workspace.",
    listWorktrees: "Worktrees are not part of the first tuios adapter.",
    createWorktree: "Worktrees are not part of the first tuios adapter.",
    openWorktree: "Worktrees are not part of the first tuios adapter.",
    listSessions:
      "Every session of this tuios daemon is already a space here. Another daemon has its own runtime directory, and tuios has no command that lists daemons, so a second daemon is reached by pointing a second collie at it.",
  },
  // One daemon holds as many sessions as the operator makes, and each one is a space.
  spaces: "many",
});

/**
 * One pane's revision as last reported. tuios counts a pane's `revision` from 0 again when the
 * daemon restarts, while the pane keeps its id. The contract says a revision never decreases while
 * the pane lives, so a new `boot_id` moves the base past the last number reported.
 */
interface PaneRevision {
  readonly bootId: string;
  readonly base: number;
  readonly reported: number;
}

/** Where a pane lives, found by id: the session to name on the wire, and the window itself. */
interface PaneLocation {
  readonly session: WireSession;
  readonly window: WireWindow;
}

/** The tuios error codes that mean "it existed and does not any more" (docs/protocol.md § Error codes). */
const GONE_CODES: ReadonlySet<string> = new Set(["window_not_found", "session_not_found", "pty_not_found", "no_windows"]);

/**
 * Which refusal an exception off the socket is.
 *
 * Three buckets, and the split is the contract's: a daemon code for something gone is `gone`, any
 * other daemon code is tuios understanding and saying no (`refused`), and an exception with no code
 * is the transport failing (`unreachable`) — which includes a connection that died mid-call
 * (MUX_CONTRACT.md § Contract-owned rules, *Transport death*).
 */
function refusalFor<T>(err: T): MuxRefusalOutcome {
  if (err instanceof TuiosError) {
    return GONE_CODES.has(err.code) ? muxGone(err.message) : muxRefused(err.message);
  }
  return muxUnreachable(err instanceof Error ? err.message : String(err));
}

/**
 * The Collie harness name for each tuios harness id, where Collie has that harness.
 *
 * tuios names harnesses after their manifests (`claude-code`); Collie's screen readers and journal
 * readers key on the short name (`claude`). The contract requires a Collie harness name or `shell`
 * (../agents.ts), so a harness missing here reads as a shell rather than passing its tuios id on.
 */
const AGENT_BY_TUIOS_HARNESS = new Map<string, string>([
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["pi", "pi"],
  ["omp", "omp"],
  ["grok", "grok"],
  ["hermes", "hermes"],
  ["antigravity", "antigravity"],
]);

// A compile-time-shaped tie, checked at load: every name above must be one the contract accepts.
for (const name of AGENT_BY_TUIOS_HARNESS.values()) {
  if (!MUX_AGENT_NAMES.includes(name)) throw new Error(`tuios adapter maps to ${name}, which is not a Collie harness`);
}

/** The Collie harness name for a tuios harness id, or `null` when Collie has no such harness. */
function agentName(harnessId: string): string | null {
  return AGENT_BY_TUIOS_HARNESS.get(harnessId.trim().toLowerCase()) ?? null;
}

/** tuios's agent state in the contract's words. `none` never reaches here: it is not an agent. */
function agentStatus(state: string): AgentStatus {
  switch (state) {
    case "working":
      return "working";
    case "needs_input":
      return "blocked";
    case "idle":
      return "idle";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

/** The id of one workspace of one session, as a Collie tab. */
function tabIdOf(sessionId: string, workspace: number): string {
  return `${sessionId}:${String(workspace)}`;
}

/** A tab id's two halves, or `null` when it is not one this adapter minted. */
function parseTabId(tabId: string): { sessionId: string; workspace: number } | null {
  const cut = tabId.lastIndexOf(":");
  if (cut <= 0) return null;
  const workspace = Number(tabId.slice(cut + 1));
  if (!Number.isInteger(workspace) || workspace < 1) return null;
  return { sessionId: tabId.slice(0, cut), workspace };
}

/**
 * The title the pane's program set, or `""` when it set none.
 *
 * Until a program sets a title, tuios fills the window's `title` with a name of its own:
 * `Terminal ` and the first eight characters of the window id (tuios
 * internal/session/session_ops.go; probed on tuios main `051da3ac`, where a zsh with no title hook
 * listed `Terminal 6247db65`). That is tuios's placeholder and not something the program said, so it
 * is not a `terminalTitle`. Reported as one, it named every quiet shell on the phone by an id.
 */
function programTitle(window: WireWindow): string {
  return window.title === `Terminal ${window.windowId.slice(0, 8)}` ? "" : window.title;
}

/** A styled capture pads every row to the pane's width with spaces; the mirror wants the row. */
function trimRows(text: string): string {
  return text
    .split("\n")
    .map((row) => row.replace(/ +$/u, ""))
    .join("\n");
}

/** One session's listing, read in one go. */
interface SessionListing {
  readonly session: WireSession;
  readonly windows: WireWindowList;
  readonly workspaces: readonly WireWorkspace[];
}

type MutableMuxPane = { -readonly [K in keyof MuxPane]: MuxPane[K] };

export class TuiosMux implements MuxAdapter {
  readonly mux = TUIOS_MUX;
  readonly capabilities = TUIOS_CAPABILITIES;
  readonly logo = TUIOS_LOGO_SVG;

  /** The last revision reported per pane, so a daemon restart cannot move one backwards. */
  private readonly revisions = new Map<string, PaneRevision>();

  /** The last event any watch read, so the next watch asks the daemon to replay from there. */
  private resumeAt: StreamResume | null = null;

  /** The daemon last checked by {@link compatibility}, by its `instance`, and what was wrong with it. */
  private checked: { readonly instance: string; readonly problem: string | null } | null = null;

  constructor(private readonly rpc: TuiosRpc) {}

  /**
   * Is a daemon answering, on a protocol and a build this adapter can drive? A daemon that answers
   * and does not fit reads as unreachable, and the snapshot says why.
   */
  async reachable(): Promise<boolean> {
    try {
      return (await this.compatibility()) === null;
    } catch {
      return false;
    }
  }

  /**
   * Every pane, tab and space the daemon holds.
   *
   * `list-sessions`, then per session `list-windows` and `list-workspaces`, plus one `list-agents`
   * over every session, all in parallel. A session that closes between the first call and its own is
   * left out, since the next snapshot will not have it either. Any other failure PROPAGATES, because
   * the snapshot is the floor and has no refusal shape, and so does a daemon that does not fit.
   */
  async snapshot(): Promise<MuxSnapshot> {
    const problem = await this.compatibility();
    if (problem !== null) throw new Error(problem);
    const [sessions, agents] = await Promise.all([this.rpc.listSessions(), this.rpc.listAgents()]);
    const listings = await Promise.all(sessions.map((session) => this.listSession(session)));
    const live = listings.filter((listing): listing is SessionListing => listing !== null);
    const snapshot = toSnapshot(live, agents);
    this.forgetGonePanes(snapshot.panes);
    return snapshot;
  }

  /**
   * A no-op that resolves, as Herdr's is. {@link snapshot} is a fresh set of round trips every
   * time, and the watch is a real event stream with no census to pull forward.
   */
  refresh(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * One pane's rendered screen, from the daemon's own terminal emulator.
   *
   * `styled` keeps SGR and nothing else (probed: a red `printf` came back as `ESC[31;1m … ESC[m`
   * and no other escape), so ADR 0008 holds. The styled capture pads each row to the pane's width,
   * and the padding is trimmed. `revision` is the daemon's own, read under the same lock as the
   * content. How far a `recent` read could reach is `readableLines` on the snapshot, so `truncated`
   * stays false.
   */
  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    const located = await this.locate(paneId);
    if (!located.ok) return located;
    try {
      const capture = await this.rpc.capturePane(located.value.session.name, paneId, {
        source: request.scope === "viewport" ? "visible" : "recent",
        styled: request.styling === "preserve",
        lines: Math.max(1, request.lines),
      });
      return muxOk({
        paneId,
        text: trimRows(capture.content.replace(/\n$/u, "")),
        truncated: false,
        revision: this.stableRevision(paneId, capture.bootId, capture.revision),
      });
    } catch (err) {
      return refusalFor(err);
    }
  }

  /** Literal text, written to the pane's PTY verbatim, submitting nothing. */
  async typeText(paneId: string, text: string): Promise<MuxAck> {
    if (text.length === 0) return muxAck();
    return this.onPane(paneId, (session) => this.rpc.sendText(session, paneId, text));
  }

  /**
   * Keys in the contract's spelling, translated and sent in ONE `send-keys` call, in order.
   *
   * The whole batch is translated before anything is sent, and the daemon parses every token of the
   * call before it sends any, so a batch holding one key tuios cannot express sends nothing.
   */
  async sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const translated: string[] = [];
    for (const key of keys) {
      const result = toTuiosKey(key);
      if (!result.ok) {
        if (result.reason === "meta") {
          return muxRefused(`tuios has no Super or Command key for a pane, so it cannot send ${key}. Use alt for the Alt key.`);
        }
        return muxRefused(`not a key: ${key}`);
      }
      translated.push(result.key);
    }
    if (translated.length === 0) return muxAck();
    return this.onPane(paneId, (session) => this.rpc.sendKeys(session, paneId, translated.join(" ")));
  }

  /**
   * Set or clear the pane's name. tuios keeps two slots — the name a person gave a window, and the
   * title its shell set — so, as on Herdr, no memory is needed to tell them apart. `""` clears.
   */
  async renamePane(paneId: string, label: string | null): Promise<MuxAck> {
    return this.onPane(paneId, (session) => this.rpc.renameWindow(session, paneId, label ?? ""));
  }

  async closePane(paneId: string): Promise<MuxAck> {
    return this.onPane(paneId, (session) => this.rpc.closeWindow(session, paneId));
  }

  /**
   * Show this pane on the operator's own screen. `focus-window` moves the focus AND shows the
   * window's workspace, in one call (probed, with a client attached).
   *
   * It moves the SESSION's focus, and tuios has no verb that moves an attached terminal to another
   * session. So when a terminal is attached to a different session and none to this one, the call
   * is refused and names the session the terminal shows: moving the focus there would answer ok and
   * move nothing the operator can see. With no terminal attached at all it goes ahead, and the next
   * attach lands on the pane — the same answer tmux gives.
   */
  async setFocus(paneId: string): Promise<MuxAck> {
    let sessions: WireSession[];
    try {
      sessions = await this.rpc.listSessions();
    } catch (err) {
      return refusalFor(err);
    }
    const located = await this.locate(paneId);
    if (!located.ok) return located;
    const home = located.value.session;
    const elsewhere = sessions.filter((session) => session.attached && session.id !== home.id);
    if (!home.attached && elsewhere.length > 0) {
      const shown = elsewhere.map((session) => session.name).join(", ");
      return muxRefused(
        `The terminal shows session ${shown}. tuios cannot move it to session ${home.name}. Switch to ${home.name} in tuios first.`,
      );
    }
    return this.attempt(() => this.rpc.focusWindow(home.name, paneId));
  }

  /**
   * A new tab: a shell window on the lowest EMPTY, unnamed workspace of the space, with the focus
   * left where it is. A label names the workspace. With every workspace in use it is refused.
   */
  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const found = await this.sessionById(request.spaceId);
    if (!found.ok) return found;
    const session = found.value;
    try {
      const workspaces = await this.rpc.listWorkspaces(session.name);
      const empty = workspaces.filter((ws) => ws.windowCount === 0 && !ws.current);
      const free = empty.find((ws) => ws.name === "") ?? empty.at(0);
      if (free === undefined) {
        return muxRefused(`Every workspace of session ${session.name} is in use. Close a tab first.`);
      }
      const asked = requestedCwd(request.cwd);
      const created = await this.rpc.newWindow(session.name, free.workspace, asked);
      const label = request.label?.trim() ?? "";
      if (label.length > 0) await this.rpc.nameWorkspace(session.name, free.workspace, label);
      return muxOk({
        paneId: created.windowId,
        spaceId: session.id,
        spaceLabel: session.name,
        tabId: tabIdOf(session.id, created.workspace || free.workspace),
        cwd: asked ?? "",
      });
    } catch (err) {
      return refusalFor(err);
    }
  }

  /** Name the workspace. A tab name cannot be cleared from the phone, matching the other adapters. */
  async renameTab(tabId: string, label: string): Promise<MuxAck> {
    const tab = await this.tabById(tabId);
    if (!tab.ok) return tab;
    return this.attempt(() => this.rpc.nameWorkspace(tab.value.session.name, tab.value.workspace, label));
  }

  /** Close every pane on the workspace — a bulk pane close, as on the other adapters. */
  async closeTab(tabId: string): Promise<MuxAck> {
    const tab = await this.tabById(tabId);
    if (!tab.ok) return tab;
    const { session, workspace } = tab.value;
    try {
      const listed = await this.rpc.listWindows(session.name);
      const doomed = listed.windows.filter((window) => window.workspace === workspace && window.host === "");
      for (const window of doomed) await this.rpc.closeWindow(session.name, window.windowId);
      return muxAck();
    } catch (err) {
      return refusalFor(err);
    }
  }

  /**
   * A new space: a detached tuios session with one shell. A name the daemon already holds comes
   * back `session_exists`, which is `refused` with tuios's own sentence.
   */
  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const asked = requestedCwd(request.cwd);
    const label = request.label?.trim() ?? "";
    try {
      const created = await this.rpc.newSession(label.length > 0 ? label : undefined, asked);
      return muxOk({
        paneId: created.windowId,
        spaceId: created.sessionId,
        spaceLabel: created.session,
        tabId: tabIdOf(created.sessionId, 1),
        cwd: asked ?? "",
      });
    } catch (err) {
      return refusalFor(err);
    }
  }

  // ── Worktrees and sessions: declined ──────────────────────────────────────────────────────────
  //
  // Worktrees are left out of the first version. tuios has worktree verbs, and they wait for their
  // own probe and their own change.

  listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return Promise.resolve(muxUnsupported("listWorktrees", "worktrees are not part of the first tuios adapter"));
  }

  createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createWorktree", "worktrees are not part of the first tuios adapter"));
  }

  openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return Promise.resolve(muxUnsupported("openWorktree", "worktrees are not part of the first tuios adapter"));
  }

  /**
   * Declined: every session of this daemon is already a space in one snapshot. The only other
   * instance there could be is another DAEMON, under another runtime directory, and tuios has no
   * command that lists daemons.
   */
  listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return Promise.resolve(
      muxUnsupported("listSessions", "every session of this tuios daemon is already a space here, and tuios has no command that lists other daemons"),
    );
  }

  /**
   * The contract's watch over one `subscribe` stream across every session.
   *
   * The stream RESUMES: each watch starts from the last event any watch of this adapter read, so
   * the daemon replays what happened between two watches, or sends a `gap` when its ring no longer
   * holds it, and a gap re-reads everything (tuios docs/protocol.md § Resuming a stream).
   */
  watch(options: MuxWatchOptions): MuxSubscription {
    const watched = new Set(options.panes);
    return this.rpc.subscribe({
      types: subscriptionTypes(options.panes),
      resume: this.resumeAt,
      onUp: (ack) => {
        this.resumeAt = ack;
        options.onUp();
      },
      onEvent: (event) => {
        // A gap marker carries no seq; everything else moves the resume point forward.
        if (event.seq > 0) this.resumeAt = { seq: event.seq, bootId: event.bootId };
        const route = routeEvent(event.type, event.window, watched);
        if (route.kind === "topology") options.onTopologyChange();
        else if (route.kind === "pane") options.onPaneChange(route.paneId);
      },
      onDown: (reason) => options.onDown(reason),
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────

  /** One session's windows and workspaces, or `null` when it closed before they were read. */
  private async listSession(session: WireSession): Promise<SessionListing | null> {
    try {
      const [windows, workspaces] = await Promise.all([
        this.rpc.listWindows(session.name),
        this.rpc.listWorkspaces(session.name),
      ]);
      return { session, windows, workspaces };
    } catch (err) {
      if (err instanceof TuiosError && err.code === "session_not_found") return null;
      throw err;
    }
  }

  /**
   * Which session holds this pane, and the window itself. A window this daemon does not list, or one
   * whose process runs on another machine, is `gone`: that pane belongs to the Collie running there.
   */
  private async locate(paneId: string): Promise<MuxOutcome<PaneLocation>> {
    try {
      const sessions = await this.rpc.listSessions();
      const session = sessions.find((candidate) => candidate.windowIds.includes(paneId));
      if (session === undefined) return muxGone(`tuios lists no pane ${paneId}`);
      const window = (await this.rpc.listWindows(session.name)).windows.find((w) => w.windowId === paneId);
      if (window === undefined) return muxGone(`tuios lists no pane ${paneId}`);
      if (window.host !== "") return muxGone(`pane ${paneId} runs on ${window.host}, not on this machine`);
      return muxOk({ session, window });
    } catch (err) {
      return refusalFor(err);
    }
  }

  /**
   * What is wrong with the daemon on the socket, or `null` when nothing is. Asked once per daemon
   * start: `hello` is cheap and names the start, `list-verbs` is not and runs only on a new one.
   */
  private async compatibility(): Promise<string | null> {
    let hello;
    try {
      hello = await this.rpc.hello();
    } catch (err) {
      if (err instanceof TuiosError && err.code === "protocol_mismatch") {
        return `This tuios daemon does not speak protocol ${String(TUIOS_PROTOCOL)}, which this Collie needs. Update tuios or Collie so the two match. tuios said: ${err.message}`;
      }
      if (err instanceof TuiosError && err.code === "unknown_verb") {
        return "This tuios daemon is too old for Collie. Update tuios to 0.8.3 or newer, then restart its daemon with `tuios kill-server`.";
      }
      throw err;
    }
    if (this.checked?.instance === hello.instance && hello.instance !== "") return this.checked.problem;
    const types = await this.rpc.subscribeTypes();
    const problem = types.includes(TUIOS_REQUIRED_EVENT)
      ? null
      : `This tuios daemon (${hello.version || "unknown version"}) does not send ${TUIOS_REQUIRED_EVENT} events, which Collie needs. Update tuios to 0.8.3 or newer, then restart its daemon with \`tuios kill-server\`.`;
    this.checked = { instance: hello.instance, problem };
    return problem;
  }

  /** A space by its id. The id outlives a rename; the name is what the wire takes. */
  private async sessionById(spaceId: string): Promise<MuxOutcome<WireSession>> {
    try {
      const session = (await this.rpc.listSessions()).find((candidate) => candidate.id === spaceId);
      return session === undefined ? muxGone(`tuios lists no session with id ${spaceId}`) : muxOk(session);
    } catch (err) {
      return refusalFor(err);
    }
  }

  /** A tab by its id: the session it is in and the workspace number. */
  private async tabById(tabId: string): Promise<MuxOutcome<{ session: WireSession; workspace: number }>> {
    const parsed = parseTabId(tabId);
    if (parsed === null) return muxGone(`not a tuios tab: ${tabId}`);
    const session = await this.sessionById(parsed.sessionId);
    if (!session.ok) return session;
    return muxOk({ session: session.value, workspace: parsed.workspace });
  }

  /** Run a pane-addressed verb in the session that holds the pane. */
  private async onPane(paneId: string, call: (session: string) => Promise<void>): Promise<MuxAck> {
    const located = await this.locate(paneId);
    if (!located.ok) return located;
    return this.attempt(() => call(located.value.session.name));
  }

  /** One verb that answers nothing but "it happened", as the contract's ack-or-refusal. */
  private async attempt(call: () => Promise<void>): Promise<MuxAck> {
    try {
      await call();
      return muxAck();
    } catch (err) {
      return refusalFor(err);
    }
  }

  /** Drop the revision tracker of every pane the daemon no longer lists. The map's only shrink path. */
  private forgetGonePanes(panes: readonly MuxPane[]): void {
    if (this.revisions.size === 0) return;
    const live = new Set(panes.map((pane) => pane.paneId));
    for (const paneId of this.revisions.keys()) {
      if (!live.has(paneId)) this.revisions.delete(paneId);
    }
  }

  /** The daemon's revision for this pane, moved past a restart so it never goes backwards. */
  private stableRevision(paneId: string, bootId: string, raw: number): number {
    const last = this.revisions.get(paneId);
    const base = last !== undefined && last.bootId !== bootId ? last.reported + 1 : (last?.base ?? 0);
    const reported = Math.max(base + raw, last?.reported ?? 0);
    this.revisions.set(paneId, { bootId, base, reported });
    return reported;
  }
}

/**
 * The listings, in the port's words.
 *
 * Counts are counts of what this snapshot carries (MUX_CONTRACT.md § *Counts*): a window on another
 * machine is dropped (§ *Host locality*), so a workspace's own `window_count` is not used.
 */
function toSnapshot(
  listings: readonly SessionListing[],
  agents: readonly WireAgent[],
): MuxSnapshot {
  const agentByPane = new Map(agents.map((agent) => [agent.windowId, agent]));
  // Focus is per client. A session with a terminal attached is in front; with none attached, the
  // most recently active one is, which is where `tuios attach` with no name lands.
  const anyAttached = listings.some((listing) => listing.session.attached);
  const newest = listings.reduce<SessionListing | null>(
    (best, listing) => (best === null || listing.session.lastActive > best.session.lastActive ? listing : best),
    null,
  );
  const panes: MuxPane[] = [];
  const spaces: MuxSpace[] = [];
  const tabs: MuxTab[] = [];
  listings.forEach((listing, index) => {
    const { session, windows, workspaces } = listing;
    const local = windows.windows.filter((window) => window.host === "");
    const current = windows.currentWorkspace || session.currentWorkspace;
    const namedByNumber = new Map(workspaces.map((ws) => [ws.workspace, ws.name]));
    const panesPerWorkspace = new Map<number, number>();
    for (const window of local) panesPerWorkspace.set(window.workspace, (panesPerWorkspace.get(window.workspace) ?? 0) + 1);
    // Only a workspace that holds a pane here is a tab.
    const shown = workspaces.filter((ws) => (panesPerWorkspace.get(ws.workspace) ?? 0) > 0);
    for (const ws of shown) {
      tabs.push({
        tabId: tabIdOf(session.id, ws.workspace),
        spaceId: session.id,
        number: ws.workspace,
        label: ws.name === "" ? String(ws.workspace) : ws.name,
        focused: ws.workspace === current,
        paneCount: panesPerWorkspace.get(ws.workspace) ?? 0,
      });
    }
    spaces.push({
      spaceId: session.id,
      number: index + 1,
      label: session.name,
      focused: anyAttached ? session.attached : newest?.session.id === session.id,
      // The workspace on screen, or the first tab when the one on screen is empty.
      activeTabId: tabIdOf(session.id, shown.some((ws) => ws.workspace === current) ? current : (shown.at(0)?.workspace ?? current)),
      tabCount: shown.length,
      paneCount: local.length,
    });
    for (const window of local) {
      const pane: MutableMuxPane = {
        paneId: window.windowId,
        spaceId: session.id,
        spaceLabel: session.name,
        spaceNumber: index + 1,
        tabId: tabIdOf(session.id, window.workspace),
        cwd: window.cwd,
        // The session's focused window, on the workspace it shows. The daemon owns both, attached
        // or not, so it is where the operator's terminal is, or will be on the next attach.
        focused: window.focused && window.workspace === current,
        alive: true,
        agent: "shell",
        status: "unknown",
      };
      const agent = agentByPane.get(window.windowId);
      const name = agent === undefined ? null : agentName(agent.harnessId);
      if (agent !== undefined && name !== null) {
        const running = agent.state !== "none" && agent.state !== "";
        if (running) {
          pane.agent = name;
          pane.status = agentStatus(agent.state);
        }
        if (agent.agentSessionId !== "") {
          pane.agentSession = { kind: "id", value: agent.agentSessionId };
          // The agent left and its conversation stayed: the pane reads as a shell again, and the
          // journal is told whose log the id names (../types.ts § MuxPane.sessionAgent).
          if (!running) pane.sessionAgent = name;
        }
      }
      const workspaceName = namedByNumber.get(window.workspace) ?? "";
      if (workspaceName !== "") {
        pane.tabLabel = workspaceName;
        pane.tabNamed = true;
      }
      if (window.customName !== "") pane.paneLabel = window.customName;
      const title = meaningfulTerminalTitle(programTitle(window), undefined, pane.agent, session.name);
      if (title !== undefined) pane.terminalTitle = title;
      // The scrollback above the screen plus the screen: what a `recent` read can return.
      if (window.height > 0) pane.readableLines = window.historyRows + window.height;
      panes.push(pane);
    }
  });
  return { panes, spaces, tabs };
}

/**
 * tuios's entry in the mux registry.
 *
 * `endpoint` is the daemon's socket path (`COLLIE_MUX_ENDPOINT_TUIOS`). Empty means the one a tuios
 * client in the bridge's environment would dial: `$XDG_RUNTIME_DIR/tuios/tuios.sock`, else
 * `/tmp/tuios-<uid>/tuios.sock`. A systemd user unit has `XDG_RUNTIME_DIR`; a unit without it would
 * look in `/tmp`, and the probe's skip line names the path it tried.
 */
export const tuiosMuxFactory: MuxAdapterFactory = {
  mux: TUIOS_MUX,
  create(target: MuxTarget) {
    return new TuiosMux(new TuiosClient(tuiosSocketFor(target.endpoint), target.timeoutMs || DEFAULT_TUIOS_TIMEOUT_MS));
  },
  describeTarget(endpoint: string) {
    return `socket ${tuiosSocketFor(endpoint)}`;
  },
};

/** The socket an endpoint names: itself, or tuios's own default when it is blank. */
export function tuiosSocketFor(endpoint: string): string {
  const named = endpoint.trim();
  return named.length > 0 ? named : defaultTuiosSocket(process.env.XDG_RUNTIME_DIR, process.getuid?.() ?? 0);
}
