import { describe, expect, test } from "bun:test";

import { decodeSessionId } from "../events/session-id.ts";
import { MAX_READ_LINES } from "../read-limits.ts";
import { idOf } from "./ids.ts";
import { buildTable, type OperationContext, type OperationTable, type OpResult } from "./operations.ts";
import { buildReads, capText, folderName, machineLabel, NAME_MAX, READ_TEXT_MAX_BYTES, SENDER_AGENT, SENDER_COLLIE } from "./reads.ts";
import { machineSourcesOf } from "./world.ts";
import type { JsonValue } from "../json.ts";
import { answeredDecision, accountRow, decision, depsOf, keyOf, MACHINE, machineBodies, pane, VERSION, world, type World } from "./fixtures/reads-world.ts";

const ESC = String.fromCodePoint(0x1b);

function ctx(): OperationContext {
  return { signal: new AbortController().signal, offered: [], standing: () => true, claimWait: () => () => undefined };
}

function tableOf(w: World): OperationTable {
  return buildTable({ version: () => "9.9.9-test", bus: w.bus, reads: buildReads(depsOf(w)) });
}

async function ask(w: World, op: string, args: Record<string, string | number> = {}): Promise<OpResult> {
  return tableOf(w).get(op)!.run(args, ctx());
}

async function answerOf(w: World, op: string, args: Record<string, string | number> = {}) {
  const result = await ask(w, op, args);
  if (!result.ok) throw new Error(`${op} refused: ${result.code}`);
  return result.answer;
}

/** A plain copy of an answer's part, typed by the caller: the test names the shape it expects. */
function wire<T>(value: JsonValue | undefined): T {
  return JSON.parse(JSON.stringify(value));
}

interface SessionWire {
  id: string;
  machine: string;
  agent: string;
  label: string;
  folder?: string;
  state: string;
  account?: string;
  rev: number;
}

async function sessionsOf(w: World): Promise<SessionWire[]> {
  return wire<SessionWire[]>((await answerOf(w, "sessions")).sessions);
}

const ID_MAIN = idOf(MACHINE, "w1:p1", "k3f9");
const ID_SIDE = idOf(MACHINE, "w2:p1", "m4n8");
const ID_SHELL = idOf(MACHINE, "w2:p2", "q7r2");

describe("sessions", () => {
  test("the contract: exactly these keys, in this order, per session, and no other key", async () => {
    const answer = await answerOf(world(), "sessions");
    expect(Object.keys(answer)).toEqual(["sessions"]);
    const rows = await sessionsOf(world());
    expect(rows.map((row) => Object.keys(row))).toEqual([
      ["id", "machine", "agent", "label", "folder", "state", "account", "rev"],
      ["id", "machine", "agent", "label", "folder", "state", "rev"],
    ]);
  });

  test("the values: the id of the pane instance, the agent word, the folder name, the state, the account label", async () => {
    const rows = await sessionsOf(world());
    expect(rows[0]).toMatchObject({ id: ID_MAIN, machine: MACHINE, agent: "claude", label: "claude", folder: "secret-project", state: "blocked", account: "work" });
    expect(rows[1]).toMatchObject({ id: ID_SIDE, machine: MACHINE, agent: "codex", label: "review box", folder: "secret-project", state: "working" });
    expect(Number.isInteger(rows[0]!.rev)).toBe(true);
    expect(decodeSessionId(rows[0]!.id)).toEqual({ machine: MACHINE, paneId: "w1:p1", instance: "k3f9" });
  });

  test("agent panes of this bridge only: no shell pane, no trick's session, none of a crew member", async () => {
    const w = world();
    w.panes.push({ muxSession: "main", pane: pane("trick:host:t:p", { kind: "trick", agent: "trick" }) });
    w.instances.set(keyOf("main", "trick:host:t:p"), "t1c2");
    const ids = (await sessionsOf(w)).map((row) => row.id);
    expect(ids).toEqual([ID_MAIN, ID_SIDE]);
    expect(ids).not.toContain(ID_SHELL);
  });

  test("a pane with no instance token is left out, and the read mints nothing", async () => {
    const w = world();
    w.instances.delete(keyOf("side", "w2:p1"));
    const ids = (await sessionsOf(w)).map((row) => row.id);
    expect(ids).toEqual([ID_MAIN]);
    expect(w.instances.has(keyOf("side", "w2:p1"))).toBe(false);
  });

  test("the label is a name a person gave, else the agent word, and never a title a program wrote", async () => {
    const w = world();
    w.panes = [
      { muxSession: "main", pane: pane("w1:p1", { paneLabel: "renamed here", sessionName: "set in the harness" }) },
      { muxSession: "main", pane: pane("w1:p2", { sessionName: "set in the harness" }) },
      { muxSession: "main", pane: pane("w1:p3", { soleTabName: "a tab I named" }) },
      { muxSession: "main", pane: pane("w1:p4", {}) },
    ];
    for (const id of ["w1:p1", "w1:p2", "w1:p3", "w1:p4"]) w.instances.set(keyOf("main", id), "abcd");
    const labels = (await sessionsOf(w)).map((row) => row.label);
    expect(labels).toEqual(["renamed here", "set in the harness", "a tab I named", "claude"]);
  });

  test("the folder is a NAME: the last part of the cwd, absent for a root or a path with no name", async () => {
    expect(folderName("/home/ada/secret-project")).toBe("secret-project");
    expect(folderName("/home/ada/secret-project/")).toBe("secret-project");
    expect(folderName("C:\\Users\\ada\\work")).toBe("work");
    expect(folderName("/")).toBe("");
    expect(folderName("")).toBe("");
    expect(folderName("C:\\")).toBe("");
    const w = world();
    w.panes = [{ muxSession: "main", pane: pane("w1:p1", { cwd: "/" }) }];
    const rows = await sessionsOf(w);
    expect("folder" in rows[0]!).toBe(false);
  });

  test("no account label for the Default account or an empty one", async () => {
    const w = world();
    w.accountLabels.set(keyOf("main", "w1:p1"), "");
    const rows = await sessionsOf(w);
    expect("account" in rows[0]!).toBe(false);
  });

  test("rev: the same row has the same rev, and a changed row has another", async () => {
    const w = world();
    const first = (await sessionsOf(w)).map((row) => row.rev);
    const again = (await sessionsOf(w)).map((row) => row.rev);
    expect(again).toEqual(first);
    w.panes[0] = { muxSession: "main", pane: pane("w1:p1", { status: "idle" }) };
    const moved = (await sessionsOf(w)).map((row) => row.rev);
    expect(moved[0]).not.toBe(first[0]);
    expect(moved[1]).toBe(first[1]);
  });
});

describe("brief", () => {
  test("the contract: exactly these keys", async () => {
    const answer = await answerOf(world(), "brief", { session: ID_MAIN });
    expect(Object.keys(answer)).toEqual(["session", "state", "ask", "lastTurnEnd", "draft"]);
    expect(answer).toEqual({ session: ID_MAIN, state: "blocked", ask: true, lastTurnEnd: null, draft: true });
  });

  test("ask follows the state: blocked is an open ask, anything else is not", async () => {
    const answer = await answerOf(world(), "brief", { session: ID_SIDE });
    expect(answer).toMatchObject({ state: "working", ask: false, draft: null });
  });

  test("lastTurnEnd is the newest turn.end of this session in the bus buffer", async () => {
    const w = world();
    w.bus.publish({ type: "turn.end", session: ID_MAIN });
    w.bus.publish({ type: "turn.end", session: ID_SIDE });
    const newest = w.bus.publish({ type: "turn.end", session: ID_MAIN });
    w.bus.publish({ type: "session.status", session: ID_MAIN, data: { state: "idle" } });
    expect((await answerOf(w, "brief", { session: ID_MAIN })).lastTurnEnd).toBe(newest.ts);
    expect((await answerOf(w, "brief", { session: ID_SIDE })).lastTurnEnd).not.toBeNull();
  });

  test("draft: a data link's word, or null when no link knows", async () => {
    const w = world();
    w.drafts.set(keyOf("main", "w1:p1"), false);
    expect((await answerOf(w, "brief", { session: ID_MAIN })).draft).toBe(false);
    w.drafts.delete(keyOf("main", "w1:p1"));
    expect((await answerOf(w, "brief", { session: ID_MAIN })).draft).toBeNull();
  });

  test("a bad id is refused by code: unknown for text, another machine and a shell pane; replaced for a reused pane id", async () => {
    const w = world();
    expect(await ask(w, "brief", { session: "ses_nonsense" })).toEqual({ ok: false, code: "api.session_unknown" });
    expect(await ask(w, "brief", { session: idOf("inst-other-b2", "w1:p1", "k3f9") })).toEqual({ ok: false, code: "api.session_unknown" });
    expect(await ask(w, "brief", { session: ID_SHELL })).toEqual({ ok: false, code: "api.session_unknown" });
    expect(await ask(w, "brief", { session: idOf(MACHINE, "w9:p9", "abcd") })).toEqual({ ok: false, code: "api.session_unknown" });
    w.instances.set(keyOf("main", "w1:p1"), "zzzz");
    expect(await ask(w, "brief", { session: ID_MAIN })).toEqual({ ok: false, code: "api.session_replaced" });
  });
});

describe("read", () => {
  test("the contract: exactly these keys", async () => {
    const w = world();
    w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: "one\ntwo", truncated: false });
    const answer = await answerOf(w, "read", { session: ID_MAIN });
    expect(Object.keys(answer)).toEqual(["session", "text", "lines", "truncated"]);
    expect(answer).toEqual({ session: ID_MAIN, text: "one\ntwo", lines: 200, truncated: false });
  });

  test("lines: the default is the bridge's, an explicit number goes to the read, and 1 to the phone's cap is all that is taken", async () => {
    const w = world();
    w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: "x", truncated: false });
    await answerOf(w, "read", { session: ID_MAIN });
    await answerOf(w, "read", { session: ID_MAIN, lines: 7 });
    await answerOf(w, "read", { session: ID_MAIN, lines: MAX_READ_LINES });
    expect(w.screenAsks.map((one) => one.lines)).toEqual([200, 7, MAX_READ_LINES]);
    expect(w.screenAsks[0]).toEqual({ muxSession: "main", paneId: "w1:p1", lines: 200 });
    for (const lines of [0, -1, 1.5, MAX_READ_LINES + 1, "5"]) {
      const result = await ask(w, "read", { session: ID_MAIN, lines });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("api.bad_request");
    }
    expect(w.screenAsks).toHaveLength(3);
  });

  test("the mask is on, and the escapes are gone from the text", async () => {
    const w = world();
    const key = ["AKIA", "PLACEHOLDER00000"].join("");
    w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: `${ESC}[32mAWS_ACCESS_KEY_ID${ESC}[0m=${key}\n$ `, truncated: false });
    const answer = await answerOf(w, "read", { session: ID_MAIN });
    expect(answer.text).toBe(`AWS_ACCESS_KEY_ID=AKIA${"•".repeat(16)}\n$ `);
    expect(String(answer.text)).not.toContain(key);
  });

  test("a screen that cannot be read is api.failed", async () => {
    expect(await ask(world(), "read", { session: ID_MAIN })).toEqual({ ok: false, code: "api.failed" });
  });

  test("a bad id is refused before any read", async () => {
    const w = world();
    expect(await ask(w, "read", { session: ID_SHELL })).toEqual({ ok: false, code: "api.session_unknown" });
    expect(w.screenAsks).toEqual([]);
  });

  test("the text is capped below the socket's answer cap, the newest lines kept, truncated says so", async () => {
    const w = world();
    const line = "x".repeat(99);
    const text = Array.from({ length: 12_000 }, (_, at) => `${String(at).padStart(5, "0")}${line}`).join("\n");
    expect(text.length).toBeGreaterThan(READ_TEXT_MAX_BYTES);
    w.screens.set(keyOf("main", "w1:p1"), { ok: true, text, truncated: false });
    const answer = await answerOf(w, "read", { session: ID_MAIN });
    expect(answer.truncated).toBe(true);
    const out = String(answer.text);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(READ_TEXT_MAX_BYTES + 2);
    expect(out.endsWith(`11999${line}`)).toBe(true);
    expect(out.startsWith("0")).toBe(true);
    expect(out.split("\n")[0]!.length).toBe(104);
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThan(1024 * 1024);
  });

  test("capText: whole lines, escapes counted at their serialized size, a line past the budget leaves nothing", () => {
    expect(capText("a\nb\nc", 100)).toEqual({ text: "a\nb\nc", cut: false });
    expect(capText("aa\nbb\ncc", 6)).toEqual({ text: "bb\ncc", cut: true });
    expect(capText("aa\nbb\ncc", 5)).toEqual({ text: "cc", cut: true });
    // A quote is two bytes serialized: five of them cost ten.
    expect(capText('"""""', 9)).toEqual({ text: "", cut: true });
    expect(capText('"""""', 10)).toEqual({ text: '"""""', cut: false });
    expect(capText("short\n" + "z".repeat(50), 10)).toEqual({ text: "", cut: true });
  });

  test("the multiplexer's own truncated flag rides through", async () => {
    const w = world();
    w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: "x", truncated: true });
    expect((await answerOf(w, "read", { session: ID_MAIN })).truncated).toBe(true);
  });
});

describe("accounts", () => {
  test("the contract: exactly these keys per account, and the values from the row", async () => {
    const w = world();
    w.accounts = [accountRow(), accountRow({ id: "claude:default", label: "", kind: "default", identity: undefined, running: undefined })];
    const answer = await answerOf(w, "accounts");
    expect(Object.keys(answer)).toEqual(["accounts"]);
    const rows = wire<Record<string, string | number | boolean | null>[]>(answer.accounts);
    expect(rows.map((row) => Object.keys(row))).toEqual([
      ["id", "agent", "label", "kind", "signedIn", "running"],
      ["id", "agent", "label", "kind", "signedIn", "running"],
    ]);
    expect(rows).toEqual([
      { id: "acc_fixture1", agent: "claude", label: "work", kind: "own", signedIn: true, running: 2 },
      { id: "claude:default", agent: "claude", label: "", kind: "default", signedIn: null, running: 0 },
    ]);
  });

  test("an account label is cut to 120 characters, as sessions.account is", async () => {
    const w = world();
    w.accounts = [accountRow({ label: "w".repeat(300) })];
    expect(wire<{ label: string }[]>((await answerOf(w, "accounts")).accounts)[0]!.label).toBe("w".repeat(NAME_MAX));
  });

  test("signedIn is false when the agent says so, null when it does not know", async () => {
    const w = world();
    w.accounts = [accountRow({ identity: { signedIn: false } })];
    expect(wire<{ signedIn: boolean | null }[]>((await answerOf(w, "accounts")).accounts)[0]!.signedIn).toBe(false);
  });

  test("a machine that offers no accounts answers an empty list", async () => {
    const w = world();
    w.accounts = null;
    expect(await answerOf(w, "accounts")).toEqual({ accounts: [] });
  });
});

describe("hill.list", () => {
  test("the contract: exactly these keys per card, and only open cards", async () => {
    const answer = await answerOf(world(), "hill.list");
    expect(Object.keys(answer)).toEqual(["cards"]);
    const cards = wire<Record<string, JsonValue>[]>(answer.cards);
    expect(cards).toHaveLength(1);
    expect(Object.keys(cards[0]!)).toEqual(["id", "machine", "sender", "title", "urgency", "date"]);
    expect(cards[0]).toEqual({ id: "dc_fixture00001", machine: "inst-fixture-a1", sender: { kind: "agent", label: "claude" }, title: "Deploy window", urgency: "today", date: "2026-11-17T09:30:00.000Z" });
    expect(Object.keys(wire<Record<string, string>>(cards[0]!.sender))).toEqual(["kind", "label"]);
  });

  test("a trick's and Collie's cards name their kind; the answered card is not listed", async () => {
    const w = world();
    w.hill = [
      decision({ id: "dc_a", from: { ...decision().from, kind: "trick", label: "daily check" } }),
      decision({ id: "dc_b", from: { ...decision().from, kind: "collie", label: "Collie" } }),
      answeredDecision(),
    ];
    const cards = wire<{ id: string; sender: { kind: string } }[]>((await answerOf(w, "hill.list")).cards);
    expect(cards.map((card) => [card.id, card.sender.kind])).toEqual([
      ["dc_a", "trick"],
      ["dc_b", "collie"],
    ]);
  });

  test("an agent sender's label is labelOf its pane here, as sessions.label: a person's name wins, the stored label never shows", async () => {
    const w = world();
    w.panes[0] = { muxSession: "main", pane: pane("w1:p1", { paneLabel: "lodge desk" }) };
    w.hill = [decision({ from: { ...decision().from, label: "stored words" } })];
    const label = (cards: Parameters<typeof wire>[0]): string => wire<{ sender: { label: string } }[]>(cards)[0]!.sender.label;
    expect(label((await answerOf(w, "hill.list")).cards)).toBe("lodge desk");
    const sessions = wire<{ label: string }[]>((await answerOf(w, "sessions")).sessions);
    expect(sessions[0]!.label).toBe("lodge desk");
  });

  test("an agent that is no session here gets the fixed word: another machine, a gone pane, a replaced instance, no address", async () => {
    const w = world();
    const base = decision().from;
    w.hill = [
      decision({ id: "dc_other", from: { ...base, memberId: "inst-workshop-b2", address: "inst-workshop-b2/w1:p1#k3f9", label: "stored one" } }),
      decision({ id: "dc_gone", from: { ...base, address: `${MACHINE}/w9:p9#k3f9`, label: "stored two" } }),
      decision({ id: "dc_replaced", from: { ...base, address: `${MACHINE}/w1:p1#zz99`, label: "stored three" } }),
      decision({ id: "dc_none", from: { ...base, address: null, label: "stored four" } }),
      decision({ id: "dc_shell", from: { ...base, address: `${MACHINE}/w2:p2#q7r2`, label: "stored five" } }),
    ];
    const cards = wire<{ id: string; sender: { label: string } }[]>((await answerOf(w, "hill.list")).cards);
    expect(cards.map((card) => [card.id, card.sender.label])).toEqual([
      ["dc_other", SENDER_AGENT],
      ["dc_gone", SENDER_AGENT],
      ["dc_replaced", SENDER_AGENT],
      ["dc_none", SENDER_AGENT],
      ["dc_shell", SENDER_AGENT],
    ]);
  });

  test("a trick's card carries the trick's name; Collie's own card the fixed word, whatever its stored label", async () => {
    const w = world();
    const base = decision().from;
    w.hill = [
      decision({ id: "dc_t", from: { ...base, kind: "trick", address: null, label: "daily check" } }),
      decision({ id: "dc_c", from: { ...base, kind: "collie", address: null, label: "anything stored" } }),
    ];
    const cards = wire<{ id: string; sender: { label: string } }[]>((await answerOf(w, "hill.list")).cards);
    expect(cards.map((card) => card.sender.label)).toEqual(["daily check", SENDER_COLLIE]);
  });

  test("one bad date leaves that card's date out and keeps the list", async () => {
    const w = world();
    w.hill = [decision({ id: "dc_bad", at: Number.NaN }), decision({ id: "dc_huge", at: 9e15 }), decision({ id: "dc_good" })];
    const cards = wire<Record<string, JsonValue>[]>((await answerOf(w, "hill.list")).cards);
    expect(cards.map((card) => [card.id, card.date ?? null])).toEqual([
      ["dc_bad", null],
      ["dc_huge", null],
      ["dc_good", "2026-11-17T09:30:00.000Z"],
    ]);
    expect(Object.keys(cards[0]!)).toEqual(["id", "machine", "sender", "title", "urgency"]);
  });

  test("no Hill on this bridge: an empty list", async () => {
    const w = world();
    w.hill = null;
    expect(await answerOf(w, "hill.list")).toEqual({ cards: [] });
  });
});

interface MachineWire {
  id: string;
  label: string;
  reachable: boolean;
  version: string | null;
  load: { cpu: number | null; memory: number | null; sessions: number | null };
}

describe("machines", () => {
  test("the contract: exactly these keys per machine, and in load exactly cpu, memory and sessions", async () => {
    const answer = await answerOf(world(), "machines");
    expect(Object.keys(answer)).toEqual(["machines"]);
    const rows = wire<MachineWire[]>(answer.machines);
    expect(rows.map((row) => Object.keys(row))).toEqual(Array.from({ length: 4 }, () => ["id", "label", "reachable", "version", "load"]));
    for (const row of rows) expect(Object.keys(row.load)).toEqual(["cpu", "memory", "sessions"]);
  });

  test("the values: the lead first as this bridge, then each member as the Machines page and the crew overview know it", async () => {
    const answer = await answerOf(world(), "machines");
    expect(wire<MachineWire[]>(answer.machines)).toEqual([
      // This machine: this bridge's id and version, its sessions as `sessions` lists them (two agents, no shell).
      { id: MACHINE, label: "workshop", reachable: true, version: VERSION, load: { cpu: 0.12, memory: 0.25, sessions: 2 } },
      // A member named by a full host name: its first part only.
      { id: "lodge", label: "lodge", reachable: true, version: "1.29.0", load: { cpu: 0.5, memory: 0.75, sessions: 3 } },
      // Named by an address: the id. Unreachable, no sample, no count, a version that is no version.
      { id: "attic", label: "attic", reachable: false, version: null, load: { cpu: null, memory: null, sessions: null } },
      // Named by a user name at a host: the id. No total memory: no fraction.
      { id: "barn", label: "barn", reachable: true, version: null, load: { cpu: 1, memory: null, sessions: 0 } },
    ]);
  });

  test("a solo bridge answers its own machine alone", async () => {
    const w = world();
    const { rows } = machineBodies();
    w.machines = machineSourcesOf([{ ...rows[0]!, id: "local", name: "workshop.example.invalid" }], null);
    expect(wire<MachineWire[]>((await answerOf(w, "machines")).machines)).toEqual([{ id: MACHINE, label: "workshop", reachable: true, version: VERSION, load: { cpu: 0.12, memory: 0.25, sessions: 2 } }]);
  });

  test("the label: the first part of a plain name, else the id", () => {
    expect(machineLabel("workshop", "m1")).toBe("workshop");
    expect(machineLabel("workshop.lan", "m1")).toBe("workshop");
    expect(machineLabel(" lodge-2 ", "m1")).toBe("lodge-2");
    for (const name of ["", "100.64.10.9", "10", "fd7a:115c::1", "[fd7a::1]", "dev-user@lodge", "/home/dev", "my box", ".hidden", "-x", "x".repeat(64)]) expect({ name, label: machineLabel(name, "m1") }).toEqual({ name, label: "m1" });
  });
});

describe("the table", () => {
  test("with the six handlers, all eight names are in the table", () => {
    expect([...tableOf(world()).keys()]).toEqual(["hello", "sessions", "brief", "read", "accounts", "hill.list", "machines", "events"]);
  });
});
