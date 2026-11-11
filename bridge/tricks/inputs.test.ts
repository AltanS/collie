import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { JsonValue } from "../json.ts";
import type { FactsSession } from "../../web/src/lib/tricks/schema.ts";
import { unsafeText } from "./code-hash.ts";
import {
  answerInputsRequest,
  INPUT_ANSWER_MAX_BYTES,
  INPUT_IMAGE_MAX_BYTES,
  INPUT_RATE_MS,
  INPUT_TEXT_MAX_BYTES,
  inputsDirName,
  parseInputsRequest,
  readPaneInputs,
  TrickInputs,
  TRICK_READS_OFF,
  type InputsCallResult,
  type InputsFetchDeps,
  type InputsMemberDeps,
  type WirePaneInputs,
} from "./inputs.ts";

// A TRICK READS FILES FROM ITS SESSIONS' FOLDERS (M99 slice 6): the member's read through the Files view,
// the request a member takes, and the lead's fetch and delivery into the approved copy, each against a
// hostile counterpart.

const roots: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "collie-trick-inputs-")));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** A PNG's signature and IHDR, padded to `size` bytes. */
function png(size = 128): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 1, 0, 8, 2, 0, 0, 0];
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head);
  return out;
}

/** A home with one session folder (`home/proj`), a state folder and a config folder inside home. */
function machine() {
  const home = tempDir();
  const root = join(home, "proj");
  const state = join(home, "state");
  const config = join(home, "config");
  for (const dir of [root, state, config]) mkdirSync(dir, { recursive: true });
  const put = (rel: string, bytes: Uint8Array | string): void => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  };
  return { home, root, state, config, put, ctx: { root, home, privateFolders: [state, config] } };
}

const budget = () => ({ left: INPUT_ANSWER_MAX_BYTES });

describe("the member's read, through the Files view", () => {
  test("the globs' files, text and pictures, with their hash and bytes; * never matches a leading dot", async () => {
    const m = machine();
    m.put("TODO.md", "- ship it\n");
    m.put("notes/a.md", "a");
    m.put("notes/.hidden.md", "h");
    m.put("notes/b.txt", "b");
    m.put("shots/red.png", png());
    const read = await readPaneInputs(m.ctx, ["TODO.md", "notes/*.md", "shots/*.png"], new Map(), budget(), false);
    expect(read.state).toBe("ok");
    expect(read.files.map((f) => [f.rel, f.kind, f.bytes])).toEqual([
      ["TODO.md", "text", 10],
      ["notes/a.md", "text", 1],
      ["shots/red.png", "image", 128],
    ]);
    expect(read.files[0]?.sha256).toBe(sha("- ship it\n"));
    expect(Buffer.from(read.files[0]?.b64 ?? "", "base64").toString()).toBe("- ship it\n");
  });

  test("a file the lead already holds travels as its hash only", async () => {
    const m = machine();
    m.put("TODO.md", "same");
    const read = await readPaneInputs(m.ctx, ["TODO.md"], new Map([["TODO.md", sha("same")]]), budget(), false);
    expect(read.files.map(({ mtime: _mtime, ...file }) => file)).toEqual([{ rel: "TODO.md", bytes: 4, sha256: sha("same"), kind: "text" }]);
  });

  test.skipIf(process.platform === "win32")("a symlink is never followed: not to a file outside, not through a folder outside", async () => {
    const m = machine();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.md"), "outside");
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "x.md"), "outside");
    symlinkSync(join(outside, "secret.md"), join(m.root, "link.md"));
    symlinkSync(join(outside, "dir"), join(m.root, "notes"));
    const read = await readPaneInputs(m.ctx, ["*.md", "notes/*.md"], new Map(), budget(), false);
    expect(read.files).toEqual([]);
  });

  test("deny-listed names and private folders are not read, whatever the glob says", async () => {
    const m = machine();
    m.put("crew-trust.json", "{}");
    m.put("paired-devices.json", "{}");
    m.put("ok.json", "{}");
    // The bridge's own state folder inside the session folder (a sibling instance's, or its own).
    const inner = join(m.root, "state-in-root");
    mkdirSync(inner);
    writeFileSync(join(inner, "notes.json"), "{}");
    const read = await readPaneInputs({ ...m.ctx, privateFolders: [...m.ctx.privateFolders, inner] }, ["*.json", "state-in-root/*.json"], new Map(), budget(), false);
    expect(read.files.map((f) => f.rel)).toEqual(["ok.json"]);
  });

  test("a .env file is never read, in any case and in any folder, whatever the glob says", async () => {
    const m = machine();
    for (const name of [".env", ".env.local", ".ENV", ".envrc", "config/.env", "config/.Env.production"]) m.put(name, "API_KEY=sk-or-v1-your-key-here\n");
    m.put(".editorconfig", "root = true\n");
    const read = await readPaneInputs(m.ctx, [".e*", "config/.e*", ".E*"], new Map(), budget(), false);
    expect(read.files.map((f) => f.rel)).toEqual([".editorconfig"]);
  });

  test.skipIf(process.platform === "win32")("a name with a control, bidi or zero-width character is never served, and counts as skipped; plain non-ASCII names pass", async () => {
    const m = machine();
    for (const name of ["evil\u202Etxt.md", "zero\u200Bwidth.md", "bell\u0007.md", "übersicht.md", "日本.txt"]) m.put(name, "x");
    m.put("dir\u202E/inner.md", "x");
    m.put("ok/inner.md", "x");
    const read = await readPaneInputs(m.ctx, ["*.md", "*.txt", "*/inner.md"], new Map(), budget(), false);
    expect(read.files.filter((f) => f.skipped === undefined).map((f) => f.rel)).toEqual(["übersicht.md", "日本.txt", "ok/inner.md"]);
    const refused = read.files.filter((f) => f.skipped === "name");
    expect(refused).toHaveLength(3);
    for (const file of refused) {
      expect(file.b64).toBeUndefined();
      expect(file.sha256).toBeUndefined();
      expect(unsafeText(file.rel)).toBe(false);
    }
  });

  test("oversize and the wrong type are skipped with the reason, never sent", async () => {
    const m = machine();
    m.put("big.md", "x".repeat(INPUT_TEXT_MAX_BYTES + 1));
    m.put("huge.png", png(INPUT_IMAGE_MAX_BYTES + 1));
    m.put("blob.md", new Uint8Array([1, 2, 0, 3]));
    m.put("anim.png", "GIF89a....");
    m.put("ok.md", "fine");
    const read = await readPaneInputs(m.ctx, ["*.md", "*.png"], new Map(), budget(), false);
    const by = Object.fromEntries(read.files.map((f) => [f.rel, f]));
    expect(by["big.md"]).toMatchObject({ skipped: "too-large" });
    expect(by["huge.png"]).toMatchObject({ skipped: "too-large" });
    expect(by["blob.md"]).toMatchObject({ skipped: "type" });
    expect(by["anim.png"]).toMatchObject({ skipped: "type" });
    for (const file of read.files.filter((f) => f.skipped !== undefined)) {
      expect(file.b64).toBeUndefined();
      expect(file.sha256).toBeUndefined();
    }
    expect(by["ok.md"]).toMatchObject({ kind: "text", bytes: 4 });
  });

  test("past the answer's budget a file is cap, and at most 32 files are listed", async () => {
    const m = machine();
    m.put("a.md", "x".repeat(100));
    m.put("b.md", "y".repeat(100));
    const read = await readPaneInputs(m.ctx, ["*.md"], new Map(), { left: 150 }, false);
    expect(read.files.map((f) => [f.rel, f.skipped ?? "sent"])).toEqual([
      ["a.md", "sent"],
      ["b.md", "cap"],
    ]);
    for (let i = 0; i < 40; i += 1) m.put(`many/${String(i).padStart(2, "0")}.md`, "m");
    const many = await readPaneInputs(m.ctx, ["many/*.md"], new Map(), budget(), false);
    expect(many.files).toHaveLength(32);
  });

  test("with COLLIE_REDACT on, a text file leaves masked, and its hash is the masked bytes'", async () => {
    const m = machine();
    m.put("env.md", "key AKIAABCDEFGHIJKLMNOP here");
    const read = await readPaneInputs(m.ctx, ["env.md"], new Map(), budget(), true);
    const text = Buffer.from(read.files[0]?.b64 ?? "", "base64").toString();
    expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(read.files[0]?.sha256).toBe(sha(text));
  });

  test("a folder outside home, or home itself, is no-folder", async () => {
    const m = machine();
    expect((await readPaneInputs({ ...m.ctx, root: m.home }, ["*.md"], new Map(), budget(), false)).state).toBe("no-folder");
    expect((await readPaneInputs({ ...m.ctx, root: "/" }, ["*.md"], new Map(), budget(), false)).state).toBe("no-folder");
  });
});

describe("the request a member takes (it trusts no word of the lead's parse)", () => {
  const good = { trick: "todo", run: "r1", globs: ["TODO.md"], panes: ["%1"] };

  test("a well-formed request reads, have included", () => {
    const req = parseInputsRequest({ ...good, have: [{ pane: "%1", files: [{ rel: "TODO.md", sha256: sha("x") }] }] });
    expect("error" in req).toBe(false);
  });

  test("a glob with .., an absolute one, ** and .git are refused before any read", () => {
    for (const glob of ["../x.md", "notes/../../x", "/etc/passwd", "~/x", "**/x.md", ".git/config", "a/.GIT/x", "a//b", "x?.md", ".env", ".env.local", "config/.ENV", ".env*"]) {
      expect(parseInputsRequest({ ...good, globs: [glob] }), glob).toHaveProperty("error");
    }
  });

  test("an unknown key, a bad trick id, a pane id with a slash, have for an unasked pane: refused", () => {
    expect(parseInputsRequest({ ...good, extra: 1 })).toHaveProperty("error");
    expect(parseInputsRequest({ ...good, trick: "../x" })).toHaveProperty("error");
    expect(parseInputsRequest({ ...good, panes: ["a/b"] })).toHaveProperty("error");
    expect(parseInputsRequest({ ...good, panes: ["trick:x"] })).toHaveProperty("error");
    expect(parseInputsRequest({ ...good, have: [{ pane: "%9", files: [] }] })).toHaveProperty("error");
    expect(parseInputsRequest({ ...good, have: [{ pane: "%1", files: [{ rel: "../x", sha256: sha("x") }] }] })).toHaveProperty("error");
    expect(parseInputsRequest({ ...good, have: [{ pane: "%1", files: [{ rel: "/etc/passwd", sha256: sha("x") }] }] })).toHaveProperty("error");
  });
});

describe("the member's answer", () => {
  function deps(m: ReturnType<typeof machine>, over: Partial<InputsMemberDeps> = {}): InputsMemberDeps & { lines: { trick: string; files: number; bytes: number }[] } {
    const lines: { trick: string; files: number; bytes: number }[] = [];
    return {
      // %1 is this machine's agent pane; %2 a shell pane and %9 another machine's: both answer null.
      rootOf: async (pane) => (pane === "%1" ? { root: m.root } : pane === "%3" ? { root: null } : null),
      home: m.home,
      privateFolders: [m.state, m.config],
      redact: false,
      allowed: () => true,
      audit: (detail) => lines.push(detail),
      lines,
      ...over,
    };
  }

  test("its own agent pane is read; a shell pane and a foreign pane are no-pane; one audit line with counts, never names", async () => {
    const m = machine();
    m.put("TODO.md", "todo");
    const d = deps(m);
    const answer = await answerInputsRequest({ trick: "todo", run: "r1", globs: ["TODO.md"], panes: ["%1", "%2", "%9", "%3"] }, d);
    expect(answer.status).toBe(200);
    // SAFETY: the handler's 200 body is `{ panes }` as it built it; the test reads it back.
    const panes = (JSON.parse(JSON.stringify(answer.body)) as { panes: (WirePaneInputs & { pane: string })[] }).panes;
    expect(panes.map((p) => [p.pane, p.state, p.files.length])).toEqual([
      ["%1", "ok", 1],
      ["%2", "no-pane", 0],
      ["%9", "no-pane", 0],
      ["%3", "no-folder", 0],
    ]);
    expect(d.lines).toEqual([{ trick: "todo", files: 1, bytes: 4 }]);
    expect(JSON.stringify(d.lines)).not.toContain("TODO.md");
  });

  test("with trick reads off it answers 403 trick_reads_off and reads nothing", async () => {
    const m = machine();
    let asked = 0;
    const answer = await answerInputsRequest({ trick: "todo", run: "r1", globs: ["TODO.md"], panes: ["%1"] }, deps(m, { allowed: () => false, rootOf: async () => ((asked += 1), { root: m.root }) }));
    expect(answer).toEqual({ status: 403, body: { error: "trick reads are off on this machine", code: TRICK_READS_OFF } });
    expect(asked).toBe(0);
  });

  test("a hostile request is a 400 and reads nothing", async () => {
    const m = machine();
    let asked = 0;
    const answer = await answerInputsRequest({ trick: "todo", run: "r1", globs: ["../../etc/*"], panes: ["%1"] }, deps(m, { rootOf: async () => ((asked += 1), { root: m.root }) }));
    expect(answer.status).toBe(400);
    expect(asked).toBe(0);
  });
});

// ── The lead's fetch ───────────────────────────────────────────────────────────────────────────

const session = (memberId: string, paneId: string, agent = true): FactsSession => {
  const s: FactsSession = { id: `${memberId}:${paneId}`, memberId, sessionId: `${memberId}:${paneId}`, paneId, host: memberId, status: "idle" };
  if (agent) s.agent = "claude";
  return s;
};

function wireFile(rel: string, bytes: Uint8Array | string, kind: "text" | "image" = "text", over: Record<string, JsonValue> = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  return { rel, bytes: data.length, mtime: "2026-11-10T09:00:00.000Z", sha256: sha(data), kind, b64: Buffer.from(data).toString("base64"), ...over };
}

interface LeadRig {
  dir: string;
  inputs: TrickInputs;
  calls: { memberId: string; body: JsonValue }[];
  answer: (memberId: string, body: JsonValue) => InputsCallResult;
  clock: { t: number };
  lines: { trick: string; files: number; bytes: number }[];
  members: Map<string, { reachable: boolean; older: boolean }>;
  local: Map<string, WirePaneInputs>;
}

function leadRig(): LeadRig {
  const dir = join(tempDir(), "copy");
  mkdirSync(join(dir, "inputs"), { recursive: true });
  const rig: Omit<LeadRig, "inputs"> = {
    dir,
    calls: [],
    answer: () => ({ kind: "failed" }),
    clock: { t: 1_000_000 },
    lines: [],
    members: new Map([["workshop", { reachable: true, older: false }]]),
    local: new Map(),
  };
  const deps: InputsFetchDeps = {
    isOwn: (id) => id === "lodge",
    readLocal: async (pane) => rig.local.get(pane) ?? { state: "no-pane", files: [] },
    member: (id) => rig.members.get(id) ?? null,
    call: async (memberId, body) => {
      // SAFETY: the fetch writes one JSON body, built by JSON.stringify.
      const parsed = JSON.parse(body) as JsonValue;
      rig.calls.push({ memberId, body: parsed });
      return rig.answer(memberId, parsed);
    },
    audit: (detail) => rig.lines.push(detail),
    now: () => rig.clock.t,
    runId: () => "r1",
  };
  return Object.assign(rig, { inputs: new TrickInputs(deps) });
}

const TRICK = (dir: string) => ({ id: "todo", dir, globs: ["TODO.md", "notes/*.md", "shots/*.png"] });
const ok = (files: unknown[]): InputsCallResult => ({ kind: "answer", status: 200, text: JSON.stringify({ panes: [{ pane: "%1", state: "ok", files }] }) });

describe("the lead's fetch and delivery", () => {
  test("its own session read locally, a member's by one call, written under inputs/<member>/<pane>/ and listed with a path the trick folder resolves", async () => {
    const r = leadRig();
    r.local.set("w6X:3", { state: "ok", files: [wireFile("TODO.md", "mine")] });
    r.answer = () => ok([wireFile("notes/a.md", "theirs"), wireFile("shots/red.png", png(), "image")]);
    const got = await r.inputs.fetch(TRICK(r.dir), [session("lodge", "w6X:3"), session("workshop", "%1"), session("workshop", "%2", false)]);
    expect(got.get("lodge:w6X:3")).toMatchObject({ state: "ok", files: [{ rel: "TODO.md", path: "inputs/lodge/w6X_3a3/TODO.md", bytes: 4, sha256: sha("mine"), kind: "text" }] });
    expect(got.get("workshop:%1")?.files.map((f) => f.path)).toEqual(["inputs/workshop/_251/notes/a.md", "inputs/workshop/_251/shots/red.png"]);
    // A shell session is none, and the member was asked only for its agent pane.
    expect(got.get("workshop:%2")).toEqual({ state: "none", files: [] });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.body).toEqual({ trick: "todo", run: "r1", globs: ["TODO.md", "notes/*.md", "shots/*.png"], panes: ["%1"], have: [] });
    expect(readFileSync(join(r.dir, "inputs/workshop/_251/notes/a.md"), "utf8")).toBe("theirs");
    expect(readFileSync(join(r.dir, "inputs/lodge/w6X_3a3/TODO.md"), "utf8")).toBe("mine");
    // One audit line for the run: counts only.
    expect(r.lines).toEqual([{ trick: "todo", files: 3, bytes: 4 + 6 + 128 }]);
  });

  test("a hostile member: an absolute rel, a .. rel, a name no glob matches, a wrong hash, a fake picture, a .git step are all refused, and nothing lands outside", async () => {
    const r = leadRig();
    const outside = tempDir();
    r.answer = () =>
      ok([
        wireFile("/etc/passwd", "x"),
        wireFile(join(outside, "planted.md"), "x"),
        wireFile("../../../planted.md", "x"),
        wireFile("notes/../../planted.md", "x"),
        wireFile("other.md", "x"),
        wireFile("TODO.md", "x", "text", { sha256: sha("y") }),
        wireFile("shots/fake.png", "not a png", "image"),
        wireFile("notes/.git", "x"),
        wireFile("TODO.md", "x".repeat(10), "text", { bytes: 3 }),
        { rel: "notes/b.md", bytes: 1, mtime: "x", sha256: sha("b"), kind: "text" },
        wireFile("notes/ok.md", "fine"),
      ]);
    const got = await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(got.get("workshop:%1")?.files.map((f) => f.rel)).toEqual(["notes/ok.md"]);
    expect(got.get("workshop:%1")?.skipped).toBe(10);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(r.dir, "planted.md"))).toBe(false);
    expect(existsSync(join(r.dir, "inputs", "planted.md"))).toBe(false);
  });

  test("a hostile member's .env file is refused even when a glob would match it", async () => {
    const r = leadRig();
    r.answer = () => ok([wireFile(".env", "API_KEY=sk-or-v1-your-key-here"), wireFile(".ENV.local", "x"), wireFile(".editorconfig", "root = true")]);
    const got = await r.inputs.fetch({ ...TRICK(r.dir), globs: [".e*", ".E*"] }, [session("workshop", "%1")]);
    expect(got.get("workshop:%1")?.files.map((f) => f.rel)).toEqual([".editorconfig"]);
    expect(got.get("workshop:%1")?.skipped).toBe(2);
  });

  test("a hostile member's name with a control, bidi or zero-width character is dropped, never written; plain non-ASCII names land", async () => {
    const r = leadRig();
    r.answer = () =>
      ok([
        wireFile("notes/evil\u202Etxt.md", "x"),
        wireFile("notes/zero\u200Bwidth.md", "x"),
        wireFile("notes/bell\u0007.md", "x"),
        wireFile("notes/übersicht.md", "ü"),
        wireFile("notes/日本.md", "日"),
        { rel: "notes/skip.md", bytes: 1, mtime: "2026-11-10T09:00:00.000Z", skipped: "name" },
      ]);
    const got = await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(got.get("workshop:%1")?.files.map((f) => f.rel)).toEqual(["notes/übersicht.md", "notes/日本.md"]);
    expect(got.get("workshop:%1")?.skipped).toBe(4);
    expect(readdirSync(join(r.dir, "inputs/workshop/_251/notes")).toSorted()).toEqual(["übersicht.md", "日本.md"].toSorted());
  });

  test("a request whose have names a file with a hidden character is refused", () => {
    for (const rel of ["evil\u202Etxt.md", "zero\u200Bwidth.md", "bell\u0007.md"]) {
      expect(parseInputsRequest({ trick: "todo", run: "r1", globs: ["*.md"], panes: ["%1"], have: [{ pane: "%1", files: [{ rel, sha256: sha("x") }] }] }), rel).toHaveProperty("error");
    }
    expect("error" in parseInputsRequest({ trick: "todo", run: "r1", globs: ["*.md"], panes: ["%1"], have: [{ pane: "%1", files: [{ rel: "übersicht.md", sha256: sha("x") }] }] })).toBe(false);
  });

  test("a binary file posing as text, more than 32 files, and an answer for a pane not asked: refused or ignored", async () => {
    const r = leadRig();
    const many = Array.from({ length: 40 }, (_, i) => wireFile(`notes/${String(i)}.md`, "m"));
    r.answer = () => ({
      kind: "answer",
      status: 200,
      text: JSON.stringify({ panes: [{ pane: "%1", state: "ok", files: [wireFile("TODO.md", new Uint8Array([0x61, 0, 0x62])), ...many] }, { pane: "%7", state: "ok", files: [wireFile("TODO.md", "x")] }] }),
    });
    const got = await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(got.get("workshop:%1")?.files).toHaveLength(32);
    expect(got.get("workshop:%1")?.files.map((f) => f.rel)).not.toContain("TODO.md");
    expect(existsSync(join(r.dir, "inputs/workshop/_257"))).toBe(false);
  });

  test("a member below the floor, or not answering, gets no call; a 404 is older and a 403 trick_reads_off is refused", async () => {
    const r = leadRig();
    r.members.set("old", { reachable: true, older: true });
    r.members.set("away", { reachable: false, older: false });
    r.members.set("plain", { reachable: true, older: false });
    r.members.set("shut", { reachable: true, older: false });
    r.answer = (memberId) =>
      memberId === "plain" ? { kind: "answer", status: 404, text: "{}" } : { kind: "answer", status: 403, text: JSON.stringify({ error: "off", code: TRICK_READS_OFF }) };
    const got = await r.inputs.fetch(TRICK(r.dir), [session("old", "%1"), session("away", "%1"), session("plain", "%1"), session("shut", "%1")]);
    expect([...got].map(([id, inputs]) => [id, inputs.state])).toEqual([
      ["old:%1", "older"],
      ["away:%1", "offline"],
      ["plain:%1", "older"],
      ["shut:%1", "refused"],
    ]);
    expect(r.calls.map((c) => c.memberId)).toEqual(["plain", "shut"]);
  });

  test("one call per trick per member per 5 s: inside the window the last answer stands and its files are kept", async () => {
    const r = leadRig();
    r.answer = () => ok([wireFile("TODO.md", "v1")]);
    await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    r.clock.t += INPUT_RATE_MS - 1;
    const again = await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(r.calls).toHaveLength(1);
    expect(again.get("workshop:%1")?.files.map((f) => f.rel)).toEqual(["TODO.md"]);
    expect(readFileSync(join(r.dir, "inputs/workshop/_251/TODO.md"), "utf8")).toBe("v1");
    // Past the window it calls again, and says what it holds, so an unchanged file travels as its hash.
    r.clock.t += 2;
    r.answer = () => ok([{ rel: "TODO.md", bytes: 2, mtime: "2026-11-10T09:00:00.000Z", sha256: sha("v1"), kind: "text" }]);
    const third = await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(r.calls[1]?.body).toMatchObject({ have: [{ pane: "%1", files: [{ rel: "TODO.md", sha256: sha("v1") }] }] });
    expect(third.get("workshop:%1")?.files.map((f) => f.rel)).toEqual(["TODO.md"]);
    expect(readFileSync(join(r.dir, "inputs/workshop/_251/TODO.md"), "utf8")).toBe("v1");
  });

  test("a hash-only answer for a file the lead does not hold is refused, not trusted", async () => {
    const r = leadRig();
    r.answer = () => ok([{ rel: "TODO.md", bytes: 2, mtime: "2026-11-10T09:00:00.000Z", sha256: sha("v1"), kind: "text" }]);
    const got = await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(got.get("workshop:%1")).toEqual({ state: "ok", files: [], skipped: 1 });
  });

  test("the folder is replaced whole: a file the run no longer holds goes, and so does what the program left there", async () => {
    const r = leadRig();
    r.answer = () => ok([wireFile("TODO.md", "a"), wireFile("notes/x.md", "x")]);
    await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    writeFileSync(join(r.dir, "inputs", "junk.txt"), "the program wrote this");
    mkdirSync(join(r.dir, "inputs", ".stage-dead"));
    r.clock.t += INPUT_RATE_MS;
    r.answer = () => ok([wireFile("TODO.md", "b")]);
    await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(readdirSync(join(r.dir, "inputs"))).toEqual(["workshop"]);
    expect(readdirSync(join(r.dir, "inputs/workshop/_251"))).toEqual(["TODO.md"]);
    expect(readFileSync(join(r.dir, "inputs/workshop/_251/TODO.md"), "utf8")).toBe("b");
  });

  test.skipIf(process.platform === "win32")("a symlink the program planted is never written through, nor read as a kept file", async () => {
    const r = leadRig();
    const outside = tempDir();
    r.answer = () => ok([wireFile("TODO.md", "v1")]);
    await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    // The program swaps the member folder for a link out, holding a file with the same bytes.
    mkdirSync(join(outside, "_251"));
    writeFileSync(join(outside, "_251", "TODO.md"), "v1");
    rmSync(join(r.dir, "inputs", "workshop"), { recursive: true });
    symlinkSync(outside, join(r.dir, "inputs", "workshop"));
    r.clock.t += INPUT_RATE_MS;
    r.answer = () => ok([{ rel: "TODO.md", bytes: 2, mtime: "2026-11-10T09:00:00.000Z", sha256: sha("v1"), kind: "text" }]);
    const got = await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(got.get("workshop:%1")).toMatchObject({ files: [], skipped: 1 });
    expect(lstatSync(join(r.dir, "inputs")).isDirectory()).toBe(true);
    expect(existsSync(join(r.dir, "inputs", "workshop"))).toBe(false);
    // The file outside is untouched.
    expect(readFileSync(join(outside, "_251", "TODO.md"), "utf8")).toBe("v1");
    // And an `inputs` that is itself a link is replaced by a real folder, never written through.
    rmSync(join(r.dir, "inputs"), { recursive: true });
    symlinkSync(outside, join(r.dir, "inputs"));
    r.clock.t += INPUT_RATE_MS;
    r.answer = () => ok([wireFile("TODO.md", "v2")]);
    await r.inputs.fetch(TRICK(r.dir), [session("workshop", "%1")]);
    expect(lstatSync(join(r.dir, "inputs")).isSymbolicLink()).toBe(false);
    expect(readdirSync(outside)).toEqual(["_251"]);
  });

  test("the run's cap: past 24 MiB in all, the rest are skipped, the lead's own first", async () => {
    const r = leadRig();
    const big = (n: number) => png(INPUT_IMAGE_MAX_BYTES - n);
    r.local.set("w6X:3", { state: "ok", files: [wireFile("shots/a.png", big(1), "image")] });
    for (const id of ["m1", "m2", "m3", "m4"]) r.members.set(id, { reachable: true, older: false });
    r.answer = () => ok([1, 2, 3, 4].map((n) => wireFile(`shots/${String(n)}.png`, big(n + 10), "image")));
    const got = await r.inputs.fetch(TRICK(r.dir), [session("m1", "%1"), session("m2", "%1"), session("m3", "%1"), session("m4", "%1"), session("lodge", "w6X:3")]);
    expect(got.get("lodge:w6X:3")?.files).toHaveLength(1);
    const total = [...got.values()].flatMap((i) => i.files).reduce((sum, f) => sum + f.bytes, 0);
    expect(total).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect([...got.values()].reduce((sum, i) => sum + (i.skipped ?? 0), 0)).toBeGreaterThan(0);
  });

  test("the folder names are one safe step each, and injective", () => {
    expect(inputsDirName("workshop")).toBe("workshop");
    expect(inputsDirName("m_k3x9q2w7ab")).toBe("m__k3x9q2w7ab");
    expect(inputsDirName("%1")).toBe("_251");
    expect(inputsDirName("w6X:3")).toBe("w6X_3a3");
    expect(inputsDirName("..")).toBe("_2e.");
    expect(inputsDirName("a/b")).toBe("a_2fb");
    expect(inputsDirName("_25")).not.toBe(inputsDirName("%"));
    expect(inputsDirName("x".repeat(200))).toMatch(/^h_[0-9a-f]{32}$/);
  });
});
