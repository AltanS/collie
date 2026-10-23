// An in-memory World for the tests of the durable-harness entry (M66 spec 03): the four calls `world-port.ts` makes
// (`runs.list`, `runs.get`, `streams.write`, `streams.getChunks`) and a session reader, with the faults a real World
// has: a write that becomes visible to readers only later (staleness), a list that answers short pages, and an outage.
// The port under test is the real `createWorldPort`; only the World under it is fake.
import { createWorldPort, type SessionView, type World, type WorldPort, type WorldPortOptions } from "../../../packages/durable-sdk/src/durable-harness/world-port.ts";

/** A run as the fake World keeps it. */
export interface FakeRun {
  runId: string;
  status: string;
  workflowName: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface FakeWorldOptions {
  /** A written chunk is invisible to `getChunks` for this long. Default 0. */
  lagMs?: number;
  /** `runs.list` answers at most this many runs per page, whatever the caller asked. Default: as asked. */
  pageCap?: number;
  /** `getChunks` answers at most this many chunks per page. Default: as asked. */
  chunkCap?: number;
  /** The World's spec version. Default 8. */
  specVersion?: number;
  /** The clock. Default `Date.now`. */
  now?: () => number;
}

const enc = new TextEncoder();
export const workflowNameOf = (name = "pi-durable", version = "0.0.1-beta.6") => `workflow//durable-harness@${version}//${name}`;

export class FakeWorld {
  readonly runs = new Map<string, FakeRun>();
  readonly sessions = new Map<string, SessionView>();
  readonly chunks = new Map<string, { at: number; data: Uint8Array }[]>();
  /** Every call the port made, by name. A 401 must leave this empty. */
  readonly calls: string[] = [];
  /** True: every call throws, as an unreachable World does. */
  down = false;
  readonly o: FakeWorldOptions;
  private seq = 0;
  constructor(o: FakeWorldOptions = {}) {
    this.o = o;
  }
  private now() {
    return (this.o.now ?? Date.now)();
  }
  private touch(name: string) {
    this.calls.push(name);
    if (this.down) throw new Error("fake World: unreachable");
  }

  /** Add a run, and its session (empty unless given). Returns the run id. */
  addRun(o: { name?: string; status?: string; session?: Partial<SessionView>; createdAt?: Date; version?: string } = {}): string {
    const runId = `wrun_01FAKE${String(++this.seq).padStart(20, "0")}`;
    const createdAt = o.createdAt ?? new Date(Date.UTC(2026, 9, 21, 12, 0, this.seq));
    this.runs.set(runId, { runId, status: o.status ?? "running", workflowName: workflowNameOf(o.name, o.version), createdAt, updatedAt: createdAt });
    this.sessions.set(runId, { sessionId: runId, eventCount: 0, unfinished: false, entries: [], live: {}, tasks: [], ...o.session });
    return runId;
  }

  /** Change a session in place. */
  setSession(runId: string, change: Partial<SessionView>) {
    this.sessions.set(runId, { ...this.sessions.get(runId)!, ...change });
  }

  /** Write raw text to a stream, for a test of the line rule. */
  writeRaw(runId: string, text: string) {
    const key = `${runId}/${runId}_collie`;
    const list = this.chunks.get(key) ?? [];
    list.push({ at: this.now(), data: enc.encode(text) });
    this.chunks.set(key, list);
  }

  /** The World object the port is given. Only what world-port.ts calls. */
  world(): World {
    const self = this;
    const fake = {
      specVersion: this.o.specVersion ?? 8,
      runs: {
        async list(params: { pagination?: { limit?: number; cursor?: string } }) {
          self.touch("runs.list");
          const all = [...self.runs.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          const from = params.pagination?.cursor === undefined ? 0 : Number(params.pagination.cursor);
          const limit = Math.min(params.pagination?.limit ?? 20, self.o.pageCap ?? Infinity);
          const data = all.slice(from, from + limit);
          const end = from + data.length;
          return { data, cursor: end < all.length ? String(end) : null, hasMore: end < all.length };
        },
        async get(id: string) {
          self.touch("runs.get");
          const run = self.runs.get(id);
          if (run === undefined) {
            const e = new Error(`Workflow run "${id}" not found`);
            e.name = "WorkflowRunNotFoundError";
            throw e;
          }
          return run;
        },
      },
      streams: {
        async write(runId: string, name: string, chunk: string | Uint8Array) {
          self.touch("streams.write");
          const key = `${runId}/${name}`;
          const list = self.chunks.get(key) ?? [];
          list.push({ at: self.now(), data: typeof chunk === "string" ? enc.encode(chunk) : chunk });
          self.chunks.set(key, list);
        },
        async getChunks(runId: string, name: string, o: { limit?: number; cursor?: string } = {}) {
          self.touch("streams.getChunks");
          const visible = (self.chunks.get(`${runId}/${name}`) ?? []).filter((c) => self.now() - c.at >= (self.o.lagMs ?? 0));
          const from = o.cursor === undefined ? 0 : Number(o.cursor);
          const limit = Math.min(o.limit ?? 100, self.o.chunkCap ?? Infinity);
          const page = visible.slice(from, from + limit);
          const end = from + page.length;
          return { data: page.map((c, i) => ({ index: from + i, data: c.data })), cursor: end < visible.length ? String(end) : null, hasMore: end < visible.length, done: false };
        },
      },
    };
    // SAFETY: the port calls these four methods and reads `specVersion`, and nothing else of the World.
    return fake as unknown as World;
  }

  /** The real port over this World, with a reader that reads the fake sessions. */
  port(o: Omit<WorldPortOptions, "world" | "reader"> = {}): WorldPort {
    return createWorldPort({
      identity: "fake-world",
      ...o,
      world: this.world(),
      reader: (id) => ({
        sessionId: id,
        refresh: async () => {
          this.touch("reader.refresh");
          return true;
        },
        snapshot: async () => {
          const s = this.sessions.get(id) ?? { sessionId: id, eventCount: 0, unfinished: false, entries: [], live: {}, tasks: [] };
          // SAFETY: the port reads the fields of SessionView and nothing else of a reader's snapshot.
          return structuredClone(s) as never;
        },
      }),
    });
  }
}

// ── sessions as the reader shows them ────────────────────────────────────────────────────────────────────────────────

let clock = Date.UTC(2026, 9, 21, 12, 0, 0);
const tick = () => (clock += 1000);

/** A user entry, as Pi commits it. */
export function userEntry(slot: number, text: string) {
  const at = tick();
  return { id: String(slot), kind: "pi.user", model: [{ role: "user", content: text, timestamp: at }], at: new Date(at).toISOString(), slot };
}

/** A finished assistant entry: text, and optionally one tool call. */
export function assistantEntry(slot: number, text: string, tool?: { id: string; name: string; args: object }) {
  const at = tick();
  const content: object[] = [{ type: "text", text }];
  if (tool !== undefined) content.push({ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args });
  return { id: String(slot), kind: "pi.assistant", model: [{ role: "assistant", content, timestamp: at, stopReason: tool === undefined ? "stop" : "toolUse" }], at: new Date(at).toISOString(), slot };
}

/** A tool result entry. */
export function toolResultEntry(slot: number, callId: string, name: string, text: string) {
  const at = tick();
  return { id: String(slot), kind: "pi.toolResult", model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: at }], at: new Date(at).toISOString(), slot };
}

/** Pi's live partial: an assistant message part way written. */
export function livePartial(text: string) {
  return { run: { id: "r" }, generation: { message: { role: "assistant", content: [{ type: "text", text }], timestamp: tick() } } };
}

/** A generation task started at `slot`, live or ended. */
export function task(id: string, slot: number, status = "running") {
  return { id, kind: "pi.generation", status, starts: [{ slot, at: new Date(clock).toISOString() }] };
}

/** A session of `n` entries: user, assistant, user, assistant, ... */
export function longSession(n: number): Pick<SessionView, "entries" | "eventCount"> {
  const entries = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? userEntry(i * 2 + 1, `message ${i} ${"word ".repeat(20)}`) : assistantEntry(i * 2 + 1, `reply ${i} ${"text ".repeat(60)}`)));
  return { entries, eventCount: n * 2 + 1 };
}
