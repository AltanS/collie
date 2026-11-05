import { asJsonObject, parseJson, type JsonValue } from "./json";
import { forgetSessionOrder, moveSession, orderSessions } from "./session-order";
import { wipeDevice } from "./wipe";

// «все 5 рабочих проектов были бы сразу же наверху». The operator's own order of the Sessions sheet:
// per device, per machine. These cases hold the public functions only. The key name is part of the
// contract (the wipe's table reads it); the stored format is not, so a broken value is made by
// rewriting what the module itself wrote.

const KEY = "collie:session-order:v1";

type FakeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> & { values: Map<string, string> };

function fakeStorage(): FakeStorage {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const rows = (...names: string[]) => names.map((name) => ({ name }));
const namesOf = (list: readonly { name: string }[]) => list.map((row) => row.name);

/** The order a device reads for these sessions on this machine. */
const read = (given: readonly string[], host: string | undefined, local: FakeStorage) =>
  namesOf(orderSessions(rows(...given), host, local));

/** Every array in a JSON value, rewritten. Finds the list without knowing the format around it. */
function mapArrays(value: JsonValue | undefined, next: (list: JsonValue[]) => JsonValue): JsonValue | undefined {
  if (Array.isArray(value)) return next(value);
  const object = asJsonObject(value);
  if (object === undefined) return value;
  return Object.fromEntries(Object.entries(object).map(([key, inner]) => [key, mapArrays(inner, next)]));
}

function rewriteStored(local: FakeStorage, next: (list: JsonValue[]) => JsonValue) {
  for (const [key, old] of local.values) local.setItem(key, JSON.stringify(mapArrays(parseJson(old), next)));
}

describe("@oracle:requirement @req:SES-1 the stored order applies to the given sessions", () => {
  const GIVEN = ["a", "b", "c", "d"];

  it("nothing stored gives the given order", () => {
    expect(read(GIVEN, undefined, fakeStorage())).toEqual(GIVEN);
  });

  it("applies the stored order", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 3, 0, undefined, local);
    expect(read(GIVEN, undefined, local)).toEqual(["d", "a", "b", "c"]);
  });

  it("a session not stored follows the placed ones, new sessions in the given order", () => {
    const local = fakeStorage();
    moveSession(["a", "b"], 1, 0, undefined, local);
    expect(read(["x", "a", "y", "b", "z"], undefined, local)).toEqual(["b", "a", "x", "y", "z"]);
  });

  it("a stored name no longer present is ignored and takes no place", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 3, 0, undefined, local);
    expect(read(["a", "c", "d"], undefined, local)).toEqual(["d", "a", "c"]);
  });

  it("does not mutate the input and returns the same rows", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 3, 0, undefined, local);
    const given = Object.freeze(rows(...GIVEN));
    const copy = [...given];

    const ordered = orderSessions(given, undefined, local);

    expect(given).toEqual(copy);
    expect(ordered).not.toBe(given);
    expect(ordered[0]).toBe(given[3]);
  });
});

describe("@oracle:requirement @req:SES-2 a move puts the session where the operator dropped it", () => {
  const GIVEN = ["a", "b", "c", "d", "e"];

  it.each([
    { what: "up", from: 3, to: 1, expected: ["a", "d", "b", "c", "e"] },
    { what: "down", from: 1, to: 3, expected: ["a", "c", "d", "b", "e"] },
    { what: "to first", from: 2, to: 0, expected: ["c", "a", "b", "d", "e"] },
    { what: "to last", from: 1, to: 4, expected: ["a", "c", "d", "e", "b"] },
    { what: "first to last", from: 0, to: 4, expected: ["b", "c", "d", "e", "a"] },
    { what: "last to first", from: 4, to: 0, expected: ["e", "a", "b", "c", "d"] },
    { what: "onto its own place", from: 2, to: 2, expected: GIVEN },
  ])("$what", ({ from, to, expected }) => {
    const local = fakeStorage();
    moveSession(GIVEN, from, to, undefined, local);
    expect(read(GIVEN, undefined, local)).toEqual(expected);
  });

  it("a second move starts from the order the first one left", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 4, 0, undefined, local);
    moveSession(read(GIVEN, undefined, local), 4, 1, undefined, local);
    expect(read(GIVEN, undefined, local)).toEqual(["e", "d", "a", "b", "c"]);
  });

  // A session can pass through a listing without being there. Its place waits for it, as a pin does
  // (pins.ts, "absence never prunes"): stored after the moved list, ahead of any session with no place.
  it("a move while a session is absent keeps that session's place for its return", () => {
    const local = fakeStorage();
    moveSession(["a", "b", "c", "d"], 3, 0, undefined, local);
    moveSession(read(["a", "c", "d"], undefined, local), 2, 0, undefined, local);
    expect(read(["x", "a", "b", "c", "d"], undefined, local)).toEqual(["c", "d", "a", "b", "x"]);
  });

  describe("the owner's case: 30 sessions, two of the working ones at the very bottom", () => {
    const THIRTY = Array.from({ length: 30 }, (_, i) => `project-${String(i + 1).padStart(2, "0")}`);
    const REST = THIRTY.slice(0, 28);

    it("the last two reach the top with the last one first", () => {
      const local = fakeStorage();
      moveSession(THIRTY, 29, 0, undefined, local);
      moveSession(read(THIRTY, undefined, local), 29, 1, undefined, local);
      expect(read(THIRTY, undefined, local)).toEqual(["project-30", "project-29", ...REST]);
    });

    it("the last two reach the top in their own order, when that is the one chosen", () => {
      const local = fakeStorage();
      moveSession(THIRTY, 28, 0, undefined, local);
      moveSession(read(THIRTY, undefined, local), 29, 1, undefined, local);
      expect(read(THIRTY, undefined, local)).toEqual(["project-29", "project-30", ...REST]);
    });
  });
});

describe("@oracle:requirement @req:SES-3 each machine keeps its own order in one storage", () => {
  const GIVEN = ["default", "web", "api"];

  it("a move on one machine leaves the same session names on another as they were", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 2, 0, "attic", local);
    expect(read(GIVEN, "attic", local)).toEqual(["api", "default", "web"]);
    expect(read(GIVEN, "workshop", local)).toEqual(GIVEN);
    expect(read(GIVEN, undefined, local)).toEqual(GIVEN);
  });

  it("two machines and the local one each hold a different order at once", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 2, 0, "attic", local);
    moveSession(GIVEN, 1, 0, "workshop", local);
    moveSession(GIVEN, 0, 2, undefined, local);
    expect(read(GIVEN, "attic", local)).toEqual(["api", "default", "web"]);
    expect(read(GIVEN, "workshop", local)).toEqual(["web", "default", "api"]);
    expect(read(GIVEN, undefined, local)).toEqual(["web", "api", "default"]);
  });
});

describe("@oracle:requirement @req:SES-4 a broken store never breaks the sheet", () => {
  const GIVEN = ["a", "b", "c"];

  it.each(["{not json", "", "42", "null", "true", '"a"', "[]", "{}", "[1,2,3]", '{"a":1}', '[{"name":"c"}]'])(
    "the stored value %j reads as the given order",
    (value) => {
      const local = fakeStorage();
      local.setItem(KEY, value);
      expect(read(GIVEN, undefined, local)).toEqual(GIVEN);
      expect(read(GIVEN, "attic", local)).toEqual(GIVEN);
    },
  );

  it("a list that lost its shape inside the stored value reads as the given order", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 2, 0, undefined, local);
    rewriteStored(local, () => 42);
    expect(read(GIVEN, undefined, local)).toEqual(GIVEN);
  });

  it("a list of things that are not names reads as the given order", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 2, 0, undefined, local);
    rewriteStored(local, (list) => list.map((_, i) => (i % 2 === 0 ? i : null)));
    expect(read(GIVEN, undefined, local)).toEqual(GIVEN);
  });

  it("a name stored twice draws one row", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 2, 0, undefined, local);
    rewriteStored(local, (list) => [...list, ...list]);
    expect(read(GIVEN, undefined, local)).toEqual(["c", "a", "b"]);
  });

  it("a move over a broken value still stores the move", () => {
    const local = fakeStorage();
    local.setItem(KEY, "{not json");
    moveSession(GIVEN, 2, 0, undefined, local);
    expect(read(GIVEN, undefined, local)).toEqual(["c", "a", "b"]);
  });

  it("a storage that throws on read gives the given order and no throw", () => {
    const local: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(namesOf(orderSessions(rows(...GIVEN), undefined, local))).toEqual(GIVEN);
    expect(() => moveSession(GIVEN, 2, 0, undefined, local)).not.toThrow();
  });

  it("a storage that throws on write gives no throw", () => {
    const local: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => moveSession(GIVEN, 2, 0, undefined, local)).not.toThrow();
    expect(() => orderSessions(rows(...GIVEN), undefined, local)).not.toThrow();
  });

  it("the default storage throwing on every call gives the given order and no throw", () => {
    forgetSessionOrder();
    const blocked = () => {
      throw new Error("blocked");
    };
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    try {
      expect(namesOf(orderSessions(rows(...GIVEN), undefined))).toEqual(GIVEN);
      expect(() => moveSession(["a", "b"], 1, 0, undefined)).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("no storage at all, the accessor itself refused, gives the given order and no throw", () => {
    forgetSessionOrder();
    const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(namesOf(orderSessions(rows(...GIVEN), undefined))).toEqual(GIVEN);
      expect(() => moveSession(["a", "b"], 1, 0, undefined)).not.toThrow();
    } finally {
      if (own === undefined) Reflect.deleteProperty(globalThis, "localStorage");
      else Object.defineProperty(globalThis, "localStorage", own);
    }
  });
});

describe("@oracle:requirement @req:SES-8 the order goes at unpair", () => {
  const GIVEN = ["a", "b", "c"];

  it("the order is stored under its key", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 2, 0, undefined, local);
    expect(local.values.has(KEY)).toBe(true);
  });

  it("forgetSessionOrder clears every machine's order", () => {
    const local = fakeStorage();
    moveSession(GIVEN, 2, 0, undefined, local);
    moveSession(GIVEN, 2, 0, "attic", local);
    forgetSessionOrder(local);
    expect(read(GIVEN, undefined, local)).toEqual(GIVEN);
    expect(read(GIVEN, "attic", local)).toEqual(GIVEN);
  });

  it("the unpair wipe leaves the given order and no key", async () => {
    forgetSessionOrder();
    moveSession(GIVEN, 2, 0, undefined);
    expect(namesOf(orderSessions(rows(...GIVEN), undefined))).toEqual(["c", "a", "b"]);

    await wipeDevice("unpair");

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(namesOf(orderSessions(rows(...GIVEN), undefined))).toEqual(GIVEN);
  });
});
