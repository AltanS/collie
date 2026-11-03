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
import { isUnnamedTab } from "../../pane-name.ts";
import type { DialMode } from "../../dial.ts";
import type { ForegroundProcess } from "../../journal/types.ts";
import { declareCapabilities } from "../capabilities.ts";
import { herdrMachineCandidates } from "./machine-list.ts";
import { herdrBeaconMatcher } from "./markers.ts";
import { herdrSessionSource } from "./sessions.ts";
import { HERDR_LOGO_SVG } from "./logo.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
  muxUnreachable,
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
  DEFAULT_TIMEOUT_MS,
  HerdrClient,
  paneAgentSession,
  type CreatedShell,
  type HerdrRpc,
  type PaneRead,
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
/** The bracketed-paste markers {@link HerdrMux.pasteBlock} frames a paste in. */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
/** Every CSI sequence: an `ansi` read carries SGR only (no cursor moves), and a `text` read none. */
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/**
 * How long one `pane.get` answer about a pane's scroll stands, in ms. A send reads the viewport several
 * times inside its S0 gap (about a second, see `BOUNDS.s0` in `bridge/surface/protocol.ts`), and the
 * whole send has 7,600 ms (`LOCK_BOUND_MS`), so the reads of one request share one answer instead of
 * paying a socket round trip each. The cost of a stale answer is small: an operator who scrolls inside
 * the window gets one old read, and the next request asks again.
 */
export const SCROLL_STATE_MEMO_MS = 1_000;
/** Whether {@link HerdrMux.pasteBlock} keeps a character: the line break, or not a control byte (C0, DEL, C1). */
function pasteKeeps(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return ch === "\n" || (code >= 0x20 && (code < 0x7f || code > 0x9f));
}

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
    "setFocus",
    "createTab",
    "renameTab",
    "closeTab",
    "createSpace",
    "pushTopologyEvents",
    "pushPaneEvents",
    "listSessions",
  ],
  unsupportedKeys: HERDR_UNSENDABLE_KEYS,
  // Herdr announces every structure change on `events.subscribe`, so there is no census and no
  // number to state (HERDR_API.md § Event stream). `refresh()` is correspondingly a no-op below.
  topologyLatency: { kind: "push" },
  notes: {
    gridScrollback:
      "Herdr reports a pane's scrollback depth, so how far back a read can reach is known rather than guessed (MuxPane.readableLines) — its own `truncated` flag is always false and must not be gated on.",
  },
  // Herdr's workspaces are Collie's spaces, and there are as many as the operator created.
  spaces: "many",
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

/**
 * The Herdr error codes that mean "it existed and does not any more" (HERDR_API.md § Errors).
 *
 * Matched on the message because `client.ts` folds Herdr's `{code, message}` into one Error — the
 * code is the first token of what it throws (`herdr pane.close: pane_not_found: …`). This is the one
 * transport failure the contract distinguishes: `gone` tells the operator their screen is stale and
 * to go back, where `unreachable` invites a retry that can only fail the same way (types.ts).
 */
const GONE_CODES: readonly string[] = ["pane_not_found", "tab_not_found", "workspace_not_found"];

/** Which refusal an exception off the socket is: a dead pane/tab, or a multiplexer that did not answer. */
function transportRefusal<T>(err: T): MuxRefusalOutcome {
  const detail = reason(err);
  return GONE_CODES.some((code) => detail.includes(code)) ? muxGone(detail) : muxUnreachable(detail);
}

export class HerdrMux implements MuxAdapter {
  readonly mux = HERDR_MUX;
  readonly capabilities = HERDR_CAPABILITIES;
  readonly logo = HERDR_LOGO_SVG;

  // session.snapshot is the fast path; flipped off PERMANENTLY once a server proves it predates the
  // method (see snapshot()), after which every read uses the legacy three-call path. Adapter state
  // rather than engine state: which methods a server has is a fact about this multiplexer.
  private supportsSessionSnapshot = true;

  /** Per pane, the last `pane.get` scroll answer (in flight or settled) and when it stops standing. */
  private readonly scrollByPane = new Map<string, { until: number; scroll: Promise<NonNullable<WirePane["scroll"]> | null> }>();

  /**
   * The client is the socket; `sessions` is where the OTHER sessions of this Herdr install are.
   *
   * Injected rather than read from the filesystem in here, so the whole translation layer stays
   * testable with no filesystem and no socket (`./sessions.ts` § herdrSessionSource). The factory
   * below builds the real one from this adapter's own endpoint.
   */
  constructor(
    private readonly client: HerdrRpc,
    private readonly sessions: () => readonly MuxSession[],
    private readonly now: () => number = Date.now,
  ) {}

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
      spaces: wire.workspaces.map((w) => toMuxSpace(w)),
      tabs: wire.tabs.map(toMuxTab),
    };
  }

  /**
   * A no-op that resolves, and it is the honest implementation rather than a stub.
   *
   * {@link snapshot} is one fresh RPC every time — the topology is never cached on this side; only
   * nothing is cached — so "the very next snapshot reflects the
   * current topology" is already true before this is called. And the
   * watch is a real event stream, not a census, so there is no interval to pull back to a floor.
   * Spending a round trip here would buy nothing and would put load on the socket that types into
   * the operator's terminals.
   */
  refresh(): Promise<void> {
    return Promise.resolve();
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
   * mirror asks for `recent` + `preserve`; the session-name scrape asks for `viewport` + `preserve`.
   * See HERDR_API.md → `pane.read` and the note above SESSION_NAME_READ_LINES.
   */
  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    try {
      const format = request.styling === "strip" ? "text" : "ansi";
      const read =
        request.scope === "viewport"
          ? await this.readLiveScreen(paneId, request.lines, format)
          : await this.client.readPane(paneId, "recent", request.lines, format);
      return muxOk({
        paneId: read.pane_id,
        text: read.text,
        truncated: read.truncated,
        revision: read.revision,
      });
    } catch (err) {
      return transportRefusal(err);
    }
  }

  /**
   * The screen the program draws now, whatever the operator's scroll.
   *
   * `visible` is the pane's viewport as Herdr shows it, and Herdr keeps a scrolled-up viewport where
   * the operator left it while output grows below. A pane scrolled up on the desktop therefore read as
   * old output with no input box: every send failed "could not find the input box" and left its probe
   * character typed. A scrolled pane reads the bottom `viewport_rows` of `recent` instead, which ends
   * at the live screen's last row (live-probed on herdr 0.9.3: a Claude pane scrolled 405 rows up read
   * its input box this way, `visible` read old output). Herdr trims a screen's trailing blank rows, so
   * on a screen the program has not filled the read also carries scrollback rows above the live ones,
   * never more rows than the viewport holds. That read is in `ansi`, the format that never harvests an
   * alt-screen pane (see {@link readGrid}), with the escapes cut for a `text` read. A pane record that
   * cannot be read, or carries no scroll, leaves the old `visible` read.
   */
  private async readLiveScreen(paneId: string, lines: number, format: "text" | "ansi"): Promise<PaneRead> {
    const scroll = await this.scrollState(paneId);
    if (scroll === null || scroll.offset_from_bottom <= 0) {
      return this.client.readPane(paneId, "visible", lines, format);
    }
    const read = await this.client.readPane(paneId, "recent", Math.min(lines, scroll.viewport_rows), "ansi");
    return format === "ansi" ? read : { ...read, text: read.text.replace(CSI_PATTERN, "") };
  }

  /**
   * A pane's scroll geometry, asked at most once per {@link SCROLL_STATE_MEMO_MS}.
   *
   * The answer (a pane that cannot be read counts as `null`, no scroll) is kept per pane, in flight
   * included, so the reads one send, ask, stop or clear makes, and any that overlap, make one `pane.get`.
   */
  private scrollState(paneId: string): Promise<NonNullable<WirePane["scroll"]> | null> {
    const at = this.now();
    const held = this.scrollByPane.get(paneId);
    if (held !== undefined && at < held.until) return held.scroll;
    for (const [id, entry] of this.scrollByPane) if (at >= entry.until) this.scrollByPane.delete(id);
    const scroll = Promise.resolve()
      .then(() => this.client.getPane(paneId))
      .then((pane) => pane?.scroll ?? null)
      .catch(() => null);
    this.scrollByPane.set(paneId, { until: at + SCROLL_STATE_MEMO_MS, scroll });
    return scroll;
  }

  /**
   * The same scrollback with soft wraps undone (`recent_unwrapped`), for URL repair.
   *
   * Read in the same escape-carrying form as `readGrid` on purpose: `ansi` is the format whose read
   * was never observed to harvest an alt-screen pane, which is the property that keeps the mirror
   * from scrolling somebody's terminal (HERDR_API.md → `pane.read`). Callers strip the styling;
   * this read exists only for the URLs in it. On an agent pane the unwrapped rows equal the wrapped
   * ones — the bridge asks for this only when a URL is actually split.
   */
  async readLogicalText(paneId: string, lines: number): Promise<MuxOutcome<string>> {
    try {
      const read = await this.client.readPane(paneId, "recent_unwrapped", lines, "ansi");
      return muxOk(read.text);
    } catch (err) {
      return transportRefusal(err);
    }
  }

  async foregroundProcesses(paneId: string): Promise<MuxOutcome<readonly ForegroundProcess[]>> {
    try {
      const info = await this.client.processInfo(paneId);
      return muxOk((info.foreground_processes ?? []).map((p) => (Number.isInteger(p.pid) && p.pid > 0 ? { argv: p.argv ?? [], pid: p.pid } : { argv: p.argv ?? [] })));
    } catch (err) {
      return transportRefusal(err);
    }
  }

  async typeText(paneId: string, text: string): Promise<MuxAck> {
    return this.attempt(() => this.client.sendPaneText(paneId, text));
  }

  /**
   * One bracketed paste of the whole text (MuxAdapter.pasteBlock). `pane.send_text` writes raw bytes
   * and carries no paste framing (HERDR_API.md), so the markers are written here, in the same call as
   * the text: a PTY is an ordered stream, and one write cannot be split by another caller's keys. Every
   * control byte but the line break (C0, DEL, C1: ESC and the 8-bit CSI among them) is cut from the text
   * first, so nothing inside can end the paste early and type the rest as keys.
   */
  async pasteBlock(paneId: string, text: string): Promise<MuxAck> {
    const body = [...text].filter(pasteKeeps).join("");
    if (body.length === 0) return muxAck();
    return this.attempt(() => this.client.sendPaneText(paneId, `${PASTE_START}${body}${PASTE_END}`));
  }

  /**
   * Keys in the contract's spelling, translated and applied in order.
   *
   * A batch containing one chord Herdr cannot express sends NOTHING — the keys of one call are a
   * sequence, and delivering its front half is worse than delivering none of it (the pane would be
   * left mid-chord with no way for the caller to know where it stopped).
   */
  async writeKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
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

  /** Show this pane on the operator's own screen. One RPC moves pane, tab and workspace (client.ts). */
  async setFocus(paneId: string): Promise<MuxAck> {
    return this.attempt(() => this.client.focusPane(paneId));
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
    // A blank `cwd` is "none asked for" and is left off entirely, so the daemon opens where it would
    // have anyway (MUX_CONTRACT.md § Contract-owned rules, *A blank cwd*).
    const asked = requestedCwd(request.cwd);
    if (asked !== undefined) opts.cwd = asked;
    try {
      const created = await this.client.createTab(request.spaceId, opts);
      return muxOk(toCreatedPane(created));
    } catch (err) {
      return transportRefusal(err);
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
    // `cwd` is REQUIRED by herdr's own `workspace.create`, so there is no "leave it off" here. A
    // blank one is passed through as blank rather than replaced with a path Collie invented: the
    // daemon owns its default, and inventing one is the guess the contract forbids everywhere else.
    const opts: Parameters<HerdrClient["createWorkspace"]>[0] = { cwd: request.cwd };
    if (request.label !== undefined) opts.label = request.label;
    try {
      const created = await this.client.createWorkspace(opts);
      return muxOk(toCreatedPane(created));
    } catch (err) {
      return transportRefusal(err);
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
  /**
   * Every Herdr session on this machine, the configured one included.
   *
   * A directory listing and a few `exists` calls, no round trip: a session that is running has its
   * socket on disk and a cleanly stopped one has removed it, so the answer costs nothing on the
   * socket that types into the operator's terminals. Never a throw, an unreadable directory reads
   * as "nothing named", which is the same answer a box with one session gives.
   */
  listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return Promise.resolve(muxOk(this.sessions()));
  }

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
      return transportRefusal(err);
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
    cwd: raw.foreground_cwd !== undefined && raw.foreground_cwd.length > 0 ? raw.foreground_cwd : raw.cwd,
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
  const tabLabel = meaningfulTabLabel(tabById.get(raw.tab_id)?.label);
  if (tabLabel) {
    pane.tabLabel = tabLabel;
    // Herdr labels an unnamed tab by position, so any other label is one the operator gave it.
    if (!isUnnamedTab(tabLabel)) pane.tabNamed = true;
  }
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
  pane.revision = raw.revision;
  return pane;
}

/**
 * One Herdr workspace as a {@link MuxSpace}. `agent_status` is carried on the wire and unused.
 *
 * `repoRoot` and `isWorktree` are not set here: the bridge reads them from the folder on disk for
 * every multiplexer (bridge/repo-facts-mux.ts). `folder` is set only when the record names one.
 */
function toMuxSpace(raw: WireWorkspace): MuxSpace {
  const space: MutableMuxSpace = {
    spaceId: raw.workspace_id,
    number: raw.number,
    label: raw.label,
    focused: raw.focused,
    activeTabId: raw.active_tab_id,
    tabCount: raw.tab_count,
    paneCount: raw.pane_count,
  };
  // herdr 0.8.2 carries the checkout on the workspace itself (`worktree.checkout_path`), the only
  // folder its record names (probed 2026-09-23 on herdr 0.9.0, which carries none). OMITTED, never
  // set to undefined, when there is none.
  const folder = raw.worktree?.checkout_path ?? raw.worktree?.repo_root;
  if (folder) space.folder = folder;
  return space;
}

type MutableMuxSpace = { -readonly [K in keyof MuxSpace]: MuxSpace[K] };

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
      herdrSessionSource(target.endpoint),
    );
  },
  /**
   * Herdr's half of the beacon join (M56 spec 11). Herdr sees agents on its own, so the decorator
   * never wraps this adapter for identity (bridge/index.ts `withBeaconsIfBlind`). The matcher is
   * for the hook edges alone: it places an edge's `HERDR_PANE_ID` on a pane of this socket.
   */
  beaconMatcher(target: MuxTarget) {
    return herdrBeaconMatcher(HERDR_MUX, target.endpoint);
  },
  describeTarget(endpoint: string) {
    return `socket ${endpoint}`;
  },
  // Herdr 0.9.0 links machines, so it is the one adapter with a list of ssh targets to offer
  // (ADR 0036 (c)). It is NOT read off the socket and it is not a pane question — see
  // `./machine-list.ts`. Nothing here enrols anything; `collie crew add` offers the list and the
  // operator picks.
  hostCandidates: herdrMachineCandidates,
};
