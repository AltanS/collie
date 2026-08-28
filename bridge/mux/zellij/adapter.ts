// ZELLIJ, BEHIND THE CONTRACT — the third adapter, and the one that was supposed to break the seam.
//
// Everything above this file talks the mux port (../types.ts); everything below it — exec.ts,
// protocol.ts, session.ts, keys.ts, watch.ts — talks zellij. So this module is the whole
// translation, exactly as `herdr/adapter.ts` and `tmux/adapter.ts` are for theirs, and it is the only
// file holding both vocabularies at once.
//
// ── THE MAPPING, WRITTEN DOWN BECAUSE IT WILL BE RE-PROPOSED ─────────────────────────────────────
//
//   zellij session  →  Collie SPACE   (exactly one, {@link ZELLIJ_SPACE_ID})
//   zellij tab      →  Collie TAB     (`tab_3`, off zellij's stable `tab_id`)
//   zellij terminal →  Collie PANE    (`terminal_7`, zellij's own id, carried through unchanged)
//
// zellij has the same three levels tmux has, and the tempting move is therefore tmux's: session →
// space. It does not work, and the reason is a property of zellij's CLI rather than a preference.
// **Every zellij verb is scoped to ONE session**: `action` takes `--session`, `list-panes` lists that
// session's panes, and there is no verb that enumerates panes across sessions. An adapter instance is
// bound to one session (session.ts), so its world has exactly one space — and the space's id is a
// CONSTANT rather than the session's name, because a name is the one thing about a session that an
// operator could change and identity rule 2 says an id may not move under them.
//
// That single space is also why {@link ZellijMux.createSpace} is declared absent. zellij CAN create a
// detached session (`zellij attach --create-background`, probed) — and a session this adapter created
// would be invisible to the very adapter that made it, because the adapter only ever lists its own.
// Declaring the capability would put a button on the phone whose result never appears.
//
// ── WHAT ZELLIJ DOES NOT KNOW, SAID OUT LOUD ─────────────────────────────────────────────────────
//
// zellij has **no idea what an agent is**, exactly as tmux has none. `list-panes` reports a pane's
// title and its `terminal_command`, and neither is an answer: the title is whatever the pane was last
// named or last printed, and a wrong agent name picks a wrong harness grammar AND a wrong journal
// adapter. So `agentDetection` is declared absent and every pane reports `"shell"` / `"unknown"` —
// the contract's documented answer, and NOT a guess (../types.ts § MuxPane.agent). `agentSessionRef`
// follows: with no agent, there is no session an agent named, so pane transcript reading is declared
// ABSENT rather than served empty (M10/06 renders that).
//
// ── ONE TITLE SLOT, AND WHO GETS IT ──────────────────────────────────────────────────────────────
//
// zellij has exactly one per-pane label — the listing's `title` — where the contract has two
// (`paneLabel`, the operator's, and `terminalTitle`, the program's). The probe found THREE things
// writing that one slot: `rename-pane`, the pane's launch command, and the pane's own printed title
// ("whatever the pane was last named or last printed"). Read as `paneLabel`, the last two are Collie
// telling the operator they named a pane they never touched.
//
// So the slot is split by MEMORY, exactly as tmux's is and for the same reason (MUX_CONTRACT.md
// § Contract-owned rules, *Pane naming*): {@link ZellijMux.ownLabels} holds the labels THIS adapter
// set through `renamePane`, and a title equal to the pane's remembered label comes back as
// `paneLabel`. Everything else in the slot comes back as `terminalTitle`. The memory is in-process,
// so a bridge restart degrades an operator's label to `terminalTitle` — visible, less prominent, and
// never a claim about who wrote it.
//
// zellij's own default for the slot is `Pane #N`, which is why {@link programTitle} drops it: an
// untouched pane says nothing at all.
//
// ── WHY EVERY WRITE TAKES A LISTING FIRST ────────────────────────────────────────────────────────
//
// `zellij action` exits 0 whether or not the pane exists (probed — protocol.ts's header has the
// list). An exit code can therefore never prove `gone`, and the contract requires `gone` for a pane
// that has been closed while the operator's screen still shows it. So the adapter keeps its own
// short-lived census and checks the target against it: see {@link ZellijMux.livePane}.

import { declareCapabilities } from "../capabilities.ts";
import { ZELLIJ_LOGO_SVG } from "./logo.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
  muxUnreachable,
  muxUnsupported,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxPane,
  type MuxRefusalOutcome,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTab,
  type MuxTabRequest,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeScope,
  type MuxWatchOptions,
} from "../types.ts";
import { resolveZellijBinary, SpawnZellijExec } from "./exec.ts";
import { toZellijKey, ZELLIJ_UNSENDABLE_KEYS } from "./keys.ts";
import { zellijBeaconMatcher } from "./markers.ts";
import {
  closePaneArgs,
  closeTabArgs,
  dumpScreenArgs,
  newTabArgs,
  parsePaneList,
  parseTabList,
  renamePaneArgs,
  renameTabArgs,
  sendKeysArgs,
  tabId,
  tabNumberOf,
  writeCharsArgs,
  ZELLIJ_LIST_PANES_ARGS,
  ZELLIJ_LIST_TABS_ARGS,
  type ZellijPaneRecord,
  type ZellijTabRecord,
} from "./protocol.ts";
import { ZellijSessionBinding, type ZellijCall } from "./session.ts";
import { ZELLIJ_CENSUS_MAX_MS, ZellijWatch } from "./watch.ts";

/** The registry name this adapter answers to, and the value of {@link ZellijMux.mux}. */
export const ZELLIJ_MUX = "zellij";

/** `MuxTarget.options` key carrying the zellij binary's absolute path. Opaque to the registry, by rule. */
export const ZELLIJ_BINARY_OPTION = "zellijBin";

/** Per-call budget when the target names none. zellij answers a listing in milliseconds. */
export const DEFAULT_ZELLIJ_TIMEOUT_MS = 5000;

/**
 * The id of the one space a zellij collie has. A constant — see the header.
 *
 * It is opaque above the adapter (identity rule 1), so it needs to say nothing; what it must do is
 * never move, which the session's own name could not promise.
 */
export const ZELLIJ_SPACE_ID = "session";

/**
 * How far behind the viewport a `recent` read is assumed to reach.
 *
 * zellij's own default `scroll_buffer_size` is 10 000 lines and no CLI verb reports the configured
 * value or the depth actually kept, so `readableLines` is that default plus the pane's rows. It is a
 * bound rather than a measurement, which is exactly what the contract asks the field for — and it is
 * the only thing that makes the mirror's "Load older" appear at all (../types.ts § readableLines).
 * An operator who lowered the setting gets a read that simply returns fewer lines.
 */
export const ASSUMED_SCROLLBACK_LINES = 10_000;

/** How many request shapes one pane's revision tracker remembers. tmux's number, for tmux's reason. */
const REVISION_VARIANTS = 32;

/**
 * The upper bound on one `write-chars`, in UTF-16 code units.
 *
 * Linux caps a single argv element at `MAX_ARG_STRLEN` — 128 KiB — and zellij takes the text as an
 * argument with no stdin path to route around it (probed: 200 000 characters answered
 * `Argument list too long`). A message past the bound is `refused` and NOT split into several calls:
 * chunking a long send is exactly what ADR 0010 refuses, because the agent on the other side reads a
 * burst of input as one paste and a split one as several.
 */
export const MAX_TYPED_CHARS = 128 * 1024;

/**
 * What zellij can do, read off the methods in this file and off the probe that proved each one
 * (zellij 0.44.2, throwaway session, M10/05).
 *
 * The three absences are real:
 *
 *  • `agentDetection` / `agentSessionRef` — declared `false` (by their omission from the list
 *    below, which `declareCapabilities` turns into an explicit `false`), for the reason in the header.
 *    The ONE thing that can lift them is the beacon decorator, which needs the agent's own hooks and
 *    is not this adapter (M11/03) — this declaration stays `false` under it, unchanged.
 *  • `createSpace` — absent because one adapter instance IS one session; see the header.
 *  • `pushTopologyEvents` — absent because zellij's CLI announces no such thing; watch.ts documents
 *    the search that failed and the bounded census that stands in for it.
 *
 * Everything else was run against the real binary: `dump-screen --ansi` returned SGR and nothing
 * else, `--full` reached 294 lines behind a 22-line viewport, `write-chars` typed literally,
 * `send-keys` typed and chorded and REFUSED a name it did not know, `rename-pane` set and cleared,
 * `close-pane`, `new-tab`, `rename-tab-by-id` and `close-tab-by-id` all answered, and `subscribe`
 * streamed JSON frames. `unsupportedKeys` is EMPTY and that is a finding, not an omission: zellij
 * sends every key in the contract's alphabet, including the six Herdr refuses (keys.ts).
 */
const ZELLIJ_CAPABILITIES = declareCapabilities({
  supports: [
    "paneGrid",
    "gridScrollback",
    "typeText",
    "sendKeys",
    "renamePane",
    "closePane",
    "createTab",
    "renameTab",
    "closeTab",
    "pushPaneEvents",
  ],
  unsupportedKeys: ZELLIJ_UNSENDABLE_KEYS,
  // The only `bounded` declaration in this build, and the number is the census CEILING — the longest
  // a change nobody announced can sit unseen. Not the floor: an adaptive census runs faster than its
  // ceiling most of the time, and a bound that only holds when the herd happens to be busy is not a
  // bound. Not the watched ceiling either: attention is something the bridge observes, never
  // something a caller can promise, so the declaration states the cadence that always holds
  // (watch.ts § the cadence).
  topologyLatency: { kind: "bounded", ms: ZELLIJ_CENSUS_MAX_MS },
  notes: {
    agentDetection:
      "zellij does not know what an agent is. It can say what a pane is called and which command it was launched with, and neither is the same question — so every pane reads as a shell rather than as a guess that would pick the wrong grammar.",
    agentSessionRef:
      "Reading an agent's own session log needs a reference to one, and zellij supplies none. It is absent here, not empty.",
    gridScrollback:
      "`dump-screen --full` reaches behind the viewport as far as the session's scroll buffer kept. It is screen text and nothing more — never a substitute for the agent's own log.",
    createSpace:
      "One Collie on zellij drives exactly one zellij session, because every zellij verb is scoped to one. A session created from the phone would not appear in this collie at all, so the button is not offered.",
    sendKeys:
      "zellij sends every key in Collie's alphabet and refuses a name it does not know rather than typing it as text. It drops a Super/Command modifier silently instead of encoding it, so a `meta` chord is refused rather than delivered as the bare key.",
    pushTopologyEvents:
      "Nothing in zellij's command line announces a pane or tab appearing, closing or being renamed — the plugin API is where such an event lives, and that is not a command line. A bounded census, 3 s after any change and relaxing to 12 s while nothing moves, is what keeps the promise instead.",
    pushPaneEvents:
      "`zellij subscribe` follows several panes at once and pushes a frame on every repaint, so a pane the operator is watching is reported without waiting for the census.",
    setFocus:
      "zellij can bring a TAB to the front, but nothing on its command line reliably focuses a pane inside one: `action focus-pane-id` exits 0 and moves nothing. Showing a tab and hoping the right pane is in front would put a neighbouring pane on the operator's screen, so Collie does not offer the button rather than half-keep the promise.",
  },
  // A Collie on zellij drives exactly ONE zellij session and that session is its one space — the
  // same fact that declines `createSpace`, read the other way round. So the phone drops the space
  // strip entirely and the tab strip is the top level.
  spaces: "one",
});

/** One pane's derived revision, and the reads it was derived from. */
interface PaneRevision {
  revision: number;
  /** Last content seen per request shape, most-recently-established last. */
  readonly variants: Map<string, string>;
}

export class ZellijMux implements MuxAdapter {
  readonly mux = ZELLIJ_MUX;
  readonly capabilities = ZELLIJ_CAPABILITIES;
  readonly logo = ZELLIJ_LOGO_SVG;

  /**
   * The derived revision, per pane. zellij HAS no content revision — no field moves when a pane
   * repaints — so the contract's race-guard token is built here rather than read.
   *
   * A monotone counter, advanced when a read of the SAME request shape comes back different from the
   * last one. Keyed per shape because `viewport`+`strip` and `recent`+`preserve` are different text
   * for one unchanged screen, and a counter that moved every time the mirror and the session-name
   * scrape took turns would refuse every tap. Establishing a NEW shape on a pane already tracked does
   * advance it: the honest direction to err is a guard that is too eager, never one that misses a
   * change (../types.ts § MuxGrid.revision).
   */
  private readonly revisions = new Map<string, PaneRevision>();

  /**
   * The label this adapter set on each pane, keyed by pane id — the split of zellij's ONE title slot
   * (see the header, and MUX_CONTRACT.md § Contract-owned rules, *Pane naming*).
   *
   * Written only by {@link renamePane}, on a call zellij accepted. Cleared by a `renamePane(null)`
   * and by {@link forgetGonePanes} when the pane leaves the listing, so a memory can never outlive
   * the pane it described. It holds at most one short string per live pane.
   */
  private readonly ownLabels = new Map<string, string>();
  /** The watches this adapter has handed out and that are still live — {@link refresh}'s subjects. */
  private readonly watches = new Set<ZellijWatch>();

  constructor(private readonly session: ZellijSessionBinding) {}

  /** Is the configured zellij session answering? One cheap listing. */
  async reachable(): Promise<boolean> {
    const call = await this.session.run(ZELLIJ_LIST_PANES_ARGS);
    return call.ok && parsePaneList(call.result.stdout) !== null;
  }

  /**
   * Every pane and tab of the configured session, plus the one space it all sits in.
   *
   * The floor of the contract, so it PROPAGATES rather than returning a refusal — the same shape the
   * other two adapters' do, and what the connected/disconnected banner already reads. An EXITED
   * session lands here as a throw whose message names it and says an `attach` brings it back
   * (session.ts).
   */
  async snapshot(): Promise<MuxSnapshot> {
    const [paneCall, tabCall] = await Promise.all([
      this.session.run(ZELLIJ_LIST_PANES_ARGS),
      this.session.run(ZELLIJ_LIST_TABS_ARGS),
    ]);
    if (!paneCall.ok) throw new Error(`zellij: ${paneCall.detail}`);
    if (!tabCall.ok) throw new Error(`zellij: ${tabCall.detail}`);
    const panes = parsePaneList(paneCall.result.stdout);
    const tabs = parseTabList(tabCall.result.stdout);
    if (panes === null || tabs === null) {
      throw new Error(`zellij: could not read the session's listing: ${paneCall.result.stderr.trim() || "not JSON"}`);
    }
    this.forgetGonePanes(panes);
    return toSnapshot(panes, tabs, this.session.label(), this.ownLabels);
  }

  /** Drop the remembered label of every pane zellij no longer lists. The map's only shrink path. */
  private forgetGonePanes(panes: readonly ZellijPaneRecord[]): void {
    if (this.ownLabels.size === 0) return;
    const live = new Set(panes.map((pane) => pane.paneId));
    // Deleting through a Map's own key iterator is defined behaviour — an entry removed before it is
    // reached is simply not visited — so no copy of the keys is taken.
    for (const paneId of this.ownLabels.keys()) {
      if (!live.has(paneId)) this.ownLabels.delete(paneId);
    }
  }

  /**
   * One pane's rendered screen.
   *
   * `--ansi` is what makes ADR 0008 hold here: it keeps the SGR escapes and nothing else, so the
   * existing ANSI parser renders zellij's grid unchanged and Collie still runs no terminal emulator.
   * Without it zellij hands back plain text, which is exactly what `styling:"strip"` asks for.
   *
   * An empty answer is the ambiguous case and the only one that costs a second call: zellij prints
   * nothing both for a pane that has gone away and for a pane whose screen is blank, so an empty dump
   * is checked against a listing before it is reported as either.
   */
  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    const call = await this.session.run(
      dumpScreenArgs(paneId, request.styling === "preserve", request.scope === "recent"),
    );
    if (!call.ok) return muxUnreachable(call.detail);
    // `trim`, not `length`: a dump of a pane that has gone away is a bare newline rather than an
    // empty string (probed), so a byte-length test would read it as a one-line screen and answer ok.
    if (call.result.stdout.trim().length === 0) {
      const live = await this.livePane(paneId);
      if (live !== null) return live;
    }
    const dumped = call.result.stdout.replace(/\n$/u, "").split("\n");
    const kept = dumped.slice(Math.max(0, dumped.length - request.lines));
    const text = kept.join("\n");
    return muxOk({
      paneId,
      text,
      // The read really was cut, here rather than by zellij — the honest reading of the flag.
      truncated: dumped.length > kept.length,
      revision: this.advanceRevision(paneId, `${request.scope}|${request.styling}|${String(request.lines)}`, text),
    });
  }

  /**
   * Literal text, submitting nothing.
   *
   * One `write-chars` call and never several — see {@link MAX_TYPED_CHARS} for why a long message is
   * refused rather than split. A newline inside the text reaches the pane AS a submit (probed), which
   * is the same thing every other adapter's literal path does; the caller decides what to send.
   */
  async typeText(paneId: string, text: string): Promise<MuxAck> {
    // An empty send is a no-op, not a spawn to achieve nothing.
    if (text.length === 0) return muxAck();
    if (text.length > MAX_TYPED_CHARS) {
      return muxRefused(
        `zellij takes typed text as a command-line argument, which the kernel caps at ${String(MAX_TYPED_CHARS)} characters — this message is ${String(text.length)}`,
      );
    }
    const gone = await this.livePane(paneId);
    if (gone !== null) return gone;
    return this.ack(writeCharsArgs(paneId, text));
  }

  /**
   * Keys in the contract's spelling, translated and applied in order.
   *
   * The whole batch is translated BEFORE anything is spawned: a batch containing one chord zellij
   * cannot express sends nothing at all, because the keys of one call are a sequence and delivering
   * its front half leaves the pane somewhere the caller cannot reason about (MUX_CONTRIBUTING.md).
   */
  async sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const translated: string[] = [];
    for (const key of keys) {
      const result = toZellijKey(key);
      if (!result.ok) {
        return muxRefused(
          result.reason === "meta"
            ? `zellij accepts a Super/Command chord and then drops the modifier, so ${key} would arrive as the bare key — it is refused rather than mis-sent`
            : `not a key: ${key}`,
        );
      }
      translated.push(result.key);
    }
    if (translated.length === 0) return muxAck();
    const gone = await this.livePane(paneId);
    if (gone !== null) return gone;
    return this.ack(sendKeysArgs(paneId, translated));
  }

  /**
   * Set or clear the operator's label. zellij's one title slot — see the header. `null` clears it.
   *
   * The label is REMEMBERED here and nowhere else, and only after zellij accepted the call: that
   * memory is the whole of what tells an operator's label from a title the pane's program printed on
   * the next listing. Stored trimmed, because that is how the listing reports it back.
   */
  async renamePane(paneId: string, label: string | null): Promise<MuxAck> {
    const gone = await this.livePane(paneId);
    if (gone !== null) return gone;
    const result = await this.ack(renamePaneArgs(paneId, label ?? ""));
    if (!result.ok) return result;
    const kept = label === null ? "" : label.trim();
    if (kept.length === 0) this.ownLabels.delete(paneId);
    else this.ownLabels.set(paneId, kept);
    return result;
  }

  async closePane(paneId: string): Promise<MuxAck> {
    const gone = await this.livePane(paneId);
    if (gone !== null) return gone;
    return this.ack(closePaneArgs(paneId));
  }

  /**
   * A new tab, opening a fresh shell.
   *
   * zellij prints the new tab's stable id and nothing else, so the fresh pane's identity comes from
   * the listing taken straight afterwards — probed three times in a row with no delay and the pane
   * was already there, so there is no settle loop to write and none is hidden here.
   *
   * `spaceId` is checked rather than used: this collie has exactly one space, and a request naming a
   * different one is a stale screen rather than something to silently redirect.
   */
  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    if (request.spaceId !== ZELLIJ_SPACE_ID) return muxGone(`no such space: ${request.spaceId}`);
    const created = await this.session.run(newTabArgs(request.label, request.cwd));
    if (!created.ok) return muxUnreachable(created.detail);
    const tabNumber = Number.parseInt(created.result.stdout.trim(), 10);
    if (!Number.isInteger(tabNumber)) {
      return muxRefused(`zellij created a tab and reported no id: ${created.result.stdout.trim() || created.result.stderr.trim()}`);
    }
    const listing = await this.session.run(ZELLIJ_LIST_PANES_ARGS);
    if (!listing.ok) return muxUnreachable(listing.detail);
    const panes = parsePaneList(listing.result.stdout);
    if (panes === null) return muxUnreachable("zellij's pane listing was not readable after the tab was created");
    const fresh = panes.find((pane) => pane.tabNumber === tabNumber && !pane.exited);
    if (fresh === undefined) return muxRefused(`zellij created tab ${String(tabNumber)} and it holds no pane`);
    return muxOk({
      paneId: fresh.paneId,
      spaceId: ZELLIJ_SPACE_ID,
      spaceLabel: this.session.label(),
      tabId: tabId(tabNumber),
      // zellij's listing reports no working directory for a pane, so the honest answer is the one the
      // request asked for and nothing invented when it asked for none.
      cwd: request.cwd ?? "",
    });
  }

  async renameTab(id: string, label: string): Promise<MuxAck> {
    const tabNumber = tabNumberOf(id);
    if (tabNumber === null) return muxGone(`no such tab: ${id}`);
    return this.ack(renameTabArgs(tabNumber, label));
  }

  async closeTab(id: string): Promise<MuxAck> {
    const tabNumber = tabNumberOf(id);
    if (tabNumber === null) return muxGone(`no such tab: ${id}`);
    return this.ack(closeTabArgs(tabNumber));
  }

  /**
   * Declined, and it is the one refusal here that was probed twice before being believed.
   *
   * zellij 0.44.2 ships `action focus-pane-id <id>`, which is exactly the verb this capability wants
   * — and it does nothing. Probed 2026-08-25 against the live test session, with a client attached
   * and two panes in one tab: `focus-pane-id terminal_3` and the bare `focus-pane-id 3` both exited 0
   * and `action list-clients` still reported the client on `terminal_0`; `focus-next-pane` moved it,
   * so the client and the session were live. Across tabs it is the same silence — `focus-pane-id`
   * aimed at another tab's pane left the active tab where it was.
   *
   * `go-to-tab <n>` DOES work (probed: 1-based over tab position), so a tab-level approximation is
   * available and is deliberately not taken. The promise is "this pane is now on the operator's
   * screen", and a tab whose focus sits on a neighbouring pane is not that — it is the quiet lie the
   * conformance suite exists to catch, told to somebody who is not looking at the screen it moved.
   */
  setFocus(_paneId: string): Promise<MuxAck> {
    return Promise.resolve(
      muxUnsupported(
        "setFocus",
        "zellij's `focus-pane-id` exits 0 and moves nothing (probed on 0.44.2), so Collie cannot promise a pane is in front",
      ),
    );
  }

  /** A zellij collie drives one zellij session, so there is no second space to make — see the header. */
  createSpace(_request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(
      muxUnsupported(
        "createSpace",
        "a Collie on zellij drives exactly one zellij session, and a session created from here would not appear in it",
      ),
    );
  }

    // ── Worktrees: declined, and why ───────────────────────────────────────────
  //
  // Two reasons, and the first alone settles it: a Collie on zellij drives exactly ONE session, so
  // there is no second space for a worktree to be opened as — the same fact that declines
  // `createSpace`. The second is tmux's: zellij keeps no record tying a checkout to what shows it.

  listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return Promise.resolve(muxUnsupported("listWorktrees", "a Collie on zellij drives exactly one session, so a worktree has no second space to be opened as"));
  }

  createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createWorktree", "a Collie on zellij drives exactly one session, so a worktree has no second space to be opened as"));
  }

  openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return Promise.resolve(muxUnsupported("openWorktree", "a Collie on zellij drives exactly one session, so a worktree has no second space to be opened as"));
  }


  /** The contract's watch over the pane stream plus a bounded census. All of it lives in watch.ts. */
  watch(options: MuxWatchOptions): MuxSubscription {
    const subscription = new ZellijWatch(this.session, options);
    this.watches.add(subscription);
    subscription.start();
    // A WRAPPER, so closing the handle also drops this adapter's own reference — see tmux's, which
    // carries the same note for the same reason.
    return {
      close: () => {
        this.watches.delete(subscription);
        subscription.close();
      },
    };
  }

  /**
   * Look now: every live watch censuses at once and drops its interval back to the floor.
   *
   * This is the adapter where `refresh()` earns its place on the floor of the port. zellij announces
   * no structure change at all, so without it a tab the operator renamed in their own terminal waits
   * out whatever the census had relaxed to — up to the twelve seconds this adapter declares.
   *
   * Watches that ended on their own are pruned rather than tracked with a callback; tmux's carries
   * the argument.
   */
  async refresh(): Promise<void> {
    for (const watch of this.watches) {
      if (watch.ended) this.watches.delete(watch);
    }
    await Promise.all([...this.watches].map((watch) => watch.refresh()));
  }

  /**
   * `null` when the pane is there, or the refusal to answer instead.
   *
   * The whole reason this exists is in the header: `zellij action` exits 0 for a pane that does not
   * exist, so the contract's `gone` has to come from a listing.
   *
   * THE LISTING IS TAKEN FRESH EVERY TIME, and a cache with even a half-second life was tried and
   * rejected: a pane that closed inside the window answers `ok` for a write that landed nowhere,
   * which is precisely the "empty success where it means I can't" the conformance suite exists to
   * catch. So a reply costs two extra listings — one before the text, one before the submit key.
   * They are cheap (`list-panes` is a listing of one session) and they are only ever paid on a WRITE;
   * the mirror's read pays for one only when zellij hands back an empty screen, which is the one
   * answer that is ambiguous between a blank pane and a pane that has gone.
   */
  private async livePane(paneId: string): Promise<MuxRefusalOutcome | null> {
    const fresh = await this.recount();
    if (fresh === null) return muxUnreachable("zellij did not answer with a pane listing");
    const pane = fresh.find((candidate) => candidate.paneId === paneId);
    if (pane === undefined) return muxGone(`no such pane: ${paneId}`);
    // A pane whose process ended but whose record zellij still holds. Typing into it goes nowhere,
    // which is the same stale screen `gone` describes.
    if (pane.exited) return muxGone(`the process in ${paneId} has ended`);
    return null;
  }

  /** Take a listing, or null when zellij did not answer with one. */
  private async recount(): Promise<readonly ZellijPaneRecord[] | null> {
    const call = await this.session.run(ZELLIJ_LIST_PANES_ARGS);
    return call.ok ? parsePaneList(call.result.stdout) : null;
  }

  /** One fire-and-forget zellij verb, as the contract's acknowledgement or refusal. */
  private async ack(args: readonly string[]): Promise<MuxAck> {
    const call: ZellijCall = await this.session.run(args);
    if (!call.ok) return muxUnreachable(call.detail);
    // A non-zero exit that survived the session check is zellij refusing the arguments themselves —
    // an unsupported key name is the one the probe found (keys.ts).
    if (call.result.code !== 0) {
      return muxRefused((call.result.stderr.trim() || call.result.stdout.trim()) || `zellij exited ${String(call.result.code)}`);
    }
    return muxAck();
  }

  /** The pane's revision after this read. See the field's comment for why it is derived this way. */
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
    // Insertion-ordered, so the first key is the least recently established one.
    if (tracked.variants.size > REVISION_VARIANTS) {
      const oldest = tracked.variants.keys().next();
      if (!oldest.done) tracked.variants.delete(oldest.value);
    }
    return tracked.revision;
  }
}

/** A cheap, stable content fingerprint. FNV-1a — this is a change detector, never a security check. */
function contentDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${String(text.length)}:${(hash >>> 0).toString(36)}`;
}

type MutableMuxPane = { -readonly [K in keyof MuxPane]: MuxPane[K] };

/** Two listings, in the port's words. */
function toSnapshot(
  paneRecords: readonly ZellijPaneRecord[],
  tabRecords: readonly ZellijTabRecord[],
  sessionLabel: string,
  ownLabels: ReadonlyMap<string, string>,
): MuxSnapshot {
  const tabByNumber = new Map(tabRecords.map((tab) => [tab.tabNumber, tab]));
  const activeTab = tabRecords.find((tab) => tab.active) ?? tabRecords.at(0);
  const spaces: MuxSpace[] = [
    {
      spaceId: ZELLIJ_SPACE_ID,
      number: 1,
      label: sessionLabel,
      // The one space a zellij collie has is the one the operator is in. Reporting it unfocused would
      // be a fact about nothing.
      focused: true,
      activeTabId: activeTab === undefined ? "" : tabId(activeTab.tabNumber),
      tabCount: tabRecords.length,
      paneCount: paneRecords.length,
    },
  ];
  const tabs: MuxTab[] = tabRecords.map((tab) => ({
    tabId: tabId(tab.tabNumber),
    spaceId: ZELLIJ_SPACE_ID,
    number: tab.position + 1,
    label: tab.name,
    focused: tab.active,
    paneCount: tab.paneCount,
  }));
  // A pane whose tab did not come back in the same listing is DROPPED rather than carried with a
  // dangling parent: the contract requires every pane to name a tab that is in the snapshot, and a
  // half-listed pane would fail the whole herd's consistency check.
  const panes: MuxPane[] = paneRecords
    .filter((pane) => tabByNumber.has(pane.tabNumber))
    .map((pane) => toMuxPane(pane, tabByNumber.get(pane.tabNumber), sessionLabel, tabRecords.length, ownLabels));
  return { panes, spaces, tabs };
}

/** One zellij pane record as a {@link MuxPane}. */
function toMuxPane(
  raw: ZellijPaneRecord,
  tab: ZellijTabRecord | undefined,
  sessionLabel: string,
  tabCount: number,
  ownLabels: ReadonlyMap<string, string>,
): MuxPane {
  const pane: MutableMuxPane = {
    paneId: raw.paneId,
    spaceId: ZELLIJ_SPACE_ID,
    spaceLabel: sessionLabel,
    spaceNumber: 1,
    tabId: tabId(raw.tabNumber),
    // zellij reports no working directory for a pane, in any of `list-panes`' field groups.
    cwd: "",
    // The pane the operator's terminal is showing, and it takes BOTH flags. `is_focused` is a
    // property of the TAB — every tab remembers its own focused pane, so several report it at once
    // (probed: two panes in one tab both read `is_focused` after a split) — and `active` is the tab
    // the attached client is on. A DETACHED session marks no tab active, so no pane is focused, which
    // is the honest answer: nobody's screen is showing one (probed 2026-08-25).
    focused: raw.focused && tab?.active === true,
    alive: !raw.exited,
    // The header's decision: zellij knows of no agent, so every pane is a shell of unknown status.
    agent: "shell",
    status: "unknown",
    // A bound rather than a measurement — see ASSUMED_SCROLLBACK_LINES.
    readableLines: raw.contentRows + ASSUMED_SCROLLBACK_LINES,
  };
  // The raw fact, reported as one: `terminal_command` is what zellij was asked to run here, which is
  // NOT who runs here (the header, and ../types.ts § MuxPane.agent). `agent` above stays `"shell"`.
  if (raw.command.length > 0) pane.foregroundCommand = raw.command;
  // Assigned, never conditionally spread, so absent stays absent (the Herdr adapter's rule).
  //
  // zellij's ONE title slot, split by memory (the header). A title equal to the label this adapter
  // set on this pane is the operator's; anything else in the slot was printed by the pane's program
  // or put there by its launch command, which is `terminalTitle` — including a label an earlier
  // bridge process set and no longer remembers. The two are never both reported: the slot holds one
  // string.
  const title = raw.title.trim();
  if (title.length > 0 && title === ownLabels.get(raw.paneId)) pane.paneLabel = title;
  else {
    const printed = programTitle(raw.title);
    if (printed !== null) pane.terminalTitle = printed;
  }
  const tabLabel = meaningfulTabName(tab, tabCount);
  if (tabLabel !== null) pane.tabLabel = tabLabel;
  return pane;
}

/** zellij's own default name for a pane nobody has named: `Pane #1`, `Pane #2`, … (probed). */
const DEFAULT_PANE_TITLE = /^Pane #\d+$/u;

/**
 * What the pane itself put in the title slot, or null when the slot still holds zellij's default.
 *
 * `Pane #N` is zellij's own placeholder and says nothing. Everything else is reported verbatim: a
 * pane launched with a command carries that command's name here, a running program can overwrite it
 * with an OSC title, and the glyphs an agent writes into its own title are that agent's text —
 * trimming them here would be Collie editing what a program said about itself.
 */
function programTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0 || DEFAULT_PANE_TITLE.test(trimmed)) return null;
  return trimmed;
}

/** zellij's own default name for a tab nobody has named: `Tab #1`, `Tab #2`, … (probed). */
const DEFAULT_TAB_NAME = /^Tab #\d+$/u;

/**
 * A tab name worth putting on screen, or null.
 *
 * zellij names an unnamed tab positionally, and in a one-tab session that reads as a bug rather than
 * a name — the same call Herdr's `meaningfulTabLabel` and tmux's `meaningfulWindowName` make. With
 * two or more tabs it is kept, because it is the only thing telling them apart.
 */
function meaningfulTabName(tab: ZellijTabRecord | undefined, tabCount: number): string | null {
  if (tab === undefined) return null;
  const name = tab.name.trim();
  if (name.length === 0) return null;
  if (DEFAULT_TAB_NAME.test(name) && tabCount <= 1) return null;
  return name;
}

/**
 * zellij's entry in the mux registry.
 *
 * `endpoint` is which zellij SESSION to drive; empty means the single running one, and ambiguity is
 * refused rather than guessed (session.ts `chooseSession`). The one adapter-private option is where
 * the binary is, resolved ONCE here so no call site has to think about `PATH` (exec.ts).
 */
export const zellijMuxFactory: MuxAdapterFactory = {
  mux: ZELLIJ_MUX,
  create(target: MuxTarget) {
    return new ZellijMux(bindingFor(target));
  },
  /**
   * zellij's half of the beacon join (M11/03) — the ONE thing that can give this adapter sight, and
   * it is contributed here rather than declared: `agentDetection` stays absent above, because the raw
   * adapter really cannot answer it. The decorator is what declares it, and only when the agent's own
   * hooks are installed.
   */
  beaconMatcher(target: MuxTarget) {
    return zellijBeaconMatcher(ZELLIJ_MUX, bindingFor(target));
  },
  describeTarget(endpoint: string) {
    const named = endpoint.trim();
    return named === "" ? "the single running session" : `session ${named}`;
  },
};

/**
 * The session binding for one target.
 *
 * The matcher gets its OWN, and that is sound rather than merely cheap: the binding resolves the
 * configured name, or discovers the single running session and refuses an ambiguous one
 * (session.ts `chooseSession`) — a deterministic rule, so two bindings built from one target can
 * never resolve to two different sessions. The cost is one extra `list-sessions`, once.
 */
function bindingFor(target: MuxTarget): ZellijSessionBinding {
  const binary = resolveZellijBinary(target.options[ZELLIJ_BINARY_OPTION] ?? "");
  return new ZellijSessionBinding(new SpawnZellijExec(binary, target.timeoutMs || DEFAULT_ZELLIJ_TIMEOUT_MS), target.endpoint);
}
