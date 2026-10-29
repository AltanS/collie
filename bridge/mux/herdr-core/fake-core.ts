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

import type { MuxWrite } from "../conformance.ts";
import {
  HcError,
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
    cols: COLS,
    rows: ROWS,
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
  /** A generation the fake claims, for the compatibility test. */
  generation = 1;

  constructor(seed = true) {
    if (seed) this.seed();
  }

  // ── What tests and the fixture drive ───────────────────────────────────────

  writes(): readonly MuxWrite[] {
    return this.recorded;
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
    const terminal = this.known(address);
    const history = lines > 0 ? terminal.history.slice(-lines) : [];
    return { text: [...history, ...terminal.screen].join("\n"), complete: true };
  }

  async pressKeys(address: string, keys: readonly string[]): Promise<void> {
    this.assertConnected("terminal.keys");
    const terminal = this.known(address);
    if (terminal.state !== "live") throw new HcError("finished", `herdr-core terminal.keys: finished: ${address} has finished`);
    const unknown = keys.find((key) => !coreKnowsKey(key));
    if (unknown !== undefined) {
      throw new HcError("invalid_params", `herdr-core terminal.keys: invalid_params: unknown key "${unknown}" (try enter, esc, up, ctrl+c, alt+x, f5, a)`);
    }
    this.recorded.push({ paneId: address, kind: "keys", payload: [...keys] });
  }

  async typeRaw(address: string, text: string): Promise<void> {
    this.assertConnected("terminal.attach");
    const terminal = this.known(address);
    if (terminal.state !== "live") throw new HcError("finished", `herdr-core terminal.attach: finished: ${address} has finished`);
    this.recorded.push({ paneId: address, kind: "text", payload: [text] });
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
      cwd: "/home/dev",
      title: "✳ Writing the conformance suite",
      status: { state: "blocked", app: "claude-code", kind: "permission" },
      foreground: { name: "claude", cwd: "/home/dev/collie" },
      screen: ["Claude Code", "", "Allow edit to src/x.ts?", "❯ 1. Yes", "  2. No", ""],
      history: Array.from({ length: 30 }, (_, i) => `earlier line ${String(i + 1)}`),
    });
    this.add({ labels: inAgents, cwd: "/home/dev/collie", foreground: { name: "bash", cwd: "/home/dev/collie" } });
    this.add({ labels: { "herdr.space": "spscratch", "herdr.tab": "tbscratch", where: "scratch / 1" }, cwd: "/home/dev/scratch", foreground: { name: "bash", cwd: "/home/dev/scratch" } });
    this.add({ name: "review", cwd: "/tmp", foreground: { name: "bash", cwd: "/tmp" } });
    this.add({ address: "box/t1", labels: inAgents, cwd: "/srv", status: { state: "working", app: "codex", kind: "" } });
  }
}
