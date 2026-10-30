// HERDR-CORE, BEHIND THE CONTRACT: the adapter for the new Herdr core (`herdr-core`, CLI `hc`),
// over the core's JSON-RPC socket. Milestone M74.
//
// Everything above this file talks the mux port (../types.ts); everything below it (client.ts,
// keys.ts, layout.ts, events.ts) talks the core. Every fact cited here is in HC_API.md, probed on
// hc 0.1.14, protocol generation 1, on 2026-10-29.
//
// NOT THE `herdr` ADAPTER. `herdr` drives the Herdr TUI over `herdr.sock`; this one drives the
// core that herdr-app draws on. They run side by side on one host, they share no socket and no
// code, and `HERDR_SOCKET_PATH` means nothing here.
//
// ── WHAT THE CORE IS, IN THE PORT'S WORDS ────────────────────────────────────────────────────────
//
// The core keeps TERMINALS, not panes, tabs or spaces. herdr-app keeps its spaces and tabs in a
// core document and tags each terminal with them; layout.ts reads both, and a terminal herdr-app
// does not show sits in one implicit space. A pane id is the terminal's address (`t7`), which the
// core never reuses and which survives a core restart (identity rules 2 and 4).
//
// Only LOCAL terminals are panes. A terminal on a machine the core added (`box/t7`) is dropped from
// the snapshot and answers `gone` to every call, because it belongs to the Collie on that machine
// (ADR 0036). The crew stays the multi-machine layer.
//
// ── WHAT IS DECLARED, AND WHAT IS NOT ────────────────────────────────────────────────────────────
//
// Declared, each from a probe: the grid (plain text, a derived revision), scrollback, agent
// detection (the program's own OSC 7501 report; where a program sends none, an exact, known foreground
// program name from the same table is a provisional identity with status `unknown`, never a status word), typing (a framed attach, see client.ts), keys,
// closing a pane, a new tab (a shell carrying herdr-app's labels), and both push channels.
// Declined: focus, every rename, closing a tab, a new space, worktrees, sessions, and an agent
// session ref. The core has no verb for any of them, and the layout belongs to herdr-app, which
// says to change it through its own commands. M74 spec 05 plans a herdr-app mod for those.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { declareCapabilities } from "../capabilities.ts";
import { EXTENDED_ONLY_CHORDS } from "../keys.ts";
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
  type MuxRefusalOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTabRequest,
  type MuxWatchOptions,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeScope,
} from "../types.ts";
import { DEFAULT_HC_TIMEOUT_MS, defaultHcSocket, HC_GENERATION, HcClient, HcError, HcTimeout, type HcRpc, type WireLayout, type WireRead, type WireTerminal } from "./client.ts";
import { routeEvent } from "./events.ts";
import { herdrCoreBeaconMatcher } from "./markers.ts";
import { HERDR_CORE_LOGO_SVG } from "./logo.ts";
import { HC_UNSENDABLE_KEYS, toHcKey, type HcKey } from "./keys.ts";
import { IMPLICIT_SPACE_ID, isLocalAddress, SPACE_LABEL, TAB_LABEL, toSnapshot } from "./layout.ts";

type MutableGrid = { -readonly [K in keyof MuxGrid]: MuxGrid[K] };

/** The registry name this adapter answers to, and the value of {@link HerdrCoreMux.mux}. */
export const HERDR_CORE_MUX = "herdr-core";

const HERDR_CORE_CAPABILITIES = declareCapabilities({
  supports: [
    "paneGrid",
    "gridScrollback",
    "agentDetection",
    "typeText",
    "sendKeys",
    "closePane",
    "createTab",
    "pushTopologyEvents",
    "pushPaneEvents",
  ],
  unsupportedKeys: [...HC_UNSENDABLE_KEYS, ...EXTENDED_ONLY_CHORDS],
  // The stream announces a terminal appearing, ending and being relabelled, and herdr-app's layout
  // document changing, which is every structure change Collie shows. So no census and no number.
  topologyLatency: { kind: "push" },
  notes: {
    paneGrid: "herdr-core hands out the screen as plain text, so the mirror shows no colour.",
    agentDetection:
      "herdr-core names the agent in a terminal from the agent's own status report. A program that sends no report is named from the process in the foreground, through the same table (omp sends none), and then has no status. A shell, or a process Collie has no harness for, reads as a shell.",
    agentSessionRef: "herdr-core keeps an agent's status but not its conversation id. The agent's own hook supplies it: install the hooks with `collie hooks install claude`.",
    sendKeys:
      "herdr-core presses keys by name. A Super or Command chord, Ctrl+Enter, and a modified key it has no name for (such as Ctrl+$) are refused.",
    renamePane: "herdr-core has no command that renames a terminal.",
    setFocus: "herdr-core does not know which terminal a screen shows. herdr-app keeps that on its own screen.",
    createTab:
      "A new tab is a new shell that herdr-app shows as a new tab in that space. A tab name cannot be set from the phone yet.",
    renameTab: "Tab names belong to herdr-app, and Collie does not change its layout.",
    renameSpace: "Space names belong to herdr-app, and Collie does not change its layout.",
    closeTab: "Tabs belong to herdr-app, and Collie does not change its layout.",
    createSpace: "Spaces belong to herdr-app, and Collie does not change its layout.",
    listWorktrees: "Worktrees are not part of the herdr-core adapter.",
    createWorktree: "Worktrees are not part of the herdr-core adapter.",
    openWorktree: "Worktrees are not part of the herdr-core adapter.",
    listSessions:
      "Each herdr-core session has its own socket. One collie drives one session; point a second collie at another with HC_SESSION.",
  },
  spaces: "many",
});

/** Error kinds that mean "it existed and does not any more", or "it is another machine's". */
const GONE_KINDS: ReadonlySet<string> = new Set(["not_found", "finished", "machine_unknown"]);

/**
 * Which refusal an exception off the socket is. A core error kind for something gone is `gone`,
 * any other kind is the core understanding and saying no (`refused`), and an exception with no
 * kind is the transport failing (`unreachable`), a connection that died mid-call included
 * (MUX_CONTRACT.md § Transport death).
 */
function refusalFor<T>(err: T): MuxRefusalOutcome {
  if (err instanceof HcError) return GONE_KINDS.has(err.kind) ? muxGone(err.message) : muxRefused(err.message);
  return muxUnreachable(err instanceof Error ? err.message : String(err));
}

/** A pane id this adapter may address: a local terminal. Another machine's is `gone` here. */
function remoteRefusal(paneId: string): MuxRefusalOutcome | null {
  return isLocalAddress(paneId) ? null : muxGone(`${paneId} is a terminal on another machine; its own Collie shows it`);
}

/**
 * One pane's derived revision. The core reports none, so the adapter counts: the number moves when
 * the pane's screen text differs from the last screen text any read saw, and never goes back.
 */
interface PaneRevision {
  revision: number;
  lastScreen: string;
}

/**
 * How long a read with scrollback may take before the screen alone answers it. A read with `lines`
 * above 0 is the core's history read (`how: history`, or `how: stitched` for a full-screen app,
 * HC_API.md § terminal.read), and it can hang: while a pi dialog stood, `lines: 60` gave no answer in
 * 30 s and the plain screen read (`lines: 0`) answered in 0.1 s (M78 spec 03, pi cases 2 and 3). The
 * client's own call budget is 5 s, so the pane read as unreadable and the dialog never reached the
 * phone. The screen read runs beside the history read; past this budget its rows answer, marked
 * `truncated` (the scrollback above them was cut), and the history read's late answer is dropped.
 */
export const HISTORY_READ_BUDGET_MS = 2000;

/**
 * How long a pane whose history read ran past {@link HISTORY_READ_BUDGET_MS} reads its screen alone,
 * counted from when the core ended that slow read. Time alone ends it: a screen change does not.
 * Each further slow read in a row doubles the wait, up to {@link HISTORY_READ_BACKOFF_MAX_MS}, and a
 * history read that answers inside the budget sets it back to this.
 *
 * WHY: giving up on Collie's side does not stop the core. hc 0.1.14 runs a terminal's history reads
 * and key presses one at a time; under pi's permission dialog one history read took 25 s and answered
 * `complete: false, how: screen`, and every `terminal.keys` on that terminal waited behind it. The
 * phone reads `recent` every 1.5 s, so a fresh history read per poll grew the queue for good and the
 * pane's keys stopped answering (M78 report 10, case 2: nine minutes). So a pane has at most one
 * history read on the core, none while its program reports `blocked` or the bridge's hint says so,
 * and none during this backoff.
 *
 * WHY NOT "until the screen changes": a pane with a dialog redraws every frame (pi's spinner, the
 * cursor), so its screen text changed on every read and such a backoff ended at once. The first fix
 * ended it that way, and one pi dialog still started ten 25 s history reads back to back (M78
 * report 10, the int/1.25.3 core leg).
 */
export const HISTORY_READ_BACKOFF_MS = 30_000;

/** The longest wait {@link HISTORY_READ_BACKOFF_MS} doubles to: 5 minutes. */
export const HISTORY_READ_BACKOFF_MAX_MS = 300_000;

/** What a test may change about the adapter: the history read's budget and backoff, the clock, and where its log lines go. */
export interface HerdrCoreOptions {
  readonly historyBudgetMs?: number;
  readonly historyBackoffMs?: number;
  readonly historyBackoffMaxMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/**
 * A pane's backoff after a slow history read: the wait it earned, and when it ends (`Infinity`
 * while the slow read still runs on the core). The entry outlives its end, so the next slow read
 * knows it came right after one and doubles the wait; a history read inside the budget removes it.
 */
interface HistoryBackoff {
  readonly waitMs: number;
  until: number;
}

export class HerdrCoreMux implements MuxAdapter {
  readonly mux = HERDR_CORE_MUX;
  readonly capabilities = HERDR_CORE_CAPABILITIES;
  readonly logo = HERDR_CORE_LOGO_SVG;

  private readonly revisions = new Map<string, PaneRevision>();

  /** Whether the core on the socket was last seen speaking our generation. `null`: not asked yet. */
  private compatible: boolean | null = null;

  /** Per pane, the history read the core still runs, until it settles; Collie's budget does not end it. */
  private readonly historyPending = new Map<string, Promise<WireRead>>();
  /** Per pane, the backoff after a slow history read, and the wait the next slow one doubles. */
  private readonly historyBackoff = new Map<string, HistoryBackoff>();
  /** Panes whose program reported `blocked` in the last snapshot: a dialog is up. */
  private readonly blockedPanes = new Set<string>();
  private readonly historyBudgetMs: number;
  private readonly historyBackoffMs: number;
  private readonly historyBackoffMaxMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly rpc: HcRpc,
    private readonly home: string = homedir(),
    options: HerdrCoreOptions = {},
  ) {
    this.historyBudgetMs = options.historyBudgetMs ?? HISTORY_READ_BUDGET_MS;
    this.historyBackoffMs = options.historyBackoffMs ?? HISTORY_READ_BACKOFF_MS;
    this.historyBackoffMaxMs = options.historyBackoffMaxMs ?? HISTORY_READ_BACKOFF_MAX_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Is a core answering, at generation 1? A core at another generation reads as unreachable. */
  async reachable(): Promise<boolean> {
    try {
      return (await this.compatibility()) === null;
    } catch {
      return false;
    }
  }

  /**
   * Every local live terminal, in herdr-app's spaces and tabs.
   *
   * Two reads side by side: `terminal.list` and herdr-app's layout document. A failure of the list
   * PROPAGATES, because the snapshot is the floor and has no refusal view. A failure of the
   * document does not: without it the names fall back to herdr-app's `where` label and the folders.
   */
  async snapshot(): Promise<MuxSnapshot> {
    const problem = await this.compatibility();
    if (problem !== null) throw new Error(problem);
    let read: [WireTerminal[], WireLayout | null];
    try {
      read = await Promise.all([this.rpc.listTerminals(), this.rpc.readLayout().catch(() => null)]);
    } catch (err) {
      this.compatible = null;
      throw err;
    }
    const snapshot = toSnapshot(read[0], read[1], this.home);
    this.forgetGonePanes(snapshot);
    this.noteHistoryState(snapshot);
    return snapshot;
  }

  /** A no-op that resolves, as Herdr's is: every snapshot is a fresh read, and the watch pushes. */
  refresh(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * One pane's rendered screen, as plain text: the core gives no colour, so `preserve` and `strip`
   * read the same text, which carries no escape at all. A `recent` read asks for `lines` lines of
   * history and keeps the last `lines` lines of what comes back.
   *
   * A read the core calls incomplete (`complete: false`, HC_API.md § terminal.read: part of it may be
   * missing while a full-screen app works) is handed over with `partial` set, on any read: the mirror
   * shows it, and the Send Protocol takes it as no read and decides nothing on it.
   *
   * A `recent` read whose history read has not answered within {@link HISTORY_READ_BUDGET_MS} is
   * answered with the screen's rows, read beside it, and marked `truncated`. So is a `recent` read
   * that starts no history read: one is still running on the core, the program reports `blocked`,
   * the request's hint says the bridge reads the pane as blocked, or the pane is in its
   * {@link HISTORY_READ_BACKOFF_MS} backoff.
   */
  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    const remote = remoteRefusal(paneId);
    if (remote !== null) return remote;
    const lines = Math.max(1, request.lines);
    try {
      if (request.scope === "viewport") {
        const screen = await this.rpc.readTerminal(paneId, 0);
        return muxOk(this.gridOf(paneId, screen, screen, { keep: null, truncated: false }));
      }
      const answered = await this.historyOrScreen(paneId, lines, request.hint?.blocked === true);
      return muxOk(this.gridOf(paneId, answered.read, answered.screen, { keep: lines, truncated: answered.truncated }));
    } catch (err) {
      return refusalFor(err);
    }
  }

  /**
   * The history read of `lines`, or the screen read beside it when the history read runs past the
   * budget. A history read that fails inside the budget fails the read, as it always did; a late answer
   * of either kind is dropped.
   *
   * At most one history read per pane runs on the core (see {@link HISTORY_READ_BACKOFF_MS}). While it
   * runs, while the program reports `blocked` or the bridge's hint does (`hintBlocked`), and during the
   * backoff after a slow one, the screen read alone answers, marked `truncated`, and no history read
   * starts.
   */
  private async historyOrScreen(paneId: string, lines: number, hintBlocked: boolean): Promise<{ read: WireRead; screen: WireRead; truncated: boolean }> {
    const screen = this.rpc.readTerminal(paneId, 0);
    // Whichever is not used must not surface as an unhandled rejection.
    screen.catch(() => undefined);
    if (this.historyPending.has(paneId) || this.blockedPanes.has(paneId) || hintBlocked || this.inBackoff(paneId)) {
      const shown = await screen;
      return { read: shown, screen: shown, truncated: true };
    }
    const history = this.startHistoryRead(paneId, lines);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.historyBudgetMs);
    });
    try {
      const read = await Promise.race([history, late]);
      if (read !== null) {
        this.historyBackoff.delete(paneId);
        return { read, screen: await screen, truncated: false };
      }
    } finally {
      clearTimeout(timer);
    }
    this.startBackoff(paneId, history);
    const shown = await screen;
    return { read: shown, screen: shown, truncated: true };
  }

  /** Is this pane inside its backoff after a slow history read? An entry past its end is not, and stays for the doubling. */
  private inBackoff(paneId: string): boolean {
    const backoff = this.historyBackoff.get(paneId);
    return backoff !== undefined && this.now() < backoff.until;
  }

  /** One history read on the core, remembered as the pane's pending one until it settles, however late. */
  private startHistoryRead(paneId: string, lines: number): Promise<WireRead> {
    const history = this.rpc.readTerminal(paneId, lines);
    this.historyPending.set(paneId, history);
    const settled = () => {
      if (this.historyPending.get(paneId) !== history) return;
      this.historyPending.delete(paneId);
      const backoff = this.historyBackoff.get(paneId);
      if (backoff !== undefined && backoff.until === Number.POSITIVE_INFINITY) backoff.until = this.now() + backoff.waitMs;
    };
    history.then(settled, settled);
    return history;
  }

  /**
   * The backoff after a slow history read. Its clock starts when the core ends that read. A slow read
   * right after a backoff doubles the wait, up to the cap. Logged when a pane's backoff starts and each
   * time its wait doubles, never once per read.
   */
  private startBackoff(paneId: string, history: Promise<WireRead>): void {
    const previous = this.historyBackoff.get(paneId);
    const waitMs = previous === undefined ? this.historyBackoffMs : Math.min(previous.waitMs * 2, this.historyBackoffMaxMs);
    const running = this.historyPending.get(paneId) === history;
    this.historyBackoff.set(paneId, { waitMs, until: running ? Number.POSITIVE_INFINITY : this.now() + waitMs });
    const wait = `${String(Math.round(waitMs / 1000))} s`;
    if (previous === undefined) {
      this.log(`[herdr-core] pane ${paneId}: history read slow (no answer in ${String(this.historyBudgetMs)} ms), screen-only reads for ${wait} after it ends`);
      return;
    }
    if (waitMs > previous.waitMs) this.log(`[herdr-core] pane ${paneId}: history read slow again, screen-only reads for ${wait} after it ends`);
  }

  /**
   * One read as a grid: its rows (the last `keep` of them, when set), `partial` when the core says so,
   * and a revision derived from `screen`, the screen read beside it (the read itself for a viewport
   * read), never from the rows of `read`.
   */
  private gridOf(paneId: string, read: WireRead, screen: WireRead, cut: { keep: number | null; truncated: boolean }): MuxGrid {
    const rows = read.text.replace(/\n$/u, "").split("\n");
    const text = (cut.keep === null ? rows : rows.slice(-cut.keep)).join("\n");
    const grid: MutableGrid = { paneId, text, truncated: cut.truncated, revision: this.revisionFor(paneId, screen.text.replace(/\n$/u, "")) };
    if (!read.complete) grid.partial = true;
    return grid;
  }

  /** Literal text, written to the terminal as raw input through a framed attach, submitting nothing. */
  async typeText(paneId: string, text: string): Promise<MuxAck> {
    const remote = remoteRefusal(paneId);
    if (remote !== null) return remote;
    if (text.length === 0) return muxAck();
    return this.attempt(() => this.rpc.typeRaw(paneId, text));
  }

  /**
   * Keys in the contract's spelling, translated whole before anything is sent. Consecutive key
   * names go in one `terminal.keys` call; a plain character the core cannot name goes as raw
   * input in between, so the order holds.
   */
  async writeKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const remote = remoteRefusal(paneId);
    if (remote !== null) return remote;
    const translated: HcKey[] = [];
    for (const key of keys) {
      const result = toHcKey(key);
      if (!result.ok) {
        if (result.reason === "meta") {
          return muxRefused(`herdr-core is not known to deliver a Super or Command key, so ${key} is refused. Use alt for the Alt key.`);
        }
        if (result.reason === "extended") {
          return muxRefused(`${key} is not known to reach a herdr-core terminal as itself rather than as the plain key, so it is refused rather than mis-sent`);
        }
        if (result.reason === "unnamed") return muxRefused(`herdr-core has no name for ${key}`);
        return muxRefused(`not a key: ${key}`);
      }
      translated.push(result.key);
    }
    if (translated.length === 0) return muxAck();
    return this.attemptKeys(paneId, async () => {
      let names: string[] = [];
      const flush = async () => {
        if (names.length === 0) return;
        const batch = names;
        names = [];
        await this.rpc.pressKeys(paneId, batch);
      };
      for (const key of translated) {
        if (key.kind === "key") {
          names.push(key.name);
          continue;
        }
        await flush();
        await this.rpc.typeRaw(paneId, key.text);
      }
      await flush();
    });
  }

  /**
   * End the terminal's program. A terminal that already finished is `gone`: the core answers a kill
   * of a finished record with the record, which would read as success for a pane that was not there.
   */
  async closePane(paneId: string): Promise<MuxAck> {
    const remote = remoteRefusal(paneId);
    if (remote !== null) return remote;
    try {
      const terminal = await this.rpc.getTerminal(paneId);
      if (terminal.state !== "live") return muxGone(`${paneId} has already ended`);
      await this.rpc.killTerminal(paneId);
      return muxAck();
    } catch (err) {
      return refusalFor(err);
    }
  }

  /**
   * A new tab: a shell started with herdr-app's labels for this space and a new tab id, which
   * herdr-app shows as a new tab ("an id Herdr doesn't know becomes a new space or tab", AGENTS.md).
   * Collie writes no layout document. In the implicit space the new shell joins its one tab.
   */
  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    let snapshot: MuxSnapshot;
    try {
      snapshot = await this.snapshot();
    } catch (err) {
      return refusalFor(err);
    }
    const space = snapshot.spaces.find((candidate) => candidate.spaceId === request.spaceId);
    if (space === undefined) return muxGone(`herdr-core shows no space ${request.spaceId}`);
    const implicit = space.spaceId === IMPLICIT_SPACE_ID;
    const tabId = implicit ? space.activeTabId : `tb${randomUUID().replaceAll("-", "")}`;
    const labels: Record<string, string> = implicit ? {} : { [SPACE_LABEL]: space.spaceId, [TAB_LABEL]: tabId };
    const asked = requestedCwd(request.cwd) ?? space.folder;
    try {
      const created = await this.rpc.runShell(asked === undefined ? { labels } : { labels, cwd: asked });
      return muxOk({ paneId: created.address, spaceId: space.spaceId, spaceLabel: space.label, tabId, cwd: created.cwd });
    } catch (err) {
      return refusalFor(err);
    }
  }

  // ── Declined: the core has no verb, or the layout is herdr-app's ──────────────────────────────

  renamePane(_paneId: string, _label: string | null): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("renamePane", "herdr-core has no command that renames a terminal"));
  }

  setFocus(_paneId: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("setFocus", "herdr-core does not know which terminal a screen shows"));
  }

  renameTab(_tabId: string, _label: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("renameTab", "tab names belong to herdr-app"));
  }

  closeTab(_tabId: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("closeTab", "tabs belong to herdr-app"));
  }

  createSpace(_request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createSpace", "spaces belong to herdr-app"));
  }

  listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return Promise.resolve(muxUnsupported("listWorktrees", "worktrees are not part of the herdr-core adapter"));
  }

  createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createWorktree", "worktrees are not part of the herdr-core adapter"));
  }

  openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return Promise.resolve(muxUnsupported("openWorktree", "worktrees are not part of the herdr-core adapter"));
  }

  listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return Promise.resolve(muxUnsupported("listSessions", "one collie drives one herdr-core session"));
  }

  /**
   * The contract's watch over one `events.subscribe` stream. The snapshot answer brings it up; a
   * heartbeat keeps it up; silence, a close or an error brings it down once, and the event poker
   * reconnects with its own backoff (bridge/event-poker.ts). Routing is events.ts.
   */
  watch(options: MuxWatchOptions): MuxSubscription {
    const watched = new Set(options.panes);
    return this.rpc.subscribe({
      onUp: () => options.onUp(),
      onEvent: (event) => {
        const route = routeEvent(event.type, event.terminal, watched);
        if (route.kind === "topology") options.onTopologyChange();
        else if (route.kind === "pane") options.onPaneChange(route.paneId);
      },
      onDown: (reason) => options.onDown(reason),
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────

  /** What is wrong with the core on the socket, or `null`. `hello` is asked again after a failure. */
  private async compatibility(): Promise<string | null> {
    if (this.compatible === true) return null;
    try {
      const hello = await this.rpc.hello();
      this.compatible = hello.generation === HC_GENERATION;
      return this.compatible
        ? null
        : `This herdr-core (${hello.version}) speaks protocol generation ${String(hello.generation)}, and this Collie speaks ${String(HC_GENERATION)}. Update Collie or herdr-core so the two match.`;
    } catch (err) {
      this.compatible = null;
      if (err instanceof HcError && err.kind === "unsupported_generation") {
        return `This herdr-core does not speak protocol generation ${String(HC_GENERATION)}, which this Collie needs. Update Collie or herdr-core so the two match. herdr-core said: ${err.message}`;
      }
      throw err;
    }
  }

  /**
   * {@link attempt} for keys. A call the core did not answer in time is `unconfirmed`, not a failure:
   * the core may still deliver the key (it did, M78 report 10 case 2). Nothing here sends it again;
   * the next read of the pane shows whether it landed.
   */
  private async attemptKeys(paneId: string, call: () => Promise<void>): Promise<MuxAck> {
    try {
      await call();
      return muxAck();
    } catch (err) {
      if (err instanceof HcTimeout) {
        return muxUnconfirmed(`herdr-core did not confirm the keys on ${paneId} in time (${err.message}). They may still arrive, so they were not sent again.`);
      }
      return refusalFor(err);
    }
  }

  /** What the last snapshot says about history reads: which panes are blocked, and the state of panes that are gone. */
  private noteHistoryState(snapshot: MuxSnapshot): void {
    this.blockedPanes.clear();
    const live = new Set<string>();
    for (const pane of snapshot.panes) {
      live.add(pane.paneId);
      if (pane.status === "blocked") this.blockedPanes.add(pane.paneId);
    }
    for (const paneId of this.historyBackoff.keys()) {
      if (!live.has(paneId)) this.historyBackoff.delete(paneId);
    }
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

  /**
   * The revision of a pane: one counter per pane that moves exactly when the pane's SCREEN text
   * differs from the last screen text any read saw. The core has no revision of its own, and the
   * phone's tap guard compares the revision of the card it drew with that of a fresh read, so every
   * view (the phone's 40 lines, the rig's 80, the bridge's own poll) must see the same number for one
   * screen. A counter per view bumped once per view for one change and made the guard refuse a tap
   * right after the screen changed as "changed". History and stitched rows never feed it.
   */
  private revisionFor(paneId: string, screenText: string): number {
    const entry = this.revisions.get(paneId);
    if (entry === undefined) {
      this.revisions.set(paneId, { revision: 1, lastScreen: screenText });
      return 1;
    }
    if (entry.lastScreen === screenText) return entry.revision;
    entry.revision += 1;
    entry.lastScreen = screenText;
    return entry.revision;
  }

  /** Drop the revision of every pane the core no longer lists. The map's only shrink path. */
  private forgetGonePanes(snapshot: MuxSnapshot): void {
    if (this.revisions.size === 0) return;
    const live = new Set(snapshot.panes.map((pane) => pane.paneId));
    for (const paneId of this.revisions.keys()) {
      if (!live.has(paneId)) this.revisions.delete(paneId);
    }
  }
}

/**
 * herdr-core's entry in the mux registry.
 *
 * `endpoint` is the core's client socket (`COLLIE_MUX_ENDPOINT_HERDR_CORE`). Empty means the one an
 * `hc` in the bridge's environment would dial: `HC_SOCKET`, else
 * `$XDG_RUNTIME_DIR/herdr-core/<HC_SESSION or default>.sock`, else the same under `/run/user/<uid>`.
 */
export const herdrCoreMuxFactory: MuxAdapterFactory = {
  mux: HERDR_CORE_MUX,
  create(target: MuxTarget) {
    return new HerdrCoreMux(new HcClient(herdrCoreSocketFor(target.endpoint), target.timeoutMs || DEFAULT_HC_TIMEOUT_MS));
  },
  /**
   * herdr-core's half of the beacon join (M74 spec 04): the hook edges land on a core terminal, and
   * a Claude's session id reaches the pane, because `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` name it.
   */
  beaconMatcher(target: MuxTarget) {
    return herdrCoreBeaconMatcher(HERDR_CORE_MUX, herdrCoreSocketFor(target.endpoint));
  },
  describeTarget(endpoint: string) {
    return `socket ${herdrCoreSocketFor(endpoint)}`;
  },
};

/** The socket an endpoint names: itself, or the core's own default when it is blank. */
export function herdrCoreSocketFor(endpoint: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const named = endpoint.trim();
  return named.length > 0 ? named : defaultHcSocket(env, process.getuid?.() ?? 0);
}
