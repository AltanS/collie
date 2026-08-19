// HERDR, BEHIND THE CONTRACT — the reference adapter (M10/02).
//
// Everything above this file talks the mux port (../types.ts); everything below it (`client.ts`)
// talks Herdr's socket. So this module is the whole translation, and it is deliberately the ONLY
// place that holds both vocabularies at once:
//
//   • the mapping from Herdr's wire records to `MuxPane` / `MuxSpace` / `MuxTab`, including the
//     three derivations the state engine used to do inline (the workspace join, the meaningful
//     tab label, the meaningful terminal title) — those are *what the multiplexer knows*, so they
//     belong to the adapter that knows it;
//   • the `session.snapshot` → three-list-calls fallback for a server that predates the method,
//     which is a Herdr version fact and nothing the port should ever hear about;
//   • the key spelling (keys.ts) and the event subscriptions (events.ts).
//
// WHAT IT DOES NOT DO. It never reaches across a machine boundary: `MuxTarget.endpoint` is a local
// socket path and `dial.ts` picks a LOCAL dialer for it (unix socket / Windows named pipe). A remote
// herd is reached by talking to the Collie running on that machine, never by dialling its Herdr
// (ADR 0011, ADR 0022) — so nothing here grows a host, and neither does dial.ts.
//
// CAPABILITIES ARE DECLARED FROM THE METHODS BELOW, one for one. Herdr implements every one of the
// contract's fourteen, which is unsurprising — Collie's routes were written against Herdr — and is
// exactly why the declaration must be read off the implementation rather than assumed: the value of
// the list is that the NEXT adapter's is shorter.

import { meaningfulTabLabel, meaningfulTerminalTitle } from "../../activity.ts";
import type { DialMode } from "../../dial.ts";
import { declareCapabilities } from "../capabilities.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxOk,
  muxRefused,
  muxUnreachable,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxPane,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTab,
  type MuxTabRequest,
  type MuxWatchOptions,
} from "../types.ts";
import {
  DEFAULT_TIMEOUT_MS,
  HerdrClient,
  paneAgentSession,
  type CreatedShell,
  type WirePane,
  type WireTab,
  type WireWorkspace,
} from "./client.ts";
import { buildSubscriptions, changedPaneId } from "./events.ts";
import { HERDR_UNSENDABLE_KEYS, toHerdrKey } from "./keys.ts";

/** The registry name this adapter answers to, and the value of {@link HerdrMux.mux}. */
export const HERDR_MUX = "herdr";

/**
 * What Herdr can do, read off the methods in this file.
 *
 * Every capability is claimed, and each one has a method below that implements it — `paneGrid` and
 * `gridScrollback` are `pane.read`'s two sources, `agentDetection`/`agentSessionRef` are fields the
 * pane record carries, the six structural verbs are one RPC each, and both push capabilities are the
 * one `events.subscribe` stream. `unsupportedKeys` is where Herdr's actual hole is: six named keys
 * the server refuses (keys.ts).
 */
const HERDR_CAPABILITIES = declareCapabilities({
  supports: [
    "paneGrid",
    "gridScrollback",
    "agentDetection",
    "agentSessionRef",
    "typeText",
    "sendKeys",
    "renamePane",
    "closePane",
    "createTab",
    "renameTab",
    "closeTab",
    "createSpace",
    "pushTopologyEvents",
    "pushPaneEvents",
  ],
  unsupportedKeys: HERDR_UNSENDABLE_KEYS,
  notes: {
    gridScrollback:
      "Herdr reports a pane's scrollback depth, so how far back a read can reach is known rather than guessed (MuxPane.readableLines) — its own `truncated` flag is always false and must not be gated on.",
  },
});

/** `MuxTarget.options` key carrying which local dialer to use. Opaque to the registry, by rule. */
export const HERDR_DIAL_MODE_OPTION = "dialMode";

/**
 * A `dialMode` option, or `auto` when the target carries none.
 *
 * Checked against the three names rather than trusted, because `MuxTarget.options` is an untyped
 * string map by design — the registry passes it through without reading a key.
 */
export function dialModeOf(options: Readonly<Record<string, string>>): DialMode {
  const mode = options[HERDR_DIAL_MODE_OPTION];
  return mode === "bun" || mode === "net" ? mode : "auto";
}

/** What a rejected call says, when the rejection is an exception rather than an answer. */
function reason<T>(err: T): string {
  return err instanceof Error ? err.message : String(err);
}

export class HerdrMux implements MuxAdapter {
  readonly mux = HERDR_MUX;
  readonly capabilities = HERDR_CAPABILITIES;

  // session.snapshot is the fast path; flipped off PERMANENTLY once a server proves it predates the
  // method (see snapshot()), after which every read uses the legacy three-call path. Adapter state
  // rather than engine state: which methods a server has is a fact about this multiplexer.
  private supportsSessionSnapshot = true;

  constructor(private readonly client: HerdrClient) {}

  /** Reachability for the connected/disconnected banner — one cheap list call. */
  reachable(): Promise<boolean> {
    return this.client.ping();
  }

  /**
   * The whole herd, preferring the single `session.snapshot` round-trip (herdr ≥ 0.7.2).
   *
   * Only an "unknown variant" error (the server predates the method) trips a PERMANENT fallback —
   * and the three list calls run in the SAME call so no poll is missed. Any other failure (timeout,
   * closed socket) is transient and PROPAGATES: `snapshot` is the contract's floor and has no
   * refusal shape, so a caller learns the multiplexer is unreachable the way it always did.
   */
  async snapshot(): Promise<MuxSnapshot> {
    const wire = await this.fetchWire();
    const spaceById = new Map(wire.workspaces.map((w) => [w.workspace_id, w]));
    const tabById = new Map(wire.tabs.map((t) => [t.tab_id, t]));
    return {
      panes: wire.panes.map((p) => toMuxPane(p, spaceById, tabById)),
      spaces: wire.workspaces.map(toMuxSpace),
      tabs: wire.tabs.map(toMuxTab),
    };
  }

  private async fetchWire(): Promise<{
    workspaces: WireWorkspace[];
    panes: WirePane[];
    tabs: WireTab[];
  }> {
    if (this.supportsSessionSnapshot) {
      try {
        const snap = await this.client.sessionSnapshot();
        return { workspaces: snap.workspaces, panes: snap.panes, tabs: snap.tabs };
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("unknown variant"))) throw err;
        this.supportsSessionSnapshot = false;
        console.log("[state] herdr predates session.snapshot — using list-call polling");
      }
    }
    const [workspaces, panes, tabs] = await Promise.all([
      this.client.listWorkspaces(),
      this.client.listPanes(),
      this.client.listTabs(),
    ]);
    return { workspaces, panes, tabs };
  }

  /**
   * One pane's rendered screen.
   *
   * `scope` picks Herdr's read source and `styling` its format, and the pairing is not cosmetic: a
   * `recent` read in `text` format makes Herdr harvest the pages above an alt-screen pane by driving
   * the agent's own scroll interface — the operator watches their terminal jump and snap back. The
   * mirror asks for `recent` + `preserve`; the session-name scrape asks for `viewport` + `strip`.
   * See HERDR_API.md → `pane.read` and the note above SESSION_NAME_READ_LINES.
   */
  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    try {
      const read = await this.client.readPane(
        paneId,
        request.scope === "viewport" ? "visible" : "recent",
        request.lines,
        request.styling === "strip" ? "text" : "ansi",
      );
      return muxOk({
        paneId: read.pane_id,
        text: read.text,
        truncated: read.truncated,
        revision: read.revision,
      });
    } catch (err) {
      return muxUnreachable(reason(err));
    }
  }

  async typeText(paneId: string, text: string): Promise<MuxAck> {
    return this.attempt(() => this.client.sendPaneText(paneId, text));
  }

  /**
   * Keys in the contract's spelling, translated and applied in order.
   *
   * A batch containing one chord Herdr cannot express sends NOTHING — the keys of one call are a
   * sequence, and delivering its front half is worse than delivering none of it (the pane would be
   * left mid-chord with no way for the caller to know where it stopped).
   */
  async sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const translated: string[] = [];
    for (const key of keys) {
      const result = toHerdrKey(key);
      if (!result.ok) {
        return muxRefused(
          result.reason === "unsendable"
            ? `herdr cannot send ${key} — no key sends it (paging and edit keys); scroll the mirror instead`
            : `not a key: ${key}`,
        );
      }
      translated.push(result.key);
    }
    return this.attempt(() => this.client.sendPaneKeys(paneId, translated));
  }

  async renamePane(paneId: string, label: string | null): Promise<MuxAck> {
    return this.attempt(() => this.client.renamePane(paneId, label));
  }

  async closePane(paneId: string): Promise<MuxAck> {
    return this.attempt(() => this.client.closePane(paneId));
  }

  /**
   * A new tab in a space, opening a fresh shell.
   *
   * `spaceLabel` comes back as the space id: `tab.create` returns the pane, not the workspace
   * record, and a second round-trip to learn a label the caller already has in its snapshot would be
   * a worse trade. That is the same fallback the route applied before this seam existed.
   */
  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    // Assigned, never spread: an absent label must stay absent (herdr stores "" literally).
    const opts: Parameters<HerdrClient["createTab"]>[1] = {};
    if (request.label !== undefined) opts.label = request.label;
    if (request.cwd !== undefined) opts.cwd = request.cwd;
    try {
      const created = await this.client.createTab(request.spaceId, opts);
      return muxOk(toCreatedPane(created));
    } catch (err) {
      return muxUnreachable(reason(err));
    }
  }

  async renameTab(tabId: string, label: string): Promise<MuxAck> {
    return this.attempt(() => this.client.renameTab(tabId, label));
  }

  async closeTab(tabId: string): Promise<MuxAck> {
    return this.attempt(() => this.client.closeTab(tabId));
  }

  /** A new space with a fresh shell pane. Herdr returns the workspace record, so its label is real. */
  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const opts: Parameters<HerdrClient["createWorkspace"]>[0] = { cwd: request.cwd };
    if (request.label !== undefined) opts.label = request.label;
    try {
      const created = await this.client.createWorkspace(opts);
      return muxOk(toCreatedPane(created));
    } catch (err) {
      return muxUnreachable(reason(err));
    }
  }

  /**
   * The contract's watch over Herdr's one `events.subscribe` stream.
   *
   * Both push capabilities ride the same connection: a `pane_*` event naming a pane is that pane's
   * change, everything else is the herd's structure. Nothing here reads an event as state — the
   * caller re-reads, which is why an event naming no pane falls to the topology side (re-read more,
   * never less).
   */
  watch(options: MuxWatchOptions): MuxSubscription {
    return this.client.subscribeEvents({
      subscriptions: buildSubscriptions(options.panes),
      onUp: () => options.onUp(),
      onEvent: (event, data) => {
        const paneId = changedPaneId(event, data);
        if (paneId === null) options.onTopologyChange();
        else options.onPaneChange(paneId);
      },
      onDown: (why) => options.onDown(why),
    });
  }

  /** One RPC that answers nothing but "it happened", as the contract's ack-or-refusal. */
  private async attempt(call: () => Promise<void>): Promise<MuxAck> {
    try {
      await call();
      return muxAck();
    } catch (err) {
      return muxUnreachable(reason(err));
    }
  }
}

/** The freshly-created shell pane, in the port's words. */
function toCreatedPane(created: CreatedShell): MuxCreatedPane {
  return {
    paneId: created.paneId,
    spaceId: created.workspaceId,
    spaceLabel: created.workspaceLabel ?? created.workspaceId,
    tabId: created.tabId,
    cwd: created.cwd,
  };
}

/**
 * One Herdr pane record as a {@link MuxPane}.
 *
 * The joins live here because the space and tab a pane belongs to are things the MULTIPLEXER knows;
 * a caller re-deriving them would have to learn Herdr's record shapes to do it.
 */
type MutableMuxPane = { -readonly [K in keyof MuxPane]: MuxPane[K] };

function toMuxPane(
  raw: WirePane,
  spaceById: Map<string, WireWorkspace>,
  tabById: Map<string, WireTab>,
): MuxPane {
  const space = spaceById.get(raw.workspace_id);
  const spaceLabel = space?.label ?? raw.workspace_id;
  // Herdr reports the agent name already lower-cased (`claude`, `codex`, `pi`, `omp`) and reports
  // nothing at all for a bare shell. Passed through rather than re-cased, so the name the harness
  // and journal registries key on is byte-identical to what Herdr said.
  const agent = raw.agent !== null && raw.agent !== undefined && raw.agent.length > 0 ? raw.agent : "shell";
  // Built mutable and returned readonly: every optional field below is ASSIGNED rather than
  // conditionally spread, so absent stays absent and each condition reads as the one rule it is.
  const pane: MutableMuxPane = {
    paneId: raw.pane_id,
    spaceId: raw.workspace_id,
    spaceLabel,
    spaceNumber: space?.number ?? 0,
    tabId: raw.tab_id,
    cwd: raw.cwd,
    focused: raw.focused,
    // Herdr drops a pane from `pane.list` when it goes away — a listed pane is a live one, and an
    // id that has left the snapshot answers `pane_not_found` on the next write.
    alive: true,
    agent,
    status: raw.agent_status,
  };
  // Optional fields are ASSIGNED, never conditionally spread: absent stays absent, and each
  // condition below stays readable as the one rule it encodes.
  //
  // A user-set pane label (herdr pane.rename); omitted when unset.
  if (raw.label !== null && raw.label !== undefined && raw.label.length > 0) pane.paneLabel = raw.label;
  // The tab's label, dropped when it's Herdr's positional default in a single-tab space.
  const tabLabel = meaningfulTabLabel(tabById.get(raw.tab_id)?.label, space?.tab_count ?? 0);
  if (tabLabel) pane.tabLabel = tabLabel;
  // What the pane says it is doing, dropped when it only repeats the agent name or the space label.
  const terminalTitle = meaningfulTerminalTitle(
    raw.terminal_title,
    raw.terminal_title_stripped,
    agent,
    spaceLabel,
  );
  if (terminalTitle) pane.terminalTitle = terminalTitle;
  // How the agent named its session. BOTH kinds are kept: Claude and Codex report an `id`, while pi
  // reports a `path`. Which kinds are meaningful is the journal adapter's call, not this function's.
  //
  // The ref must also BELONG to the agent currently in the pane. Herdr keeps reporting the last
  // session announced for a pane, so relaunching a pane's agent as a different harness leaves the
  // old one's ref behind — live-observed: a pane running `pi` still advertising a claude `id` from
  // the claude that had been there before. Serving that would hand pi's adapter a Claude uuid.
  // Absence of `agent` stays permissive, so an older server that omits the field still works.
  const session = paneAgentSession(raw.agent_session);
  if (session !== null && (session.agent === undefined || session.agent === agent)) {
    pane.agentSession = { kind: session.kind, value: session.value };
  }
  // Scrollback depth + viewport = what a `recent` read can yield. Omitted when the server predates
  // `scroll`, so an older Herdr reads as "unknown" rather than "zero".
  if (raw.scroll) pane.readableLines = raw.scroll.max_offset_from_bottom + raw.scroll.viewport_rows;
  return pane;
}

/** One Herdr workspace as a {@link MuxSpace}. `agent_status` is carried on the wire and unused. */
function toMuxSpace(raw: WireWorkspace): MuxSpace {
  return {
    spaceId: raw.workspace_id,
    number: raw.number,
    label: raw.label,
    focused: raw.focused,
    activeTabId: raw.active_tab_id,
    tabCount: raw.tab_count,
    paneCount: raw.pane_count,
  };
}

/** One Herdr tab as a {@link MuxTab}. */
function toMuxTab(raw: WireTab): MuxTab {
  return {
    tabId: raw.tab_id,
    spaceId: raw.workspace_id,
    number: raw.number,
    label: raw.label,
    focused: raw.focused,
    paneCount: raw.pane_count,
  };
}

/**
 * Herdr's entry in the mux registry.
 *
 * The factory is where a socket path becomes a client: `endpoint` is the Herdr socket, `timeoutMs`
 * the per-request budget, and the one adapter-private option is which local dialer opens it.
 */
export const herdrMuxFactory: MuxAdapterFactory = {
  mux: HERDR_MUX,
  create(target: MuxTarget) {
    return new HerdrMux(
      new HerdrClient(target.endpoint, target.timeoutMs || DEFAULT_TIMEOUT_MS, dialModeOf(target.options)),
    );
  },
};
