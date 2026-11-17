import { describe, expect, test } from "bun:test";

import { EventBus } from "../events/bus.ts";
import { encodeSessionId } from "../events/session-id.ts";
import type { JsonObject } from "../json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { ANSWER_MAX_BYTES, EVENTS_PER_ANSWER } from "./limits.ts";
import {
  admit,
  buildTable,
  DECLARED,
  holds,
  LOCAL_TIER_RIGHTS,
  lowerOf,
  offeredOf,
  OPERATION_LEVELS,
  OPERATION_NAMES,
  RIGHT_ORDER,
  row,
  tableOf,
  type ArgType,
  type OperationContext,
  type OpResult,
  type ReadHandlers,
  type Right,
  type TableRow,
} from "./operations.ts";

const LOCAL: Right = LOCAL_TIER_RIGHTS;
const RIGHTS: readonly Right[] = ["see", "read", "send", "control"];
const SESSION = encodeSessionId({ machine: "inst-test-a1", paneId: "w1:p2", instance: "k3f9" });

const stub = async (): Promise<OpResult> => ({ ok: true, answer: { stub: true } });
const READS: ReadHandlers = { sessions: stub, brief: stub, read: stub, accounts: stub, "hill.list": stub, machines: stub };

function newBus(): EventBus {
  return new EventBus({ machine: () => "inst-test-a1", bootId: "boot1" });
}

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return { signal: new AbortController().signal, offered: [], standing: () => true, claimWait: () => () => undefined, ...overrides };
}

function fullTable(bus = newBus()): ReturnType<typeof buildTable> {
  return buildTable({ version: () => "9.9.9-test", bus, reads: READS });
}

describe("the table walk", () => {
  test("the eight names, declared once each, in hello's order", () => {
    expect([...OPERATION_NAMES]).toEqual(["hello", "sessions", "brief", "read", "accounts", "hill.list", "machines", "events"]);
    expect(Object.keys(DECLARED).toSorted()).toEqual([...OPERATION_NAMES].toSorted());
    for (const name of OPERATION_NAMES) expect(DECLARED[name].name).toBe(name);
    expect([...fullTable().keys()]).toEqual([...OPERATION_NAMES]);
  });

  test("every row names a right of the four; every row is a read; only events waits", () => {
    for (const one of fullTable().values()) {
      expect(RIGHTS).toContain(one.right);
      expect(one.kind).toBe("read");
      expect(one.waits).toBe(one.name === "events");
      expect(one.summary.length).toBeGreaterThan(0);
    }
  });

  test("read is the only row above see, and the table takes each right from OPERATION_LEVELS", () => {
    const table = fullTable();
    expect([...table.values()].filter((one) => one.right !== "see").map((one) => one.name)).toEqual(["read"]);
    expect(table.get("read")!.right).toBe("read");
    for (const name of OPERATION_NAMES) expect({ name, right: DECLARED[name].right }).toEqual({ name, right: OPERATION_LEVELS[name] });
    expect(Object.keys(OPERATION_LEVELS)).toEqual([...OPERATION_NAMES]);
    expect(OPERATION_LEVELS).toEqual({ hello: "see", sessions: "see", brief: "see", read: "read", accounts: "see", "hill.list": "see", machines: "see", events: "see" });
  });

  test("the levels are ordered: a grant holds its own level and every one below it, never one above", () => {
    expect([...RIGHT_ORDER]).toEqual(["see", "read", "send", "control"]);
    for (const [g, granted] of RIGHT_ORDER.entries()) {
      for (const [n, needed] of RIGHT_ORDER.entries()) expect({ granted, needed, holds: holds(granted, needed) }).toEqual({ granted, needed, holds: g >= n });
    }
  });

  test("the local tier grants read, which holds see: every row is admitted and offered", () => {
    expect(LOCAL_TIER_RIGHTS).toBe("read");
    const table = fullTable();
    for (const name of table.keys()) expect(admit(table, name, LOCAL).ok).toBe(true);
    expect(offeredOf(table, LOCAL)).toEqual([...OPERATION_NAMES]);
  });

  test("a see grant is offered every row but read, and read is denied", () => {
    const table = fullTable();
    expect(offeredOf(table, "see")).toEqual(OPERATION_NAMES.filter((name) => name !== "read"));
    expect(admit(table, "read", "see")).toEqual({ ok: false, code: "api.denied" });
    for (const name of OPERATION_NAMES.filter((one) => one !== "read")) expect(admit(table, name, "see").ok).toBe(true);
  });

  test("an unknown name is refused, by exact name only", () => {
    const table = fullTable();
    for (const op of ["", "send", "control", "Hello", "hello ", "hill", "hill.post", "__proto__", "constructor", "toString"]) {
      expect(admit(table, op, LOCAL)).toEqual({ ok: false, code: "api.unknown_op" });
    }
  });

  test("deny by default: a planted send or control row is refused for a read grant and not offered", () => {
    const planted = (right: Right): TableRow => row({ name: `planted.${right}`, kind: "read", right, waits: false, summary: "planted", args: [], parse: () => ({ ok: true, args: {} }), handle: stub });
    const table = tableOf([...fullTable().values(), planted("send"), planted("control")]);
    expect(admit(table, "planted.send", LOCAL)).toEqual({ ok: false, code: "api.denied" });
    expect(admit(table, "planted.control", LOCAL)).toEqual({ ok: false, code: "api.denied" });
    expect(offeredOf(table, LOCAL)).toEqual([...OPERATION_NAMES]);
    // A send grant holds see and read too: the order, not a list.
    expect(offeredOf(table, "send")).toEqual([...OPERATION_NAMES, "planted.send"]);
    expect(admit(table, "planted.control", "send")).toEqual({ ok: false, code: "api.denied" });
  });

  test("a name twice is a bug, refused when the table is built", () => {
    const one = fullTable().get("hello")!;
    expect(() => tableOf([one, one])).toThrow(/twice/);
  });

  test("a read row with no handler on this bridge is not in the table: neither offered nor callable", () => {
    const table = buildTable({ version: () => "9.9.9-test", bus: newBus(), reads: { sessions: stub } });
    expect([...table.keys()]).toEqual(["hello", "sessions", "events"]);
    expect(admit(table, "read", LOCAL)).toEqual({ ok: false, code: "api.unknown_op" });
  });

  test("the reads cannot replace hello or events", async () => {
    const reads = { ...READS, hello: stub, events: stub };
    const table = buildTable({ version: () => "9.9.9-test", bus: newBus(), reads });
    const answer = await table.get("hello")!.run({ token: "A".repeat(43) }, ctx({ offered: ["hello"] }));
    expect(answer).toEqual({ ok: true, answer: { api: 1, collie: "9.9.9-test", experimental: true, operations: ["hello"] } });
  });
});

describe("arguments", () => {
  test("an operation with no arguments refuses any", async () => {
    for (const name of ["sessions", "accounts", "hill.list", "machines"]) {
      expect(await fullTable().get(name)!.run({ x: 1 }, ctx())).toEqual({ ok: false, code: "api.bad_request", detail: { reason: "this operation takes no arguments" } });
    }
  });

  test("brief and read take one session id, and nothing else", async () => {
    for (const name of ["brief", "read"]) {
      const one = fullTable().get(name)!;
      expect(await one.run({ session: SESSION }, ctx())).toEqual({ ok: true, answer: { stub: true } });
      for (const args of [{}, { session: 3 }, { session: "" }, { session: "s".repeat(513) }, { session: SESSION, paneId: "w1:p2" }]) {
        expect((await one.run(args, ctx())).ok).toBe(false);
      }
    }
  });

  test("events: after is a text up to 64, wait a whole number from 0 to 25", async () => {
    const events = fullTable().get("events")!;
    for (const args of [{ after: 5 }, { after: "" }, { after: "c".repeat(65) }, { wait: -1 }, { wait: 26 }, { wait: 1.5 }, { wait: "3" }, { since: "boot1.0" }]) {
      const result = await events.run(args, ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("api.bad_request");
    }
    expect((await events.run({ after: "c".repeat(64), wait: 0 }, ctx())).ok).toBe(true);
  });
});

describe("hello", () => {
  const TOKEN = "A".repeat(43);

  test("the answer contract: api, collie, experimental, and the operations this caller may call; never the token", async () => {
    const answer = await fullTable().get("hello")!.run({ token: TOKEN }, ctx({ offered: ["hello", "events"] }));
    expect(answer).toEqual({ ok: true, answer: { api: 1, collie: "9.9.9-test", experimental: true, operations: ["hello", "events"] } });
    if (answer.ok) expect(Object.keys(answer.answer)).toEqual(["api", "collie", "experimental", "operations"]);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  test("token: exactly 43 base64url characters, else a bad request; `client` is no argument any more (spec 05, decision 5)", async () => {
    const hello = fullTable().get("hello")!;
    for (const token of [TOKEN, "a-_9".repeat(10) + "abc"]) expect((await hello.run({ token }, ctx())).ok).toBe(true);
    for (const args of [{}, { token: "" }, { token: "A".repeat(42) }, { token: "A".repeat(44) }, { token: `${"A".repeat(42)}=` }, { token: `${"A".repeat(42)}/` }, { token: 3 }, { token: null }, { client: "trick:cpu-load" }, { token: TOKEN, client: "trick:cpu-load" }, { x: 1 }]) {
      const result = await hello.run(args, ctx());
      expect({ args, ok: result.ok }).toEqual({ args, ok: false });
      if (!result.ok) expect(result.code).toBe("api.bad_request");
    }
  });

  test("lowerOf: a token's level under the ceiling", () => {
    expect(lowerOf("see", "read")).toBe("see");
    expect(lowerOf("read", "read")).toBe("read");
    expect(lowerOf("send", "read")).toBe("read");
    expect(lowerOf("read", "see")).toBe("see");
  });
});

describe("events", () => {
  test("no cursor: no events and the head; a cursor: the events after it, in the API's shape", async () => {
    const bus = newBus();
    const events = fullTable(bus).get("events")!;
    expect(await events.run({}, ctx())).toEqual({ ok: true, answer: { events: [], next: "boot1.0" } });
    bus.publish({ type: "turn.end", session: SESSION });
    const answer = await events.run({ after: "boot1.0" }, ctx());
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(Object.keys(answer.answer)).toEqual(["events", "next"]);
    expect(answer.answer.next).toBe("boot1.1");
    expect(JSON.parse(JSON.stringify(answer.answer.events))).toMatchObject([{ v: 1, type: "turn.end", session: SESSION, cursor: "boot1.1", data: {} }]);
  });

  test("gap and reset pass through at once, with no wait", async () => {
    const bus = new EventBus({ machine: () => "inst-test-a1", bootId: "boot1", maxCount: 1 });
    bus.publish({ type: "turn.end", session: SESSION });
    bus.publish({ type: "turn.end", session: SESSION });
    const events = fullTable(bus).get("events")!;
    const claims: number[] = [];
    const counting = ctx({ claimWait: () => (claims.push(1), () => undefined) });
    const gap = await events.run({ after: "boot1.0", wait: 25 }, counting);
    const reset = await events.run({ after: "older.3", wait: 25 }, counting);
    expect(gap.ok && JSON.parse(JSON.stringify(gap.answer.events))[0]).toMatchObject({ type: "gap", data: { reason: "evicted" } });
    expect(reset.ok && JSON.parse(JSON.stringify(reset.answer.events))[0]).toMatchObject({ type: "reset", data: { reason: "other-boot" } });
    expect(claims).toEqual([]);
  });

  test("a wait takes a slot and gives it back; no slot answers too_many_waits at once", async () => {
    const bus = newBus();
    const events = fullTable(bus).get("events")!;
    expect(await events.run({ wait: 5 }, ctx({ claimWait: () => null }))).toEqual({ ok: false, code: "api.too_many_waits", detail: { perConnection: 4, total: 16 } });
    expect(bus.listeners().waits).toBe(0);
    let held = 0;
    const claim = (): (() => void) => {
      held += 1;
      return () => {
        held -= 1;
      };
    };
    const waiting = events.run({ wait: 5 }, ctx({ claimWait: claim }));
    await Bun.sleep(5);
    expect([held, bus.listeners().waits]).toEqual([1, 1]);
    bus.publish({ type: "ask.open", session: SESSION });
    const answer = await waiting;
    expect(answer.ok && JSON.parse(JSON.stringify(answer.answer.events))).toMatchObject([{ type: "ask.open" }]);
    expect([held, bus.listeners().waits]).toEqual([0, 0]);
  });

  test("a wait that wakes to a socket no longer standing answers closing", async () => {
    const bus = newBus();
    const waiting = fullTable(bus).get("events")!.run({ wait: 5 }, ctx({ standing: () => false }));
    await Bun.sleep(5);
    bus.publish({ type: "ask.open", session: SESSION });
    expect(await waiting).toEqual({ ok: false, code: "api.closing" });
  });

  test("an abort ends the wait with closing and leaves no listener", async () => {
    const bus = newBus();
    const controller = new AbortController();
    const waiting = fullTable(bus).get("events")!.run({ wait: 25 }, ctx({ signal: controller.signal }));
    await Bun.sleep(5);
    controller.abort();
    expect(await waiting).toEqual({ ok: false, code: "api.closing" });
    expect(bus.listeners().waits).toBe(0);
  });
});

describe("events pages (security read 1, item 6)", () => {
  test("after a reset with 2048 events kept: pages of at most 256, the reset counted, each under 1 MiB, nothing lost or repeated", async () => {
    const bus = newBus();
    for (let i = 0; i < 2048; i += 1) bus.publish({ type: "session.status", session: SESSION, data: { state: i % 2 === 0 ? "working" : "idle" } });
    const table = fullTable(bus);
    const seen: string[] = [];
    let resets = 0;
    let cursor = "boot0.5";
    let pages = 0;
    for (; pages < 20; pages += 1) {
      const result = await table.get("events")!.run({ after: cursor }, ctx());
      if (!result.ok) throw new Error(result.code);
      expect(Buffer.byteLength(JSON.stringify({ ok: true, ...result.answer }))).toBeLessThan(ANSWER_MAX_BYTES);
      const raw = result.answer.events;
      const events: JsonObject[] = (Array.isArray(raw) ? raw : []).map((one) => asJsonObject(one) ?? {});
      expect(events.length).toBeLessThanOrEqual(EVENTS_PER_ANSWER);
      for (const event of events) {
        if (event.type === "reset") resets += 1;
        else seen.push(asJsonString(event.id) ?? "");
      }
      cursor = String(result.answer.next);
      if (events.length === 0) break;
    }
    expect(resets).toBe(1);
    expect(seen.length).toBe(2048);
    expect(new Set(seen).size).toBe(2048);
    // 2049 events with the marker: eight full pages, one of one event, one empty at the head.
    expect(pages).toBe(9);
    expect(cursor).toBe(bus.head());
  });

  test("a page of fewer than 256 answers the head as next, as before", async () => {
    const bus = newBus();
    const from = bus.head();
    for (let i = 0; i < 3; i += 1) bus.publish({ type: "turn.end", session: SESSION });
    const result = await fullTable(bus).get("events")!.run({ after: from }, ctx());
    expect(result).toMatchObject({ ok: true, answer: { next: bus.head() } });
  });
});

describe("the declared arguments", () => {
  // One valid sample per declared type; the parsers' own limits are met by these.
  // A run token is the one text argument with a shape of its own (43 base64url characters).
  const sample = (type: ArgType, name = ""): string | number => {
    if (type === "integer") return 5;
    return name === "token" ? "A".repeat(43) : "ses_sample";
  };
  const wrong = (type: ArgType): string | number => (type === "integer" ? "abc" : 5);

  test("every operation declares its arguments, and its parser takes exactly those", () => {
    for (const name of OPERATION_NAMES) {
      const declared = DECLARED[name];
      const required = Object.fromEntries(declared.args.filter((arg) => arg.required).map((arg) => [arg.name, sample(arg.type, arg.name)]));
      // Only the required ones: accepted (the optional ones are optional).
      expect(declared.parse(required).ok).toBe(true);
      for (const arg of declared.args) {
        // Each declared argument, given with a value of its type, is taken.
        expect(declared.parse({ ...required, [arg.name]: sample(arg.type, arg.name) }).ok).toBe(true);
        // A value of the wrong type is refused.
        expect(declared.parse({ ...required, [arg.name]: wrong(arg.type) }).ok).toBe(false);
        // A required argument left out is refused.
        if (arg.required) {
          const { [arg.name]: _left, ...rest } = required;
          expect(declared.parse(rest).ok).toBe(false);
        }
        expect(arg.help.length).toBeGreaterThan(0);
      }
      // An argument no declaration lists is refused, so the parser takes nothing the CLI cannot name.
      expect(declared.parse({ ...required, "not-declared": "x" }).ok).toBe(false);
    }
  });

  test("an argument name is unique within a row and is one word the command face can spell as a flag", () => {
    for (const name of OPERATION_NAMES) {
      const names = DECLARED[name].args.map((arg) => arg.name);
      expect(new Set(names).size).toBe(names.length);
      for (const one of names) expect(one).toMatch(/^[a-z]+(?:-[a-z]+)*$|^[a-z][A-Za-z]*$/u);
    }
  });

  test("the rows of a built table carry the declarations", () => {
    const built = fullTable();
    for (const name of OPERATION_NAMES) expect(built.get(name)?.args).toBe(DECLARED[name].args);
  });
});
