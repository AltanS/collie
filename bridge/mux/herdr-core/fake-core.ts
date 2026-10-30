// A FAKE herdr-core: what lets the adapter be proved with no core on the box.
//
// NOT a production module. `bridge/index.ts` builds `HerdrCoreMux` over a real `HcClient`; tests
// and the conformance fixture build the same adapter over this in-memory core of the same shape
// (`HcRpc`), so the whole translation layer runs without a socket.
//
// EVERY ANSWER BELOW IS ONE THE REAL CORE GAVE (HC_API.md, hc 0.1.14). A fake kinder than the core
// proves nothing, so the unkind parts are copied on purpose:
//
//  • an unknown address answers `not_found`, a finished terminal answers `finished` to keys and to
//    typing, and a kill of a finished terminal answers with no error at all;
//  • `terminal.keys` refuses a name it does not know (`$`, a space, `page_up`) with
//    `invalid_params`, and sends nothing of that batch;
//  • `terminal.list` lists live terminals only, this machine's first and then an added machine's
//    (`box/t1`), which the adapter must drop;
//  • `terminal.read` is plain text with no escape, and `lines` adds history above the screen;
//  • an address is never reused, and a core restart keeps every address and rebuilds every record.
//
// THE UNKIND PARTS BEHIND A SWITCH (M78 spec 02). Each is OFF until a test turns it on, so the
// conformance fixture and the older tests keep the kinder core they were written against:
//
//  • `holdKeysAfterRawWrite` (HC_API.md § Typing, "The key hold"): a `terminal.keys` call that follows
//    a raw write is answered about 3,030 ms after that write. The wait runs on an injected clock, never
//    on a real timer. `answer: "early"` is the other reading the doc leaves open (the call answers at
//    once, the key reaches the program later);
//  • `fullScreenApp` (HC_API.md § terminal.read, `how` and `complete`): a read with `lines` above 0 of
//    a full-screen app is `how: "stitched"`, and `complete: false` with `why: "working"` while the app
//    works. A read with no history is `how: "screen"` and complete; a plain terminal's history read is
//    `how: "history"`;
//  • `resize` (HC_API.md § The terminal record, `cols` and `rows`: "the last ACTIVE attached viewer
//    sets it"): the terminal's size changes between two reads, and a read has exactly `rows` lines,
//    none wider than `cols`, trailing blank rows kept (HC_API.md § terminal.read);
//  • `reportState` (HC_API.md § Status, `state`: idle, working, done, blocked, error): the program's
//    own report, `done` and `error` included;
//  • `loseProgram` (HC_API.md § The terminal record, `keep`: "Replace a lost program with a shell in
//    place"): a terminal with `keep` gets a shell at the SAME address; one without it is a `finished`
//    record (HC_API.md § terminal.run, terminal.kill);
//  • `stopCore` and `startCore` (HC_API.md § The terminal record, `keep` and `state`; § Transport,
//    error kinds `finished` and `unavailable`): while the core is stopped every call fails as a dead
//    socket does; on the next start a kept terminal comes back as a shell at the same address (waiting,
//    and answering `unavailable` to keys and typing, until `shellsReady`), and a terminal without
//    `keep` is `finished`. What a core stop does to a program is not in HC_API.md; the rule is the
//    M78 spec 02 reading of `keep` and was not probed;
//  • `hangHistoryReads` (HC_API.md § terminal.read, `lines: N` and `how: stitched`; M78 spec 03
//    report, pi cases 2 and 3): a read with `lines` above 0 gives no answer while the switch is on
//    (the real core gave none in 30 s while a pi dialog stood), and the plain screen read (`lines: 0`)
//    still answers at once. `answerHungReads` lets the held reads answer, late;
//  • `slowHistoryReads` (M78 report 10, case 2, hc 0.1.14 under pi's permission dialog): a read with
//    `lines` above 0 runs until `endSlowRead` and then answers the screen alone, `complete: false, how:
//    screen`, as the real one did after 25 s. The terminal runs its history reads and key presses one
//    at a time, so a `terminal.keys` call waits behind every history read queued before it. With
//    `keysTimeoutMs` such a key call fails as the client's timeout does (`HcTimeout`) and the key
//    still lands when its turn comes, as the real `Down` did. Screen reads (`lines: 0`) and other
//    terminals answer at once.

import type { MuxWrite } from "../conformance.ts";
import {
  HcError,
  HcTimeout,
  type EventStream,
  type HcRpc,
  type RunShellRequest,
  type SubscribeOptions,
  type WireHello,
  type WireLayout,
  type WireLayoutSpace,
  type WireRead,
  type WireStatus,
  type WireTerminal,
} from "./client.ts";

/** The key names the real core accepted, lower case (HC_API.md § Typing). */
const NAMED = new Set([
  "up", "down", "left", "right", "tab", "enter", "esc", "escape", "space", "backspace", "delete", "insert",
  "home", "end", "pageup", "pagedown", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
const NAMEABLE_CHAR = /^[A-Za-z0-9',\-./;=[\\\]`]$/u;
const MODIFIERS = new Set(["ctrl", "alt", "shift", "super", "meta", "cmd"]);

/** Whether the real core takes this key name. */
export function coreKnowsKey(name: string): boolean {
  const parts = name.split("+");
  const key = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((mod) => !MODIFIERS.has(mod.toLowerCase()))) return false;
  return NAMED.has(key.toLowerCase()) || NAMEABLE_CHAR.test(key);
}

/**
 * The bytes a program in raw mode receives for a key name, for the letter keys whose bytes the lab
 * measured (keys-probe.txt): `g` is 0x67, `shift+g` is 0x47, `ctrl+g` is 0x07, `alt+g` is ESC g. The
 * core takes names case-insensitively, so a bare `G` is `g`, NOT a capital: a mapping that leaves
 * an upper case letter as it is sends the lower case byte, and only these bytes show it. `null` for
 * any other name (the named keys and punctuation are pinned by their names).
 */
export function keyBytes(name: string): number[] | null {
  const parts = name.toLowerCase().split("+");
  const letter = parts.at(-1) ?? "";
  if (!/^[a-z]$/u.test(letter)) return null;
  const mods = new Set(parts.slice(0, -1));
  if ([...mods].some((mod) => mod !== "ctrl" && mod !== "alt" && mod !== "shift")) return null;
  const code = letter.charCodeAt(0);
  const base = mods.has("ctrl") ? code & 0x1f : mods.has("shift") ? code - 0x20 : code;
  return mods.has("alt") ? [0x1b, base] : [base];
}

/** The time a fake core waits on. Tests share one with the code under test, so a 3 s hold costs no real second. */
export interface FakeClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

/** A clock that only moves when somebody waits on it: `wait` advances it and resolves at once. */
export class ManualClock implements FakeClock {
  ms = 0;
  now(): number {
    return this.ms;
  }
  wait(ms: number): Promise<void> {
    this.ms += Math.max(0, ms);
    return Promise.resolve();
  }
}

/** The measured gap between a raw write and the answer to the next key press (HC_API.md § Typing, "The key hold"). */
export const KEY_HOLD_MS = 3030;

/** What the program in a terminal receives, for a test that draws a screen from its input. */
export type FakeInput = { readonly kind: "text"; readonly text: string } | { readonly kind: "keys"; readonly keys: readonly string[] };

interface FakeTerminal {
  address: string;
  name: string;
  labels: Record<string, string>;
  state: "live" | "finished";
  cwd: string;
  title: string;
  status: WireStatus | null;
  foreground: { name: string; cwd: string } | null;
  screen: string[];
  history: string[];
  cols: number;
  rows: number;
  /** HC_API.md § The terminal record: a lost program is replaced by a shell in place. */
  keep: boolean;
  /** A full-screen app is read by scrolling it; `working` is true while it works. Null: a plain terminal. */
  fullScreen: { working: boolean } | null;
  /** A kept terminal that has not got its new shell yet answers `unavailable`. */
  waiting: boolean;
  onInput: ((input: FakeInput) => void) | null;
  /** The bytes the program received from letter keys, in order (see {@link keyBytes}). */
  received: number[];
}

interface Subscriber {
  readonly opts: SubscribeOptions;
  down: boolean;
}

const COLS = 80;
const ROWS = 6;

function record(terminal: FakeTerminal): WireTerminal {
  return {
    address: terminal.address,
    name: terminal.name,
    labels: { ...terminal.labels },
    state: terminal.state,
    cwd: terminal.cwd,
    cols: terminal.cols,
    rows: terminal.rows,
    title: terminal.title,
    status: terminal.status === null ? null : { ...terminal.status },
    foreground: terminal.foreground === null ? null : { ...terminal.foreground },
  };
}

function notFound(address: string): HcError {
  return new HcError("not_found", `herdr-core terminal: not_found: no terminal "${address}"`);
}

/** A herdr-core socket, in memory, answering as the real one does. */
export class FakeHcCore implements HcRpc {
  private terminals: FakeTerminal[] = [];
  private layout: WireLayoutSpace[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly recorded: MuxWrite[] = [];
  /** Never decreases, never reused, so a new terminal never lands on a dead terminal's address. */
  private minted = 0;
  private seq = 0;
  private connected = true;
  /** False between `stopCore` and `startCore`: no socket answers. */
  private running = true;
  /** The key hold, when switched on: the clock it waits on, how long, and the last raw write. */
  private hold: { readonly clock: FakeClock; readonly ms: number; readonly answer: "late" | "early"; lastWriteAt: number | null } | null = null;
  /** Key effects an `early` hold has answered and not yet delivered, in order. */
  private readonly pendingKeys: { readonly dueAt: number; readonly address: string; readonly keys: readonly string[] }[] = [];
  /** Terminals whose history reads hang, and the held reads waiting to answer. */
  private readonly hungHistory = new Set<string>();
  private heldReads: (() => void)[] = [];
  /** Terminals whose history reads are slow, with the key call timeout to act out (null: none). */
  private readonly slowHistory = new Map<string, { readonly keysTimeoutMs: number | null }>();
  /** Per terminal, the end of its one-at-a-time queue of slow history reads and key presses. */
  private readonly lanes = new Map<string, Promise<void>>();
  /** Per terminal, the slow history reads waiting for `endSlowRead`, oldest first. */
  private readonly slowReads = new Map<string, (() => void)[]>();
  /** Per terminal, how many history reads (`lines` above 0) the core was asked for. */
  private readonly historyCounts = new Map<string, number>();
  /** A generation the fake claims, for the compatibility test. */
  generation = 1;

  constructor(seed = true) {
    if (seed) this.seed();
  }

  // ── What tests and the fixture drive ───────────────────────────────────────

  writes(): readonly MuxWrite[] {
    return this.recorded;
  }

  /** The bytes a program in this terminal received from letter keys, as a real program would see them. */
  receivedBytes(address: string): readonly number[] {
    return this.known(address).received;
  }

  /** Add a terminal as the core would after `terminal.run`, and announce it. */
  add(partial: Partial<Omit<FakeTerminal, "address">> & { address?: string }): string {
    const address = partial.address ?? this.mint();
    const terminal: FakeTerminal = {
      address,
      name: partial.name ?? "",
      labels: partial.labels ?? {},
      state: partial.state ?? "live",
      cwd: partial.cwd ?? "/home/dev",
      title: partial.title ?? "",
      status: partial.status ?? null,
      foreground: partial.foreground ?? { name: "bash", cwd: partial.cwd ?? "/home/dev" },
      screen: partial.screen ?? [`${address}$ `],
      history: partial.history ?? [],
      cols: partial.cols ?? COLS,
      rows: partial.rows ?? ROWS,
      keep: partial.keep ?? false,
      fullScreen: partial.fullScreen ?? null,
      waiting: false,
      onInput: null,
      received: [],
    };
    this.terminals.push(terminal);
    this.emit("created", address);
    return address;
  }

  setLayout(spaces: WireLayoutSpace[]): void {
    this.layout = spaces.map((space) => ({ ...space, tabs: space.tabs.map((tab) => ({ ...tab })) }));
    this.emit("doc", "");
  }

  /** The program in a terminal reports its status, as OSC 7501 does. */
  setStatus(address: string, status: WireStatus | null): void {
    const terminal = this.find(address);
    if (terminal !== undefined) terminal.status = status;
    this.emit("status", address);
  }

  /** What the program in a terminal reports (OSC 7501): idle, working, done, blocked or error. */
  reportState(address: string, state: "idle" | "working" | "done" | "blocked" | "error", app = "claude-code"): void {
    this.setStatus(address, { state, app, kind: "" });
  }

  /**
   * Switch the key hold on: a `terminal.keys` call after a raw write waits out the rest of `ms` since
   * that write, on `clock`. `answer: "late"` (the measured shape) delivers the keys when it answers;
   * `"early"` answers at once and delivers them `ms` after the write.
   */
  holdKeysAfterRawWrite(clock: FakeClock, options: { ms?: number; answer?: "late" | "early" } = {}): void {
    this.hold = { clock, ms: options.ms ?? KEY_HOLD_MS, answer: options.answer ?? "late", lastWriteAt: null };
  }

  /** Make the terminal a full-screen app: a read with history is stitched, and incomplete while it works. */
  fullScreenApp(address: string, working: boolean): void {
    const terminal = this.find(address);
    if (terminal !== undefined) terminal.fullScreen = { working };
  }

  /** A read with history of this terminal gives no answer until `answerHungReads`; `on: false` ends that for new reads. */
  hangHistoryReads(address: string, on = true): void {
    if (on) this.hungHistory.add(address);
    else this.hungHistory.delete(address);
  }

  /**
   * Make this terminal's history reads slow and queue its keys behind them, one at a time (see the
   * header). `on: false` ends that for new calls; reads already queued still wait for `endSlowRead`.
   */
  slowHistoryReads(address: string, options: { on?: boolean; keysTimeoutMs?: number | null } = {}): void {
    if (options.on === false) this.slowHistory.delete(address);
    else this.slowHistory.set(address, { keysTimeoutMs: options.keysTimeoutMs ?? null });
  }

  /** The oldest slow history read of this terminal ends now. False when none waits. */
  endSlowRead(address: string): boolean {
    const release = this.slowReads.get(address)?.shift();
    if (release === undefined) return false;
    release();
    return true;
  }

  /** How many slow history reads of this terminal wait for `endSlowRead`. */
  pendingSlowReads(address: string): number {
    return this.slowReads.get(address)?.length ?? 0;
  }

  /** How many history reads (`lines` above 0) of this terminal the core was asked for, in all. */
  historyReads(address: string): number {
    return this.historyCounts.get(address) ?? 0;
  }

  /** Every history read held so far answers now, as a late answer would. */
  answerHungReads(): void {
    const held = this.heldReads;
    this.heldReads = [];
    for (const release of held) release();
  }

  /** A viewer that is active sets the terminal's size (HC_API.md § The terminal record, `cols`). */
  resize(address: string, cols: number, rows: number): void {
    const terminal = this.find(address);
    if (terminal === undefined) return;
    terminal.cols = cols;
    terminal.rows = rows;
    this.emit("size", address);
  }

  /** The terminal as the fake holds it, for a test that derives a generation from it. */
  peek(address: string): { readonly foreground: { name: string; cwd: string } | null; readonly status: WireStatus | null; readonly state: string } | undefined {
    return this.find(address);
  }

  /** Replace the rows of the screen, as the program in the terminal drawing would. */
  setScreen(address: string, screen: readonly string[]): void {
    const terminal = this.find(address);
    if (terminal !== undefined) terminal.screen = [...screen];
  }

  /** Hand every text write and key press to `onInput`, after the core let it through. */
  program(address: string, onInput: ((input: FakeInput) => void) | null): void {
    const terminal = this.find(address);
    if (terminal !== undefined) terminal.onInput = onInput;
  }

  /**
   * The program in the terminal is lost. With `keep` the core starts a shell in place, at the same
   * address, and says `lost` and then `restarted`; without it the terminal is a `finished` record.
   */
  loseProgram(address: string): void {
    const terminal = this.find(address);
    if (terminal === undefined || terminal.state !== "live") return;
    this.emit("lost", address);
    if (!terminal.keep) {
      terminal.state = "finished";
      this.emit("finished", address);
      return;
    }
    this.shellIn(terminal);
    this.emit("restarted", address);
  }

  /** The core stops: no call is answered, every stream ends. */
  stopCore(): void {
    this.running = false;
    for (const subscriber of this.subscribers) this.fireDown(subscriber, "connection closed");
    this.subscribers.clear();
  }

  /**
   * The core starts again, with a new `seq`. A kept terminal gets a shell at its address (and answers
   * `unavailable` until `shellsReady` when `shellsReady` is false); a live terminal without `keep` is
   * `finished`; a finished one stays finished.
   */
  startCore(options: { shellsReady?: boolean } = {}): void {
    this.running = true;
    this.seq = 0;
    for (const terminal of this.terminals) {
      if (terminal.state !== "live") continue;
      if (!terminal.keep) {
        terminal.state = "finished";
        continue;
      }
      this.shellIn(terminal);
      terminal.waiting = options.shellsReady === false;
    }
  }

  /** The new shells of the kept terminals are up: keys and typing are taken again. */
  shellsReady(): void {
    for (const terminal of this.terminals) terminal.waiting = false;
  }

  async reconnect(): Promise<void> {
    this.connected = false;
    await Promise.resolve();
    this.connected = true;
  }

  /** The core process restarts: addresses kept, records rebuilt, seq from 0, every stream ends. */
  async restartMux(): Promise<void> {
    this.terminals = this.terminals.map((terminal) => ({ ...terminal, labels: { ...terminal.labels }, screen: [...terminal.screen] }));
    this.layout = this.layout.map((space) => ({ ...space, tabs: space.tabs.map((tab) => ({ ...tab })) }));
    this.seq = 0;
    for (const subscriber of this.subscribers) this.fireDown(subscriber, "connection closed");
    await Promise.resolve();
  }

  /** The core has no rename; the nearest act out of band is a label somebody sets. */
  async renameOutOfBand(paneId: string, label: string): Promise<void> {
    const terminal = this.find(paneId);
    if (terminal !== undefined) {
      terminal.labels = { ...terminal.labels, note: label };
      this.emit("labels", paneId);
    }
    await Promise.resolve();
  }

  async setProgramTitle(paneId: string, title: string): Promise<void> {
    const terminal = this.find(paneId);
    if (terminal !== undefined) {
      terminal.title = title;
      this.emit("title", paneId);
    }
    await Promise.resolve();
  }

  async changePane(paneId: string): Promise<void> {
    const terminal = this.find(paneId);
    if (terminal !== undefined) {
      this.minted += 1;
      terminal.history.push(terminal.screen.shift() ?? "");
      terminal.screen.push(`changed ${String(this.minted)}`);
    }
    await Promise.resolve();
  }

  /** The program ends and the record is removed (`terminal.rm`), so the address is unknown now. */
  async endPane(paneId: string): Promise<void> {
    this.terminals = this.terminals.filter((terminal) => terminal.address !== paneId);
    this.emit("finished", paneId);
    this.emit("removed", paneId);
    await Promise.resolve();
  }

  /** herdr-app renames a tab in its document, and nothing reaches the stream. */
  async pokeTopologyOutOfBand(): Promise<void> {
    const space = this.layout[0];
    const tab = space?.tabs[0];
    this.minted += 1;
    if (space !== undefined && tab !== undefined) {
      this.layout[0] = { ...space, tabs: [{ ...tab, name: `out-of-band-${String(this.minted)}` }, ...space.tabs.slice(1)] };
    }
    await Promise.resolve();
  }

  pokeTopology(): void {
    this.emit("created", this.terminals[0]?.address ?? "");
  }

  pokePane(paneId: string): void {
    this.emit("status", paneId);
  }

  /** Send a `missed` notification, as the core does to a subscriber that fell behind. */
  pokeMissed(): void {
    this.seq += 1;
    for (const subscriber of this.subscribers) {
      if (!subscriber.down) subscriber.opts.onEvent({ type: "missed", terminal: "", seq: this.seq });
    }
  }

  shutdown(): void {
    for (const subscriber of this.subscribers) this.fireDown(subscriber, "closed");
    this.subscribers.clear();
  }

  // ── The methods (HcRpc) ───────────────────────────────────────────────────

  async hello(): Promise<WireHello> {
    this.assertConnected("hello");
    if (this.generation !== 1) {
      throw new HcError("unsupported_generation", "herdr-core hello: unsupported_generation: protocol generation 1 not supported");
    }
    return { generation: 1, version: "0.1.14", coreId: "fake", coreName: "fakehost" };
  }

  async listTerminals(): Promise<WireTerminal[]> {
    this.assertConnected("terminal.list");
    const live = this.terminals.filter((terminal) => terminal.state === "live");
    const local = live.filter((terminal) => !terminal.address.includes("/"));
    const remote = live.filter((terminal) => terminal.address.includes("/"));
    return [...local, ...remote].map(record);
  }

  async getTerminal(address: string): Promise<WireTerminal> {
    this.assertConnected("terminal.get");
    return record(this.known(address));
  }

  async readTerminal(address: string, lines: number): Promise<WireRead> {
    this.assertConnected("terminal.read");
    if (lines > 0) this.historyCounts.set(address, this.historyReads(address) + 1);
    if (lines > 0 && this.slowHistory.has(address)) return this.slowRead(address);
    if (lines > 0 && this.hungHistory.has(address)) await new Promise<void>((resolve) => this.heldReads.push(resolve));
    this.deliverDueKeys();
    const terminal = this.known(address);
    const history = lines > 0 ? terminal.history.slice(-lines) : [];
    const shown = terminal.screen.slice(-terminal.rows);
    while (shown.length < terminal.rows) shown.push("");
    const rows = [...history, ...shown.map((row) => [...row].slice(0, terminal.cols).join(""))];
    const text = `${rows.join("\n")}\n`;
    if (lines === 0) return { text, complete: true, how: "screen" };
    if (terminal.fullScreen === null) return { text, complete: true, how: "history" };
    if (terminal.fullScreen.working) return { text, complete: false, how: "stitched", why: "working" };
    return { text, complete: true, how: "stitched" };
  }

  async pressKeys(address: string, keys: readonly string[]): Promise<void> {
    this.assertConnected("terminal.keys");
    this.deliverDueKeys();
    const terminal = this.known(address);
    this.assertTakesInput(terminal, "terminal.keys");
    const unknown = keys.find((key) => !coreKnowsKey(key));
    if (unknown !== undefined) {
      throw new HcError("invalid_params", `herdr-core terminal.keys: invalid_params: unknown key "${unknown}" (try enter, esc, up, ctrl+c, alt+x, f5, a)`);
    }
    const slow = this.slowHistory.get(address);
    if (slow !== undefined) return this.keysInLane(terminal, keys, slow.keysTimeoutMs);
    const hold = this.hold;
    if (hold === null || hold.lastWriteAt === null) return this.deliverKeys(terminal, keys);
    const remaining = hold.lastWriteAt + hold.ms - hold.clock.now();
    if (remaining <= 0) return this.deliverKeys(terminal, keys);
    if (hold.answer === "early") {
      this.pendingKeys.push({ dueAt: hold.lastWriteAt + hold.ms, address, keys: [...keys] });
      return;
    }
    await hold.clock.wait(remaining);
    this.deliverKeys(terminal, keys);
  }

  async typeRaw(address: string, text: string): Promise<void> {
    this.assertConnected("terminal.attach");
    this.deliverDueKeys();
    const terminal = this.known(address);
    this.assertTakesInput(terminal, "terminal.attach");
    if (this.hold !== null) this.hold.lastWriteAt = this.hold.clock.now();
    this.recorded.push({ paneId: address, kind: "text", payload: [text] });
    terminal.onInput?.({ kind: "text", text });
  }

  async killTerminal(address: string): Promise<void> {
    this.assertConnected("terminal.kill");
    const terminal = this.known(address);
    if (terminal.state === "live") {
      terminal.state = "finished";
      this.emit("finished", address);
    }
  }

  async runShell(request: RunShellRequest): Promise<WireTerminal> {
    this.assertConnected("terminal.run");
    const address = this.add({ labels: { ...request.labels }, cwd: request.cwd ?? "/home/dev" });
    return record(this.known(address));
  }

  async readLayout(): Promise<WireLayout | null> {
    this.assertConnected("doc.get");
    return this.layout.length === 0 ? null : { spaces: this.layout.map((space) => ({ ...space, tabs: space.tabs.map((tab) => ({ ...tab })) })) };
  }

  subscribe(opts: SubscribeOptions): EventStream {
    const subscriber: Subscriber = { opts, down: false };
    if (!this.connected) {
      queueMicrotask(() => this.fireDown(subscriber, "connect failed"));
      return { close: () => this.fireDown(subscriber, "closed") };
    }
    this.subscribers.add(subscriber);
    queueMicrotask(() => {
      if (!subscriber.down) opts.onUp();
    });
    return { close: () => this.fireDown(subscriber, "closed") };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private mint(): string {
    this.minted += 1;
    return `t${String(this.minted)}`;
  }

  private find(address: string): FakeTerminal | undefined {
    return this.terminals.find((terminal) => terminal.address === address);
  }

  private known(address: string): FakeTerminal {
    const terminal = this.find(address);
    if (terminal === undefined) throw notFound(address);
    return terminal;
  }

  private assertConnected(method: string): void {
    if (!this.connected) throw new Error(`herdr-core ${method}: connection closed before the answer`);
    if (!this.running) throw new Error(`herdr-core ${method}: connect ENOENT: the core is not running`);
  }

  /** Keys and typing: a finished terminal says `finished`, a kept terminal without its shell says `unavailable`. */
  private assertTakesInput(terminal: FakeTerminal, method: string): void {
    if (terminal.state !== "live") throw new HcError("finished", `herdr-core ${method}: finished: ${terminal.address} has finished`);
    if (terminal.waiting) throw new HcError("unavailable", `herdr-core ${method}: unavailable: ${terminal.address} is waiting for its new shell`);
  }

  /** Run `work` after everything queued on this terminal before it, one at a time. */
  private inLane<T>(address: string, work: () => Promise<T> | T): Promise<T> {
    const before = this.lanes.get(address) ?? Promise.resolve();
    const run = before.then(work);
    this.lanes.set(
      address,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** A slow history read: it waits its turn and its `endSlowRead`, then answers the screen alone, incomplete. */
  private async slowRead(address: string): Promise<WireRead> {
    const { promise: ended, resolve: release } = Promise.withResolvers<void>();
    const waiting = this.slowReads.get(address) ?? [];
    waiting.push(release);
    this.slowReads.set(address, waiting);
    await this.inLane(address, () => ended);
    const read = await this.readTerminal(address, 0);
    return { text: read.text, complete: false, how: "screen" };
  }

  /** Keys queued behind the terminal's slow reads. A key call timeout fails the call, and the key still lands in turn. */
  private keysInLane(terminal: FakeTerminal, keys: readonly string[], timeoutMs: number | null): Promise<void> {
    const landed = this.inLane(terminal.address, () => {
      if (terminal.state === "live") this.deliverKeys(terminal, keys);
    });
    if (timeoutMs === null) return landed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HcTimeout("terminal.keys", timeoutMs)), timeoutMs);
    });
    return Promise.race([landed, late]).finally(() => clearTimeout(timer));
  }

  private deliverKeys(terminal: FakeTerminal, keys: readonly string[]): void {
    this.recorded.push({ paneId: terminal.address, kind: "keys", payload: [...keys] });
    for (const key of keys) terminal.received.push(...(keyBytes(key) ?? []));
    terminal.onInput?.({ kind: "keys", keys });
  }

  /** The keys an `early` hold answered are due: they reach the program now, in order. */
  private deliverDueKeys(): void {
    const hold = this.hold;
    if (hold === null) return;
    const now = hold.clock.now();
    while (this.pendingKeys.length > 0 && (this.pendingKeys[0]?.dueAt ?? Infinity) <= now) {
      const due = this.pendingKeys.shift();
      const terminal = due === undefined ? undefined : this.find(due.address);
      if (due !== undefined && terminal !== undefined && terminal.state === "live") this.deliverKeys(terminal, due.keys);
    }
  }

  /** A shell in place of the program: same address, no report, a fresh screen. */
  private shellIn(terminal: FakeTerminal): void {
    terminal.status = null;
    terminal.fullScreen = null;
    terminal.foreground = { name: "bash", cwd: terminal.cwd };
    terminal.screen = [`${terminal.address}$ `];
    terminal.history = [];
    terminal.onInput = null;
  }

  private emit(type: string, terminal: string): void {
    this.seq += 1;
    for (const subscriber of this.subscribers) {
      if (!subscriber.down) subscriber.opts.onEvent({ type, terminal, seq: this.seq });
    }
  }

  private fireDown(subscriber: Subscriber, reason: string): void {
    if (subscriber.down) return;
    subscriber.down = true;
    this.subscribers.delete(subscriber);
    subscriber.opts.onDown(reason);
  }

  /**
   * Two herdr-app spaces and one terminal herdr-app does not show, four live local panes in all,
   * one of them Claude Code blocked on a permission, plus a terminal on an added machine that must
   * never become a pane.
   */
  private seed(): void {
    this.layout = [
      {
        id: "spcollie",
        name: "collie",
        folder: "/home/dev/collie",
        tabs: [
          { id: "tbagents", name: "agents" },
          { id: "tbspare", name: "" },
        ],
      },
      { id: "spscratch", name: "", folder: "/home/dev", tabs: [{ id: "tbscratch", name: "" }] },
    ];
    const inAgents = { "herdr.space": "spcollie", "herdr.tab": "tbagents", where: "collie / agents" };
    this.add({
      labels: inAgents,
      keep: true,
      cwd: "/home/dev",
      title: "✳ Writing the conformance suite",
      status: { state: "blocked", app: "claude-code", kind: "permission" },
      foreground: { name: "claude", cwd: "/home/dev/collie" },
      screen: ["Claude Code", "", "Allow edit to src/x.ts?", "❯ 1. Yes", "  2. No", ""],
      history: Array.from({ length: 30 }, (_, i) => `earlier line ${String(i + 1)}`),
    });
    this.add({
      labels: inAgents,
      keep: true,
      cwd: "/home/dev/collie",
      foreground: { name: "bash", cwd: "/home/dev/collie" },
      history: ["$ bun test", "1293 pass", "0 fail"],
    });
    this.add({ labels: { "herdr.space": "spscratch", "herdr.tab": "tbscratch", where: "scratch / 1" }, keep: true, cwd: "/home/dev/scratch", foreground: { name: "bash", cwd: "/home/dev/scratch" } });
    this.add({ name: "review", cwd: "/tmp", foreground: { name: "bash", cwd: "/tmp" } });
    this.add({ address: "box/t1", labels: inAgents, cwd: "/srv", status: { state: "working", app: "codex", kind: "" } });
  }
}
