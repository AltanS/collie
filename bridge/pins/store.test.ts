import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { pinSessionKey } from "./key.ts";
import { ANCHOR_CHARS, MAX_PIN_CHARS, MAX_PINS, PinStore, SWEEP_DAYS, type PinDraft } from "./store.ts";

// File modes are POSIX: the mode checks are skipped on Windows.
const POSIX_ONLY = HOST.platform === "win32";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "pins-"));
  roots.push(root);
  return join(root, "pins");
}

const T0 = 1_786_000_000_000;
const draft = (itemId: string, over: Partial<PinDraft> = {}): PinDraft => ({ itemId, kind: "reply", text: `text of ${itemId}`, ...over });

function counter(): () => string {
  let n = 0;
  return () => `p${++n}`;
}

describe("the pin store", () => {
  test("lists newest first and keeps each session apart", () => {
    let now = T0;
    const store = new PinStore(null, () => ++now, counter());
    store.add("claude.s1", draft("a:0"));
    store.add("claude.s1", draft("b:0", { kind: "user" }));
    store.add("claude.s2", draft("c:0"));
    expect(store.list("claude.s1").map((pin) => pin.itemId)).toEqual(["b:0", "a:0"]);
    expect(store.list("claude.s2").map((pin) => pin.itemId)).toEqual(["c:0"]);
    expect(store.count("claude.s1")).toBe(2);
    expect(store.count("claude.nothing")).toBe(0);
  });

  test("a tool pin keeps its name and input, and an optional time", () => {
    const store = new PinStore(null, () => T0, counter());
    const added = store.add("claude.s1", draft("toolu_1", { kind: "tool", tool: { name: "Bash", input: "ls" }, ts: "2026-11-06T10:00:00Z" }));
    expect(added).toEqual({
      ok: true,
      created: true,
      pin: { id: "p1", itemId: "toolu_1", kind: "tool", text: "text of toolu_1", anchor: "text of toolu_1", tool: { name: "Bash", input: "ls" }, ts: "2026-11-06T10:00:00Z", pinnedAt: T0 },
    });
  });

  test("pinning a block twice answers the pin it has and spends no cap", () => {
    const store = new PinStore(null, () => T0, counter());
    store.add("claude.s1", draft("a:0"));
    const again = store.add("claude.s1", draft("a:0", { text: "changed" }));
    expect(again).toMatchObject({ ok: true, created: false, pin: { id: "p1", text: "text of a:0" } });
    expect(store.count("claude.s1")).toBe(1);
  });

  test("refuses the 101st pin and keeps the 100", () => {
    const store = new PinStore(null, () => T0);
    for (let i = 0; i < MAX_PINS; i += 1) expect(store.add("claude.s1", draft(`e${i}:0`)).ok).toBe(true);
    expect(store.add("claude.s1", draft("one-more:0"))).toEqual({ ok: false, reason: "cap" });
    expect(store.count("claude.s1")).toBe(MAX_PINS);
    // A block already pinned is still answered at the cap, and an unpin makes room.
    expect(store.add("claude.s1", draft("e0:0")).ok).toBe(true);
    const first = store.list("claude.s1").at(-1)!;
    expect(store.remove("claude.s1", first.id)).toEqual({ ok: true, removed: true });
    expect(store.add("claude.s1", draft("one-more:0")).ok).toBe(true);
  });

  test("keeps the first 80 characters as the anchor, and get finds one pin by id", () => {
    const store = new PinStore(null, () => T0, counter());
    const added = store.add("claude.s1", draft("a:0", { text: "z".repeat(500) }));
    expect(added.ok && added.pin.anchor).toBe("z".repeat(ANCHOR_CHARS));
    expect(store.get("claude.s1", "p1")?.itemId).toBe("a:0");
    expect(store.get("claude.s1", "nope")).toBeUndefined();
  });

  test("a row written before the anchor existed takes it from its text", () => {
    const folder = dir();
    mkdirSync(folder, { recursive: true });
    const old = { id: "p1", itemId: "a:0", kind: "user", text: "q".repeat(200), pinnedAt: T0 };
    writeFileSync(join(folder, "claude.s1.json"), JSON.stringify({ v: 1, pins: [old] }));
    expect(new PinStore(folder).list("claude.s1")[0]!.anchor).toBe("q".repeat(ANCHOR_CHARS));
  });

  test("cuts the text at the Chat cap", () => {
    const store = new PinStore(null, () => T0);
    const added = store.add("claude.s1", draft("a:0", { text: "x".repeat(MAX_PIN_CHARS + 500) }));
    expect(added.ok && added.pin.text.length).toBe(MAX_PIN_CHARS);
  });

  test("remove is idempotent", () => {
    const store = new PinStore(null, () => T0, counter());
    store.add("claude.s1", draft("a:0"));
    expect(store.remove("claude.s1", "p1")).toEqual({ ok: true, removed: true });
    expect(store.remove("claude.s1", "p1")).toEqual({ ok: true, removed: false });
    expect(store.remove("claude.never", "p9")).toEqual({ ok: true, removed: false });
    expect(store.list("claude.s1")).toEqual([]);
  });

  test("refuses a key that is not a file name", () => {
    const store = new PinStore(null);
    expect(() => store.list("../escape")).toThrow();
    expect(() => store.add("a/b", draft("a:0"))).toThrow();
    expect(() => store.count("..")).toThrow();
  });
});

describe("the pin file", () => {
  test("writes a v1 envelope, survives a restart, and keeps the 0700 folder and 0600 file", () => {
    const folder = dir();
    const first = new PinStore(folder, () => T0, counter());
    first.add("claude.s1", draft("a:0"));
    first.add("claude.s1", draft("toolu_1", { kind: "tool", tool: { name: "Read" } }));
    const file = join(folder, "claude.s1.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      v: 1,
      pins: [
        { id: "p1", itemId: "a:0", kind: "reply", text: "text of a:0", pinnedAt: T0, anchor: "text of a:0" },
        { id: "p2", itemId: "toolu_1", kind: "tool", text: "text of toolu_1", tool: { name: "Read" }, pinnedAt: T0, anchor: "text of toolu_1" },
      ],
    });
    expect(readdirSync(folder)).toEqual(["claude.s1.json"]);
    if (!POSIX_ONLY) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(folder).mode & 0o777).toBe(0o700);
    }
    const second = new PinStore(folder, () => T0 + 1, counter());
    expect(second.list("claude.s1").map((pin) => pin.id)).toEqual(["p2", "p1"]);
    expect(second.remove("claude.s1", "p1")).toEqual({ ok: true, removed: true });
    expect(new PinStore(folder).list("claude.s1").map((pin) => pin.id)).toEqual(["p2"]);
  });

  test("writes no file for a read", () => {
    const folder = dir();
    const store = new PinStore(folder);
    expect(store.list("claude.s1")).toEqual([]);
    expect(store.count("claude.s1")).toBe(0);
    expect(existsSync(folder)).toBe(false);
  });

  test("a file that does not parse, or has another version, reads as empty until the next write", () => {
    const folder = dir();
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "claude.bad.json"), "{not json");
    writeFileSync(join(folder, "claude.new.json"), JSON.stringify({ v: 2, pins: [{ id: "x" }] }));
    const store = new PinStore(folder, () => T0, counter());
    expect(store.list("claude.bad")).toEqual([]);
    expect(store.list("claude.new")).toEqual([]);
    expect(readFileSync(join(folder, "claude.bad.json"), "utf8")).toBe("{not json");
    expect(store.add("claude.bad", draft("a:0")).ok).toBe(true);
    expect(new PinStore(folder).list("claude.bad")).toHaveLength(1);
  });

  test("a row that is malformed is skipped and the rest are kept", () => {
    const folder = dir();
    mkdirSync(folder, { recursive: true });
    const good = { id: "p1", itemId: "a:0", kind: "user" as const, text: "hi", pinnedAt: T0, anchor: "hi" };
    writeFileSync(join(folder, "claude.s1.json"), JSON.stringify({ v: 1, pins: [{ id: "p0", kind: "bogus" }, good, 7] }));
    expect(new PinStore(folder).list("claude.s1")).toEqual([good]);
  });

  test("a write that fails is reported, and memory keeps what the disk has", () => {
    const folder = dir();
    const store = new PinStore(folder, () => T0, counter());
    store.add("claude.s1", draft("a:0"));
    store.add("claude.s1", draft("c:0"));
    // A folder where the temp file goes makes the write throw on every platform and for root too.
    mkdirSync(join(folder, "claude.s1.json.tmp"));
    expect(store.add("claude.s1", draft("b:0"))).toEqual({ ok: false, reason: "write" });
    expect(store.remove("claude.s1", "p1")).toEqual({ ok: false, reason: "write" });
    expect(store.list("claude.s1").map((pin) => pin.itemId)).toEqual(["c:0", "a:0"]);
  });
});

describe("the lifecycle of a pin file", () => {
  test("the file goes when its last pin is removed, and a new pin makes it again", () => {
    const folder = dir();
    const store = new PinStore(folder, () => T0, counter());
    store.add("claude.s1", draft("a:0"));
    store.add("claude.s1", draft("b:0"));
    const file = join(folder, "claude.s1.json");
    store.remove("claude.s1", "p1");
    expect(existsSync(file)).toBe(true);
    store.remove("claude.s1", "p2");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(folder)).toEqual([]);
    expect(new PinStore(folder).list("claude.s1")).toEqual([]);
    expect(store.add("claude.s1", draft("c:0")).ok).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  test("sweep removes a file not written for 180 days, keeps a newer one, and clears a stale temp file", () => {
    const folder = dir();
    const store = new PinStore(folder);
    store.add("claude.old", draft("a:0"));
    store.add("claude.fresh", draft("b:0"));
    writeFileSync(join(folder, "claude.crash.json.tmp"), "{}");
    const day = 86_400_000;
    const age = (name: string, days: number) => utimesSync(join(folder, name), new Date(Date.now() - days * day), new Date(Date.now() - days * day));
    age("claude.old.json", SWEEP_DAYS + 1);
    age("claude.crash.json.tmp", SWEEP_DAYS + 1);
    age("claude.fresh.json", SWEEP_DAYS - 1);
    expect(new PinStore(folder).sweep()).toBe(2);
    expect(readdirSync(folder)).toEqual(["claude.fresh.json"]);
    expect(new PinStore(folder).list("claude.old")).toEqual([]);
    expect(new PinStore(folder).sweep()).toBe(0);
  });

  test("sweep with no folder, or an in-memory store, does nothing", () => {
    expect(new PinStore(dir()).sweep()).toBe(0);
    expect(new PinStore(null).sweep()).toBe(0);
  });
});

describe("the session key", () => {
  test("keeps a plain id and hashes a path, and the two never meet", () => {
    expect(pinSessionKey("claude", { kind: "id", value: "6f1c2e0a-1b2c-4d3e-8f90-0123456789ab" })).toBe("claude.6f1c2e0a-1b2c-4d3e-8f90-0123456789ab");
    const path = pinSessionKey("pi", { kind: "path", value: "/home/me/.pi/sessions/x.jsonl" });
    expect(path).toMatch(/^pi\.p-[0-9a-f]{32}$/);
    expect(path).not.toContain("/");
    expect(pinSessionKey("pi", { kind: "id", value: "../../etc" })).toMatch(/^pi\.[0-9a-f]{32}$/);
    expect(pinSessionKey("pi", { kind: "id", value: ".." })).toMatch(/^pi\.[0-9a-f]{32}$/);
  });
});
