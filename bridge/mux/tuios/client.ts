import type { JsonObject, JsonValue } from "../../json.ts";
import { dialHerdr, type SockHandle } from "../../dial.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The tuios daemon's JSON verb socket — the TRANSPORT. This is the only file that knows tuios's
// verb names and wire shapes; `adapter.ts` next to it is the only file that knows these typed
// methods, and everything above that talks the mux port (bridge/mux/types.ts). The protocol is
// tuios's own `docs/protocol.md`.
//
// Three wire facts shape this file, each probed against a tuios daemon built from main on
// 2026-09-30 (MUX_CONTRACT.md, source **TU**):
//
//  • **Newline JSON, many requests per connection** — but this client still opens one connection
//    per request, as the Herdr client does. The daemon answers requests on one connection strictly
//    in order, so a shared connection would serialise the snapshot's parallel reads; a Unix socket
//    connect costs nothing next to that.
//  • **Every verb that names a session takes its NAME**, and an omitted session means "the most
//    recently active one". So this client never omits it: a pane-addressed call always names the
//    session the adapter found the pane in, and a guess by the daemon never decides which pane a
//    phone tap lands on.
//  • **Unknown params are refused** (`invalid_params: verb X has no parameter Y`), so a params
//    object here carries exactly the documented fields and nothing speculative.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-request wall-clock budget, when the target names none. */
export const DEFAULT_TUIOS_TIMEOUT_MS = 5000;

/**
 * The protocol integer this client speaks, sent in `hello`. The daemon answers `protocol_mismatch`
 * when it is outside the range the daemon serves.
 */
export const TUIOS_PROTOCOL = 1;

/**
 * The newest thing this adapter needs from a protocol-1 daemon: the `workspace-renamed` event.
 * New verbs and fields do not bump the protocol integer (docs/protocol.md § Versioning), so a
 * daemon that speaks protocol 1 can still be too old. The event list `list-verbs` reports for
 * `subscribe` is how the adapter tells.
 */
export const TUIOS_REQUIRED_EVENT = "workspace-renamed";

/** What `hello` says about the daemon. */
export interface WireHello {
  readonly protocol: number;
  readonly minProtocol: number;
  readonly version: string;
  /** Changes when the daemon restarts. */
  readonly instance: string;
}

/** A session, as `list-sessions` reports it. `id` is re-minted when the daemon restarts (probed). */
export interface WireSession {
  readonly name: string;
  readonly id: string;
  readonly attached: boolean;
  /** Unix seconds. */
  readonly lastActive: number;
  readonly currentWorkspace: number;
  /** Every window of the session, by id — enough to find which session a pane lives in. */
  readonly windowIds: readonly string[];
}

/** A window, as `list-windows` reports it. */
export interface WireWindow {
  readonly windowId: string;
  /** What the shell last set with an OSC title. */
  readonly title: string;
  /** The name a person gave the window (`set-window`, the TUI's rename). Empty when unset. */
  readonly customName: string;
  readonly workspace: number;
  readonly focused: boolean;
  readonly height: number;
  /** Scrollback lines above the screen. */
  readonly historyRows: number;
  /** Absent until the shell has reported one. */
  readonly cwd: string;
  /** Set when the window's process runs on another machine. Empty for this one. */
  readonly host: string;
}

/** `list-windows` for one session. */
export interface WireWindowList {
  readonly currentWorkspace: number;
  readonly focusedWindowId: string;
  readonly windows: readonly WireWindow[];
}

/** A workspace, as `list-workspaces` reports it. All of them are listed, empty ones included. */
export interface WireWorkspace {
  readonly workspace: number;
  readonly name: string;
  readonly windowCount: number;
  readonly current: boolean;
}

/** An agent pane, as `list-agents` reports it. */
export interface WireAgent {
  readonly session: string;
  readonly windowId: string;
  /** `none`, `idle`, `working`, `needs_input` or `done`. */
  readonly state: string;
  /** The tuios harness manifest id (`claude-code`, `codex`, …). Kept after the agent exits. */
  readonly harnessId: string;
  /** The harness's own conversation id. Kept after the agent exits. */
  readonly agentSessionId: string;
}

/** What `new-window` hands back. */
export interface WireCreatedWindow {
  readonly windowId: string;
  readonly workspace: number;
}

/** What `new-session` hands back. */
export interface WireCreatedSession {
  readonly session: string;
  readonly sessionId: string;
  readonly windowId: string;
}

/** One line of the event stream, read for the fields the watch dispatches on and no others. */
export interface WireEvent {
  readonly seq: number;
  readonly bootId: string;
  readonly type: string;
  readonly window: string;
}

/** Where a resumed stream picks up: the last event read, and the daemon start it came from. */
export interface StreamResume {
  readonly seq: number;
  readonly bootId: string;
}

/** What {@link TuiosClient.subscribe} is asked for. */
export interface SubscribeOptions {
  readonly types: readonly string[];
  readonly resume: StreamResume | null;
  onUp(ack: StreamResume): void;
  onEvent(event: WireEvent): void;
  onDown(reason: string): void;
}

/** The handle {@link TuiosClient.subscribe} hands back. `close()` is idempotent. */
export interface EventStream {
  close(): void;
}

/** What `capture-pane` hands back. */
export interface WireCapture {
  readonly content: string;
  /** Grows each time the pane's content can change. Counts from 0 again when the daemon restarts. */
  readonly revision: number;
  /** Names the daemon start the revision counts in. */
  readonly bootId: string;
}

/** What a read asks `capture-pane` for. */
export interface CaptureRequest {
  readonly source: "visible" | "recent";
  readonly styled: boolean;
  readonly lines: number;
}

/**
 * The daemon said no, with one of its stable error codes (docs/protocol.md § Error codes).
 *
 * A transport failure is a plain `Error`; this subclass is the daemon's own answer, so the adapter
 * can tell "tuios understood and refused" from "tuios did not answer" without parsing prose.
 */
export class TuiosError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TuiosError";
  }
}

/**
 * The daemon socket a tuios client would dial, when the operator named none.
 *
 * tuios's own rule (internal/session/manager_unix.go, docs/SESSIONS.md § Where State Lives):
 * `$XDG_RUNTIME_DIR/tuios/tuios.sock`, and `/tmp/tuios-<uid>/tuios.sock` without a runtime dir.
 * `TUIOS_SOCKET` is deliberately NOT read: tuios sets it inside its own panes to the daemon that
 * runs them and says in its docs that it does not choose a daemon.
 */
export function defaultTuiosSocket(runtimeDir: string | undefined, uid: number): string {
  const runtime = (runtimeDir ?? "").trim();
  return runtime.length > 0 ? `${runtime}/tuios/tuios.sock` : `/tmp/tuios-${String(uid)}/tuios.sock`;
}

// ── Field readers — the parse. Every `typeof` in this file sits in one of these. ──

function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function str(record: JsonObject, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record: JsonObject, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bool(record: JsonObject, key: string): boolean {
  return record[key] === true;
}

function parseSession(raw: JsonValue): WireSession {
  const record = asObject(raw);
  return {
    name: str(record, "name"),
    id: str(record, "id"),
    attached: bool(record, "attached"),
    lastActive: num(record, "last_active"),
    currentWorkspace: num(record, "current_workspace"),
    windowIds: asArray(record.windows).map((window) => str(asObject(window), "id")).filter((id) => id !== ""),
  };
}

function parseWindow(raw: JsonValue): WireWindow {
  const record = asObject(raw);
  return {
    windowId: str(record, "window_id"),
    title: str(record, "title"),
    customName: str(record, "custom_name"),
    workspace: num(record, "workspace"),
    focused: bool(record, "focused"),
    height: num(record, "height"),
    historyRows: num(record, "history_rows"),
    cwd: str(record, "cwd"),
    host: str(record, "host"),
  };
}

function parseWorkspace(raw: JsonValue): WireWorkspace {
  const record = asObject(raw);
  return {
    workspace: num(record, "workspace"),
    name: str(record, "name"),
    windowCount: num(record, "window_count"),
    current: bool(record, "current"),
  };
}

function parseAgent(raw: JsonValue): WireAgent {
  const record = asObject(raw);
  return {
    session: str(record, "session"),
    windowId: str(record, "window_id"),
    state: str(record, "state"),
    harnessId: str(record, "harness_id"),
    agentSessionId: str(record, "agent_session_id"),
  };
}

/** One reply line → its `result`, or a {@link TuiosError} for its `error`. */
function decodeReply(line: string, verb: string): JsonObject {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`tuios ${verb}: the reply was not JSON`);
  }
  const envelope = asObject(parsed);
  if (envelope.error !== undefined) {
    const error = asObject(envelope.error);
    const code = str(error, "code") || "unknown";
    throw new TuiosError(code, `tuios ${verb}: ${code}: ${str(error, "message")}`);
  }
  if (envelope.result === undefined) throw new Error(`tuios ${verb}: the reply carried no result`);
  return asObject(envelope.result);
}

let idCounter = 0;

/**
 * The verbs the adapter next door actually calls — the shape it depends on, rather than this class.
 *
 * A `Pick` of {@link TuiosClient}, so it cannot drift from the real transport, and the shape the
 * conformance fixture fakes (MUX_CONTRIBUTING.md § Your deliverable).
 */
export type TuiosRpc = Pick<
  TuiosClient,
  | "hello"
  | "subscribeTypes"
  | "listSessions"
  | "listWindows"
  | "listWorkspaces"
  | "listAgents"
  | "capturePane"
  | "sendText"
  | "sendKeys"
  | "renameWindow"
  | "closeWindow"
  | "focusWindow"
  | "newWindow"
  | "nameWorkspace"
  | "newSession"
  | "subscribe"
>;

export class TuiosClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = DEFAULT_TUIOS_TIMEOUT_MS,
  ) {}

  /** One request, one reply line. Rejects on an error reply, a timeout or an early close. */
  private request(verb: string, params: JsonObject = {}): Promise<JsonObject> {
    const id = `c${String(++idCounter)}`;
    return new Promise<JsonObject>((resolve, reject) => {
      let buf = "";
      let settled = false;
      let socket: SockHandle | null = null;
      let cancelDial: (() => void) | null = null;
      const decoder = new TextDecoder("utf-8");
      // Settle BEFORE closing: end() fires `close` synchronously, which re-enters here as a no-op.
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
        try {
          if (socket) socket.end();
          else cancelDial?.();
        } catch {
          /* already closed */
        }
        socket = null;
        cancelDial = null;
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`tuios ${verb}: timed out after ${String(this.timeoutMs)}ms`))),
        this.timeoutMs,
      );
      // `bun`, never `auto`: `auto` maps a path to a Windows named pipe, which is Herdr's transport
      // on that platform and not tuios's.
      const dialed = dialHerdr(
        this.socketPath,
        {
          onDial(cancel) {
            cancelDial = cancel;
          },
          open(s) {
            socket = s;
          },
          data(s, chunk) {
            socket = s;
            buf += decoder.decode(chunk, { stream: true });
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            const line = buf.slice(0, nl);
            finish(() => {
              try {
                resolve(decodeReply(line, verb));
              } catch (err) {
                reject(err);
              }
            });
          },
          error(_s, err) {
            finish(() => reject(err));
          },
          close() {
            finish(() => reject(new Error(`tuios ${verb}: connection closed before reply`)));
          },
        },
        "bun",
      );
      void (async () => {
        try {
          const s = await dialed;
          if (settled) {
            s.end();
            return;
          }
          socket = s;
          s.write(JSON.stringify({ id, verb, params }) + "\n");
          s.flush();
        } catch (err) {
          finish(() => reject(err));
        }
      })();
    });
  }

  /**
   * The handshake, pinned to {@link TUIOS_PROTOCOL}. A daemon outside that range rejects with
   * `protocol_mismatch`, and a daemon older than the handshake with `unknown_verb`.
   */
  async hello(): Promise<WireHello> {
    const result = await this.request("hello", { client: "collie", protocol: TUIOS_PROTOCOL });
    return {
      protocol: num(result, "protocol"),
      minProtocol: num(result, "min_protocol"),
      version: str(result, "daemon_version"),
      instance: str(result, "instance"),
    };
  }

  /** The event types `subscribe` accepts, as `list-verbs` reports them. */
  async subscribeTypes(): Promise<string[]> {
    const result = await this.request("list-verbs", { verb: "subscribe" });
    const verb = asArray(result.verbs).map(asObject).find((entry) => str(entry, "verb") === "subscribe");
    const types = asArray(verb?.params).map(asObject).find((param) => str(param, "name") === "types");
    return asArray(types?.accepted).filter((value): value is string => typeof value === "string");
  }

  async listSessions(): Promise<WireSession[]> {
    const result = await this.request("list-sessions");
    return asArray(result.sessions).map(parseSession);
  }

  async listWindows(session: string): Promise<WireWindowList> {
    const result = await this.request("list-windows", { session });
    return {
      currentWorkspace: num(result, "current_workspace"),
      focusedWindowId: str(result, "focused_window_id"),
      windows: asArray(result.windows).map(parseWindow),
    };
  }

  async listWorkspaces(session: string): Promise<WireWorkspace[]> {
    const result = await this.request("list-workspaces", { session });
    return asArray(result.workspaces).map(parseWorkspace);
  }

  /**
   * Every pane something identified as an agent, over every session.
   *
   * `all_sessions` and no `all`: a pane that is not and never was an agent has nothing to say here,
   * and the ones that were keep their harness and session id after the agent exits (probed), which
   * is what a pane's leftover history is read from.
   */
  async listAgents(): Promise<WireAgent[]> {
    const result = await this.request("list-agents", { all_sessions: true });
    return asArray(result.agents).map(parseAgent);
  }

  async capturePane(session: string, window: string, request: CaptureRequest): Promise<WireCapture> {
    const result = await this.request("capture-pane", {
      session,
      window,
      source: request.source,
      styled: request.styled,
      lines: request.lines,
    });
    return { content: str(result, "content"), revision: num(result, "revision"), bootId: str(result, "boot_id") };
  }

  /** Literal text, written to the PTY verbatim. */
  async sendText(session: string, window: string, text: string): Promise<void> {
    await this.request("send-text", { session, window, text });
  }

  /** Keys in tuios's own grammar, space-separated. The daemon parses every token before sending. */
  async sendKeys(session: string, window: string, keys: string): Promise<void> {
    await this.request("send-keys", { session, window, keys });
  }

  /** Name a window, or clear its name with `""` so it falls back to the shell's title. */
  async renameWindow(session: string, window: string, name: string): Promise<void> {
    await this.request("set-window", { session, window, name });
  }

  async closeWindow(session: string, window: string): Promise<void> {
    await this.request("close-window", { session, window });
  }

  /** Focus a window, and show its workspace, in one call. */
  async focusWindow(session: string, window: string): Promise<void> {
    await this.request("focus-window", { session, window });
  }

  /**
   * A new shell window on a workspace, leaving the focus where it is (`focus: false`), so nothing
   * the person is looking at moves.
   */
  async newWindow(session: string, workspace: number, cwd: string | undefined): Promise<WireCreatedWindow> {
    const params: JsonObject = { session, workspace, focus: false };
    if (cwd !== undefined) params.cwd = cwd;
    const result = await this.request("new-window", params);
    return { windowId: str(result, "window_id"), workspace: num(result, "workspace") };
  }

  /** Name a workspace, or clear the name with `""` so it shows its number. */
  async nameWorkspace(session: string, workspace: number, name: string): Promise<void> {
    await this.request("set-workspace-name", { session, workspace, name });
  }

  /** A detached session with one shell window. A name the daemon holds is `session_exists`. */
  async newSession(name: string | undefined, cwd: string | undefined): Promise<WireCreatedSession> {
    const params: JsonObject = {};
    if (name !== undefined) params.name = name;
    if (cwd !== undefined) params.cwd = cwd;
    const result = await this.request("new-session", params);
    return {
      session: str(result, "session"),
      sessionId: str(result, "session_id"),
      windowId: str(result, "window_id"),
    };
  }

  /**
   * Open a LONG-LIVED `subscribe` stream over every session.
   *
   * After the ack each line is an event. With `resume` the daemon first replays the events after
   * that seq from its ring, or sends a `gap` marker when it cannot (docs/protocol.md § Resuming a
   * stream). `onDown` fires exactly once, for any reason; `close()` is idempotent.
   */
  subscribe(opts: SubscribeOptions): EventStream {
    const id = `s${String(++idCounter)}`;
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let socket: SockHandle | null = null;
    let cancelDial: (() => void) | null = null;
    let down = false;
    let acked = false;

    const fireDown = (reason: string) => {
      if (down) return;
      down = true;
      clearTimeout(ackTimer);
      try {
        if (socket) socket.end();
        else cancelDial?.();
      } catch {
        /* already closed */
      }
      socket = null;
      cancelDial = null;
      opts.onDown(reason);
    };

    // A daemon that takes the connection and never acks counts as down, not healthy.
    const ackTimer = setTimeout(() => fireDown("ack timeout"), this.timeoutMs);

    const handleLine = (line: string) => {
      if (line.trim() === "") return;
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(line);
      } catch {
        fireDown("protocol error: an event line was not JSON");
        return;
      }
      const record = asObject(parsed);
      if (!acked) {
        if (record.error !== undefined) {
          const error = asObject(record.error);
          fireDown(`${str(error, "code")}: ${str(error, "message")}`);
          return;
        }
        const result = asObject(record.result);
        acked = true;
        clearTimeout(ackTimer);
        opts.onUp({ seq: num(result, "seq"), bootId: str(result, "boot_id") });
        return;
      }
      opts.onEvent({
        seq: num(record, "seq"),
        bootId: str(record, "boot_id"),
        type: str(record, "type"),
        window: str(record, "window"),
      });
    };

    const dialed = dialHerdr(
      this.socketPath,
      {
        onDial(cancel) {
          cancelDial = cancel;
        },
        open(s) {
          socket = s;
        },
        data(s, chunk) {
          socket = s;
          buf += decoder.decode(chunk, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            if (down) break;
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            handleLine(line);
            nl = buf.indexOf("\n");
          }
        },
        error(_s, err) {
          fireDown(err.message || "socket error");
        },
        close() {
          fireDown("connection closed");
        },
      },
      "bun",
    );

    void (async () => {
      try {
        const s = await dialed;
        if (down) {
          s.end();
          return;
        }
        socket = s;
        const params: JsonObject = { types: [...opts.types] };
        if (opts.resume !== null) {
          params.after_seq = opts.resume.seq;
          params.boot_id = opts.resume.bootId;
        }
        s.write(JSON.stringify({ id, verb: "subscribe", params }) + "\n");
        s.flush();
      } catch (err) {
        fireDown((err instanceof Error ? err.message : String(err)) || "connect failed");
      }
    })();

    return { close: () => fireDown("closed") };
  }
}
