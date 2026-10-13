import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../json.ts";
import { NO_CURSOR } from "./cursor.ts";
import {
  createOpenclawReducer,
  footerSessionKey,
  OPENCLAW_SCHEMA_VERSIONS,
  openclawJournal,
  OpenclawTranscriptSource,
  parseOpenclawFooter,
  parseOpenclawTranscript,
  sessionKeyLookup,
} from "./openclaw.ts";
import { parseWith, unknownCount } from "./reduce.ts";
import { stripAnsi } from "./text.ts";
import type { TranscriptEntry, TranscriptPart } from "./types.ts";

// THE SAMPLES (bridge/journal/fixtures/openclaw/, all with personal data stripped):
//  - lab-sample-2026.10.2.json  the 2026-10-12 lab session on OpenClaw 2026.10.2 with a real model
//    (experiments/openclaw-401). Its SQLite was deleted after the lab, so these rows are rebuilt from
//    the same session's gateway `chat.history` answer: split messages joined, nested-tool rows put
//    back in their stored shape. The answers' `details` did not survive that projection.
//  - session-2026.10.2.json and session-2026.9.8.json  re-captures straight out of the SQLite, on the
//    current release and on the reporter's (#401), against a scripted local model: one reply, ls,
//    read, exec, and `ask_user` answered in the TUI. Every row, its seq, its branch position, and
//    whether OpenClaw stored it zstd-compressed.
//  - tui-*.raw.txt  the TUI's screen, escapes and all, with its footer.

const FIXTURES = join(import.meta.dir, "fixtures", "openclaw");

interface FixtureRow {
  seq: number;
  active: number | null;
  createdAt: number;
  zstd: boolean;
  row: JsonObject;
}
interface Fixture {
  openclawVersion: string;
  schemaVersion: number;
  sessionKey: string;
  sessionId: string;
  rows: FixtureRow[];
}

async function fixture(name: string): Promise<Fixture> {
  // SAFETY: the fixture files are this test's own, written in exactly this shape.
  return JSON.parse(await readFile(join(FIXTURES, name), "utf8")) as Fixture;
}

/** The branch rows of a fixture, in branch order, as the source would hand them over. */
function branchText(fx: Fixture): string {
  return fx.rows
    .filter((r) => r.active !== null)
    .toSorted((a, b) => (a.active ?? 0) - (b.active ?? 0))
    .map((r) => JSON.stringify(r.row))
    .join("\n");
}

/** One turn in a word or two per part, so a whole session reads as a list a person can check. */
function sketch(entries: TranscriptEntry[]): string[] {
  const part = (p: TranscriptPart): string => {
    if (p.kind === "tool") return `tool:${p.name}(${p.result === undefined ? "pending" : p.result.isError ? "err" : "ok"})`;
    if (p.kind === "image") return "image";
    return `${p.kind}`;
  };
  return entries.map((e) => `${e.role} ${e.parts.map(part).join(" ")}`);
}

// ── The footer ───────────────────────────────────────────────────────────────

describe("the TUI footer names the session", () => {
  test.each([
    ["tui-ask-user-lab-2026.10.2.raw.txt", "agent:main:main"],
    ["tui-ask-user-2026.10.2.raw.txt", "agent:main:main"],
    ["tui-idle-2026.9.8.raw.txt", "agent:main:main"],
  ])("%s", async (file, key) => {
    const screen = stripAnsi(await readFile(join(FIXTURES, file), "utf8"));
    const footer = parseOpenclawFooter(screen);
    expect(footer).not.toBeNull();
    expect(footerSessionKey(footer!)).toBe(key);
  });

  test("a named agent and a display name keep the id and the key", () => {
    const footer = parseOpenclawFooter(" agent ops (Ops Bot) | session work (Planning) | gpt | deliver:off");
    expect(footer).toEqual({ agentId: "ops", sessionLabel: "work (Planning)" });
    expect(sessionKeyLookup(footerSessionKey(footer!))?.candidates).toContain("agent:ops:work");
  });

  test("the bottommost footer wins over one the agent printed above it", () => {
    const screen = ["agent evil | session stolen | x", "some reply", " agent main (main) | session main | m"].join("\n");
    expect(parseOpenclawFooter(screen)).toEqual({ agentId: "main", sessionLabel: "main" });
  });

  test("the header line and a screen without a footer name nothing", () => {
    expect(parseOpenclawFooter(" openclaw tui - ws://127.0.0.1:19411 - agent main (main) - session main")).toBeNull();
    expect(parseOpenclawFooter("$ ls\nREADME.md\n")).toBeNull();
    expect(parseOpenclawFooter("")).toBeNull();
  });

  test("a key off the screen is refused before it can become a path", () => {
    expect(sessionKeyLookup("agent:../etc:main")).toBeNull();
    expect(sessionKeyLookup("agent:main/../x:main")).toBeNull();
    expect(sessionKeyLookup("agent:Main:main")).toBeNull();
    expect(sessionKeyLookup("agent:main:")).toBeNull();
    expect(sessionKeyLookup(`agent:main:a${String.fromCharCode(7)}b`)).toBeNull();
    expect(sessionKeyLookup(`agent:main:${"x".repeat(600)}`)).toBeNull();
    expect(sessionKeyLookup("main")).toBeNull();
    expect(sessionKeyLookup("agent:main:work")).toEqual({ agentId: "main", candidates: ["agent:main:work", "work"] });
  });
});

// ── The grammar ──────────────────────────────────────────────────────────────

describe("the normaliser in front of the pi reducer", () => {
  test("the lab sample reads with user turns, replies, tools and ask_user by name", async () => {
    const entries = parseOpenclawTranscript(branchText(await fixture("lab-sample-2026.10.2.json")));
    expect(sketch(entries)).toEqual([
      "user text",
      "assistant thinking text",
      "user text",
      "assistant thinking tool:ls(ok)",
      "assistant text",
      "user text",
      "assistant thinking tool:read(ok)",
      "assistant thinking text",
      "user text",
      "assistant thinking tool:exec(ok)",
      "assistant text",
      "user text",
      // The model's first call had the wrong shape: the error says why, under the real name.
      "assistant thinking tool:ask_user(err)",
      "assistant text tool:ask_user(ok)",
      "assistant text",
      "user text",
      "assistant thinking tool:ask_user(ok)",
      "assistant text",
      "user text",
      "assistant thinking tool:exec(err)",
      "assistant text tool:exec(err)",
      "assistant text",
    ]);
    expect(entries[0]?.parts[0]).toEqual({ kind: "text", text: "Reply with only the word ready." });
    const failed = entries[12]?.parts[1];
    expect(failed?.kind === "tool" && failed.result?.text).toContain("must have required property");
  });

  test.each(["session-2026.10.2.json", "session-2026.9.8.json"])("%s reads the same shape", async (name) => {
    const fx = await fixture(name);
    expect(fx.schemaVersion).toBe(24);
    const entries = parseOpenclawTranscript(branchText(fx));
    expect(sketch(entries)).toEqual([
      "user text",
      "assistant text",
      "user text",
      "assistant tool:ls(ok)",
      "assistant text",
      "user text",
      "assistant tool:read(ok)",
      "assistant text",
      "user text",
      "assistant tool:exec(ok)",
      "assistant text",
      "user text",
      "assistant tool:ask_user(ok)",
      "assistant text",
    ]);
    const ask = entries[12]?.parts[0];
    if (ask?.kind !== "tool") throw new Error("no ask_user part");
    expect(ask.name).toBe("ask_user");
    expect(ask.summary).toBe("Which color do you prefer?");
    // The question card: the question as asked, and the label the person picked in the TUI.
    expect(ask.call).toEqual({
      kind: "question",
      name: "ask_user",
      summary: "Which color do you prefer?",
      questions: [{ question: "Which color do you prefer?", header: "Color", multiple: false, options: [{ label: "Red" }, { label: "Blue" }] }],
      answers: [[name.includes("9.8") ? "Red" : "Blue"]],
    });
    // The result is the tool's own text, not the meta tool's JSON envelope around it.
    expect(ask.result?.text.startsWith("Color: ")).toBe(true);
  });

  test("every row OpenClaw wrote is one the reader knows", async () => {
    for (const name of ["lab-sample-2026.10.2.json", "session-2026.10.2.json", "session-2026.9.8.json"]) {
      const reducer = createOpenclawReducer();
      parseWith(reducer, branchText(await fixture(name)));
      expect(unknownCount(reducer.unknowns()), name).toBe(0);
    }
  });

  test("a nested-tool row that is not under a meta call is drawn as its result", () => {
    const row = {
      type: "message",
      id: "n1",
      parentId: null,
      timestamp: "2026-10-12T20:00:00.000Z",
      message: {
        role: "custom",
        customType: "openclaw.nested-tool.v1",
        display: true,
        content: "",
        details: { toolCallId: "code:1:read:1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "file body" }] } },
      },
    };
    const entries = parseOpenclawTranscript(JSON.stringify(row));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.parts[0]).toMatchObject({ kind: "tool", name: "read", result: { text: "file body" } });
  });

  test("an unknown custom message is counted, shown when it asks to be, and keeps the chain", () => {
    const rows = [
      { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "hi" } },
      { type: "message", id: "c1", parentId: "u1", timestamp: "", message: { role: "custom", customType: "x.later", display: true, content: "a notice" } },
      { type: "message", id: "a1", parentId: "c1", timestamp: "", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    ];
    const reducer = createOpenclawReducer();
    const entries = parseWith(reducer, rows.map((r) => JSON.stringify(r)).join("\n"));
    expect(sketch(entries)).toEqual(["user text", "note text", "assistant text"]);
    // Nothing was read as a rewind: a dropped row would have abandoned the turns before it.
    expect(entries.some((e) => e.abandoned === true)).toBe(false);
    expect([...reducer.unknowns().rows]).toEqual([["custom:x.later", 1]]);
  });
});

// ── The database ─────────────────────────────────────────────────────────────

/** The tables this reader touches, in the columns OpenClaw 2026.9.8 and 2026.10.2 give them. */
const SCHEMA = `
create table schema_meta (meta_key text primary key, role text not null, schema_version integer not null, agent_id text, app_version text, created_at integer not null, updated_at integer not null);
create table session_nodes (session_key text primary key, current_session_id text not null, entry_json text not null, updated_at integer not null);
create table transcript_events (session_id text not null, seq integer not null, event_json text, created_at integer not null, event_zstd blob, event_utf8_bytes integer, navigation_json text, primary key (session_id, seq));
create table session_transcript_index_state (session_id text primary key, indexed_seq integer not null, leaf_event_id text, needs_rebuild integer not null default 0, active_event_count integer not null default 0, active_message_count integer not null default 0, updated_at integer not null);
create table session_transcript_active_events (session_id text not null, active_position integer not null, event_seq integer not null, message_position integer, context_eligible integer, primary key (session_id, active_position));
`;

let base = "";
let stateDir = "";
let dbPath = "";

function writeAgentDb(path: string, fx: Fixture, schemaVersion = fx.schemaVersion): void {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  db.query("insert into schema_meta values ('primary', 'agent', ?, 'main', ?, 0, 0)").run(schemaVersion, fx.openclawVersion);
  db.query("insert into session_nodes values (?, ?, '{}', 0)").run(fx.sessionKey, fx.sessionId);
  for (const r of fx.rows) insertRow(db, fx.sessionId, r);
  db.query("insert into session_transcript_index_state values (?, 0, null, 0, 0, 0, 0)").run(fx.sessionId);
  db.close();
}

function insertRow(db: Database, sessionId: string, r: FixtureRow): void {
  const json = JSON.stringify(r.row);
  if (r.zstd) {
    db.query("insert into transcript_events values (?, ?, null, ?, ?, ?, '{}')").run(sessionId, r.seq, r.createdAt, Bun.zstdCompressSync(Buffer.from(json)), Buffer.byteLength(json));
  } else {
    db.query("insert into transcript_events values (?, ?, ?, ?, null, null, null)").run(sessionId, r.seq, json, r.createdAt);
  }
  if (r.active !== null) db.query("insert into session_transcript_active_events values (?, ?, ?, null, null)").run(sessionId, r.active, r.seq);
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "collie-openclaw-")));
  stateDir = join(base, "state");
  await mkdir(join(stateDir, "agents", "main", "agent"), { recursive: true });
  dbPath = join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  writeAgentDb(dbPath, await fixture("session-2026.10.2.json"));
  // What sits beside the agent database in a real state folder, and must never be read: the config
  // file and the state database that holds the gateway's shared secret. Placeholders only.
  await writeFile(join(stateDir, "openclaw.json"), JSON.stringify({ gateway: { auth: { token: "oc-gateway-token-placeholder" } } }));
  await mkdir(join(stateDir, "state"), { recursive: true });
  const secrets = new Database(join(stateDir, "state", "openclaw.sqlite"), { create: true });
  secrets.exec("create table secret_store_entries (name text, value text, deleted_at_ms integer)");
  secrets.query("insert into secret_store_entries values ('OPENCLAW_GATEWAY_TOKEN', 'oc-gateway-token-placeholder', null)").run();
  secrets.close();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const REF = { kind: "id" as const, value: "agent:main:main" };

describe("OpenclawTranscriptSource", () => {
  test("resolves the footer's key to the agent database and the session's current id", async () => {
    const source = new OpenclawTranscriptSource([stateDir]);
    const key = await source.resolve(REF);
    expect(key).toBe(`${dbPath}#d21f9015-1ea1-4ee5-b344-ba173f57ed2f`);
    expect(await source.resolve({ kind: "id", value: "agent:main:nope" })).toBeNull();
    expect(await source.resolve({ kind: "id", value: "agent:other:main" })).toBeNull();
    expect(await source.resolve({ kind: "path", value: dbPath })).toBeNull();
  });

  test("a whole read is the branch in order, zstd rows decoded, through the adapter's own parse", async () => {
    const adapter = openclawJournal([stateDir]);
    const key = await adapter.source.resolve(REF);
    const loaded = await adapter.source.load(key!);
    expect(loaded.complete).toBe(true);
    expect(loaded.size).toBe(31);
    const entries = adapter.parse(loaded.text);
    expect(entries.filter((e) => e.role === "user")).toHaveLength(5);
    // The read tool's result was a zstd row; its text arrived.
    const read = entries.find((e) => e.parts.some((p) => p.kind === "tool" && p.name === "read"))?.parts.at(-1);
    expect(read?.kind === "tool" && read.result?.text.startsWith("Lab file body.")).toBe(true);
  });

  test("a live read opens with the branch tail, then carries only what is new", async () => {
    const source = new OpenclawTranscriptSource([stateDir]);
    const key = (await source.resolve(REF))!;
    const first = await source.readSince(key, NO_CURSOR);
    expect(first.reset).toBe(true);
    expect(first.fromStart).toBe(true);
    expect(first.lines).toHaveLength(31);
    expect(await source.readSince(key, first.cursor)).toEqual({ lines: [], cursor: first.cursor, reset: false, fromStart: false });

    const db = new Database(dbPath);
    const reply = { type: "message", id: "late-1", parentId: "ac671adc-8fc7-4c61-8b88-7e4d3f3ffa11", timestamp: "2026-10-12T21:00:00.000Z", message: { role: "user", content: "One more." } };
    insertRow(db, "d21f9015-1ea1-4ee5-b344-ba173f57ed2f", { seq: 32, active: 31, createdAt: 1, zstd: false, row: reply });
    db.close();
    const next = await source.readSince(key, first.cursor);
    expect(next.reset).toBe(false);
    expect(next.lines.map((l) => JSON.parse(l).id)).toEqual(["late-1"]);
  });

  test("a branch index OpenClaw is rebuilding is not read; the caller holds what it has", async () => {
    const source = new OpenclawTranscriptSource([stateDir]);
    const key = (await source.resolve(REF))!;
    const db = new Database(dbPath);
    db.query("update session_transcript_index_state set needs_rebuild = 1").run();
    db.close();
    expect(await source.readSince(key, NO_CURSOR)).toEqual({ lines: [], cursor: NO_CURSOR, reset: false, fromStart: false });
  });

  test("a schema newer than the known one is no log, never a read", async () => {
    const newer = Math.max(...OPENCLAW_SCHEMA_VERSIONS) + 1;
    const source = new OpenclawTranscriptSource([stateDir]);
    const key = (await source.resolve(REF))!;
    const db = new Database(dbPath);
    db.query("update schema_meta set schema_version = ?").run(newer);
    db.close();
    expect(await source.resolve(REF)).toBeNull();
    // A key resolved before OpenClaw migrated the file reads nothing after it.
    expect(await source.stat(key)).toBeNull();
    expect((await source.load(key)).text).toBe("");
    expect((await source.readSince(key, NO_CURSOR)).lines).toEqual([]);
  });

  test("a database outside the state folder is not followed", async () => {
    const elsewhere = join(base, "elsewhere");
    await mkdir(join(elsewhere, "agent"), { recursive: true });
    writeAgentDb(join(elsewhere, "agent", "openclaw-agent.sqlite"), await fixture("session-2026.9.8.json"));
    await symlink(elsewhere, join(stateDir, "agents", "linked"));
    expect(await new OpenclawTranscriptSource([stateDir]).resolve({ kind: "id", value: "agent:linked:main" })).toBeNull();
  });

  test("a key it cannot serve reports nothing new", async () => {
    const source = new OpenclawTranscriptSource([stateDir]);
    expect(await source.readSince("/nope/not-a-key", NO_CURSOR)).toEqual({ lines: [], cursor: NO_CURSOR, reset: false, fromStart: false });
    expect(await source.stat("/nope/not-a-key")).toBeNull();
  });
});

describe("no gateway token is read or stored", () => {
  test("the adapter opens the agent database and nothing else, and needs neither neighbour", async () => {
    const opened: string[] = [];
    const adapter = openclawJournal([stateDir], (path) => {
      opened.push(path);
      return new Database(path, { readonly: true });
    });
    // Both neighbours unreadable: a reader that touched either would fail here instead of reading.
    await chmod(join(stateDir, "openclaw.json"), 0o000);
    await chmod(join(stateDir, "state", "openclaw.sqlite"), 0o000);
    try {
      const key = (await adapter.source.resolve(REF))!;
      await adapter.source.stat(key);
      await adapter.source.load(key);
      await adapter.source.readSince(key, NO_CURSOR);
      expect(adapter.parse((await adapter.source.load(key)).text).length).toBeGreaterThan(0);
    } finally {
      await chmod(join(stateDir, "openclaw.json"), 0o600);
      await chmod(join(stateDir, "state", "openclaw.sqlite"), 0o600);
    }
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened)).toEqual(new Set([dbPath]));
  });

  test("the module has no way to read a file, and names neither the config nor the secret", async () => {
    const source = await readFile(join(import.meta.dir, "openclaw.ts"), "utf8");
    const imports = [...source.matchAll(/ from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.toSorted()).toEqual(["../json.ts", "./cursor.ts", "./files.ts", "./pi.ts", "./reduce.ts", "./types.ts", "bun:sqlite", "node:path"]);
    expect(source).not.toMatch(/readFile|Bun\.file|openSync|createReadStream|process\.env|openclaw\.json|secret_store_entries|OPENCLAW_GATEWAY_TOKEN/);
  });
});

describe("discover", () => {
  test("reads the footer off the pane's screen, and nothing without one", async () => {
    const adapter = openclawJournal([stateDir]);
    const screen = stripAnsi(await readFile(join(FIXTURES, "tui-idle-2026.9.8.raw.txt"), "utf8"));
    expect(await adapter.discover?.("/anywhere", { screen: async () => screen })).toEqual(REF);
    expect(await adapter.discover?.("/anywhere", { screen: async () => null })).toBeNull();
    expect(await adapter.discover?.("/anywhere")).toBeNull();
    expect(await adapter.discover?.("/anywhere", { screen: async () => "$ ls\n" })).toBeNull();
  });
});
