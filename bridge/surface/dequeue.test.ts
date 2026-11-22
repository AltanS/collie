// Take a waiting queue back (ADR 0122, the 2026-11-22 addendum): `POST /api/pane/:id/dequeue`. A scripted
// Claude Code pane shows the lab captures of a running turn (2.1.319, 174 columns) with its box row drawn
// from what the agent holds, keeps the agent's queue and its prompt history, and writes the journal rows
// Claude Code writes (`queue-operation`); the real Claude Code reducer reads them, so the proof runs on the
// reducer's own queue mark. Up with an empty box puts the whole queue into the box and writes `popAll`;
// Up with an empty box and an empty queue recalls the last prompt from history. Covered: each outcome,
// each refusal before the key (no key pressed), the replay rule, the history trap, the route's audit line,
// and that no queued text reaches a log line, the audit line, the protocol's row ring or a file.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import type { JsonValue } from "../json.ts";
import { createClaudeReducer } from "../journal/claude.ts";
import type { RowReducer } from "../journal/reduce.ts";
import { crewRouteFor } from "../crew/forward.ts";
import { muxAck, muxOk, muxRefused, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { dequeueRoute, type DequeueRouteRuntime } from "../server.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { DequeueReason, DequeueReceipt } from "../../web/src/lib/surface/dequeue.ts";
import { DequeueService, PROOF_GAPS_MS, proofOf, type DequeueAsk } from "./dequeue.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const RUNNING = readFileSync(join(FIXTURES, "claude--v2319-stop-returns-running--w174.txt"), "utf8").split("\r\n");
const IDLE = readFileSync(join(FIXTURES, "claude--v2319-stop-returns-idle--w174.txt"), "utf8").split("\r\n");
const DIALOG = readFileSync(join(PANES, "claude-lab--ask-single-v2296--w82.txt"), "utf8");
const CLAUDE = loadProfiles().get("claude")!;
const ESC = String.fromCodePoint(0x1b);
const plain = (row: string): string => row.replace(new RegExp(`${ESC}\\[[0-9;:]*m`, "gu"), "");
const boxRowOf = (rows: readonly string[]): number => rows.findLastIndex((row) => plain(row).startsWith("❯"));

const queueOp = (operation: string, content?: string): string =>
  JSON.stringify({ type: "queue-operation", operation, timestamp: "2026-11-22T10:00:00.000Z", sessionId: "s-1", content } satisfies Record<string, JsonValue | undefined>);

const FIRST = "and run the tests after that";
const SECOND = "then write the changelog line";

/** Claude Code as the take-back meets it: a running turn, its queue, its history, its box and its journal. */
class ClaudePane {
  running = true;
  dialog = false;
  box = "";
  queue: string[] = [];
  history: string[] = [];
  journal: string[] = [];
  keysSeen: string[][] = [];
  /** The turn ends between the take-back's read and its key: the queue goes out as the next prompt. */
  turnEndsAtKey = false;
  /** Up writes `popAll` with the queue's text (true), without content (null), or no row at all (false). */
  popAllRow: "content" | "bare" | "none" = "content";
  /** The box Up fills shows other words than the queue (a marker the screen draws). */
  boxShows: string | null = null;
  /** Backspace does nothing: a box that will not empty. */
  deaf = false;
  refuseKeys = false;
  revision = 1;

  enqueue(...texts: string[]): void {
    for (const text of texts) {
      this.queue.push(text);
      this.journal.push(queueOp("enqueue", text));
    }
  }

  get screen(): string {
    if (this.dialog) return DIALOG;
    const rows = [...(this.running ? RUNNING : IDLE)];
    const at = boxRowOf(rows);
    const lines = this.box.split("\n");
    rows.splice(at, 1, `❯ ${lines[0]!}`, ...lines.slice(1).map((line) => `  ${line}`));
    return rows.join("\r\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    return Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: this.revision }));
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    if (this.refuseKeys) return Promise.resolve(muxRefused("refused"));
    this.keysSeen.push([...keys]);
    this.revision++;
    for (const key of keys) {
      if (key === "Up") this.up();
      if (key === "Backspace" && !this.deaf) this.box = [...this.box].slice(0, -1).join("");
    }
    return Promise.resolve(muxAck());
  };

  private up(): void {
    if (this.turnEndsAtKey) {
      // The turn ended and the next one started with the queue: a dequeue row and the prompt in the log.
      const prompt = this.queue.join("\n");
      this.journal.push(queueOp("dequeue"));
      this.journal.push(JSON.stringify({ type: "user", uuid: `u-${String(this.journal.length)}`, timestamp: "2026-11-22T10:00:02.000Z", message: { role: "user", content: prompt } }));
      this.history.push(prompt);
      this.queue = [];
      this.turnEndsAtKey = false;
    }
    if (this.box !== "") return;
    if (this.queue.length > 0) {
      const text = this.queue.join("\n");
      if (this.popAllRow === "content") this.journal.push(queueOp("popAll", text));
      if (this.popAllRow === "bare") this.journal.push(queueOp("popAll"));
      this.box = this.boxShows ?? text;
      this.queue = [];
      return;
    }
    // An empty queue: Up walks the prompt history.
    this.box = this.history.at(-1) ?? "";
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-dequeue-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Rig {
  readonly pane: ClaudePane;
  readonly service: DequeueService;
  readonly protocol: SendProtocol;
  readonly forgotten: string[][];
  readonly sleeps: number[];
  readonly lines: string[];
  readonly ask: DequeueAsk;
  readonly take: (requestId: string, paneId?: string) => Promise<DequeueReceipt>;
  readonly route: (body: JsonValue | undefined, ask?: DequeueAsk | null) => Promise<Response>;
  /** The log generation the fake journal answers; a test moves it to break the tie. */
  gen: number;
  /** This bridge would mask every text (`redact` and a secret shape). */
  masks: boolean;
}

function rig(pane = new ClaudePane()): Rig {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const sleeps: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    clock.now += ms;
    return Promise.resolve();
  };
  const profile = (harness: string) => Promise.resolve(profileFor(harness, "2.1.319", { log: () => undefined, profiles: new Map([["claude", CLAUDE]]) }));
  const gate = new KeyGate(pane, now);
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: () => Promise.resolve(muxAck()), pasteText: () => Promise.resolve(muxAck()) },
    gate,
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile,
    generation: () => "claude:lab-session",
    now,
    sleep,
  });
  const forgotten: string[][] = [];
  const service = new DequeueService({
    mux: pane,
    gate,
    profile,
    lock: (paneId, owner, spanMs, work, busy) => protocol.underPaneLock("main", paneId, owner, spanMs, work, busy),
    forget: (paneId, texts) => {
      forgotten.push([...texts]);
      protocol.takenBack("main", paneId, texts);
    },
    sleep,
  });
  // The journal: the real reducer over the rows the pane wrote, read on each call (LiveWindows.queueNow).
  let reducer: RowReducer = createClaudeReducer();
  let read = 0;
  const out: Rig = {
    pane,
    service,
    protocol,
    forgotten,
    sleeps,
    lines: [],
    gen: 1,
    masks: false,
    ask: {
      keys: ["Up"],
      journal: () => {
        if (out.gen !== 1 && read > 0) {
          reducer = createClaudeReducer();
          read = 0;
        }
        for (; read < pane.journal.length; read++) reducer.push(pane.journal[read]!);
        return Promise.resolve({ gen: out.gen, mark: reducer.queueMark!() });
      },
      sendable: () => !out.masks,
    },
    take: async (requestId, paneId = "%1") => {
      const answer = await service.handle(requestId, paneId, "claude", out.ask);
      if (answer.kind !== "receipt") throw new Error(answer.kind);
      return answer.receipt;
    },
    route: (body, ask) => {
      const engine = { current: () => ({ agents: [{ paneId: "%1", agent: "claude" }], shellPanes: [] }), noteInput: () => undefined, pokeNow: () => undefined };
      const rt: DequeueRouteRuntime = { dequeue: service, engine };
      const audit = new AuditLog((line) => void out.lines.push(line));
      return dequeueRoute(rt, "%1", body, ask === undefined ? out.ask : ask, { audit, device: "phone", session: "main", acceptEncoding: null });
    },
  };
  return out;
}

const upPresses = (pane: ClaudePane): number => pane.keysSeen.filter((keys) => keys.includes("Up")).length;

describe("the captures the scripted pane draws", () => {
  test("a running turn with an empty box takes the key; the same turn with text in the box refuses before it", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    expect(await r.take("dq-capture-01")).toMatchObject({ outcome: "taken" });
    const two = rig();
    two.pane.box = `${FIRST}\n${SECOND}`;
    // A box with text refuses before the key: the scripted rows read as a draft.
    two.pane.enqueue(FIRST);
    expect(await two.take("dq-capture-02")).toEqual({ requestId: "dq-capture-02", outcome: "refused", reason: "draft_present" });
  });
});

describe("taken: the journal shows the queue going back, the box is emptied, the texts come back", () => {
  test("one message", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    expect(await r.take("dq-taken-01")).toEqual({ requestId: "dq-taken-01", outcome: "taken", texts: [FIRST] });
    expect(upPresses(r.pane)).toBe(1);
    expect(r.pane.box).toBe("");
    // One clear press: the text's length and the profile's slack, all Backspace.
    expect(r.pane.keysSeen[1]).toEqual(Array.from({ length: FIRST.length + CLAUDE.keys.clear.slack }, () => "Backspace"));
    expect(r.forgotten).toEqual([[FIRST]]);
    // The proof waited on the Stop's clock and no longer.
    expect(r.sleeps[0]).toBe(PROOF_GAPS_MS[0]);
  });

  test("two messages: both, in queue order, from one key", async () => {
    const r = rig();
    r.pane.enqueue(FIRST, SECOND);
    expect(await r.take("dq-taken-02")).toEqual({ requestId: "dq-taken-02", outcome: "taken", texts: [FIRST, SECOND] });
    expect(upPresses(r.pane)).toBe(1);
    expect(r.pane.box).toBe("");
  });

  test("a popAll with no content ties by its place alone", async () => {
    const r = rig();
    r.pane.popAllRow = "bare";
    r.pane.enqueue(FIRST);
    expect(await r.take("dq-taken-03")).toMatchObject({ outcome: "taken", texts: [FIRST] });
  });

  test("the harness's own plumbing moving before the popAll does not break the tie", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    const write = r.pane.writeKeys;
    r.pane.writeKeys = (paneId, keys) => {
      if (keys.includes("Up")) {
        r.pane.journal.push(queueOp("enqueue", "<task-notification>\n<task-id>t9</task-id>\n</task-notification>"));
        r.pane.journal.push(queueOp("dequeue"));
      }
      return write(paneId, keys);
    };
    // The dequeue takes the front, which is the person's message here, so the tie breaks: nothing is cleared.
    expect((await r.take("dq-taken-04")).outcome).toBe("in_box");
    expect(r.pane.box).toBe(FIRST);
  });
});

describe("in_box: the key went in and the text stays in the agent's box", () => {
  test("the box shows other words than the queue (a marker the screen draws): nothing is cleared", async () => {
    const r = rig();
    r.pane.boxShows = "[Pasted text #1 +3 lines]";
    r.pane.enqueue(FIRST);
    expect(await r.take("dq-inbox-01")).toEqual({ requestId: "dq-inbox-01", outcome: "in_box" });
    expect(r.pane.keysSeen).toEqual([["Up"]]);
    expect(r.forgotten).toEqual([]);
  });

  test("a box that does not read back empty after the clear", async () => {
    const r = rig();
    r.pane.deaf = true;
    r.pane.enqueue(FIRST);
    expect(await r.take("dq-inbox-02")).toEqual({ requestId: "dq-inbox-02", outcome: "in_box" });
    expect(r.pane.box).toBe(FIRST);
    // One clear press and no second, blind one.
    expect(r.pane.keysSeen.length).toBe(2);
    expect(r.forgotten).toEqual([]);
  });

  test("a popAll whose words are not the queue read: the box is left alone", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    const write = r.pane.writeKeys;
    r.pane.writeKeys = (paneId, keys) => {
      if (keys.includes("Up")) r.pane.queue = ["typed at the desk meanwhile"];
      return write(paneId, keys);
    };
    expect(await r.take("dq-inbox-03")).toEqual({ requestId: "dq-inbox-03", outcome: "in_box" });
    expect(r.pane.box).toBe("typed at the desk meanwhile");
    expect(r.pane.keysSeen).toEqual([["Up"]]);
  });
});

describe("too_late: the history trap", () => {
  test("the turn ends between the read and the key; Up shows the last prompt; no popAll; the box is emptied again", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    r.pane.turnEndsAtKey = true;
    expect(await r.take("dq-late-01")).toEqual({ requestId: "dq-late-01", outcome: "too_late" });
    expect(r.pane.journal.some((row) => row.includes('"popAll"'))).toBe(false);
    expect(upPresses(r.pane)).toBe(1);
    // The recalled prompt was emptied with the clear key, and nothing went to the composer.
    expect(r.pane.box).toBe("");
    expect(r.pane.keysSeen[1]!.every((key) => key === "Backspace")).toBe(true);
    expect(r.forgotten).toEqual([]);
  });

  test("a box read alone is not the proof: the same box with no dequeue in the log is `unknown`, left alone", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    r.pane.popAllRow = "none";
    expect(await r.take("dq-late-02")).toEqual({ requestId: "dq-late-02", outcome: "unknown" });
    expect(r.pane.box).toBe(FIRST);
    expect(r.pane.keysSeen).toEqual([["Up"]]);
    // It waited the whole bound for a proof that never came.
    expect(r.sleeps.slice(0, PROOF_GAPS_MS.length)).toEqual([...PROOF_GAPS_MS]);
  });
});

describe("unknown: the key went in and Collie cannot tell", () => {
  test("the turn ended and the box shows text that is none of the queue: touched no further", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    r.pane.turnEndsAtKey = true;
    r.pane.history = ["an older prompt"];
    const write = r.pane.writeKeys;
    r.pane.writeKeys = (paneId, keys) => {
      const done = write(paneId, keys);
      if (keys.includes("Up")) r.pane.box = "an older prompt";
      return done;
    };
    expect(await r.take("dq-unknown-01")).toEqual({ requestId: "dq-unknown-01", outcome: "unknown" });
    expect(r.pane.box).toBe("an older prompt");
    expect(r.pane.keysSeen).toEqual([["Up"]]);
  });

  test("the log was rewritten under the take-back (a new generation): no tie, nothing cleared", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    const write = r.pane.writeKeys;
    r.pane.writeKeys = (paneId, keys) => {
      if (keys.includes("Up")) r.gen = 2;
      return write(paneId, keys);
    };
    expect((await r.take("dq-unknown-02")).outcome).toBe("in_box");
    expect(r.pane.box).toBe(FIRST);
  });
});

describe("a refusal before the key presses nothing", () => {
  const cases: [string, (r: Rig) => void, DequeueReason][] = [
    ["a dialog is up", (r) => void (r.pane.dialog = true), "dialog_open"],
    ["the turn already ended", (r) => void (r.pane.running = false), "turn_idle"],
    ["the agent's box holds a draft", (r) => void (r.pane.box = "half a thought"), "draft_present"],
    ["the journal lists no waiting message", (r) => void (r.pane.queue = []), "queue_empty"],
    ["a waiting message the log names only by a marker", (r) => void r.pane.journal.push(queueOp("enqueue", "see [Image #1]")), "not_whole"],
    ["a waiting message this bridge would mask", (r) => void (r.masks = true), "not_whole"],
  ];
  for (const [name, set, reason] of cases) {
    test(name, async () => {
      const r = rig();
      if (reason !== "queue_empty") r.pane.enqueue(FIRST);
      set(r);
      expect(await r.take(`dq-refused-${reason}`)).toEqual({ requestId: `dq-refused-${reason}`, outcome: "refused", reason });
      expect(r.pane.keysSeen).toEqual([]);
    });
  }

  test("another send holds the pane", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    const held = r.protocol.underPaneLock("main", "%1", "another-send", 60_000, async () => r.take("dq-refused-busy"), () => null);
    expect(await held).toEqual({ requestId: "dq-refused-busy", outcome: "refused", reason: "busy" });
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("no journal, a pane with no profile, no key", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    const none = await r.service.handle("dq-refused-nolog", "%1", "claude", { ...r.ask, journal: () => Promise.resolve(null) });
    expect(none.kind === "receipt" && none.receipt.reason).toBe("no_journal");
    const blind = await r.service.handle("dq-refused-nopro", "%1", "", r.ask);
    expect(blind.kind === "receipt" && blind.receipt.reason).toBe("no_profile");
    const keyless = await r.service.handle("dq-refused-nokey", "%1", "claude", { ...r.ask, keys: [] });
    expect(keyless.kind === "receipt" && keyless.receipt.reason).toBe("no_key");
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("the multiplexer refuses the key", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    r.pane.refuseKeys = true;
    expect(await r.take("dq-refused-press")).toEqual({ requestId: "dq-refused-press", outcome: "refused", reason: "press_failed" });
  });
});

describe("one request id, one key", () => {
  test("the same id twice presses Up once and answers the first receipt, texts and all", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    const first = await r.take("dq-replay-01");
    r.pane.enqueue(SECOND);
    const second = await r.service.handle("dq-replay-01", "%1", "claude", r.ask);
    expect(second).toEqual({ kind: "receipt", receipt: first, replayed: true, pressed: true });
    expect(upPresses(r.pane)).toBe(1);
  });

  test("a second tap while the first runs joins it", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    const [a, b] = await Promise.all([r.take("dq-replay-02"), r.take("dq-replay-02")]);
    expect(a).toEqual(b);
    expect(upPresses(r.pane)).toBe(1);
  });

  test("the same id on another pane is refused", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    await r.take("dq-replay-03");
    expect(await r.service.handle("dq-replay-03", "%2", "claude", r.ask)).toEqual({ kind: "id_reused" });
  });
});

describe("the proof", () => {
  test("moves past what the mark keeps, or a gap in the numbering, cannot be tied", () => {
    const before = { gen: 1, mark: { moves: 4, texts: ["a"], recent: [] } };
    expect(proofOf(before, { gen: 1, mark: { moves: 40, texts: [], recent: [{ n: 40, kind: "back", words: "a" }] } }, ["a"])).toBe("lost");
    expect(proofOf(before, { gen: 1, mark: { moves: 5, texts: [], recent: [{ n: 5, kind: "back", words: "a" }] } }, ["a"])).toBe("proved");
    expect(proofOf(before, { gen: 1, mark: { moves: 4, texts: ["a"], recent: [] } }, ["a"])).toBe("none");
    expect(proofOf(before, null, ["a"])).toBe("lost");
  });

  test("two texts tie to a popAll whose words are both, joined as the box holds them", () => {
    const before = { gen: 1, mark: { moves: 2, texts: ["a b", "c"], recent: [] } };
    expect(proofOf(before, { gen: 1, mark: { moves: 3, texts: [], recent: [{ n: 3, kind: "back", words: "a b\nc" }] } }, ["a b", "c"])).toBe("proved");
    expect(proofOf(before, { gen: 1, mark: { moves: 3, texts: [], recent: [{ n: 3, kind: "back", words: "c" }] } }, ["a b", "c"])).toBe("back_untied");
  });
});

describe("the route", () => {
  test("a body that is no request id is a 400, and no dequeue key refuses no_key with nothing pressed", async () => {
    const r = rig();
    r.pane.enqueue(FIRST);
    expect((await r.route({ nope: 1 })).status).toBe(400);
    const keyless = await r.route({ requestId: "dq-route-00001" }, null);
    expect(await keyless.json()).toEqual({ requestId: "dq-route-00001", outcome: "refused", reason: "no_key" });
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("the crew forwards it like the Stop and the Clear", () => {
    expect(crewRouteFor("/api/pane/%251/dequeue", "POST")).not.toBeNull();
  });

  test("a taken run: the texts travel in the answer only, never in a log line, the audit line, the row ring or a file", async () => {
    const r = rig();
    const secretish = "please refactor the parser of the frobnicator";
    r.pane.enqueue(secretish, SECOND);
    const logged: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) => spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))));
    let res: Response;
    try {
      res = await r.route({ requestId: "dq-route-00002" });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const body: unknown = await res.json();
    expect(body).toEqual({ requestId: "dq-route-00002", outcome: "taken", texts: [secretish, SECOND] });
    expect(r.lines.length).toBe(1);
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ action: "dequeue", detail: { requestId: "dq-route-00002", outcome: "taken", count: 2, pressed: true } });
    const files = readdirSync(dir, { recursive: true }).map(String);
    const onDisk = files.map((name) => {
      try {
        return readFileSync(join(dir, name), "utf8");
      } catch {
        return "";
      }
    });
    for (const text of [secretish, SECOND, "frobnicator"]) {
      expect(r.lines.join("\n")).not.toContain(text);
      expect(logged.join("\n")).not.toContain(text);
      expect(onDisk.join("\n")).not.toContain(text);
    }
  });
});
