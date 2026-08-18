import type { JsonObject, JsonValue } from "../json.ts";
import { unlinkSync } from "node:fs";

// A stand-in Herdr control socket, for the two-instance harness (`harness.test.ts`).
//
// NOT a production module and not imported by one. It exists because the harness's subject is the
// PACK transport — two real Collie processes, real pinned TLS, real HTTP — and standing up a real
// Herdr to get there would make the test depend on a second project's build and on a machine that
// has one. What a Collie needs from Herdr to serve a snapshot and a pane read is small and stable
// enough (`HERDR_API.md`) to answer honestly here.
//
// It implements the protocol's two shapes exactly as `bridge/herdr-client.ts` expects them:
//   • RPC is ONE-SHOT — read one line, write one reply, close the connection;
//   • `events.subscribe` is the exception: ack, then hold the connection open forever.
// Getting either wrong would make the harness fail for a reason that has nothing to do with a pack.

export interface FakePane {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly label: string;
  /** What `pane.read` returns for this pane. The harness asserts byte-fidelity across the hop. */
  readonly text: string;
}

export interface FakeHerdrOptions {
  readonly socketPath: string;
  readonly workspaceLabel: string;
  readonly panes: readonly FakePane[];
}

export interface FakeHerdr {
  /** Every `pane.send_text` / `pane.send_keys` this fake received — the harness's write evidence. */
  readonly writes: PaneWrite[];
  /** Every method name served, in order. Counting these is how the harness measures poll cadence. */
  readonly calls: string[];
  stop(): void;
}

const AGENT_STATUS = { state: "idle", label: "idle" };

/** One `pane.send_text` / `pane.send_keys` / `pane.rename` the fake received — the write evidence. */
export type PaneWrite = { method: string; params: JsonObject };

/** One request line off the socket, before any of its fields are believed. */
type RpcRequest = { id?: string; method?: string; params?: JsonObject };

/** The slice of Bun's socket `handle` uses — named so the fake states its own contract. */
type FakeSocket = { write(s: string): void; end(): void };

/** Start the fake on `socketPath`. Unlinks a stale socket first, as a real daemon would. */
export function startFakeHerdr(opts: FakeHerdrOptions): FakeHerdr {
  try {
    unlinkSync(opts.socketPath);
  } catch {
    // No stale socket — the normal case.
  }
  const writes: PaneWrite[] = [];
  const calls: string[] = [];

  const snapshot = () => ({
    version: "0.7.5",
    protocol: 1,
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: opts.workspaceLabel,
        focused: true,
        pane_count: opts.panes.length,
        tab_count: 1,
        active_tab_id: "t1",
        agent_status: AGENT_STATUS,
      },
    ],
    tabs: [
      {
        tab_id: "t1",
        workspace_id: "w1",
        number: 1,
        label: "tab",
        focused: true,
        pane_count: opts.panes.length,
        agent_status: AGENT_STATUS,
      },
    ],
    panes: opts.panes.map((p, i) => ({
      pane_id: p.paneId,
      terminal_id: `term-${p.paneId}`,
      workspace_id: p.workspaceId,
      tab_id: p.tabId,
      focused: i === 0,
      cwd: "/tmp",
      agent: "claude",
      agent_status: AGENT_STATUS,
      label: p.label,
      revision: 1,
    })),
  });

  const answer = (method: string, params: JsonObject): JsonValue => {
    if (method === "session.snapshot") return { type: "snapshot", snapshot: snapshot() };
    if (method === "workspace.list") return { workspaces: snapshot().workspaces };
    if (method === "tab.list") return { tabs: snapshot().tabs };
    if (method === "pane.list") return { panes: snapshot().panes };
    if (method === "pane.read") {
      const paneId = String(params.pane_id ?? "");
      const pane = opts.panes.find((p) => p.paneId === paneId);
      if (pane === undefined) return null;
      return { read: { pane_id: paneId, text: pane.text, truncated: false, revision: 1 } };
    }
    if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.rename") {
      writes.push({ method, params });
      return {};
    }
    return null;
  };

  const server = Bun.listen<{ buf: string }>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = { buf: "" };
      },
      data(socket, chunk) {
        socket.data.buf += chunk.toString();
        let nl = socket.data.buf.indexOf("\n");
        while (nl >= 0) {
          const line = socket.data.buf.slice(0, nl);
          socket.data.buf = socket.data.buf.slice(nl + 1);
          handle(socket, line);
          nl = socket.data.buf.indexOf("\n");
        }
      },
    },
  });

  function handle(socket: FakeSocket, line: string): void {
    let msg: RpcRequest;
    try {
      // SAFETY: the harness speaks the same newline-delimited JSON-RPC the real daemon does; every
      // field below is read with a `??` default, so a line of another shape answers rather than throws.
      msg = JSON.parse(line) as RpcRequest;
    } catch {
      socket.end();
      return;
    }
    const id = msg.id ?? "0";
    if (msg.method === "events.subscribe") {
      // The ONE long-lived connection. Acked and then held open with nothing on it: the harness
      // drives freshness through the poll, and an event stream that pushed would make the timing of
      // every later assertion depend on this fake rather than on the code under test.
      socket.write(`${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`);
      return;
    }
    calls.push(msg.method ?? "");
    const result = answer(msg.method ?? "", msg.params ?? {});
    const reply =
      result === null
        ? { id, error: { code: "unknown_method", message: `no such method: ${msg.method}` } }
        : { id, result };
    socket.write(`${JSON.stringify(reply)}\n`);
    // One-shot: the real server closes after a single reply, and code that accidentally relies on a
    // reusable connection must fail here rather than in production.
    socket.end();
  }

  return {
    writes,
    calls,
    stop() {
      server.stop(true);
      try {
        unlinkSync(opts.socketPath);
      } catch {
        // Already gone.
      }
    },
  };
}
