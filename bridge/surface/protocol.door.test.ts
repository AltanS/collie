// The Send Protocol tries the pane's door before the screen (ADR 0141): a plain message to a pane with a
// door goes through it with no read and no key; a refusal before `submit` falls back to the screen
// path; a `submit` that may have reached the agent is never typed again; the multiplexer's `blocked`
// does not refuse a door's send. The pane is Claude Code 2.1.310's captured running turn, so the screen
// path, when it runs, ends `sent` + `queued`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import { doorRegistry, type Door, type DoorAnswer, type DoorSend, type Preflight } from "../door/door.ts";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { sendRoute, type SendRouteRuntime } from "../server.ts";
import type { AgentStatus } from "../types.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const SURFACE = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface");
const TURN = readFileSync(join(SURFACE, "claude--v2-1-310-walky-turn-empty-box--w120.txt"), "utf8");
const QUEUED = readFileSync(join(SURFACE, "claude--v2-1-310-walky-queued-two-rows--w120.txt"), "utf8");
const RULE = "─".repeat(120);

/** The captured running turn with its box drawn from what was typed; Enter takes a text into the queue. */
class Pane {
  box = "";
  reads = 0;
  keysSeen: string[] = [];
  private queued = false;
  private readonly head: string[];
  private readonly footer: string[];

  constructor() {
    const rows = TURN.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const bottom = rows.findLastIndex((row) => /^─{8,}$/u.test(row));
    const top = rows.slice(0, bottom).findLastIndex((row) => /^─{8,}$/u.test(row));
    this.head = rows.slice(0, top);
    this.footer = rows.slice(bottom + 1);
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    const text = this.queued ? QUEUED : [...this.head, RULE, `❯ ${this.box}`, RULE, ...this.footer].join("\n");
    return Promise.resolve(muxOk({ paneId, text, truncated: false, revision: this.reads }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    if (!this.queued) this.box += text;
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "Enter" && this.box.length > 0) {
        this.box = "";
        this.queued = true;
      }
    }
    return Promise.resolve(muxAck());
  };
}

/** A door for `claude` whose preflight and submit answer as told, and which counts its submits. */
class FakeDoor implements Door {
  readonly id = "claude";
  submits: DoorSend[] = [];
  constructor(
    private readonly bind: () => Promise<Preflight> = () => Promise.resolve({ ok: true, door: { submit: (send) => this.submitted(send) } }),
    private readonly answer: () => Promise<DoorAnswer> = () => Promise.resolve({ kind: "taken" }),
  ) {}
  preflight = (): Promise<Preflight> => this.bind();
  submitted(send: DoorSend): Promise<DoorAnswer> {
    this.submits.push(send);
    return this.answer();
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-door-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;
const nextId = (): string => `door_case${String(++ids).padStart(4, "0")}-72207d22`;

function rig(door: Door | null, status?: AgentStatus) {
  const pane = new Pane();
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "2.1.310", { log: () => undefined })),
    generation: () => "gen-1",
    muxStatus: () => status,
    doors: doorRegistry(door === null ? [] : [door]),
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: nextId(), text, mode: "send", fromPhone: true, ...over }, { session: "main", paneId: "%1", harness: "claude" });
  return { pane, protocol, send };
}

describe("the door goes first (ADR 0141 point 2)", () => {
  test("a door that takes the text: no read, no key, `via` names it, and the receipt is a card", async () => {
    const door = new FakeDoor();
    const { pane, protocol, send } = rig(door);
    const answer = await send("hello from the phone");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, via: "claude", keys: [] });
    expect(answer.receipt?.gapsMs.door).toBeNumber();
    expect(door.submits).toEqual([{ requestId: answer.receipt!.requestId, text: "hello from the phone" }]);
    expect(pane.reads).toBe(0);
    expect(pane.keysSeen).toEqual([]);
    expect(protocol.queuedOf("main", "%1").map((card) => card.requestId)).toEqual([answer.receipt!.requestId]);
  });

  test("no door registered: the screen path, `via` screen", async () => {
    const { pane, send } = rig(null);
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, via: "screen" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
  });

  test("a refusal before submit falls back to the screen: an unbound door, a preflight throw, the agent's own refusal", async () => {
    const doors = [
      new FakeDoor(() => Promise.resolve({ ok: false, why: "no socket" })),
      new FakeDoor(() => Promise.reject(new Error("ENOENT"))),
      new FakeDoor(undefined, () => Promise.resolve({ kind: "refused", why: "cannot take a message now" })),
    ];
    for (const door of doors) {
      const { pane, send } = rig(door);
      const answer = await send("hello");
      expect(answer.receipt).toMatchObject({ outcome: "sent", via: "screen" });
      expect(pane.reads).toBeGreaterThan(0);
      expect(pane.keysSeen.at(-1)).toBe("Enter");
    }
  });
});

describe("once submit may have reached the agent there is no fallback (ADR 0141 point 2)", () => {
  test("a submit that throws: `unknown`, nothing read or typed, a card, and no Resend offered", async () => {
    const door = new FakeDoor(undefined, () => Promise.reject(new Error("connection dropped after write")));
    const { pane, protocol, send } = rig(door);
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence", via: "claude", keys: [] });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.reads).toBe(0);
    expect(pane.keysSeen).toEqual([]);
    expect(protocol.queuedOf("main", "%1").map((card) => card.requestId)).toEqual([answer.receipt!.requestId]);
  });

  test("the same request id replays the stored receipt and submits once", async () => {
    const door = new FakeDoor();
    const { protocol } = rig(door);
    const request: SendRequest = { id: nextId(), text: "hello", mode: "send", fromPhone: true };
    const target = { session: "main", paneId: "%1", harness: "claude" };
    const first = await protocol.handle(request, target);
    const again = await protocol.handle(request, target);
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt!);
    expect(door.submits).toHaveLength(1);
  });
});

test("the multiplexer's `blocked` does not refuse a door's send (ADR 0141 point 5)", async () => {
  const door = new FakeDoor();
  const { pane, send } = rig(door, "blocked");
  const answer = await send("hello");
  expect(answer.receipt).toMatchObject({ outcome: "sent", via: "claude" });
  expect(pane.keysSeen).toEqual([]);
});

describe("only a plain message goes through the door", () => {
  test("a command, a steer and a mode that acts on the box take the screen path", async () => {
    const asks: Partial<SendRequest>[] = [{ mode: "command" }, { when: "steer" }, { mode: "replace" }, { mode: "append" }];
    for (const over of asks) {
      const door = new FakeDoor();
      const { send } = rig(door);
      const answer = await send(over.mode === "command" ? "/model" : "hello", over);
      expect(door.submits).toEqual([]);
      expect(answer.receipt?.via).toBe("screen");
    }
  });

  test("a plain send whose text opens with a reserved lead is a command: the screen's", async () => {
    const door = new FakeDoor();
    const { send } = rig(door);
    await send("/model");
    expect(door.submits).toEqual([]);
  });
});

test("the route: a door's send pokes the engine though it pressed no key, and the audit line names `via`", async () => {
  const { protocol } = rig(new FakeDoor());
  const pokes = { input: 0, now: 0 };
  const engine = {
    current: () => ({ agents: [{ paneId: "%1", agent: "claude" }] }),
    noteInput: () => void pokes.input++,
    pokeNow: () => void pokes.now++,
  };
  const rt: SendRouteRuntime = { send: protocol, engine, herdr: {}, name: "main" };
  const lines: string[] = [];
  const context = { audit: new AuditLog((line) => void lines.push(line)), device: "phone", redact: true, acceptEncoding: null };
  const id = nextId();
  const answer = await (await sendRoute(rt, { id, pane: "%1", text: "hello" }, context)).json();
  expect(answer.receipt).toMatchObject({ outcome: "sent", via: "claude", keys: [] });
  expect(pokes).toEqual({ input: 1, now: 1 });
  expect(lines.join("\n")).toContain('"via":"claude"');
  await sendRoute(rt, { id, pane: "%1", text: "hello" }, context);
  expect(pokes).toEqual({ input: 1, now: 1 });
});
