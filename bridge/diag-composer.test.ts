import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.ts";
import { HOST } from "./host.ts";
import {
  COMPOSER_DIAG_KEYS,
  ComposerDiagStore,
  DIAG_COMPOSER_FILE,
  DIAG_COMPOSER_MAX_BYTES,
  DIAG_COMPOSER_MAX_LINES,
  diagFileIo,
  parseComposerDiag,
  type ComposerDiag,
  type DiagIo,
} from "./diag-composer.ts";
import type { JsonObject } from "./json.ts";
import { ensureOwnerOnlyDir, isOwnerOnly, privateRoot } from "./owner-only.ts";
import { DEVICES_FILENAME, filePairingIo, PairingStore, sha256Hex } from "./pairing.ts";
import { apiFrontGate, guard } from "./server.ts";

const GOOD: ComposerDiag = {
  innerHeight: 900,
  visualHeight: 820,
  visualOffsetTop: 0,
  visualScalePct: 100,
  screenHeight: 915,
  clientHeight: 900,
  scrollTop: 0,
  composerTop: 840,
  composerBottom: 920,
  scrollerHeight: 900,
  scrollerTop: 0,
  msSinceForeground: 1200,
  standalone: true,
  pinRecent: false,
  keyboardOpen: false,
  trigger: "foreground",
  pinAction: "none",
  paneKind: "agent",
};

const body = (patch: JsonObject = {}): JsonObject => ({ ...GOOD, ...patch });

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-diag-composer-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("the composer diagnostic validator", () => {
  test("a record with every key, in range, is believed", () => {
    expect(parseComposerDiag(body())).toEqual(GOOD);
  });

  test("the key set is fixed: it is what the phone sends and nothing else", () => {
    expect(COMPOSER_DIAG_KEYS).toEqual(Object.keys(GOOD).toSorted());
  });

  test("an extra key is refused, however harmless it looks", () => {
    expect(parseComposerDiag(body({ note: "hello" }))).toBeNull();
    expect(parseComposerDiag(body({ extra: 1 }))).toBeNull();
    expect(parseComposerDiag(body({ paneId: "w1:p1" }))).toBeNull();
  });

  test("a missing key is refused", () => {
    const { scrollTop: _drop, ...rest } = body();
    expect(parseComposerDiag(rest)).toBeNull();
  });

  test("a string, null or boolean where a number goes is refused", () => {
    expect(parseComposerDiag(body({ innerHeight: "900" }))).toBeNull();
    expect(parseComposerDiag(body({ innerHeight: null }))).toBeNull();
    expect(parseComposerDiag(body({ innerHeight: true }))).toBeNull();
  });

  test("a fraction is refused: the phone rounds every number", () => {
    expect(parseComposerDiag(body({ visualHeight: 820.5 }))).toBeNull();
  });

  test("a number out of its range is refused", () => {
    expect(parseComposerDiag(body({ innerHeight: -1 }))).toBeNull();
    expect(parseComposerDiag(body({ innerHeight: 20_001 }))).toBeNull();
    expect(parseComposerDiag(body({ visualScalePct: 0 }))).toBeNull();
    expect(parseComposerDiag(body({ scrollTop: 1_000_001 }))).toBeNull();
    expect(parseComposerDiag(body({ msSinceForeground: 7 * 24 * 60 * 60 * 1000 + 1 }))).toBeNull();
    expect(parseComposerDiag(body({ composerTop: Number.MAX_SAFE_INTEGER }))).toBeNull();
  });

  test("a negative offset and a composer above the top are real readings and pass", () => {
    expect(parseComposerDiag(body({ visualOffsetTop: -40, composerTop: -300 }))).not.toBeNull();
  });

  test("a boolean field holds a boolean, an enum field one of its words", () => {
    expect(parseComposerDiag(body({ standalone: "true" }))).toBeNull();
    expect(parseComposerDiag(body({ keyboardOpen: 1 }))).toBeNull();
    expect(parseComposerDiag(body({ trigger: "later" }))).toBeNull();
    expect(parseComposerDiag(body({ pinAction: "repinned" }))).toBeNull();
    expect(parseComposerDiag(body({ paneKind: "claude" }))).toBeNull();
  });

  test("what is not an object is refused", () => {
    expect(parseComposerDiag(undefined)).toBeNull();
    expect(parseComposerDiag(null)).toBeNull();
    expect(parseComposerDiag([])).toBeNull();
    expect(parseComposerDiag("text")).toBeNull();
    expect(parseComposerDiag(7)).toBeNull();
  });
});

function memoryIo(initial: string | null = null): DiagIo & { text: string | null } {
  const io = {
    text: initial,
    read: () => Promise.resolve(io.text),
    append: (t: string) => {
      io.text = (io.text ?? "") + t;
      return Promise.resolve();
    },
    replace: (t: string) => {
      io.text = t;
      return Promise.resolve();
    },
  };
  return io;
}

describe("the composer diagnostic file", () => {
  test("a record becomes one line with the server time, the version and the device label", async () => {
    const io = memoryIo();
    const store = new ComposerDiagStore(io, { version: "1.29.1", now: () => Date.UTC(2026, 10, 18, 9, 30) });
    expect(await store.record(GOOD, "Pixel")).toBe("written");
    const rows = (io.text ?? "").split("\n").filter((r) => r !== "");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!)).toEqual({ v: 1, at: "2026-11-18T09:30:00.000Z", version: "1.29.1", device: "Pixel", ...GOOD });
  });

  test("a device with no label is kept as null, and a long label is cut", async () => {
    const io = memoryIo();
    const store = new ComposerDiagStore(io, { version: "1.29.1" });
    await store.record(GOOD, null);
    await store.record(GOOD, "x".repeat(500));
    const rows = (io.text ?? "").split("\n").filter((r) => r !== "").map((r) => JSON.parse(r));
    expect(rows[0].device).toBeNull();
    expect(rows[1].device).toHaveLength(80);
  });

  test("the real file is made owner-only inside an owner-only folder, and only on the first record", async () => {
    const parent = await tmp();
    // Windows: the bridge gives the state folder an owner-only access list at start (M43 spec 04), and what is
    // made inside inherits it. NTFS has no 0600 or 0700, so the check reads that list instead.
    if (HOST.platform === "win32") ensureOwnerOnlyDir(parent, HOST, { root: privateRoot("state"), repair: true });
    const dir = join(parent, "state");
    const store = new ComposerDiagStore(diagFileIo(dir), { version: "1.29.1" });
    expect(() => statSync(dir)).toThrow();
    expect(await store.record(GOOD, "Pixel")).toBe("written");
    for (const [path, mode] of [[join(dir, DIAG_COMPOSER_FILE), 0o600], [dir, 0o700]] as const) {
      if (HOST.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(mode);
      else expect(isOwnerOnly(path, HOST)).toEqual({ state: "private" });
    }
    await store.record(GOOD, "Pixel");
    expect(readFileSync(join(dir, DIAG_COMPOSER_FILE), "utf8").split("\n").filter((r) => r !== "")).toHaveLength(2);
  });

  test("a file made loose by another hand is tightened to 0600 on the first append", async () => {
    const dir = await tmp();
    await writeFile(join(dir, DIAG_COMPOSER_FILE), "", { mode: 0o644 });
    await new ComposerDiagStore(diagFileIo(dir), { version: "1.29.1" }).record(GOOD, null);
    // A file mode is POSIX. On Windows the state folder's access list is repaired at start (M43 spec 04), not
    // per file, so the append itself is what holds there.
    if (HOST.platform !== "win32") expect(statSync(join(dir, DIAG_COMPOSER_FILE)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, DIAG_COMPOSER_FILE), "utf8").split("\n").filter((r) => r !== "")).toHaveLength(1);
  });

  test("past the line cap the oldest lines go and the file never holds more than the cap", async () => {
    const dir = await tmp();
    const store = new ComposerDiagStore(diagFileIo(dir), { version: "1.29.1", maxLines: 5 });
    for (let i = 0; i < 8; i++) await store.record({ ...GOOD, msSinceForeground: i }, null);
    const rows = readFileSync(join(dir, DIAG_COMPOSER_FILE), "utf8").split("\n").filter((r) => r !== "").map((r) => JSON.parse(r));
    expect(rows.map((r) => r.msSinceForeground)).toEqual([3, 4, 5, 6, 7]);
    if (HOST.platform !== "win32") expect(statSync(join(dir, DIAG_COMPOSER_FILE)).mode & 0o777).toBe(0o600);
  });

  test("a store opened on a file that is already full drops the oldest too", async () => {
    const existing = Array.from({ length: 5 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n";
    const io = memoryIo(existing);
    await new ComposerDiagStore(io, { version: "1.29.1", maxLines: 5 }).record(GOOD, null);
    const rows = (io.text ?? "").split("\n").filter((r) => r !== "");
    expect(rows).toHaveLength(5);
    expect(JSON.parse(rows[0]!)).toEqual({ n: 1 });
    expect(JSON.parse(rows[4]!).paneKind).toBe("agent");
  });

  test("past the byte cap the oldest lines go", async () => {
    const io = memoryIo();
    const store = new ComposerDiagStore(io, { version: "1.29.1", maxBytes: 1500 });
    for (let i = 0; i < 12; i++) await store.record({ ...GOOD, msSinceForeground: i }, null);
    expect(Buffer.byteLength(io.text ?? "")).toBeLessThanOrEqual(1500);
    const rows = (io.text ?? "").split("\n").filter((r) => r !== "").map((r) => JSON.parse(r));
    expect(rows.at(-1).msSinceForeground).toBe(11);
    expect(rows.length).toBeLessThan(12);
  });

  test("the shipped caps are 500 lines and 256 KB", () => {
    expect(DIAG_COMPOSER_MAX_LINES).toBe(500);
    expect(DIAG_COMPOSER_MAX_BYTES).toBe(256 * 1024);
  });

  test("a disk that cannot be written answers unwritable and does not throw", async () => {
    const io: DiagIo = {
      read: () => Promise.resolve(null),
      append: () => Promise.reject(new Error("disk full")),
      replace: () => Promise.reject(new Error("disk full")),
    };
    expect(await new ComposerDiagStore(io, { version: "1.29.1" }).record(GOOD, null)).toBe("unwritable");
  });

  test("concurrent records all land, in order", async () => {
    const io = memoryIo();
    const store = new ComposerDiagStore(io, { version: "1.29.1" });
    await Promise.all([0, 1, 2, 3].map((i) => store.record({ ...GOOD, msSinceForeground: i }, null)));
    const rows = (io.text ?? "").split("\n").filter((r) => r !== "").map((r) => JSON.parse(r));
    expect(rows.map((r) => r.msSinceForeground)).toEqual([0, 1, 2, 3]);
  });
});

describe("the composer diagnostic route", () => {
  const TOKEN = "tok-phone-placeholder";
  const request = (headers: Record<string, string> = {}): Request =>
    new Request("http://127.0.0.1:8787/api/diag/composer", {
      method: "POST",
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", ...headers },
      body: JSON.stringify(GOOD),
    });
  const config = () => loadConfig({ HOME: "/tmp/collie-diag-composer-home" });

  async function store(paired: boolean): Promise<PairingStore> {
    const dir = await tmp();
    if (paired) {
      const now = Date.now();
      await writeFile(join(dir, DEVICES_FILENAME), JSON.stringify({ devices: [{ label: "phone", tokenHash: sha256Hex(TOKEN), createdAt: now, lastSeenAt: now }] }));
    }
    return new PairingStore(filePairingIo(dir));
  }

  test("a request with no token, or a token nobody holds, is refused before the route reads it", async () => {
    const paired = await store(true);
    const none = apiFrontGate(request(), "/api/diag/composer", config(), paired);
    expect(none?.status).toBe(403);
    const wrong = guard(request({ authorization: "Bearer not-the-token" }), config(), "read", paired);
    expect(wrong?.status).toBe(403);
    expect(await wrong?.text()).toBe("device not paired");
    const empty = guard(request({ authorization: `Bearer ${TOKEN}` }), config(), "read", await store(false));
    expect(empty?.status).toBe(403);
  });

  test("a paired device passes the gate", async () => {
    const paired = await store(true);
    expect(guard(request({ authorization: `Bearer ${TOKEN}` }), config(), "read", paired)).toBeNull();
  });

  test("the route is read-gated, checks the body before it keeps anything, and answers 204 (by source)", () => {
    const code = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const at = code.indexOf('pathname === "/api/diag/composer"');
    expect(at).toBeGreaterThan(0);
    const block = code.slice(at, code.indexOf("\n      }\n", at));
    expect(block).toContain('browserGate("read")');
    expect(block).toContain("DIAG_COMPOSER_BODY_MAX");
    expect(block.indexOf("parseComposerDiag(body)")).toBeLessThan(block.indexOf("composerDiag.record("));
    expect(block).toContain('text("bad composer record", 400)');
    expect(block).toContain("status: 204");
    expect(block).not.toContain("host.kind");
  });
});
