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
// operator's, and `terminalTitle`, the program's). Collie spends it on the OPERATOR: `renamePane`
// writes it and it comes back as `paneLabel`. `terminalTitle` is therefore never reported on tmux;
// reporting the same string twice under two names would tell the UI that a program said something it
// did not. tmux's own default for the slot is the host name, which is why {@link operatorLabel}
// drops a title equal to it — an untouched pane has no label, and saying "bluefin" would be noise.

import { declareCapabilities } from "../capabilities.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
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
  type MuxRefusalOutcome,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTab,
  type MuxTabRequest,
  type MuxWatchOptions,
} from "../types.ts";
import { resolveTmuxBinary, SpawnTmuxExec, tmuxServerArgs, type TmuxExec, type TmuxRunResult } from "./exec.ts";
import { toTmuxKey, TMUX_UNSENDABLE_KEYS } from "./keys.ts";
import {
  CREATED_FORMAT,
  LISTING_ARGS,
  parseCreated,
  parseListing,
  saysMissing,
  saysNoServer,
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
 *  • `agentDetection` / `agentSessionRef` — absent, for the reason in the header. Declaring either
 *    would make the herd view invent agents out of process names.
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
    "createTab",
    "renameTab",
    "closeTab",
    "createSpace",
    "pushTopologyEvents",
    "pushPaneEvents",
  ],
  unsupportedKeys: TMUX_UNSENDABLE_KEYS,
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
    const result = await this.exec.run([...LISTING_ARGS]);
    if (result.code !== 0 && result.stdout.length === 0) {
      throw new Error(`tmux list: ${result.stderr.trim() || `exited ${String(result.code)}`}`);
    }
    return toSnapshot(parseListing(result.stdout));
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

  /** Set or clear the operator's label. tmux's one title slot — see the header. `null` clears it. */
  async renamePane(paneId: string, label: string | null): Promise<MuxAck> {
    const result = await this.attemptRun(["select-pane", "-t", paneId, "-T", label ?? ""]);
    return result.ok ? muxAck() : result;
  }

  async closePane(paneId: string): Promise<MuxAck> {
    const result = await this.attemptRun(["kill-pane", "-t", paneId]);
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

  /** The contract's watch over control mode plus a bounded listing. All of it lives in watch.ts. */
  watch(options: MuxWatchOptions): MuxSubscription {
    const subscription = new TmuxWatch(this.exec, options);
    subscription.start();
    return subscription;
  }

  /** Run a create verb and read the identity it printed. */
  private async created(args: readonly string[]): Promise<MuxOutcome<MuxCreatedPane>> {
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
function toSnapshot(listing: TmuxListing): MuxSnapshot {
  const sessionById = new Map(listing.sessions.map((session) => [session.id, session]));
  const windowById = new Map(listing.windows.map((window) => [window.id, window]));
  const numberById = new Map(listing.sessions.map((session, index) => [session.id, index + 1]));
  // tmux orders sessions by name and gives them no index of their own, so "focused" cannot be read
  // off an attached client — this watch's own control clients are attached clients, and counting
  // them would report every session as focused. Last activity is the one ordering tmux does keep.
  const liveliest = listing.sessions.reduce<TmuxSession | null>(
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
    .map((pane) => toMuxPane(pane, sessionById, windowById, numberById));
  return { panes, spaces, tabs };
}

type MutableMuxPane = { -readonly [K in keyof MuxPane]: MuxPane[K] };

/** One tmux pane record as a {@link MuxPane}. */
function toMuxPane(
  raw: TmuxPaneRecord,
  sessionById: ReadonlyMap<string, TmuxSession>,
  windowById: ReadonlyMap<string, TmuxWindow>,
  numberById: ReadonlyMap<string, number>,
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
    // tmux's focus is per-client and Collie never sets it; the pane tmux would type into is the
    // active pane of the active window.
    focused: raw.active && raw.windowActive,
    // `pane_dead` is 1 only where the operator set `remain-on-exit`; everywhere else the record is
    // simply gone from the listing, and the next write answers `can't find pane`.
    alive: !raw.dead,
    // The header's decision: tmux knows of no agent, so every pane is a shell of unknown status.
    agent: "shell",
    status: "unknown",
  };
  // Assigned, never conditionally spread, so absent stays absent (the Herdr adapter's rule).
  const label = operatorLabel(raw);
  if (label !== null) pane.paneLabel = label;
  const tabLabel = meaningfulWindowName(window, session);
  if (tabLabel !== null) pane.tabLabel = tabLabel;
  // What a `recent` read can yield: the history tmux kept, plus the viewport it sits behind. This is
  // the mirror's only reliable "is there more" signal, and tmux reports both halves exactly.
  pane.readableLines = raw.historySize + raw.height;
  return pane;
}

/**
 * The operator's own label for this pane, or null when the slot still holds tmux's default.
 *
 * tmux seeds `pane_title` with the host name (probed: `bluefin` on an untouched pane), so a title
 * equal to the host is tmux's and not the operator's. It is a heuristic and it is the honest one
 * available: the alternative is showing every pane a label nobody chose.
 */
function operatorLabel(raw: TmuxPaneRecord): string | null {
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
    const binary = resolveTmuxBinary(target.options[TMUX_BINARY_OPTION] ?? "");
    return new TmuxMux(
      new SpawnTmuxExec(binary, tmuxServerArgs(target.endpoint), target.timeoutMs || DEFAULT_TMUX_TIMEOUT_MS),
    );
  },
};
