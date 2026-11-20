// REX'S CONFORMANCE FIXTURE — the Rex adapter over an in-memory `rex`.
//
// {@link FakeRex} answers the argv the adapter builds with what the real CLI printed for it on rex
// 0.0.1795019727 (MUX_CONTRACT.md, source **RX**): the same JSON shapes, the same exit codes (3 for a
// target that is not found, 4 for no server), and the same quirks — a `--keep-open` block whose
// program exited still takes `send` with exit 0, `send-key` refuses a whole batch for one unknown key,
// and closing a window's last block closes the window. A fake kinder than the server proves nothing.
//
// The world: two sessions. `work` has a client attached (a Rex app is showing it) and two windows,
// the first split in two with Claude Code running in one half; `notes` has one window and nobody
// attached, so nothing in it is focused.

import type { JsonObject } from "../../json.ts";
import type { MuxConformanceFixture, MuxConformanceWorld, MuxWrite } from "../conformance.ts";
import { RexMux } from "./adapter.ts";
import { TIMED_OUT_CODE, timedOutMessage, type RexExec, type RexRunResult, type RexStreamClient, type RexStreamHandlers } from "./exec.ts";
import { REX_TERMINAL_CREATOR } from "./protocol.ts";

const GREEN = "\u001b[32m";
const RESET = "\u001b[0m";
/** An OSC 8 hyperlink, which the real `--format=vt` carries and the adapter must drop. */
const LINK_OPEN = "\u001b]8;;https://example.test\u001b\\";
const LINK_CLOSE = "\u001b]8;;\u001b\\";
/** The start of a cursor-forward, `ESC [ n C`, which the real `--format=vt` writes for blank cells. */
const CURSOR_FORWARD = "\u001b[";

/** The address the fake server reports as its primary listener, and blocks carry as `REX_SERVER`. */
export const FAKE_REX_SERVER = "unix:///run/user/1000/rex/server.sock";

interface FakeRecord {
  state: string;
  app: string;
  /** Who wrote it: the agent in the foreground (the default) or the block's own shell. */
  owner?: "foreground" | "shell";
}

interface FakeBlock {
  id: string;
  label: string;
  cwd: string;
  foreground: string;
  exited: boolean;
  title: string;
  records: FakeRecord[];
  history: string[];
  screen: string[];
  rows: number;
}

interface FakeWindow {
  id: string;
  label: string;
  focusedBlockId: string;
  blockIds: string[];
}

interface FakeSession {
  id: string;
  label: string;
  attached: number;
  activeWindowId: string;
  windowIds: string[];
}

interface FakeListener {
  handlers: RexStreamHandlers;
  ended: boolean;
}

const ok = (stdout = ""): RexRunResult => ({ code: 0, stdout, stderr: "" });
const notFound = (kind: "block" | "window" | "session", target: string): RexRunResult => ({
  code: 3,
  stdout: "",
  stderr: `Error: ${kind} target "${target}" not found\n`,
});

/** A block method's JSON arguments, as the adapter wrote them: only the fields this fake reads. */
interface BlockArgs {
  readonly format?: string;
  readonly max_bytes?: number;
  readonly id?: number;
  readonly offset?: number;
}

function requestOf(raw: string | undefined): BlockArgs {
  const parsed: BlockArgs = JSON.parse(raw ?? "{}");
  return parsed;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** How long `text` is once written as a JSON string, without its quotes: what `max_bytes` counts. */
function jsonLength(text: string): number {
  return byteLength(JSON.stringify(text)) - 2;
}

/** The longest start of `text` whose JSON form fits in `limit`. */
function fitJson(text: string, limit: number): string {
  let used = 0;
  let end = 0;
  for (const char of text) {
    used += jsonLength(char);
    if (used > limit) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/** The value after `name` in argv, or undefined. */
function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * argv with every `-x value` / `--long value` pair and every `--flag=value` / bare `--flag` removed,
 * as rex's parser reads it. After `--` every word is positional, unless `dash` says the verb reads
 * them as a COMMAND (`rex new`, `rex window new`), when they are not positionals at all.
 */
function positionals(args: readonly string[], valued: readonly string[], dash: "names" | "command" = "names"): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      if (dash === "names") out.push(...args.slice(i + 1));
      return out;
    }
    if (valued.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

export class FakeRex implements RexExec {
  /** The next text write fails once (M100 spec 03): `stall` gets no answer in time, `refuse` is told no. */
  nextWrite: "stall" | "refuse" | null = null;
  /** The next key write fails once, the same two ways. */
  nextKeys: "stall" | "refuse" | null = null;
  /** The server forgets every stored `format` result, as it does once newer reads push one out. */
  forgetResults = false;
  /** The API revision `server.status` reports; 19 is the one the adapter was last probed on. */
  apiRevision = 19;
  /** What a VT row that holds anything opens with. The real server writes `ESC [ 0 m`. */
  vtRowStart = RESET;

  private sessions = new Map<string, FakeSession>();
  private windows = new Map<string, FakeWindow>();
  private blocks = new Map<string, FakeBlock>();
  private readonly listeners = new Set<FakeListener>();
  private readonly recorded: MuxWrite[] = [];
  private serial = 0x100;
  /** `format` results kept for `blob_read`, by id. */
  private readonly results = new Map<number, string>();
  private resultSerial = 0;
  private connected = true;

  constructor() {
    this.seed();
  }

  /** A fresh rex-shaped id: `<kind>:<uuid>`, never handed out twice. */
  private mint(kind: "session" | "window" | "block"): string {
    this.serial += 1;
    const tail = this.serial.toString(16).padStart(12, "0");
    return `${kind}:01a1f140-f804-7d10-b29f-${tail}`;
  }

  private block(id: string, init: Partial<FakeBlock>): FakeBlock {
    return {
      id,
      label: "shell",
      cwd: "/home/rex",
      foreground: "zsh",
      exited: false,
      title: "",
      records: [],
      history: [],
      screen: ["$ "],
      rows: 24,
      ...init,
    };
  }

  private seed(): void {
    const work = this.mint("session");
    const notes = this.mint("session");
    const main = this.mint("window");
    const logs = this.mint("window");
    const scratch = this.mint("window");
    const agent = this.mint("block");
    const shell = this.mint("block");
    const tail = this.mint("block");
    const memo = this.mint("block");

    this.blocks.set(
      agent,
      this.block(agent, {
        cwd: "/home/rex/project",
        foreground: "2.1.327",
        title: "claude",
        records: [{ state: "working", app: "claude-code" }],
        history: ["older 1", "older 2", "older 3"],
        screen: ["> fix the tests", "Thinking…"],
      }),
    );
    this.blocks.set(shell, this.block(shell, { cwd: "/home/rex/project", screen: ["$ git status"] }));
    this.blocks.set(tail, this.block(tail, { cwd: "/var/log", foreground: "tail", title: "tail -f app.log", screen: ["log line"] }));
    this.blocks.set(memo, this.block(memo, { cwd: "/home/rex/notes", foreground: "vim", title: "todo.md", screen: ["- [ ] ship it"] }));

    this.windows.set(main, { id: main, label: "main", focusedBlockId: agent, blockIds: [agent, shell] });
    this.windows.set(logs, { id: logs, label: `Window ${logs.slice(-8)}`, focusedBlockId: tail, blockIds: [tail] });
    // A `--keep-open` block whose program exited: still listed, its screen still readable, no longer
    // alive. The live probe found the counts wrong on exactly this block (2026-11-19).
    const done = this.mint("block");
    this.blocks.set(done, this.block(done, { cwd: "/home/rex/notes", exited: true, screen: ["build finished"] }));
    this.windows.set(scratch, { id: scratch, label: "scratch", focusedBlockId: memo, blockIds: [memo, done] });

    this.sessions.set(work, { id: work, label: "work", attached: 1, activeWindowId: main, windowIds: [main, logs] });
    this.sessions.set(notes, { id: notes, label: "notes", attached: 0, activeWindowId: scratch, windowIds: [scratch] });
  }

  /** Put `lines` above a block's screen, as a long-running program leaves them in its scrollback. */
  /** The block's own shell prints a status record, as `printf` of an OSC 7501 at its prompt does. */
  forgeStatusFromShell(paneId: string, state: string, app: string): void {
    const block = this.blocks.get(paneId);
    if (block) block.records = [{ state, app, owner: "shell" }];
  }

  fillHistory(paneId: string, lines: readonly string[]): void {
    const block = this.blocks.get(paneId);
    if (block) block.history = [...block.history, ...lines];
  }

  /**
   * A block's screen AND scrollback, always, padded to the terminal's rows as a real screen is. As
   * probed: VT rows are joined by `\r\n`, each row that holds anything opens with `ESC [ 0 m`, a run
   * of blank cells is `ESC [ n C`, and links are OSC 8.
   */
  private render(block: FakeBlock, vt: boolean): string {
    const screen = [...block.screen, ...Array.from({ length: Math.max(0, block.rows - block.screen.length) }, () => "")];
    const lines = [...block.history, ...screen].map((line) =>
      vt && line !== ""
        ? `${this.vtRowStart}${GREEN}${LINK_OPEN}${line.replace(/ +/gu, (run) => `${CURSOR_FORWARD}${String(run.length)}C`)}${LINK_CLOSE}${RESET}`
        : line,
    );
    return lines.join(vt ? "\r\n" : "\n");
  }

  writes(): readonly MuxWrite[] {
    return this.recorded;
  }

  private emit(line: JsonObject): void {
    const text = JSON.stringify(line);
    for (const listener of this.listeners) if (!listener.ended) listener.handlers.onLine(text);
  }

  private emitSession(sessionId: string, type: string, payload: JsonObject): void {
    this.emit({ type: "session_event", payload: { session_id: sessionId, event: { type, payload } } });
  }

  private emitBlock(sessionId: string, blockId: string, name: string, payload: JsonObject): void {
    this.emitSession(sessionId, "block_event", { block_id: blockId, creator_name: REX_TERMINAL_CREATOR, name, payload });
  }

  private sessionOf(target: string | undefined): FakeSession | undefined {
    if (target === undefined) return undefined;
    return this.sessions.get(target) ?? [...this.sessions.values()].find((s) => s.label === target);
  }

  private windowHome(windowId: string): FakeSession | undefined {
    return [...this.sessions.values()].find((s) => s.windowIds.includes(windowId));
  }

  private blockHome(blockId: string): { session: FakeSession; window: FakeWindow } | undefined {
    for (const window of this.windows.values()) {
      if (!window.blockIds.includes(blockId)) continue;
      const session = this.windowHome(window.id);
      if (session) return { session, window };
    }
    return undefined;
  }

  /** Close a block as rex does: the window goes with its last block, and the session's active window moves on. */
  private removeBlock(blockId: string): void {
    const home = this.blockHome(blockId);
    this.blocks.delete(blockId);
    if (!home) return;
    const { session, window } = home;
    window.blockIds = window.blockIds.filter((id) => id !== blockId);
    this.emitSession(session.id, "block_closed", { block_id: blockId });
    if (window.focusedBlockId === blockId) window.focusedBlockId = window.blockIds[0] ?? "";
    if (window.blockIds.length === 0) this.removeWindow(session, window.id);
  }

  private removeWindow(session: FakeSession, windowId: string): void {
    const window = this.windows.get(windowId);
    for (const blockId of window?.blockIds ?? []) this.blocks.delete(blockId);
    this.windows.delete(windowId);
    session.windowIds = session.windowIds.filter((id) => id !== windowId);
    this.emitSession(session.id, "window_closed", { window_id: windowId });
    if (session.activeWindowId === windowId) session.activeWindowId = session.windowIds[0] ?? "";
  }

  async run(args: readonly string[], stdin?: string): Promise<RexRunResult> {
    if (!this.connected) {
      return { code: 4, stdout: "", stderr: `Error: no Rex server is running at ${FAKE_REX_SERVER.slice(7)}, and autostart is disabled\n` };
    }
    const [verb, sub] = args;

    if (verb === "ls") {
      const sessions = [...this.sessions.values()].map((s) => ({ session_id: s.id, label: s.label }));
      return ok(JSON.stringify({ sessions }));
    }

    if (verb === "api" && sub === "call" && args[2] === "server.status") {
      return ok(JSON.stringify({ api_revision: this.apiRevision, listeners: [{ endpoint: FAKE_REX_SERVER, transport: "unix", primary: true }] }));
    }

    if (verb === "window" && sub === "ls") {
      const target = flag(args, "-s");
      const session = this.sessionOf(target);
      if (!session) return notFound("session", target ?? "");
      return ok(JSON.stringify(this.view(session)));
    }

    if (verb === "client" && sub === "ls") {
      const target = flag(args, "-s");
      const session = this.sessionOf(target);
      if (!session) return notFound("session", target ?? "");
      // Every listing also carries a command-line client, as a live server's does while another `rex`
      // call (the adapter's own `window ls`, a `rex events -s`) is attached to the session.
      const apps = Array.from({ length: session.attached }, (_, i) => ({ client_id: `client:app-${String(i)}`, info: { kind: "app" } }));
      const clients = [...apps, { client_id: "client:cli-0", info: { kind: "cli", name: "rex" } }];
      return ok(JSON.stringify({ clients }));
    }

    if (verb === "block" && sub === "call") {
      const id = flag(args, "-b") ?? "";
      const block = this.blocks.get(id);
      if (!block) return notFound("block", id);
      const method = positionals(args.slice(2), ["-b", "-s", "-w"])[0];
      if (method === "process") {
        return ok(
          JSON.stringify(
            block.exited
              ? { last_exit: { exit_code: 0 }, home: "/home/rex" }
              : {
                  last_exit: null,
                  child: { pid: 4242, name: "zsh", argv0: "-zsh", cwd: block.cwd },
                  foreground: { pid: 4243, name: block.foreground, cwd: block.cwd },
                  home: "/home/rex",
                },
          ),
        );
      }
      if (method === "program_status") {
        const records = block.records.map((r) => ({
          state: r.state,
          app: r.app,
          effective_app: r.app,
          updated_at: "2026-11-19T00:00:00Z",
          owner: r.owner === "shell" ? { pid: 4242, name: "zsh" } : { pid: 4243, name: block.foreground },
        }));
        return ok(JSON.stringify({ records }));
      }
      if (method === "title") return ok(JSON.stringify({ title: block.title, owner: { pid: 4243, name: block.foreground } }));
      if (method === "size") return ok(JSON.stringify({ columns: 80, rows: block.rows, owner: null, desired: [] }));
      if (method === "format") return this.format(block, positionals(args.slice(2), ["-b", "-s", "-w"])[1]);
      if (method === "blob_read") return this.blobRead(positionals(args.slice(2), ["-b", "-s", "-w"])[1]);
      return { code: 1, stdout: "", stderr: `Error: unknown method ${String(method)}\n` };
    }

    if (verb === "capture") {
      const id = flag(args, "-b") ?? "";
      const block = this.blocks.get(id);
      if (!block) return notFound("block", id);
      const vt = args.includes("--format=vt");
      // The CLI prints the output and ends it with one `\n`, also after VT's `\r\n` rows (probed).
      return ok(`${this.render(block, vt)}\n`);
    }

    if (verb === "send") {
      const id = flag(args, "-b") ?? "";
      const failing = this.nextWrite;
      if (failing !== null) {
        this.nextWrite = null;
        if (failing === "stall") return { code: TIMED_OUT_CODE, stdout: "", stderr: timedOutMessage(args, 5000) };
        return { code: 1, stdout: "", stderr: "Error: the server refused the input\n" };
      }
      const block = this.blocks.get(id);
      if (!block) return notFound("block", id);
      // As probed: an exited `--keep-open` block takes the text and delivers nothing.
      if (block.exited) return ok();
      const text = stdin ?? positionals(args.slice(1), ["-b", "-s", "-w"]).join(" ");
      this.recorded.push({ paneId: id, kind: "text", payload: [text] });
      block.screen.push(text);
      return ok();
    }

    if (verb === "send-key") {
      const id = flag(args, "-b") ?? "";
      const failing = this.nextKeys;
      if (failing !== null) {
        this.nextKeys = null;
        if (failing === "stall") return { code: TIMED_OUT_CODE, stdout: "", stderr: timedOutMessage(args, 5000) };
        return { code: 1, stdout: "", stderr: "Error: the server refused the keys\n" };
      }
      const block = this.blocks.get(id);
      if (!block) return notFound("block", id);
      const cut = args.indexOf("--");
      const keys = cut >= 0 ? args.slice(cut + 1) : positionals(args.slice(1), ["-b", "-s", "-w"]);
      // As probed: one key rex has no name for refuses the whole batch, and nothing is sent.
      const unknown = keys.find((key) => /[?!]/u.test(key) || key.trim() === "");
      if (unknown !== undefined) return { code: 2, stdout: "", stderr: `Error: invalid key "${unknown}": unknown key "${unknown}"\n` };
      if (block.exited) return ok();
      this.recorded.push({ paneId: id, kind: "keys", payload: keys });
      return ok();
    }

    if (verb === "block" && sub === "close") {
      const id = positionals(args.slice(2), ["-s", "-w"])[0] ?? "";
      if (!this.blocks.has(id)) return notFound("block", id);
      this.removeBlock(id);
      return ok();
    }

    if (verb === "focus") {
      const id = positionals(args.slice(1), ["-s", "-w"])[0] ?? "";
      const home = this.blockHome(id);
      if (!home) return notFound("block", id);
      home.window.focusedBlockId = id;
      home.session.activeWindowId = home.window.id;
      this.emitSession(home.session.id, "active_window_changed", { window_id: home.window.id });
      return ok();
    }

    if (verb === "window" && sub === "new") {
      const target = flag(args, "-s");
      const session = this.sessionOf(target);
      if (!session) return notFound("session", target ?? "");
      const label = positionals(args.slice(2), ["-s", "-c", "--cwd", "--shell"], "command")[0];
      const windowId = this.mint("window");
      const blockId = this.mint("block");
      this.blocks.set(blockId, this.block(blockId, { cwd: flag(args, "--cwd") ?? "/home/rex" }));
      this.windows.set(windowId, { id: windowId, label: label ?? `Window ${windowId.slice(-8)}`, focusedBlockId: blockId, blockIds: [blockId] });
      session.windowIds.push(windowId);
      if (!args.includes("--focus=false")) session.activeWindowId = windowId;
      this.emitSession(session.id, "window_created", { window_id: windowId });
      return ok(JSON.stringify({ window_id: windowId, block_ids: [blockId], revision: 2 }));
    }

    if (verb === "window" && sub === "rename") {
      const [windowId, label] = positionals(args.slice(2), ["-s"]);
      const window = windowId === undefined ? undefined : this.windows.get(windowId);
      if (!window || label === undefined) return notFound("window", windowId ?? "");
      window.label = label;
      const home = this.windowHome(window.id);
      if (home) this.emitSession(home.id, "window_label_changed", { window_id: window.id, label });
      return ok();
    }

    if (verb === "window" && sub === "close") {
      const [windowId] = positionals(args.slice(2), ["-s"]);
      const session = windowId === undefined ? undefined : this.windowHome(windowId);
      if (!session || windowId === undefined) return notFound("window", windowId ?? "");
      this.removeWindow(session, windowId);
      return ok();
    }

    if (verb === "session" && sub === "rename") {
      const [sessionId, label] = positionals(args.slice(2), []);
      const session = this.sessionOf(sessionId);
      if (!session || label === undefined) return notFound("session", sessionId ?? "");
      session.label = label;
      this.emitSession(session.id, "session_label_changed", { label });
      return ok();
    }

    if (verb === "new") {
      const label = positionals(args.slice(1), ["-c", "--cwd", "--window", "--shell"], "command")[0] ?? "quiet-meadow";
      const sessionId = this.mint("session");
      const windowId = this.mint("window");
      const blockId = this.mint("block");
      this.blocks.set(blockId, this.block(blockId, { cwd: flag(args, "--cwd") ?? "/home/rex" }));
      this.windows.set(windowId, { id: windowId, label: `Window ${windowId.slice(-8)}`, focusedBlockId: blockId, blockIds: [blockId] });
      this.sessions.set(sessionId, { id: sessionId, label, attached: 0, activeWindowId: windowId, windowIds: [windowId] });
      this.emit({ type: "session_created", payload: { session: { session_id: sessionId, label } } });
      return ok(JSON.stringify({ session_id: sessionId, initial_windows: [{ window_id: windowId, block_ids: [blockId], revision: 1 }] }));
    }

    return { code: 2, stdout: "", stderr: `Error: unknown command "${String(verb)}" for "rex"\n` };
  }

  /** `rex window ls --json` for one session, in the server's shape. */
  private view(session: FakeSession): JsonObject {
    return {
      revision: 1,
      session_id: session.id,
      label: session.label,
      active_window_id: session.activeWindowId,
      windows: session.windowIds.flatMap((windowId) => {
        const window = this.windows.get(windowId);
        if (!window) return [];
        return [
          {
            window_id: window.id,
            label: window.label,
            focused_block_id: window.focusedBlockId,
            layers: [
              {
                layer_id: `layer:${window.id.slice(7)}`,
                kind: "tiled",
                bounds: [0, 0, 1, 1],
                blocks: window.blockIds.flatMap((blockId) => {
                  const block = this.blocks.get(blockId);
                  return block ? [{ block_id: block.id, label: block.label, creator_name: REX_TERMINAL_CREATOR, flavor: `${REX_TERMINAL_CREATOR}.shell` }] : [];
                }),
              },
            ],
          },
        ];
      }),
    };
  }

  /**
   * `block call format`: the whole output, or with `max_bytes` its first part, the byte `total`, and
   * an `id` to read the rest with `blob_read`. As on the server, `max_bytes` counts the JSON string.
   */
  private format(block: FakeBlock, raw: string | undefined): RexRunResult {
    const request = requestOf(raw);
    const content = this.render(block, request.format === "vt");
    const limit = request.max_bytes ?? 0;
    if (limit <= 0 || jsonLength(content) <= limit) return ok(JSON.stringify(limit > 0 ? { content, total: byteLength(content) } : { content }));
    this.resultSerial += 1;
    this.results.set(this.resultSerial, content);
    return ok(JSON.stringify({ content: fitJson(content, limit), id: this.resultSerial, total: byteLength(content) }));
  }

  /** `block call blob_read`: bytes from `offset`; a cut through a character reads as U+FFFD, as probed. */
  private blobRead(raw: string | undefined): RexRunResult {
    const request = requestOf(raw);
    const content = this.forgetResults ? undefined : this.results.get(request.id ?? 0);
    if (content === undefined) return { code: 3, stdout: "", stderr: "Error: not_found: the result is no longer kept\n" };
    const rest = Buffer.from(content, "utf8").subarray(request.offset ?? 0).toString("utf8");
    const limit = request.max_bytes ?? 0;
    const data = fitJson(rest, limit > 0 ? limit : 49152);
    return ok(JSON.stringify({ id: request.id, data, total: byteLength(content), eof: data.length === rest.length }));
  }

  events(handlers: RexStreamHandlers): RexStreamClient {
    const listener: FakeListener = { handlers, ended: false };
    this.listeners.add(listener);
    return {
      kill: () => {
        if (listener.ended) return;
        listener.ended = true;
        this.listeners.delete(listener);
        handlers.onExit("closed");
      },
    };
  }

  // ── Conformance perturbations ───────────────────────────────────────────────────────────────────

  async reconnect(): Promise<void> {
    this.connected = false;
    await Promise.resolve();
    this.connected = true;
  }

  /** The server restarts with the same sessions: every record a fresh object, every id kept. */
  async restartMux(): Promise<void> {
    this.sessions = new Map([...this.sessions].map(([id, s]) => [id, { ...s, windowIds: [...s.windowIds] }]));
    this.windows = new Map([...this.windows].map(([id, w]) => [id, { ...w, blockIds: [...w.blockIds] }]));
    this.blocks = new Map(
      [...this.blocks].map(([id, b]) => [id, { ...b, records: b.records.map((r) => ({ ...r })), history: [...b.history], screen: [...b.screen] }]),
    );
    await Promise.resolve();
  }

  /** Someone renames the block in a Rex app. Rex's block label is its own slot, apart from the title. */
  async renameOutOfBand(paneId: string, label: string): Promise<void> {
    const block = this.blocks.get(paneId);
    if (block) block.label = label;
  }

  async setProgramTitle(paneId: string, title: string): Promise<void> {
    const block = this.blocks.get(paneId);
    if (block) block.title = title;
  }

  async changePane(paneId: string): Promise<void> {
    const block = this.blocks.get(paneId);
    if (block) block.screen.push(`paint ${String(block.screen.length)}`);
  }

  /** The block's program ends and rex forgets the block, as it does without `--keep-open`. */
  async endPane(paneId: string): Promise<void> {
    this.removeBlock(paneId);
  }

  /** A window renamed in a Rex app, with no event — what only a census or a refresh can see. */
  async pokeTopologyOutOfBand(): Promise<void> {
    const window = [...this.windows.values()][0];
    if (window) window.label = "renamed-silently";
  }

  pokeTopology(): void {
    const session = [...this.sessions.values()][0];
    const window = session ? this.windows.get(session.windowIds[0] ?? "") : undefined;
    if (session && window) this.emitSession(session.id, "window_label_changed", { window_id: window.id, label: window.label });
  }

  pokePane(paneId: string): void {
    const home = this.blockHome(paneId);
    const block = this.blocks.get(paneId);
    if (home && block) {
      const record = block.records[0];
      this.emitBlock(home.session.id, paneId, "program_status_changed", record ? { state: record.state, app: record.app } : { state: "idle" });
    }
  }

  /** The operator clicks a block in a Rex app: its window becomes active and the block focused. */
  async focusOutOfBand(paneId: string): Promise<void> {
    const home = this.blockHome(paneId);
    if (!home) return;
    home.window.focusedBlockId = paneId;
    home.session.activeWindowId = home.window.id;
  }
}

export function rexWorld(fake: FakeRex): MuxConformanceWorld {
  const adapter = new RexMux(fake);
  return {
    adapter,
    writes: () => fake.writes(),
    failNextWrite: (how) => {
      if (how === "stall" || how === "refuse") fake.nextWrite = how;
    },
    failNextKeys: (how) => {
      if (how === "stall" || how === "refuse") fake.nextKeys = how;
    },
    reconnect: () => fake.reconnect(),
    restartMux: () => fake.restartMux(),
    renameOutOfBand: (paneId, label) => fake.renameOutOfBand(paneId, label),
    setProgramTitle: (paneId, title) => fake.setProgramTitle(paneId, title),
    changePane: (paneId) => fake.changePane(paneId),
    endPane: (paneId) => fake.endPane(paneId),
    pokeTopologyOutOfBand: () => fake.pokeTopologyOutOfBand(),
    pokeTopology: () => fake.pokeTopology(),
    pokePane: (paneId) => fake.pokePane(paneId),
    focusOutOfBand: (paneId) => fake.focusOutOfBand(paneId),
    close: () => Promise.resolve(),
  };
}

export const rexConformanceFixture: MuxConformanceFixture = {
  mux: "rex",
  create(): Promise<MuxConformanceWorld> {
    return Promise.resolve(rexWorld(new FakeRex()));
  },
};
