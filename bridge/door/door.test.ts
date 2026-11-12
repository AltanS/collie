// The door seam's own rules (ADR 0141 point 2): a preflight that fails in any way refuses, so the
// screen path runs; a submit that throws or hangs may have reached the agent, so it is never a refusal.

import { describe, expect, test } from "bun:test";
import { doorRegistry, tryDoor, type BoundDoor, type Door, type DoorAnswer, type Preflight } from "./door.ts";

const TARGET = { session: "main", paneId: "%1", harness: "pi" };
const SEND = { requestId: "req_door_0001", text: "hello" };
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function doorOf(preflight: () => Promise<Preflight>): Door {
  return { id: "pi", preflight };
}
function bound(submit: () => Promise<DoorAnswer>): Promise<Preflight> {
  const door: BoundDoor = { submit };
  return Promise.resolve({ ok: true, door });
}

describe("tryDoor", () => {
  test("a hint is submitted", async () => {
    for (const kind of ["taken", "queued", "replayed"] as const) {
      expect(await tryDoor(doorOf(() => bound(() => Promise.resolve({ kind }))), TARGET, SEND, 1000)).toEqual({ kind: "submitted", answer: { kind } });
    }
  });

  test("the agent's own refusal falls back", async () => {
    expect(await tryDoor(doorOf(() => bound(() => Promise.resolve({ kind: "refused", why: "busy" }))), TARGET, SEND, 1000)).toEqual({ kind: "refused", why: "busy" });
  });

  test("a pane with no door is absent, never a refusal (SPEC V25)", async () => {
    expect(await tryDoor(doorOf(() => Promise.resolve({ ok: false, why: "no inbox", absent: true })), TARGET, SEND, 1000)).toEqual({ kind: "absent", why: "no inbox" });
  });

  test("an unbound door, a throw or a hang in preflight is a refusal", async () => {
    expect((await tryDoor(doorOf(() => Promise.resolve({ ok: false, why: "no socket" })), TARGET, SEND, 1000)).kind).toBe("refused");
    expect((await tryDoor(doorOf(() => Promise.reject(new Error("ENOENT"))), TARGET, SEND, 1000)).kind).toBe("refused");
    expect((await tryDoor(doorOf(never), TARGET, SEND, 20)).kind).toBe("refused");
  });

  test("a throw or a hang in submit is uncertain, never a refusal", async () => {
    expect(await tryDoor(doorOf(() => bound(() => Promise.reject(new Error("EPIPE")))), TARGET, SEND, 1000)).toEqual({ kind: "uncertain", why: "submit: EPIPE" });
    expect((await tryDoor(doorOf(() => bound(never)), TARGET, SEND, 20)).kind).toBe("uncertain");
  });

  test("a hang aborts the door's signal", async () => {
    let seen: AbortSignal | undefined;
    await tryDoor(doorOf(() => bound(() => never())), TARGET, SEND, 20);
    await tryDoor({ id: "pi", preflight: (_target, signal) => ((seen = signal), never()) }, TARGET, SEND, 20);
    expect(seen?.aborted).toBe(true);
  });
});

test("two doors for one harness is an error", () => {
  const door = doorOf(() => Promise.resolve({ ok: false, why: "-" }));
  expect(() => doorRegistry([door, door])).toThrow("two doors for harness pi");
  expect(doorRegistry([door]).get("pi")).toBe(door);
});
