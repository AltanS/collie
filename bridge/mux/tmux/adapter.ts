// TMUX, BEHIND THE CONTRACT — the second adapter, and the first written against a contract nobody
// had implemented yet (M10/04).
//
// Everything above this file talks the mux port (../types.ts); everything below it — exec.ts,
// protocol.ts, keys.ts, watch.ts — talks tmux. So this module is the whole translation, exactly as
// `herdr/adapter.ts` is for Herdr, and it is the only file holding both vocabularies at once.
//
// ── THE MAPPING, WRITTEN DOWN BECAUSE IT WILL BE RE-PROPOSED ─────────────────────────────────────
//
//   tmux session  →  Collie SPACE   (`$0`)
//   tmux window   →  Collie TAB     (`@3`)
//   tmux pane     →  Collie PANE    (`%7`)
//
// It is the natural one and it is also the only one that survives identity rule 2. The tempting
// alternative — one space per tmux SERVER, tabs from sessions — collapses two levels into one and
// leaves nothing to map windows onto; the other — ignore sessions and treat every window as a space
// — throws away the grouping the operator actually organises by. tmux's three levels are Collie's
// three levels, and each id is carried through UNCHANGED: `$N`, `@N`, `%N` are tmux's own,
// server-lifetime unique, never recycled, and stable across a rename (a session_id survives what a
// session_name does not). `%` is legal in a Collie id for precisely this reason (../identity.ts).
//
// ── WHAT TMUX DOES NOT KNOW, SAID OUT LOUD ───────────────────────────────────────────────────────
//
// tmux has **no idea what an agent is**. It reports `pane_current_command` and `pane_title`, and
// neither is an answer: `pane_current_command` is whatever is in the foreground this second (the
// probe caught it reading `tmux` for a pane that had just run a tmux command), and a wrong agent name
// picks a wrong harness grammar AND a wrong journal adapter. So `agentDetection` is declared absent
// and every pane reports `"shell"` / `"unknown"` — the contract's documented answer, and NOT a guess
// (../types.ts § MuxPane.agent). `agentSessionRef` follows: with no agent, there is no session an
// agent named, so pane history is declared ABSENT rather than served empty (M10/06 renders that).
//
// ── ONE TITLE SLOT, AND WHO GETS IT ──────────────────────────────────────────────────────────────
//
// tmux has exactly one per-pane label — `pane_title` — where the contract has two (`paneLabel`, the
// operator's, and `terminalTitle`, the program's). ANY program in the pane can write it with an OSC
// title, and tmux KEEPS what it wrote after it exits: live-observed, a bare `bash` still advertising
// a finished agent's task. Read as `paneLabel`, that is Collie telling the operator they named a pane
// they never touched — with a dead agent's sentence as the name.
//
// So the slot is split by MEMORY, which is the contract's rule for every one-slot multiplexer
// (MUX_CONTRACT.md § Contract-owned rules, *Pane naming*): {@link TmuxMux.ownLabels} holds the labels
// THIS adapter set through `renamePane`, and a title equal to the pane's remembered label comes back
// as `paneLabel`. Everything else in the slot is the program's and comes back as `terminalTitle`.
// The memory is in-process, so a bridge restart degrades an operator's label to `terminalTitle` —
// visible, less prominent, and never a claim about who wrote it.
//
// tmux's own default for the slot is the host name, which is why {@link programTitle} drops a title
// equal to it: an untouched pane says nothing, and reporting "bluefin" would be noise.

import { declareCapabilities } from "../capabilities.ts";
import { TMUX_LOGO_SVG } from "./logo.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
  muxUnsupported,
  muxUnreachable,
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
import {
  resolveTmuxBinary,
  SpawnTmuxExec,
  tmuxServerArgs,
  tmuxServerLabel,
  type TmuxExec,
  type TmuxRunResult,
} from "./exec.ts";
import { toTmuxKey, TMUX_UNSENDABLE_KEYS } from "./keys.ts";
import { tmuxBeaconMatcher } from "./markers.ts";
import {
  CREATED_FORMAT,
  LISTING_ARGS,
  parseCreated,
  parseListing,
  saysMissing,
  saysNoServer,
  type TmuxClient,
  type TmuxListing,
  type TmuxPaneRecord,
  type TmuxSession,
  type TmuxWindow,
} from "./protocol.ts";
import { TmuxWatch } from "./watch.ts";

/** The registry name this adapter answers to, and the value of {@link TmuxMux.mux}. */
export const TMUX_MUX = "tmux";

/** `MuxTarget.options` key carrying the tmux binary's absolute path. Opaque to the registry, by rule. */
export const TMUX_BINARY_OPTION = "tmuxBin";

/** Per-call budget when the target names none. tmux answers a listing in milliseconds. */
export const DEFAULT_TMUX_TIMEOUT_MS = 5000;

/** The named paste buffer literal text travels through. Collie's own, deleted after every paste. */
const TYPE_BUFFER = "collie-type";

/**
 * The global `window-size` value that kills a pre-3.7 tmux SERVER the moment it spawns a window.
 *
 * Not a Collie bug and not a guess: tmux ≤ 3.6b dereferences the not-yet-existing window's
 * `manual_sx` in `spawn_window → default_window_size → clients_calculate_size`, and the whole server
 * — every session the operator has — segfaults. Reproduced on scratch servers and confirmed by the
 * coredump; upstream is tmux issue #4849, fixed by commit 7d41761e, first shipped in 3.7. Both create
 * verbs trigger it (`new-window` AND `new-session`), and nothing else about the call matters —
 * clients, control mode, `default-size` and `-x/-y` are all irrelevant. `latest`, `largest` and
 * `smallest` are safe.
 */
const FATAL_WINDOW_SIZE = "manual";

/**
 * Read the effective `window-size`, and the version, in ONE invocation before a create spawns.
 *
 * `;`-joined exactly as {@link LISTING_ARGS} is, so the guard costs one round trip and never two. The
 * version half is appended only until it is known — a running server cannot change its own binary.
 */
const WINDOW_SIZE_ARGS: readonly string[] = ["show-options", "-gv", "window-size"];
/**
 * The version half, on its own, because `collie doctor` asks the same question of the same server
 * (`cli/doctor.ts` § the `mux` finding). Exported rather than spelled twice: a diagnostic that
 * derived the version differently from the adapter could report a server the adapter never saw.
 */
export const TMUX_VERSION_ARGS: readonly string[] = ["display-message", "-p", "-F", "#{version}"];

/**
 * How many request shapes one pane's revision tracker remembers.
 *
 * Generous next to what the bridge actually asks for (the mirror's read and the session-name scrape,
 * two shapes) and finite so a long-lived process cannot grow a map per pane per line count.
 */
const REVISION_VARIANTS = 32;

/**
 * What tmux can do, read off the methods in this file and off the probe that proved each one.
 *
 * The value of this list is that it is SHORTER than Herdr's, and that the two absences are real:
 *
 *  • `agentDetection` / `agentSessionRef` — declared `false` (by their omission from the list
 *    below, which `declareCapabilities` turns into an explicit `false`), for the reason in the header.
 *    Declaring either would make the herd view invent agents out of process names. The ONE thing
 *    that can lift them is the beacon decorator, which needs the agent's own hooks and is not this
 *    adapter (M11/03) — this declaration stays `false` under it, unchanged.
 *
 * Everything else is claimed because a probe ran it on tmux 3.6b: `capture-pane -p -e` returned SGR
 * and nothing else, `-S -N` reached 51 lines behind a 24-line viewport, `send-keys` typed and
 * chorded, `select-pane -T` set and cleared a label, `kill-pane` / `kill-window` / `new-window -P` /
 * `new-session -P` / `rename-window` all answered, and control mode streamed. `unsupportedKeys` is
 * EMPTY and that is a finding, not an omission: tmux sends every key in the contract's alphabet,
 * including the six Herdr refuses (keys.ts).
 */
const TMUX_CAPABILITIES = declareCapabilities({
  supports: [
    "paneGrid",
    "gridScrollback",
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
  unsupportedKeys: TMUX_UNSENDABLE_KEYS,
  // `push`, and the 5-second resync behind it is a BACKSTOP rather than the bound: control mode
  // announces windows and sessions appearing, closing and being renamed (watch.ts § the two ways).
  // The census exists for the sessions no control client is attached to and for a tmux too old to
  // have control mode at all — stating 5 s here would describe the fallback rather than the promise.
  topologyLatency: { kind: "push" },
  notes: {
    agentDetection:
      "tmux does not know what an agent is. It can say which command is in the foreground, and that is not the same question — so every pane reads as a shell rather than as a guess that would pick the wrong grammar.",
    agentSessionRef:
      "Pane history reads the agent's own session log, and tmux supplies no reference to one. It is absent here, not empty.",
    gridScrollback:
      "`capture-pane -S` reaches behind the viewport as far as the pane's history-limit allows; a pane on the alternate screen has no history to reach, exactly as on Herdr.",
    createSpace: "A new space is a new tmux session on the same server. It is created detached, so nothing the operator is looking at moves.",
    sendKeys:
      "tmux sends every key in Collie's alphabet. It has no Super/Command key, so a `meta` chord is refused — tmux's `M-` is Alt, which Collie already spells `alt`.",
    pushTopologyEvents:
      "Control mode pushes window and session changes. A bounded 5-second listing backs it up, which is also what keeps the promise on a tmux with no control mode.",
    pushPaneEvents:
      "Control mode pushes `%output` for the panes of each attached session, up to eight sessions; beyond that the same 5-second listing is the floor.",
  },
  // One tmux server holds as many sessions as the operator makes, and each one is a Collie space.
  spaces: "many",
});

/** One pane's derived revision, and the reads it was derived from. */
interface PaneRevision {
  revision: number;
  /** Last content seen per request shape, most-recently-established last. */
  readonly variants: Map<string, string>;
}

export class TmuxMux implements MuxAdapter {
  readonly mux = TMUX_MUX;
  readonly capabilities = TMUX_CAPABILITIES;
  readonly logo = TMUX_LOGO_SVG;

  /**
   * The derived revision, per pane. tmux HAS no content revision — no format field moves when a pane
   * repaints — so the contract's race-guard token is built here rather than read.
   *
   * A monotone counter, advanced when a read of the SAME request shape comes back different from the
   * last one. Keyed per shape because `viewport`+`strip` and `recent`+`preserve` are different text
   * for one unchanged screen, and a counter that moved every time the mirror and the session-name
   * scrape took turns would refuse every tap. Establishing a NEW shape on a pane already tracked
   * does advance it: the honest direction to err is a guard that is too eager, never one that misses
   * a change (../types.ts § MuxGrid.revision).
   */
  private readonly revisions = new Map<string, PaneRevision>();

  /**
   * The tmux version this server runs, once it has said so. `null` until the first create asks.
   *
   * Cached because a running server cannot swap its own binary: the answer is fixed for the life of
   * the socket, and a restarted server is a new process this adapter re-probes at its next create. An
   * unreadable answer is NOT cached — it stays `null` and is asked again, which also keeps the guard
   * conservative (see {@link spawnSurvivesManualWindowSize}).
   */
  private tmuxVersion: string | null = null;

  /**
   * The label this adapter set on each pane, keyed by pane id — the split of tmux's ONE title slot
   * (see the header, and MUX_CONTRACT.md § Contract-owned rules, *Pane naming*).
   *
   * Written only by {@link renamePane}, on a call tmux accepted. Cleared by a `renamePane(null)` and
   * by {@link forgetGonePanes} when the pane leaves the listing, so a recycled memory can never
   * outlive the pane it described. It holds at most one short string per live pane.
   */
  private readonly ownLabels = new Map<string, string>();
  /** The watches this adapter has handed out and that are still live — {@link refresh}'s subjects. */
  private readonly watches = new Set<TmuxWatch>();

  constructor(private readonly exec: TmuxExec) {}

  /** Is a tmux server answering on the configured socket? One cheap listing. */
  async reachable(): Promise<boolean> {
    try {
      const result = await this.exec.run(["list-sessions", "-F", "#{session_id}"]);
      return result.code === 0 || !saysNoServer(result.stderr);
    } catch {
      return false;
    }
  }

  /**
   * Every pane, window and session of the configured server, in one invocation.
   *
   * The floor of the contract, so it PROPAGATES rather than returning a refusal — the same shape
   * Herdr's does, and what the connected/disconnected banner already reads.
   */
  async snapshot(): Promise<MuxSnapshot> {
    return toSnapshot(await this.listing(), this.ownLabels);
  }

  /**
   * The one listing call, parsed — the raw tmux world behind {@link snapshot}.
   *
   * Split out because {@link setFocus} needs the fourth section (the clients), and the port's
   * snapshot has no word for a client. Same spawn, same parse, one caller each.
   */
  private async listing(): Promise<TmuxListing> {
    const result = await this.exec.run([...LISTING_ARGS]);
    if (result.code !== 0 && result.stdout.length === 0) {
      throw new Error(`tmux list: ${result.stderr.trim() || `exited ${String(result.code)}`}`);
    }
    const listing = parseListing(result.stdout);
    this.forgetGonePanes(listing);
    return listing;
  }

  /** Drop the remembered label of every pane tmux no longer lists. The map's only shrink path. */
  private forgetGonePanes(listing: TmuxListing): void {
    if (this.ownLabels.size === 0) return;
    const live = new Set(listing.panes.map((pane) => pane.id));
    // Deleting through a Map's own key iterator is defined behaviour — an entry removed before it is
    // reached is simply not visited — so no copy of the keys is taken.
    for (const paneId of this.ownLabels.keys()) {
      if (!live.has(paneId)) this.ownLabels.delete(paneId);
    }
  }

  /**
   * One pane's rendered screen.
   *
   * `-e` is what makes ADR 0008 hold here: it keeps the SGR escapes and nothing else, so the existing
   * ANSI parser renders tmux's grid unchanged and Collie still runs no terminal emulator. Without it
   * tmux hands back plain text, which is exactly what `styling:"strip"` asks for — the contract's
   * request is a real branch, not a field nobody reads.
   */
  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    const args = ["capture-pane", "-p", "-t", paneId];
    if (request.styling === "preserve") args.push("-e");
    // `-S -N` starts the capture N lines above the viewport; tmux clamps to what it kept.
    if (request.scope === "recent") args.push("-S", `-${String(Math.max(1, request.lines))}`);
    const result = await this.attemptRun(args);
    if (!result.ok) return result;
    const captured = result.value.stdout.replace(/\n$/u, "").split("\n");
    const kept = captured.slice(Math.max(0, captured.length - request.lines));
    const text = kept.join("\n");
    return muxOk({
      paneId,
      text,
      // The read really was cut, here rather than by tmux — the honest reading of the flag.
      truncated: captured.length > kept.length,
      revision: this.advanceRevision(paneId, `${request.scope}|${request.styling}|${String(request.lines)}`, text),
    });
  }

  /**
   * Literal text, submitting nothing.
   *
   * It travels through a named paste buffer on STDIN rather than as an argument, and both halves of
   * that matter. tmux's argument lexer eats a trailing `;` (probed: nothing typed, exit code 0), so
   * an argument would silently drop a character out of the operator's message. And Linux caps one
   * argv element at 128 KiB, so a long reply would not fail gracefully — it would not run. `-d`
   * deletes the buffer after the paste, so Collie leaves nothing in the operator's buffer stack.
   */
  async typeText(paneId: string, text: string): Promise<MuxAck> {
    // An empty send is a no-op, not a paste of nothing: `paste-buffer` on an empty buffer has
    // nothing to put anywhere, and a spawn to achieve that would be a spawn for no reason.
    if (text.length === 0) return muxAck();
    const args = [
      "load-buffer",
      "-b",
      TYPE_BUFFER,
      "-",
      ";",
      "paste-buffer",
      "-d",
      "-b",
      TYPE_BUFFER,
      "-t",
      paneId,
      // The line separator tmux would otherwise substitute is a carriage return. Newlines are carried
      // through as themselves so the pane sees the bytes Collie was asked to type.
      "-s",
      "\n",
    ];
    const result = await this.attemptRun(args, text);
    return result.ok ? muxAck() : result;
  }

  /**
   * Keys in the contract's spelling, translated and applied in order.
   *
   * The whole batch is translated BEFORE anything is spawned: a batch containing one chord tmux
   * cannot express sends nothing at all, because the keys of one call are a sequence and delivering
   * its front half leaves the pane somewhere the caller cannot reason about (MUX_CONTRIBUTING.md).
   * `--` ends tmux's own flags, so a key that is a bare `-` is a key and not a flag.
   */
  async sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const translated: string[] = [];
    for (const key of keys) {
      const result = toTmuxKey(key);
      if (!result.ok) {
        return muxRefused(
          result.reason === "meta"
            ? `tmux has no Super/Command key, so it cannot send ${key} — its own \`M-\` is Alt, which Collie spells \`alt\``
            : `not a key: ${key}`,
        );
      }
      translated.push(result.key);
    }
    if (translated.length === 0) return muxAck();
    const result = await this.attemptRun(["send-keys", "-t", paneId, "--", ...translated]);
    return result.ok ? muxAck() : result;
  }

  /**
   * Set or clear the operator's label. tmux's one title slot — see the header. `null` clears it.
   *
   * The label is REMEMBERED here and nowhere else, and only after tmux accepted the call: that memory
   * is the whole of what tells an operator's label from a program's title on the next listing. It is
   * stored trimmed, because that is how the listing will report it back.
   */
  async renamePane(paneId: string, label: string | null): Promise<MuxAck> {
    const result = await this.attemptRun(["select-pane", "-t", paneId, "-T", label ?? ""]);
    if (!result.ok) return result;
    const kept = label === null ? "" : label.trim();
    if (kept.length === 0) this.ownLabels.delete(paneId);
    else this.ownLabels.set(paneId, kept);
    return muxAck();
  }

  async closePane(paneId: string): Promise<MuxAck> {
    const result = await this.attemptRun(["kill-pane", "-t", paneId]);
    return result.ok ? muxAck() : result;
  }

  /**
   * Show this pane on the operator's own screen — the window first, then the pane inside it.
   *
   * Both halves are needed and they are ONE invocation: `select-pane` alone leaves the operator
   * looking at another window, and two spawns would leave the screen half-moved if the second failed.
   * `%N` and `@N` are server-wide, so neither target needs its session named. Probed 2026-08-25
   * against the test server: `select-window -t @4 ; select-pane -t %9` moved `window_active` and
   * `pane_active` together; a stale id answers `can't find window: @999` / `can't find pane: %999`,
   * which {@link refusalFor} reads as the contract's `gone`.
   *
   * The window id is not passed in — the caller has a PANE id and nothing else — so it is read out of
   * the same listing the snapshot uses. A pane the listing no longer carries is `gone` before
   * anything is spawned, which is the answer the contract wants anyway.
   *
   * AND THE SESSION, WHICH IS THE HALF THAT WAS MISSING. tmux's current window is a property of the
   * SESSION, so those two commands move the target session's own screen and NOTHING ELSE: a terminal
   * attached to a different session keeps showing that session, and the operator who tapped "Show in
   * terminal" sees nothing move (live evidence 2026-08-25 — a `{ok:true}` for a pane of `collie-tmux`
   * while the attached client sat on `ss-wp`). So every NON-control client on another session is
   * carried over with `switch-client -c <tty> -t <session>`, in the SAME invocation — the clients are
   * already in the listing taken above, and a client is addressed by its tty and by nothing else.
   * With no client attached nothing is switched, and that is the right answer rather than a gap: the
   * window/pane selection stands and the next attach lands on it.
   */
  async setFocus(paneId: string): Promise<MuxAck> {
    const listing = await this.listing();
    const pane = listing.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return muxGone(`can't find pane: ${paneId}`);
    const args = ["select-window", "-t", pane.windowId, ";", "select-pane", "-t", paneId];
    for (const client of clientsToSwitch(listing, pane.sessionId)) {
      args.push(";", "switch-client", "-c", client.tty, "-t", pane.sessionId);
    }
    const result = await this.attemptRun(args);
    return result.ok ? muxAck() : result;
  }

  /**
   * A new tab in a space — a new tmux window in that session, created detached.
   *
   * `-d` is deliberate: creating a tab from the phone must not move the window the operator is
   * looking at on the desktop. `-P -F` brings the fresh pane's identity back on the same round trip.
   */
  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const args = ["new-window", "-d", "-t", request.spaceId, "-P", "-F", CREATED_FORMAT];
    if (request.cwd !== undefined) args.push("-c", request.cwd);
    if (request.label !== undefined) args.push("-n", request.label);
    return this.created(args);
  }

  /** `--` ends tmux's flags, so a label starting with `-` is a label (probed). */
  async renameTab(tabId: string, label: string): Promise<MuxAck> {
    const result = await this.attemptRun(["rename-window", "-t", tabId, "--", label]);
    return result.ok ? muxAck() : result;
  }

  async closeTab(tabId: string): Promise<MuxAck> {
    const result = await this.attemptRun(["kill-window", "-t", tabId]);
    return result.ok ? muxAck() : result;
  }

  /**
   * A new space — a new tmux session on the same server, detached.
   *
   * Claimed rather than declined, and the decision is worth stating: a tmux session is often the
   * operator's own configuration (their `tmuxinator`, their `.tmux.conf`), so Collie creating one is
   * a real change to their setup. It is still theirs to ask for, it is exactly one verb, and it is
   * detached — nothing they are looking at moves. tmux refuses a duplicate name, which arrives as
   * the contract's `refused` with tmux's own sentence.
   */
  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const args = ["new-session", "-d", "-P", "-F", CREATED_FORMAT, "-c", request.cwd];
    if (request.label !== undefined) args.push("-s", request.label);
    return this.created(args);
  }

    // ── Worktrees: declined, and why ───────────────────────────────────────────
  //
  // tmux knows nothing about Git. `git worktree add` would run fine on this host — but these verbs
  // do not promise a checkout, they promise a checkout WITH the session showing it, and removal is
  // addressed by space precisely because the multiplexer must close what it opened. tmux keeps no
  // such record, so a `createWorktree` here could not answer `openSpaceId`, and `removeWorktree`
  // would have nothing to name. Declining is the honest answer until an adapter keeps that mapping
  // itself and a probe proves it (MUX_CONTRIBUTING.md, "probe first, declare second").

  listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return Promise.resolve(muxUnsupported("listWorktrees", "tmux keeps no record tying a Git checkout to the session showing it, so a worktree opened here could not be found, listed or removed again"));
  }

  createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createWorktree", "tmux keeps no record tying a Git checkout to the session showing it, so a worktree opened here could not be found, listed or removed again"));
  }

  openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return Promise.resolve(muxUnsupported("openWorktree", "tmux keeps no record tying a Git checkout to the session showing it, so a worktree opened here could not be found, listed or removed again"));
  }


  /** The contract's watch over control mode plus a bounded listing. All of it lives in watch.ts. */
  watch(options: MuxWatchOptions): MuxSubscription {
    const subscription = new TmuxWatch(this.exec, options);
    this.watches.add(subscription);
    subscription.start();
    // The handle the caller holds is a WRAPPER, so closing it also drops this adapter's own reference
    // — `close()` on the watch alone would leave a dead object in the set forever. It stays
    // idempotent, which is what the contract asks of a subscription.
    return {
      close: () => {
        this.watches.delete(subscription);
        subscription.close();
      },
    };
  }

  /**
   * Look now: every live watch resyncs its listing and re-arms its backstop from zero.
   *
   * With no watch running this resolves having done nothing, and that is correct rather than lazy —
   * {@link snapshot} is a fresh invocation every time, so the contract's "the next snapshot reflects
   * the current topology" needs no help. What refresh buys on tmux is the CENSUS being pulled
   * forward, and a census only exists inside a watch.
   *
   * Watches that ended on their own are pruned here rather than tracked with a callback: the poker
   * drops a dead stream without closing it (event-poker.ts § onDown), so a set that only shrank on
   * `close()` would grow one entry per reconnect for the life of the process.
   */
  async refresh(): Promise<void> {
    for (const watch of this.watches) {
      if (watch.ended) this.watches.delete(watch);
    }
    await Promise.all([...this.watches].map((watch) => watch.refresh()));
  }

  /**
   * Run a create verb and read the identity it printed — after the one thing that must be asked
   * first.
   *
   * Both create verbs funnel through here, so the #4849 guard sits here once rather than twice. It
   * REFUSES; it never repairs. Collie could make the spawn safe by setting `window-size` itself, and
   * that option is the operator's own configuration — a phone tap must not rewrite the setting that
   * governs every window on their desktop, and a Collie that silently "fixed" it would leave a server
   * behaving differently from the `.tmux.conf` that describes it. So the operator is told the exact
   * command instead, and stays the one who runs it.
   */
  private async created(args: readonly string[]): Promise<MuxOutcome<MuxCreatedPane>> {
    const guard = await this.refuseFatalSpawn();
    if (guard !== null) return guard;
    const result = await this.attemptRun(args);
    if (!result.ok) return result;
    const created = parseCreated(result.value.stdout);
    if (created === null) return muxRefused(`tmux created something and reported no pane id: ${result.value.stdout.trim()}`);
    return muxOk({
      paneId: created.paneId,
      spaceId: created.sessionId,
      spaceLabel: created.sessionName,
      tabId: created.windowId,
      cwd: created.cwd,
    });
  }

  /**
   * The refusal that stops a create from segfaulting the operator's whole tmux server, or `null`.
   *
   * Two facts decide it, both read in one invocation: the EFFECTIVE global `window-size` (which the
   * operator can change at any moment, so it is asked every time) and the version (asked once —
   * {@link tmuxVersion}). Only `manual` on a tmux that predates the fix refuses; every other
   * combination spawns exactly as before, with no extra branch in the argv.
   *
   * A probe that does not come back is NOT a refusal. tmux gained `window-size` in 2.9, so a binary
   * that answers `unknown option` has no hazard to guard against, and a probe that failed because the
   * server is gone is answered honestly by the create's own outcome one line later. The guard only
   * ever fires on a positive reading.
   */
  private async refuseFatalSpawn(): Promise<MuxRefusalOutcome | null> {
    const args =
      this.tmuxVersion === null ? [...WINDOW_SIZE_ARGS, ";", ...TMUX_VERSION_ARGS] : [...WINDOW_SIZE_ARGS];
    const probe = await this.attemptRun(args);
    if (!probe.ok) return null;
    const lines = probe.value.stdout.split("\n");
    const windowSize = (lines.at(0) ?? "").trim();
    const version = this.tmuxVersion ?? readVersion(lines.at(1));
    if (version !== null) this.tmuxVersion = version;
    if (windowSize !== FATAL_WINDOW_SIZE) return null;
    if (spawnSurvivesManualWindowSize(version)) return null;
    return muxRefused(fatalWindowSizeDetail(version));
  }

  /** One tmux command, as the contract's outcome-or-refusal. A throw is `unreachable`, never a crash. */
  private async attemptRun(args: readonly string[], stdin?: string): Promise<MuxOutcome<TmuxRunResult>> {
    let result: TmuxRunResult;
    try {
      result = await this.exec.run(args, stdin);
    } catch (err) {
      return muxUnreachable(err instanceof Error ? err.message : String(err));
    }
    return result.code === 0 ? muxOk(result) : refusalFor(result);
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

/**
 * Which refusal a non-zero tmux exit is.
 *
 * The three sentences were read off the real binary (M10/04): `can't find pane: %999` for something
 * that has gone away, `no server running on …` for a tmux that is not there, and anything else —
 * `duplicate session: other` — is tmux understanding and saying no.
 */
function refusalFor(result: TmuxRunResult): MuxRefusalOutcome {
  const detail = (result.stderr.trim() || result.stdout.trim()) || `tmux exited ${String(result.code)}`;
  if (saysMissing(detail)) return muxGone(detail);
  if (saysNoServer(detail)) return muxUnreachable(detail);
  return muxRefused(detail);
}

/** What `display-message -p -F '#{version}'` said, trimmed, or `null` when it said nothing usable. */
function readVersion(reported: string | undefined): string | null {
  const version = (reported ?? "").trim();
  return version.length > 0 ? version : null;
}

/**
 * Whether this tmux carries the #4849 fix — i.e. whether it survives spawning under `window-size
 * manual`.
 *
 * `3.7` and later, and an unreadable version reads as UNSAFE. That asymmetry is deliberate: guessing
 * "probably fine" costs the operator every session on the server, and guessing "probably not" costs
 * them one refusal carrying the command that clears it. tmux spells its version `3.6b` / `3.7` /
 * `next-3.7`, so the first `<major>.<minor>` in the string is the answer and the letter suffix — a
 * patch level, never a feature — is ignored.
 */
function spawnSurvivesManualWindowSize(version: string | null): boolean {
  if (version === null) return false;
  const match = /(\d+)\.(\d+)/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 7);
}

/** What the operator is told, and it ends in the exact command that clears the refusal. */
function fatalWindowSizeDetail(version: string | null): string {
  const named = version === null ? "this tmux" : `tmux ${version}`;
  return `${named} crashes when it spawns a window while window-size is manual (tmux #4849, fixed in 3.7) — run: tmux set -g window-size latest`;
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

/** One listing, in the port's words. */
function toSnapshot(listing: TmuxListing, ownLabels: ReadonlyMap<string, string>): MuxSnapshot {
  const sessionById = new Map(listing.sessions.map((session) => [session.id, session]));
  const windowById = new Map(listing.windows.map((window) => [window.id, window]));
  const numberById = new Map(listing.sessions.map((session, index) => [session.id, index + 1]));
  // WHICH SESSION IS THE OPERATOR LOOKING AT. The listing's fourth section answers it directly: the
  // session a NON-control client is attached to is a session somebody's terminal is showing, and
  // `client_control_mode` is what keeps this adapter's own watch out of the answer (protocol.ts §
  // TmuxClient). With two real terminals the most recently active one wins.
  //
  // The fallback is the old rule and it stays, because "no client attached" is ordinary — a server
  // full of detached sessions still has to render somewhere sensible, and last activity is the one
  // ordering tmux keeps over sessions.
  const watched = watchedSession(listing);
  const liveliest =
    watched ??
    listing.sessions.reduce<TmuxSession | null>(
      (best, session) => (best === null || session.activity > best.activity ? session : best),
      null,
    );
  const activeTabBySession = new Map<string, string>();
  for (const window of listing.windows) {
    if (window.active || !activeTabBySession.has(window.sessionId)) activeTabBySession.set(window.sessionId, window.id);
  }
  const paneCounts = new Map<string, number>();
  for (const pane of listing.panes) paneCounts.set(pane.sessionId, (paneCounts.get(pane.sessionId) ?? 0) + 1);

  const spaces: MuxSpace[] = listing.sessions.map((session) => ({
    spaceId: session.id,
    number: numberById.get(session.id) ?? 0,
    label: session.name.length > 0 ? session.name : session.id,
    focused: liveliest?.id === session.id,
    activeTabId: activeTabBySession.get(session.id) ?? "",
    tabCount: session.windows,
    paneCount: paneCounts.get(session.id) ?? 0,
  }));
  const tabs: MuxTab[] = listing.windows
    .filter((window) => sessionById.has(window.sessionId))
    .map((window) => ({
      tabId: window.id,
      spaceId: window.sessionId,
      number: window.index,
      label: window.name,
      focused: window.active,
      paneCount: window.panes,
    }));
  // A pane whose session or window did not come back in the same listing is DROPPED rather than
  // carried with a dangling parent: the contract requires every pane to name a space and a tab that
  // are in the snapshot, and a half-listed pane would fail the whole herd's consistency check.
  const panes: MuxPane[] = listing.panes
    .filter((pane) => sessionById.has(pane.sessionId) && windowById.has(pane.windowId))
    .map((pane) => toMuxPane(pane, sessionById, windowById, numberById, ownLabels));
  return { panes, spaces, tabs };
}

/**
 * The session a real terminal is attached to, or null when only Collie's own watch is.
 *
 * `client_session` prints a session NAME rather than a `$N` id (probed 2026-08-25), so the match is
 * against either — a name today, an id if tmux ever changes its mind, and no re-derivation either
 * way. A client naming a session this listing does not carry is ignored rather than guessed at.
 */
function watchedSession(listing: TmuxListing): TmuxSession | null {
  const attached = listing.clients.filter((client) => !client.control);
  let best: { session: TmuxSession; activity: number } | null = null;
  for (const client of attached) {
    const session = sessionOfClient(listing, client);
    if (session === undefined) continue;
    if (best === null || client.activity > best.activity) best = { session, activity: client.activity };
  }
  return best?.session ?? null;
}

/**
 * The session one client is showing, or undefined when it names a session this listing does not have.
 *
 * `client_session` prints a session NAME rather than a `$N` id (probed 2026-08-25), so the match is
 * against either — a name today, an id if tmux ever changes its mind, and no re-derivation either way.
 */
function sessionOfClient(listing: TmuxListing, client: TmuxClient): TmuxSession | undefined {
  return listing.sessions.find((candidate) => candidate.id === client.sessionId || candidate.name === client.sessionId);
}

/**
 * The real terminals that must be CARRIED to `sessionId`, because they are looking somewhere else.
 *
 * A control client is excluded for the same reason it is excluded from `watchedSession` — it is
 * nobody's screen, and switching it would only move this adapter's own watch. A client already on the
 * session is excluded because switching it would be a spawn that changes nothing. A client with no
 * tty cannot be addressed at all (`switch-client -c` takes a tty and nothing else), so it is left
 * alone rather than guessed at.
 */
function clientsToSwitch(listing: TmuxListing, sessionId: string): TmuxClient[] {
  return listing.clients.filter((client) => {
    if (client.control || client.tty.length === 0) return false;
    return sessionOfClient(listing, client)?.id !== sessionId;
  });
}

type MutableMuxPane = { -readonly [K in keyof MuxPane]: MuxPane[K] };

/** One tmux pane record as a {@link MuxPane}. */
function toMuxPane(
  raw: TmuxPaneRecord,
  sessionById: ReadonlyMap<string, TmuxSession>,
  windowById: ReadonlyMap<string, TmuxWindow>,
  numberById: ReadonlyMap<string, number>,
  ownLabels: ReadonlyMap<string, string>,
): MuxPane {
  const session = sessionById.get(raw.sessionId);
  const window = windowById.get(raw.windowId);
  const pane: MutableMuxPane = {
    paneId: raw.id,
    spaceId: raw.sessionId,
    spaceLabel: session !== undefined && session.name.length > 0 ? session.name : raw.sessionId,
    spaceNumber: numberById.get(raw.sessionId) ?? 0,
    tabId: raw.windowId,
    cwd: raw.cwd,
    // The pane a terminal attached to this session is showing: the active pane of the active window.
    // tmux's current window is a property of the SESSION, not of a client, so every client on one
    // session sees the same pane — which is why this needs no client lookup, while WHICH SESSION is
    // in front does (see `watchedSession`). A detached session keeps its active pane, and reporting
    // it is the contract's stated fallback.
    focused: raw.active && raw.windowActive,
    // `pane_dead` is 1 only where the operator set `remain-on-exit`; everywhere else the record is
    // simply gone from the listing, and the next write answers `can't find pane`.
    alive: !raw.dead,
    // The header's decision: tmux knows of no agent, so every pane is a shell of unknown status.
    agent: "shell",
    status: "unknown",
  };
  // Assigned, never conditionally spread, so absent stays absent (the Herdr adapter's rule).
  //
  // tmux's ONE title slot, split by memory (the header). A title equal to the label this adapter set
  // on this pane is the operator's; anything else in the slot is whatever the pane's program printed,
  // which is `terminalTitle` — including a label an earlier bridge process set and no longer
  // remembers. The two are never both reported: the slot holds one string.
  const title = raw.title.trim();
  if (title.length > 0 && title === ownLabels.get(raw.id)) pane.paneLabel = title;
  else {
    const printed = programTitle(raw);
    if (printed !== null) pane.terminalTitle = printed;
  }
  const tabLabel = meaningfulWindowName(window, session);
  if (tabLabel !== null) pane.tabLabel = tabLabel;
  // What a `recent` read can yield: the history tmux kept, plus the viewport it sits behind. This is
  // the mirror's only reliable "is there more" signal, and tmux reports both halves exactly.
  pane.readableLines = raw.historySize + raw.height;
  // The raw fact, reported as one: `pane_current_command` is what tmux sees in the foreground this
  // second, which is NOT who runs here (the header, and ../types.ts § MuxPane.agent). `agent` above
  // stays `"shell"` whatever this says.
  if (raw.currentCommand.length > 0) pane.foregroundCommand = raw.currentCommand;
  return pane;
}

/**
 * What the pane's program printed into the title slot, or null when the slot says nothing.
 *
 * tmux seeds `pane_title` with the host name (probed: `bluefin` on an untouched pane), so a title
 * equal to the host is tmux's own default and not anybody's statement. Everything else is reported,
 * verbatim: the glyphs an agent puts in its own title (`✳ …`) are that agent's text, and trimming
 * them here would be Collie editing what a program said about itself.
 */
function programTitle(raw: TmuxPaneRecord): string | null {
  const title = raw.title.trim();
  if (title.length === 0) return null;
  if (title === raw.host || title === raw.host.split(".").at(0)) return null;
  return title;
}

/**
 * A window name worth putting on screen, or null.
 *
 * tmux renames a window after whatever runs in it unless the operator turned that off or named it —
 * `#{automatic-rename}` says which. An auto-name in a one-window session is the positional default
 * Herdr's `meaningfulTabLabel` drops for the same reason: it reads as a bug rather than a name. With
 * two or more windows it is kept, because it is the only thing telling two tabs apart.
 */
function meaningfulWindowName(window: TmuxWindow | undefined, session: TmuxSession | undefined): string | null {
  if (window === undefined) return null;
  const name = window.name.trim();
  if (name.length === 0) return null;
  if (window.autoNamed && (session?.windows ?? 0) <= 1) return null;
  return name;
}

/**
 * tmux's entry in the mux registry.
 *
 * `endpoint` is which tmux SERVER to talk to — a socket name (`-L`) or a socket path (`-S`), empty
 * for tmux's own default server; `tmuxServerArgs` documents the fork. The one adapter-private option
 * is where the binary is, resolved ONCE here so no call site has to think about `PATH` (exec.ts).
 */
export const tmuxMuxFactory: MuxAdapterFactory = {
  mux: TMUX_MUX,
  create(target: MuxTarget) {
    return new TmuxMux(execFor(target));
  },
  /**
   * tmux's half of the beacon join (M11/03) — the ONE thing that can give this adapter sight, and it
   * is contributed here rather than declared: `agentDetection` stays absent above, because the raw
   * adapter really cannot answer it. The decorator is what declares it, and only when the agent's own
   * hooks are installed.
   */
  beaconMatcher(target: MuxTarget) {
    return tmuxBeaconMatcher(TMUX_MUX, execFor(target));
  },
  describeTarget: tmuxServerLabel,
};

/** The transport for one target. Stateless configuration, so the matcher may build its own. */
function execFor(target: MuxTarget): TmuxExec {
  const binary = resolveTmuxBinary(target.options[TMUX_BINARY_OPTION] ?? "");
  return new SpawnTmuxExec(binary, tmuxServerArgs(target.endpoint), target.timeoutMs || DEFAULT_TMUX_TIMEOUT_MS);
}
