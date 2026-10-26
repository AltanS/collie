// ── THE LAUNCH WINDOW: A PANE WHERE AN AGENT IS STARTING, BEFORE THE AGENT HAS DRAWN ─────────────
//
// An agent takes a while to draw its input box: omp 18.12.6 takes about twenty seconds. For the first
// seconds the multiplexer may still report a plain shell (it names an agent by its process, and that
// takes a poll or more), and the screen shows the shell's banner. The Send Protocol sees a pane with no
// profile, and such a pane takes a send blind: the text, then Enter (ADR 0107). A person who sent in
// that window (a walky talky delivery, a quick first message) got `sent` for a line the shell took, and
// the agent later showed the text as an unsent draft that blocked the next sends (omp gang, testers 15
// and gang three S3).
//
// The window is a property of the PANE, not of who started the agent. Three sources open it:
//
//  • `launch`: the bridge typed a harness's line into a pane it created (`POST /api/launch`). This
//    covers the gap before the agent's process exists. {@link LaunchWindow.mark}.
//  • `process`: a send to a pane with no profile of its own reads the pane's foreground processes
//    (`MuxAdapter.foregroundProcesses`), and one of them is a known harness binary
//    ({@link harnessOfProcesses}). This covers a person typing `omp` in a shell, a crew script, the
//    multiplexer's own launcher. {@link LaunchWindow.starting}.
//  • `agent`: a poll finds the multiplexer naming a harness on a pane it named otherwise, or did not
//    list, on the poll before. {@link LaunchWindow.observe}. The first poll a bridge sees is the
//    baseline: an agent already named then opens nothing, because its age is unknown.
//
// While the window is open the Send Protocol reads the screen with that harness's profile and presses
// no key until the harness's input box is on screen (`SendDeps.starting`). The window ends when that
// box takes a key ({@link LaunchWindow.framed}: a send's probe showed in it), when the poll's Surface
// reads the box ({@link LaunchWindow.drawn}), after {@link LAUNCH_WINDOW_MS}, or when the harness is gone
// from the pane: the foreground is a plain shell again, or the multiplexer stops naming it. A window
// that ended is not opened again by the same harness on the same pane (`settled`) until that harness
// leaves the pane: a started agent goes back to what the pane did before this module existed.
//
// A drawn box is not always a box that reads keys: omp 18.12.6 draws its box about twenty seconds
// before it reads one (gang three, 2026-10-26). A send whose probe never showed in a drawn box says so
// ({@link LaunchWindow.deaf}): the window stays open, or opens again inside the bound it first opened
// with, the pane counts the probe characters that may still show, and only a probe that shows ends it.
// The protocol takes those characters out once the box shows them (bridge/surface/probe-marker.ts).
// Each such character blocks a new probe ({@link LaunchWindow.pending}) for {@link PENDING_PROBE_MS}
// from the moment it was typed, not for the whole window: a box that never shows it (a program that
// flushes its input when it starts) must not keep the pane from a send for two minutes, and the next
// probe is how Collie learns the box reads keys now (2026-10-26).
//
// It fails open on missing evidence. A multiplexer with no foreground read (tmux, zellij and tuios
// today) gets no `process` window, a read that fails or takes longer than {@link FOREGROUND_READ_MS}
// counts as no read, and a plain shell in the foreground keeps the blind send.
//
// No harness is named here: the binaries come from the profiles (`identity.binary`), passed in.
// Memory only, per bridge: a restart forgets the windows, and the first poll after it is a baseline.

import type { ForegroundProcess } from "./journal/types.ts";

/** How long a pane may take to show its agent's input box: omp 18.12.6 takes about 20 s. */
export const LAUNCH_WINDOW_MS = 120_000;

/**
 * How long a probe character that never showed blocks the pane's next probe and its held sends, from the
 * moment it was typed. The deaf gap seen live was about 20 s (omp 18.12.6); past this the character is
 * still counted for {@link LaunchWindow.drawn}, but the next send may type one new probe.
 */
export const PENDING_PROBE_MS = 30_000;

/** How long a send waits for the multiplexer's foreground read. Past it the read counts as none. */
export const FOREGROUND_READ_MS = 1_500;

/** The most windows open at once. A safety bound: the oldest goes first. */
const WINDOWS_MAX = 64;

/** The most panes remembered as settled (their agent's window ended). Panes the poll no longer lists go first. */
const SETTLED_MAX = 1_024;

/**
 * Programs that run a script named by their first plain argument: `bun /…/node_modules/.bin/omp`.
 * Generic interpreters, never a harness: a harness shipped as a script shows as one of these.
 */
const INTERPRETERS: ReadonlySet<string> = new Set(["node", "nodejs", "bun", "deno", "python", "python3"]);

type Source = "launch" | "process" | "agent";

interface Window {
  readonly harness: string;
  /** When the window opened: a window that opens again for a deaf box keeps its first bound. */
  readonly opened: number;
  readonly until: number;
  readonly source: Source;
  /** A foreground read showed the harness's process: a shell in the foreground after that means it exited. */
  processSeen: boolean;
  /**
   * Probe characters a send typed into the harness's box that never showed: the box is drawn but reads
   * no keys yet, and they may show later. A window with any is not ended by a box read alone.
   */
  deaf: number;
  /** When each of the {@link deaf} characters was typed: one blocks for {@link PENDING_PROBE_MS}. */
  typed: number[];
}

/** A pane whose agent's window ended: the harness, and when its window opened. */
interface Settled {
  readonly harness: string;
  readonly opened: number;
}

/** The last name of a path, without a Windows program suffix, lower case: `C:\x\omp.EXE` is `omp`. */
function programName(word: string): string {
  const last = word.split(/[\\/]/u).at(-1) ?? "";
  return last.replace(/\.(exe|cmd|bat|ps1)$/iu, "").toLowerCase();
}

/** Whether a path's program name is one of the generic interpreters ({@link INTERPRETERS}). */
export function isInterpreter(word: string): boolean {
  return INTERPRETERS.has(programName(word));
}

/**
 * The foreground process that runs a known harness, and how: `script` is the argv word an interpreter
 * runs (`bun /…/node_modules/.bin/omp`), absent when argv[0] itself is the harness's binary.
 */
export interface HarnessProcess {
  readonly harness: string;
  readonly process: ForegroundProcess;
  readonly script?: string;
}

/**
 * The first of `processes` that runs a known harness, by its binary: argv[0]'s program name, or, when
 * argv[0] is an interpreter, the program name of its first argument that is not a flag. `binaries`
 * maps a binary's program name (lower case) to its harness id. Null when no process is a known harness binary.
 */
export function harnessProcessOf(processes: readonly ForegroundProcess[], binaries: ReadonlyMap<string, string>): HarnessProcess | null {
  for (const process of processes) {
    const [first, ...rest] = process.argv;
    if (first === undefined) continue;
    const name = programName(first);
    const direct = binaries.get(name);
    if (direct !== undefined) return { harness: direct, process };
    if (!INTERPRETERS.has(name)) continue;
    const script = rest.find((word) => !word.startsWith("-"));
    const scripted = script === undefined ? undefined : binaries.get(programName(script));
    if (scripted !== undefined && script !== undefined) return { harness: scripted, process, script };
  }
  return null;
}

/** The harness id one of `processes` runs ({@link harnessProcessOf}), or null. */
export function harnessOfProcesses(processes: readonly ForegroundProcess[], binaries: ReadonlyMap<string, string>): string | null {
  return harnessProcessOf(processes, binaries)?.harness ?? null;
}

/**
 * What a foreground read found: a harness id, `null` for a read that found no harness (a plain shell),
 * `undefined` for no read at all (the multiplexer has none, it refused, threw, or was too slow).
 */
export type ForegroundHarness = () => Promise<string | null | undefined>;

/** One pane as a poll lists it: the agent the multiplexer names, or null for a shell. */
export interface ObservedPane {
  readonly paneId: string;
  readonly agent: string | null;
}

export class LaunchWindow {
  private readonly windows = new Map<string, Window>();
  /** Panes whose agent's window ended (a frame read, or the bound), by harness. */
  private readonly settled = new Map<string, Settled>();
  /** The last poll's panes per session, pane id to agent ("" for a shell). Absent: no poll yet. */
  private readonly known = new Map<string, Map<string, string>>();

  /**
   * `canonical` folds the names one harness goes by into one (a multiplexer's agent name and a profile
   * id): `bridge/index.ts` passes the profile lookup. The default compares names as they are.
   */
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly canonical: (name: string) => string = (name) => name,
  ) {}

  private static keyOf(session: string, paneId: string): string {
    return `${session}\u0000${paneId}`;
  }

  /** The open window of a pane, or null. A window past its bound ends here and settles the pane. */
  private open(key: string): Window | null {
    const window = this.windows.get(key);
    if (window === undefined) return null;
    if (window.until > this.now()) return window;
    this.windows.delete(key);
    this.settle(key, window.harness, window.opened);
    return null;
  }

  private openWindow(key: string, harness: string, source: Source, processSeen = false): void {
    const at = this.now();
    for (const [other, window] of this.windows) {
      if (window.until <= at) {
        this.windows.delete(other);
        this.settle(other, window.harness, window.opened);
      }
    }
    this.windows.delete(key);
    if (this.windows.size >= WINDOWS_MAX) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
    this.windows.set(key, { harness, opened: at, until: at + LAUNCH_WINDOW_MS, source, processSeen, deaf: 0, typed: [] });
  }

  private settle(key: string, harness: string, opened: number): void {
    this.settled.delete(key);
    if (this.settled.size >= SETTLED_MAX) {
      const oldest = this.settled.keys().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }
    this.settled.set(key, { harness, opened });
  }

  private settledAs(key: string): string | null {
    return this.settled.get(key)?.harness ?? null;
  }

  /** The harness left the pane: its window, of any source, and its settled mark go. */
  private left(key: string): void {
    this.windows.delete(key);
    this.settled.delete(key);
  }

  /** A launch typed `harness`'s line into `paneId`: sends to that pane wait for its input box. */
  mark(session: string, paneId: string, harness: string): void {
    const key = LaunchWindow.keyOf(session, paneId);
    this.settled.delete(key);
    this.openWindow(key, this.canonical(harness), "launch");
  }

  /** The harness id of the pane's open window, of any source, else null. Asks the multiplexer nothing. */
  expecting(session: string, paneId: string): string | null {
    return this.open(LaunchWindow.keyOf(session, paneId))?.harness ?? null;
  }

  /**
   * One poll's panes of a session (agent panes and shells). A pane whose agent the multiplexer names now
   * and did not name on the poll before opens an `agent` window, unless a window for that harness is
   * open (a launch's mark keeps its earlier start) or the harness already settled there. A pane whose
   * agent went (a shell now) and a pane the poll no longer lists are forgotten. The first call per
   * session only records the panes.
   */
  observe(session: string, panes: readonly ObservedPane[]): void {
    const next = new Map<string, string>(panes.map((pane) => [pane.paneId, pane.agent === null || pane.agent === "" ? "" : this.canonical(pane.agent)]));
    const before = this.known.get(session);
    this.known.set(session, next);
    const prefix = `${session}\u0000`;
    for (const map of [this.windows, this.settled]) {
      for (const key of map.keys()) if (key.startsWith(prefix) && !next.has(key.slice(prefix.length))) map.delete(key);
    }
    if (before === undefined) return;
    for (const [paneId, agent] of next) {
      const was = before.get(paneId);
      if (agent === was) continue;
      const key = LaunchWindow.keyOf(session, paneId);
      if (agent === "") {
        if (was !== undefined) this.left(key);
        continue;
      }
      if (this.open(key)?.harness === agent || this.settledAs(key) === agent) continue;
      this.openWindow(key, agent, "agent");
    }
  }

  /** The box of `harness` took a key on the pane (a send's probe showed in it): its start is over, and the pane settles. */
  framed(session: string, paneId: string, harness: string): void {
    const key = LaunchWindow.keyOf(session, paneId);
    const name = this.canonical(harness);
    const window = this.windows.get(key);
    if (window?.harness === name) this.windows.delete(key);
    // A pane that settles with no window of its own keeps no bound to open one in again.
    this.settle(key, name, window?.harness === name ? window.opened : this.now() - LAUNCH_WINDOW_MS);
  }

  /**
   * The poll's Surface read a box of `harness` on the pane. A drawn box ends the window as {@link framed}
   * does, unless a send's probe already went unseen in it ({@link deaf}): that box is drawn but reads
   * no keys, and only a probe that shows ends its window (or the bound).
   */
  drawn(session: string, paneId: string, harness: string): void {
    const key = LaunchWindow.keyOf(session, paneId);
    const window = this.open(key);
    if (window !== null && window.harness === this.canonical(harness) && window.deaf > 0) return;
    this.framed(session, paneId, harness);
  }

  /**
   * A send's probe never showed in the box of `harness` on the pane: the box is drawn but reads no keys
   * yet. An open window for that harness stays open and counts one more character that may show later.
   * A window a box read ended opens again, inside the bound it opened with. Answers the count, 0 when the
   * pane is not starting (no window, another harness, or past the bound): then nothing changes.
   * `typedAt` is when the send typed the character (default now): its {@link PENDING_PROBE_MS} run from there.
   */
  deaf(session: string, paneId: string, harness: string, typedAt?: number): number {
    const key = LaunchWindow.keyOf(session, paneId);
    const name = this.canonical(harness);
    const at = typedAt ?? this.now();
    const window = this.open(key);
    if (window !== null) {
      if (window.harness !== name) return 0;
      window.deaf += 1;
      window.typed.push(at);
      return window.deaf;
    }
    const settled = this.settled.get(key);
    const until = (settled?.opened ?? 0) + LAUNCH_WINDOW_MS;
    if (settled?.harness !== name || until <= this.now()) return 0;
    this.settled.delete(key);
    this.windows.set(key, { harness: name, opened: settled.opened, until, source: "agent", processSeen: true, deaf: 1, typed: [at] });
    return 1;
  }

  /**
   * How many probe characters ({@link deaf}) typed less than {@link PENDING_PROBE_MS} ago may still show
   * in the pane's box: while any does, no send types another. 0 with no open window. An older one no
   * longer blocks, though it may still show: the residue rule takes it out then (probe-marker.ts).
   */
  pending(session: string, paneId: string): number {
    const window = this.open(LaunchWindow.keyOf(session, paneId));
    if (window === null) return 0;
    const since = this.now() - PENDING_PROBE_MS;
    return window.typed.filter((at) => at > since).length;
  }

  /**
   * The harness a send should wait for on this pane, or null.
   *
   * `named` is the agent the multiplexer names on the pane, for a pane with a profile of its own: the
   * answer is that harness while its window is open, else null, and nothing is read. For a pane with no
   * profile of its own (`named` null), `foreground` reads its foreground processes first: a harness
   * there opens a `process` window (unless it settled), and a plain shell there ends a window the
   * process had confirmed and any settled mark. A launch's mark outlives a shell foreground until its
   * process has been seen, since the line typed may not have run yet.
   */
  async starting(session: string, paneId: string, named: string | null, foreground?: ForegroundHarness): Promise<string | null> {
    const key = LaunchWindow.keyOf(session, paneId);
    if (named !== null) {
      const harness = this.canonical(named);
      return this.open(key)?.harness === harness ? harness : null;
    }
    const seen = foreground === undefined ? undefined : await foreground();
    if (seen === null) {
      const window = this.open(key);
      if (window !== null && (window.source !== "launch" || window.processSeen)) this.windows.delete(key);
      this.settled.delete(key);
    } else if (seen !== undefined) {
      const harness = this.canonical(seen);
      const window = this.open(key);
      if (window?.harness === harness) window.processSeen = true;
      else if (this.settledAs(key) !== harness) this.openWindow(key, harness, "process", true);
    }
    return this.open(key)?.harness ?? null;
  }
}

/**
 * A {@link ForegroundHarness} over a multiplexer's foreground read, bounded by {@link FOREGROUND_READ_MS}.
 * Undefined when the multiplexer has no such read. A refusal, a throw or a slow read answer `undefined`.
 */
export function foregroundHarnessOf(
  read: ((paneId: string) => Promise<{ readonly ok: true; readonly value: readonly ForegroundProcess[] } | { readonly ok: false }>) | undefined,
  binaries: () => ReadonlyMap<string, string>,
  bound = FOREGROUND_READ_MS,
): ((paneId: string) => ForegroundHarness) | undefined {
  if (read === undefined) return undefined;
  return (paneId) => async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), bound);
    });
    try {
      const result = await Promise.race([read(paneId).catch(() => undefined), late]);
      if (result === undefined || !result.ok) return undefined;
      return harnessOfProcesses(result.value, binaries());
    } finally {
      clearTimeout(timer);
    }
  };
}
