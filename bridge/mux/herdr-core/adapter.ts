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
// detection from the program's own OSC 7501 report, typing (a framed attach, see client.ts), keys,
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
import { DEFAULT_HC_TIMEOUT_MS, defaultHcSocket, HC_GENERATION, HcClient, HcError, type HcRpc, type WireLayout, type WireTerminal } from "./client.ts";
import { routeEvent } from "./events.ts";
import { herdrCoreBeaconMatcher } from "./markers.ts";
import { HERDR_CORE_LOGO_SVG } from "./logo.ts";
import { HC_UNSENDABLE_KEYS, toHcKey, type HcKey } from "./keys.ts";
import { IMPLICIT_SPACE_ID, isLocalAddress, SPACE_LABEL, TAB_LABEL, toSnapshot } from "./layout.ts";

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
      "herdr-core names the agent in a terminal from the agent's own status report. A program that sends no report reads as a shell.",
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
 * a read of the SAME view (scope and lines, a view) returns different text, and never goes back. Keyed by
 * view so that a viewport read and a history read of one quiet pane do not bump each other.
 */
interface PaneRevision {
  revision: number;
  readonly lastText: Map<string, string>;
}

/** At most this many read views are remembered per pane; the oldest is forgotten first. */
const MAX_VIEWS_PER_PANE = 8;

export class HerdrCoreMux implements MuxAdapter {
  readonly mux = HERDR_CORE_MUX;
  readonly capabilities = HERDR_CORE_CAPABILITIES;
  readonly logo = HERDR_CORE_LOGO_SVG;

  private readonly revisions = new Map<string, PaneRevision>();

  /** Whether the core on the socket was last seen speaking our generation. `null`: not asked yet. */
  private compatible: boolean | null = null;

  constructor(
    private readonly rpc: HcRpc,
    private readonly home: string = homedir(),
  ) {}

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
   */
  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    const remote = remoteRefusal(paneId);
    if (remote !== null) return remote;
    const lines = Math.max(1, request.lines);
    try {
      const read = await this.rpc.readTerminal(paneId, request.scope === "viewport" ? 0 : lines);
      const rows = read.text.replace(/\n$/u, "").split("\n");
      const text = (request.scope === "viewport" ? rows : rows.slice(-lines)).join("\n");
      return muxOk({
        paneId,
        text,
        truncated: !read.complete,
        revision: this.revisionFor(paneId, `${request.scope}:${String(request.scope === "viewport" ? 0 : lines)}`, text),
      });
    } catch (err) {
      return refusalFor(err);
    }
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
    return this.attempt(async () => {
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

  /** One verb that answers nothing but "it happened", as the contract's ack-or-refusal. */
  private async attempt(call: () => Promise<void>): Promise<MuxAck> {
    try {
      await call();
      return muxAck();
    } catch (err) {
      return refusalFor(err);
    }
  }

  /** The revision for this read: the same as last time unless this view's text moved. */
  private revisionFor(paneId: string, view: string, text: string): number {
    let entry = this.revisions.get(paneId);
    if (entry === undefined) {
      entry = { revision: 1, lastText: new Map() };
      this.revisions.set(paneId, entry);
    }
    const last = entry.lastText.get(view);
    if (last !== undefined && last !== text) entry.revision += 1;
    entry.lastText.delete(view);
    entry.lastText.set(view, text);
    if (entry.lastText.size > MAX_VIEWS_PER_PANE) {
      const oldest = entry.lastText.keys().next();
      if (oldest.done !== true) entry.lastText.delete(oldest.value);
    }
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
