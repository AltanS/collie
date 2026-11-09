import { enterSlot, rememberSlotPane, slotSpace } from "./slots";

// Each tile of the owner's browser is a tab pinned at its own `/slot/<n>`. These cases hold the
// requirement «при закрытии и открытии браузера оставались те же проекты в которых я работал до
// закрытия браузера» against the public functions only: no key name and no stored format appears
// here. A tab is a sessionStorage of its own; the device is one localStorage; a browser restart is
// new empty sessionStorages on the same localStorage.

const HOME = "/";

type FakeStorage = Pick<Storage, "getItem" | "setItem"> & { values: Map<string, string> };

function fakeStorage(): FakeStorage {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

/** Overwrites what is stored, through the Storage interface, without naming a key. */
function overwriteEveryValue(storage: FakeStorage, next: (old: string) => string) {
  for (const [key, old] of storage.values) storage.setItem(key, next(old));
}

/** What a brand-new tab would be sent to for this slot. Marks only that new tab. */
function addressAfterRestart(slot: string, local: FakeStorage) {
  return enterSlot(slot, fakeStorage(), local);
}

/** A tab that opened `/slot/<slot>` and then showed this pane. */
function visitInSlot(slot: string, address: string, local: FakeStorage) {
  const session = fakeStorage();
  enterSlot(slot, session, local);
  showPage(address, session, local);
  return session;
}

function showPage(address: string, session: FakeStorage, local: FakeStorage) {
  const at = address.indexOf("?");
  const pathname = at === -1 ? address : address.slice(0, at);
  const search = at === -1 ? "" : address.slice(at);
  rememberSlotPane(pathname, search, session, local);
}

function everySlot() {
  return Array.from({ length: 99 }, (_, idx) => String(idx + 1));
}

function expectNoSlotHasAnAddress(local: FakeStorage) {
  for (const slot of everySlot()) expect(addressAfterRestart(slot, local), `slot ${slot}`).toBe(HOME);
}

describe("@oracle:requirement @req:SLOT-1 a stored address is where the slot leads", () => {
  it("keeps the pane's address and its query verbatim", () => {
    const local = fakeStorage();
    visitInSlot("3", "/pane/w3%3Ap1?s=project-ss-form", local);
    expect(addressAfterRestart("3", local)).toBe("/pane/w3%3Ap1?s=project-ss-form");
  });

  it("keeps a query of several parameters in its own order and encoding", () => {
    const local = fakeStorage();
    visitInSlot("3", "/pane/p1?z=1&s=a%20b&h=peer", local);
    expect(addressAfterRestart("3", local)).toBe("/pane/p1?z=1&s=a%20b&h=peer");
  });

  it("keeps a pane address without a query", () => {
    const local = fakeStorage();
    visitInSlot("3", "/pane/p1", local);
    expect(addressAfterRestart("3", local)).toBe("/pane/p1");
  });

  it.each(["1", "9", "10", "42", "99"])("treats %s as a valid slot number", (slot) => {
    const local = fakeStorage();
    visitInSlot(slot, `/pane/in-${slot}`, local);
    expect(addressAfterRestart(slot, local)).toBe(`/pane/in-${slot}`);
  });
});

describe("@oracle:requirement @req:SLOT-2 a slot never used", () => {
  it("leads home on an empty device", () => {
    expect(addressAfterRestart("1", fakeStorage())).toBe(HOME);
  });

  it("leads home while another slot has an address", () => {
    const local = fakeStorage();
    visitInSlot("1", "/pane/a", local);
    expect(addressAfterRestart("2", local)).toBe(HOME);
    // Slots 1 and 11 are different slots, whatever the stored form looks like.
    expect(addressAfterRestart("11", local)).toBe(HOME);
  });
});

describe("@oracle:requirement @req:SLOT-3 moving between panes in a slot tab", () => {
  it("updates that slot to the last pane shown", () => {
    const local = fakeStorage();
    const session = visitInSlot("2", "/pane/a?s=one", local);
    showPage("/pane/b?s=two", session, local);
    expect(addressAfterRestart("2", local)).toBe("/pane/b?s=two");
    showPage("/pane/b?s=three", session, local);
    expect(addressAfterRestart("2", local)).toBe("/pane/b?s=three");
  });

  it("leaves the other slots as they were", () => {
    const local = fakeStorage();
    visitInSlot("1", "/pane/first", local);
    visitInSlot("3", "/pane/third", local);
    const session = visitInSlot("2", "/pane/a", local);
    showPage("/pane/b", session, local);
    expect(addressAfterRestart("1", local)).toBe("/pane/first");
    expect(addressAfterRestart("3", local)).toBe("/pane/third");
  });

  it("drops a query the new address no longer has", () => {
    const local = fakeStorage();
    const session = visitInSlot("2", "/pane/a?s=one", local);
    showPage("/pane/a", session, local);
    expect(addressAfterRestart("2", local)).toBe("/pane/a");
  });
});

describe("@oracle:requirement @req:SLOT-4 the owner's five tiles", () => {
  const SLOTS = ["1", "2", "3", "4", "5"];
  const opened = (slot: string) => `/pane/w${slot}%3Ap1?s=project-${slot}`;
  const moved = (slot: string) => `/pane/w${slot}%3Ap2?s=project-${slot}-next`;

  function workInFiveTabs(local: FakeStorage) {
    // All five tabs live at once and take turns: no tab finishes before the next one starts.
    const sessions = new Map(SLOTS.map((slot) => [slot, fakeStorage()]));
    const session = (slot: string) => sessions.get(slot) ?? fakeStorage();
    for (const slot of SLOTS) expect(enterSlot(slot, session(slot), local)).toBe(HOME);
    for (const slot of SLOTS) showPage(opened(slot), session(slot), local);
    for (const slot of SLOTS.toReversed()) showPage(moved(slot), session(slot), local);
    return session;
  }

  it("keeps each tab's own pane while all five are open", () => {
    const local = fakeStorage();
    const session = workInFiveTabs(local);
    for (const slot of SLOTS) expect(enterSlot(slot, session(slot), local)).toBe(moved(slot));
  });

  it("returns each tile to its own last pane after a browser restart", () => {
    const local = fakeStorage();
    workInFiveTabs(local);
    for (const slot of SLOTS) expect(addressAfterRestart(slot, local)).toBe(moved(slot));
  });

  it("does the same when the tiles come back in another order", () => {
    const local = fakeStorage();
    workInFiveTabs(local);
    for (const slot of ["4", "1", "5", "3", "2"]) expect(addressAfterRestart(slot, local)).toBe(moved(slot));
  });

  it("reads the device's storage after a restart, not memory of this page's life", async () => {
    const local = fakeStorage();
    workInFiveTabs(local);
    vi.resetModules();
    const restarted = await import("./slots");
    for (const slot of SLOTS) expect(restarted.enterSlot(slot, fakeStorage(), local)).toBe(moved(slot));
  });

  it("keeps storing after the restart: a tile that came back is still its slot", () => {
    const local = fakeStorage();
    workInFiveTabs(local);
    const session = fakeStorage();
    enterSlot("2", session, local);
    showPage("/pane/later?s=after-restart", session, local);
    expect(addressAfterRestart("2", local)).toBe("/pane/later?s=after-restart");
    for (const slot of ["1", "3", "4", "5"]) expect(addressAfterRestart(slot, local)).toBe(moved(slot));
  });
});

describe("@oracle:requirement @req:SLOT-5 a tab never opened through /slot", () => {
  it("writes nothing on an empty device", () => {
    const local = fakeStorage();
    rememberSlotPane("/pane/link", "?s=elsewhere", fakeStorage(), local);
    expect(local.values.size).toBe(0);
    expectNoSlotHasAnAddress(local);
  });

  it("does not change a slot another tab stored", () => {
    const local = fakeStorage();
    visitInSlot("1", "/pane/mine?s=one", local);
    const before = new Map(local.values);
    rememberSlotPane("/pane/link", "?s=elsewhere", fakeStorage(), local);
    expect(local.values).toEqual(before);
    expect(addressAfterRestart("1", local)).toBe("/pane/mine?s=one");
  });

  it("writes nothing on its later panes either", () => {
    const local = fakeStorage();
    const session = fakeStorage();
    rememberSlotPane("/pane/link", "", session, local);
    rememberSlotPane("/pane/link-2", "", session, local);
    expect(local.values.size).toBe(0);
  });
});

describe("@oracle:requirement @req:SLOT-6 pages that are not a pane page", () => {
  it.each([
    ["/", ""],
    ["/", "?h=peer"],
    ["/settings", ""],
    ["/settings/system", ""],
    ["/space/w1", ""],
    ["/new", ""],
    ["/crew", ""],
    ["/slot/3", ""],
    ["/pane", ""],
    ["/pane/", ""],
    ["/panes/x", ""],
    ["/x/pane/y", ""],
    ["/pane/x/history", ""],
    ["/pane/x/history", "?s=project"],
    ["/pane/x/zoom", ""],
    ["/pane/x/changes", ""],
    ["/pane/x/changes", "?s=project"],
    ["/pane/x/changes/files", "?dir=a"],
  ])("%s%s keeps the stored address", (pathname, search) => {
    const local = fakeStorage();
    const session = visitInSlot("4", "/pane/last?s=project", local);
    rememberSlotPane(pathname, search, session, local);
    expect(addressAfterRestart("4", local)).toBe("/pane/last?s=project");
  });

  it("stores nothing for a slot that has only seen such pages", () => {
    const local = fakeStorage();
    const session = fakeStorage();
    enterSlot("4", session, local);
    for (const address of ["/", "/settings", "/pane/x/history", "/pane/x/zoom"]) showPage(address, session, local);
    expect(addressAfterRestart("4", local)).toBe(HOME);
  });

  it("still takes the next pane after them", () => {
    const local = fakeStorage();
    const session = visitInSlot("4", "/pane/one", local);
    showPage("/settings", session, local);
    showPage("/pane/one/history", session, local);
    showPage("/pane/two", session, local);
    expect(addressAfterRestart("4", local)).toBe("/pane/two");
  });
});

describe("@oracle:requirement @req:SLOT-7 invalid slot numbers", () => {
  const INVALID = ["0", "00", "100", "101", "999", "abc", "01", "007", "1x", "x1", "", " ", " 1", "1 ", "1\n", "-1", "+1", "1.5", "1e1", "0x1", "٣", "__proto__", "constructor"];

  it.each(INVALID)("%j leads home", (raw) => {
    const local = fakeStorage();
    visitInSlot("1", "/pane/a", local);
    expect(enterSlot(raw, fakeStorage(), local)).toBe(HOME);
  });

  it("undefined leads home", () => {
    const local = fakeStorage();
    visitInSlot("1", "/pane/a", local);
    expect(enterSlot(undefined, fakeStorage(), local)).toBe(HOME);
  });

  it.each(INVALID)("%j marks nothing: a later pane visit stores nothing", (raw) => {
    const local = fakeStorage();
    const session = fakeStorage();
    enterSlot(raw, session, local);
    rememberSlotPane("/pane/later", "?s=x", session, local);
    expect(local.values.size).toBe(0);
    expectNoSlotHasAnAddress(local);
  });

  it("undefined marks nothing: a later pane visit stores nothing", () => {
    const local = fakeStorage();
    const session = fakeStorage();
    enterSlot(undefined, session, local);
    rememberSlotPane("/pane/later", "", session, local);
    expect(local.values.size).toBe(0);
    expectNoSlotHasAnAddress(local);
  });

  it("a later pane visit leaves another tab's slot alone", () => {
    const local = fakeStorage();
    visitInSlot("1", "/pane/a", local);
    const session = fakeStorage();
    enterSlot("abc", session, local);
    rememberSlotPane("/pane/later", "", session, local);
    expect(addressAfterRestart("1", local)).toBe("/pane/a");
  });
});

describe("@oracle:requirement @req:SLOT-8 stored data that cannot be trusted", () => {
  const MARK = "/pane/mark-to-replace?s=mark";
  const NOT_PANE = [
    "https://evil.example/",
    "https://evil.example/pane/x",
    "//evil.example/pane/x",
    "/\\evil.example/pane/x",
    "/settings",
    "/",
    "/pane/x/history",
    "/pane/x/zoom",
    "/pane/x/changes",
    "/pane/",
    "/pane//evil.example",
    "/pane/x/../../settings",
    "pane/x",
    "javascript:alert(1)",
    "",
  ];

  // Whatever one value holds (one slot's address or all of them), it now holds something else whole.
  const WHOLE_VALUES = [...new Set([
    "{broken",
    "null",
    "true",
    "42",
    "[]",
    "{}",
    '["/pane/x"]',
    '{"3":42}',
    '{"3":null}',
    '{"3":{}}',
    '{"3":["/pane/x"]}',
    ...NOT_PANE,
    ...NOT_PANE.map((address) => JSON.stringify(address)),
    ...NOT_PANE.map((address) => JSON.stringify({ "3": address })),
  ])];

  it.each(WHOLE_VALUES)("a stored value of %j leads home", (garbage) => {
    const local = fakeStorage();
    visitInSlot("3", "/pane/good", local);
    overwriteEveryValue(local, () => garbage);
    expect(addressAfterRestart("3", local)).toBe(HOME);
  });

  // The value keeps its own shape and only the address inside it changes, so the address itself is
  // what must be refused: no JSON or shape check can catch this one. A stored form in which the
  // address is not readable text cannot be planted this way, and that case reports as skipped.
  it.for(NOT_PANE)("an address of %j inside a well-formed value leads home", (address, ctx) => {
    const local = fakeStorage();
    visitInSlot("3", MARK, local);
    const carriesAddress = [...local.values.values()].some((value) => value.includes(MARK));
    if (!carriesAddress) {
      ctx.skip();
      return;
    }
    overwriteEveryValue(local, (old) => old.split(MARK).join(address.replaceAll("\\", "\\\\")));
    expect(addressAfterRestart("3", local)).toBe(HOME);
  });

  it.each(WHOLE_VALUES)("after a stored value of %j the slot takes a new pane again", (garbage) => {
    const local = fakeStorage();
    visitInSlot("3", "/pane/good", local);
    overwriteEveryValue(local, () => garbage);
    visitInSlot("3", "/pane/after?s=fresh", local);
    expect(addressAfterRestart("3", local)).toBe("/pane/after?s=fresh");
  });
});

describe("@oracle:requirement @req:SLOT-9 a storage that throws", () => {
  const refuse = () => {
    throw new DOMException("denied", "SecurityError");
  };
  const unreadable = (): FakeStorage => ({ ...fakeStorage(), getItem: refuse });
  const unwritable = (): FakeStorage => ({ ...fakeStorage(), setItem: refuse });
  const dead = (): FakeStorage => ({ ...fakeStorage(), getItem: refuse, setItem: refuse });

  it("enterSlot leads home when the device storage cannot be read", () => {
    expect(enterSlot("1", fakeStorage(), unreadable())).toBe(HOME);
  });

  it("enterSlot leads home when both storages refuse everything", () => {
    expect(enterSlot("1", dead(), dead())).toBe(HOME);
  });

  it("enterSlot leads home when the tab storage refuses and nothing is stored", () => {
    expect(enterSlot("1", dead(), fakeStorage())).toBe(HOME);
    expect(enterSlot("1", unwritable(), fakeStorage())).toBe(HOME);
  });

  it("enterSlot does not throw and gives a usable address when only the tab storage refuses", () => {
    const local = fakeStorage();
    visitInSlot("1", "/pane/a", local);
    expect([HOME, "/pane/a"]).toContain(enterSlot("1", dead(), local));
  });

  it("enterSlot leads home for an invalid slot when both storages refuse", () => {
    expect(enterSlot("abc", dead(), dead())).toBe(HOME);
    expect(enterSlot(undefined, dead(), dead())).toBe(HOME);
  });

  it("rememberSlotPane does not throw when the device storage refuses", () => {
    const session = fakeStorage();
    enterSlot("1", session, fakeStorage());
    expect(() => rememberSlotPane("/pane/a", "", session, dead())).not.toThrow();
    expect(() => rememberSlotPane("/pane/a", "", session, unwritable())).not.toThrow();
    expect(() => rememberSlotPane("/pane/a", "", session, unreadable())).not.toThrow();
  });

  it("rememberSlotPane does not throw when the tab storage refuses", () => {
    expect(() => rememberSlotPane("/pane/a", "", dead(), fakeStorage())).not.toThrow();
    expect(() => rememberSlotPane("/settings", "", dead(), dead())).not.toThrow();
  });

  it("a tab whose storage refuses changes no slot", () => {
    const local = fakeStorage();
    visitInSlot("1", "/pane/a", local);
    rememberSlotPane("/pane/b", "", dead(), local);
    expect(addressAfterRestart("1", local)).toBe("/pane/a");
  });

  describe("the default storages", () => {
    // A locked-down browser throws on reading `window.localStorage` itself, before any getItem.
    const NAMES = ["localStorage", "sessionStorage"] as const;
    const originals = new Map<string, PropertyDescriptor | undefined>();
    function refuseAccessTo(name: (typeof NAMES)[number]) {
      Object.defineProperty(window, name, { configurable: true, get: refuse });
    }
    beforeEach(() => {
      for (const name of NAMES) originals.set(name, Object.getOwnPropertyDescriptor(window, name));
    });
    afterEach(() => {
      for (const [name, descriptor] of originals) {
        Reflect.deleteProperty(window, name);
        if (descriptor) Object.defineProperty(window, name, descriptor);
      }
    });

    it("enterSlot leads home when reaching window.localStorage throws", () => {
      refuseAccessTo("localStorage");
      expect(enterSlot("1")).toBe(HOME);
    });

    it("enterSlot leads home when reaching window.sessionStorage throws", () => {
      refuseAccessTo("sessionStorage");
      expect(enterSlot("1")).toBe(HOME);
    });

    it("rememberSlotPane does not throw when reaching either one throws", () => {
      refuseAccessTo("sessionStorage");
      expect(() => rememberSlotPane("/pane/a", "")).not.toThrow();
      refuseAccessTo("localStorage");
      expect(() => rememberSlotPane("/pane/a", "")).not.toThrow();
    });
  });
});

describe("@oracle:requirement @req:SLOT-10 a tab in one slot that opens another", () => {
  it("leads to the new slot's address", () => {
    const local = fakeStorage();
    visitInSlot("2", "/pane/two", local);
    const session = visitInSlot("1", "/pane/one", local);
    expect(enterSlot("2", session, local)).toBe("/pane/two");
  });

  it("stores later panes for the new slot and leaves the old slot alone", () => {
    const local = fakeStorage();
    const session = visitInSlot("1", "/pane/one", local);
    expect(enterSlot("2", session, local)).toBe(HOME);
    showPage("/pane/moved", session, local);
    expect(addressAfterRestart("2", local)).toBe("/pane/moved");
    expect(addressAfterRestart("1", local)).toBe("/pane/one");
  });
});

describe("the default storages are the window's own @oracle:requirement @req:SLOT-4", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("marks the tab in sessionStorage and the address in localStorage: a restart keeps the address", () => {
    enterSlot("6");
    rememberSlotPane("/pane/w6", "?s=project");
    window.sessionStorage.clear();
    expect(enterSlot("6")).toBe("/pane/w6?s=project");
  });

  it("forgets the tab's slot when sessionStorage is new: the next pane is not stored", () => {
    enterSlot("6");
    rememberSlotPane("/pane/w6", "");
    window.sessionStorage.clear();
    rememberSlotPane("/pane/other", "");
    expect(enterSlot("6")).toBe("/pane/w6");
  });
});

// A pane id is unique only within one bridge process and a slot outlives that process, so the slot
// also keeps the name of the workspace the pane stood in. The route compares it (routes/slot.test.tsx).
describe("@oracle:requirement @req:SLOT-11 the workspace name a slot keeps", () => {
  const ADDRESS = "/pane/w3%3Ap1?s=project-x";
  const PATH = "/pane/w3%3Ap1";
  const QUERY = "?s=project-x";

  function tabInSlot(slot: string, local: FakeStorage) {
    const session = fakeStorage();
    enterSlot(slot, session, local);
    return session;
  }

  it("returns the name stored with the pane, and the address is unchanged", () => {
    const local = fakeStorage();
    rememberSlotPane(PATH, QUERY, tabInSlot("3", local), local, "A");
    expect(slotSpace("3", local)).toBe("A");
    expect(addressAfterRestart("3", local)).toBe(ADDRESS);
  });

  it("keeps a name with quotes, slashes and Cyrillic letters verbatim", () => {
    const local = fakeStorage();
    const name = 'проект «А» "x"/y\\z {1}';
    rememberSlotPane(PATH, QUERY, tabInSlot("3", local), local, name);
    expect(slotSpace("3", local)).toBe(name);
  });

  it("a call without a name for the same address keeps the name stored before", () => {
    const local = fakeStorage();
    const session = tabInSlot("3", local);
    rememberSlotPane(PATH, QUERY, session, local, "A");
    rememberSlotPane(PATH, QUERY, session, local);
    expect(slotSpace("3", local)).toBe("A");
  });

  it("a call without a name for the same address keeps the name after a restart too", () => {
    const local = fakeStorage();
    rememberSlotPane(PATH, QUERY, tabInSlot("3", local), local, "A");
    rememberSlotPane(PATH, QUERY, tabInSlot("3", local), local);
    expect(slotSpace("3", local)).toBe("A");
  });

  it("a call without a name for another pane stores no name", () => {
    const local = fakeStorage();
    const session = tabInSlot("3", local);
    rememberSlotPane(PATH, QUERY, session, local, "A");
    rememberSlotPane("/pane/other", QUERY, session, local);
    expect(slotSpace("3", local)).toBeUndefined();
    expect(addressAfterRestart("3", local)).toBe(`/pane/other${QUERY}`);
  });

  it("the same pane under another query is another address: it stores no name", () => {
    const local = fakeStorage();
    const session = tabInSlot("3", local);
    rememberSlotPane(PATH, QUERY, session, local, "A");
    rememberSlotPane(PATH, "?s=project-y", session, local);
    expect(slotSpace("3", local)).toBeUndefined();
  });

  it("a new name replaces the old one, for the same address and for another", () => {
    const local = fakeStorage();
    const session = tabInSlot("3", local);
    rememberSlotPane(PATH, QUERY, session, local, "A");
    rememberSlotPane(PATH, QUERY, session, local, "B");
    expect(slotSpace("3", local)).toBe("B");
    rememberSlotPane("/pane/other", "", session, local, "C");
    expect(slotSpace("3", local)).toBe("C");
  });

  it("a page that is not a pane page changes neither the address nor the name", () => {
    const local = fakeStorage();
    const session = tabInSlot("3", local);
    rememberSlotPane(PATH, QUERY, session, local, "A");
    rememberSlotPane("/settings", "", session, local, "Z");
    rememberSlotPane("/pane/x/history", "", session, local, "Z");
    expect(slotSpace("3", local)).toBe("A");
    expect(addressAfterRestart("3", local)).toBe(ADDRESS);
  });

  it("a tab outside any slot stores no name", () => {
    const local = fakeStorage();
    rememberSlotPane(PATH, QUERY, tabInSlot("3", local), local, "A");
    rememberSlotPane(PATH, QUERY, fakeStorage(), local, "Z");
    expect(slotSpace("3", local)).toBe("A");
  });

  it("each slot has its own name", () => {
    const local = fakeStorage();
    rememberSlotPane(PATH, QUERY, tabInSlot("3", local), local, "A");
    rememberSlotPane(PATH, QUERY, tabInSlot("4", local), local, "B");
    expect(slotSpace("3", local)).toBe("A");
    expect(slotSpace("4", local)).toBe("B");
  });

  it("is undefined for a pane stored with no name, and for a slot never used", () => {
    const local = fakeStorage();
    rememberSlotPane(PATH, QUERY, tabInSlot("3", local), local);
    expect(slotSpace("3", local)).toBeUndefined();
    expect(slotSpace("4", local)).toBeUndefined();
    expect(addressAfterRestart("3", local)).toBe(ADDRESS);
  });

  it.each(["0", "100", "abc", "01", "1x", "", undefined])("is undefined for the invalid slot %j", (raw) => {
    const local = fakeStorage();
    rememberSlotPane(PATH, QUERY, tabInSlot("1", local), local, "A");
    expect(slotSpace(raw, local)).toBeUndefined();
  });

  it.each(["{broken", "", "null", "true", "42", "[]", "{}", '["A"]', '{"3":42}', '{"3":null}', '{"space":42}', '{"name":42}'])(
    "is undefined when the stored value is %j",
    (garbage) => {
      const local = fakeStorage();
      rememberSlotPane(PATH, QUERY, tabInSlot("3", local), local, "A");
      overwriteEveryValue(local, () => garbage);
      expect(slotSpace("3", local)).toBeUndefined();
    },
  );

  it("is undefined and does not throw when the device storage refuses", () => {
    const refusing: FakeStorage = {
      ...fakeStorage(),
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(slotSpace("3", refusing)).toBeUndefined();
  });

  it("is undefined and does not throw when reaching window.localStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      expect(slotSpace("3")).toBeUndefined();
    } finally {
      Reflect.deleteProperty(window, "localStorage");
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });

  it("rememberSlotPane with a name does not throw when a storage refuses", () => {
    const refusing: FakeStorage = {
      ...fakeStorage(),
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    const local = fakeStorage();
    expect(() => rememberSlotPane(PATH, QUERY, tabInSlot("3", local), refusing, "A")).not.toThrow();
    expect(() => rememberSlotPane(PATH, QUERY, refusing, local, "A")).not.toThrow();
  });

  it("uses the window's own localStorage by default", () => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    enterSlot("6");
    rememberSlotPane(PATH, QUERY, undefined, undefined, "A");
    window.sessionStorage.clear();
    expect(slotSpace("6")).toBe("A");
    window.localStorage.clear();
  });
});
