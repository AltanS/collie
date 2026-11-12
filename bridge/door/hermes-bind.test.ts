import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hermesLatestTurns, type HermesLatestTurn } from "../journal/hermes.ts";
import { hermesBinder, type HermesBindDeps, type HermesPane } from "./hermes-bind.ts";

const sid = (n: number): string => `local-${String(n).repeat(64).slice(0, 64)}`;
const A = sid(1);
const B = sid(2);
const C = sid(3);

const REPLY_A = "The build passed on the second try after the cache was cleared by hand.";
const REPLY_B = "I renamed the three handlers and updated every caller in the router module.";

const TARGET = { session: "s", paneId: "w1:p2", harness: "hermes" };

/** An Ink screen: a banner, the turns, wrapped at `width`, and a composer. */
function ink(turns: readonly string[], width = 40): string {
  const rows = ["  Hermes Agent v0.23.0", ""];
  for (const turn of turns) for (let at = 0; at < turn.length; at += width) rows.push(`  ${turn.slice(at, at + width)}`);
  rows.push("", "❯ ", " Session: 11111111");
  return rows.join("\n");
}

interface Rig {
  turns?: readonly HermesLatestTurn[] | null;
  panes?: readonly HermesPane[];
  screens?: Record<string, string | null>;
  hang?: string;
}

function bind(rig: Rig) {
  const deps: HermesBindDeps = {
    dbPath: "/unused",
    turns: () => (rig.turns === undefined ? [{ sessionId: A, text: REPLY_A, whole: true }, { sessionId: B, text: REPLY_B, whole: true }] : rig.turns),
    panes: () => rig.panes ?? [{ paneId: "w1:p2", session: A }, { paneId: "w1:p3", session: B }],
    read: (paneId) => (paneId === rig.hang ? new Promise<string | null>(() => undefined) : Promise.resolve(rig.screens?.[paneId] ?? null)),
  };
  return hermesBinder(deps)(TARGET, new AbortController().signal);
}

const twoPanes = { "w1:p2": ink(["desk A one", REPLY_A]), "w1:p3": ink(["desk B one", REPLY_B]) };

describe("hermesBinder (SPEC V16, V28, V29)", () => {
  test("binds the one live session whose latest turn is on this pane's screen, wrapped", async () => {
    expect(await bind({ screens: twoPanes })).toEqual({ ok: true, sessionId: A });
  });

  test("leg F: the screen shows A, the multiplexer names B for this pane → refused, never sent to B", async () => {
    const answer = await bind({ screens: twoPanes, panes: [{ paneId: "w1:p2", session: B }, { paneId: "w1:p3", session: undefined }] });
    expect(answer.ok).toBe(false);
  });

  test("the multiplexer names no session for the pane → refused (the journal could not prove it)", async () => {
    const answer = await bind({ screens: twoPanes, panes: [{ paneId: "w1:p2", session: undefined }, { paneId: "w1:p3", session: B }] });
    expect(answer).toMatchObject({ ok: false });
  });

  test("the same latest turn on another Hermes pane → refused", async () => {
    expect((await bind({ screens: { "w1:p2": twoPanes["w1:p2"], "w1:p3": ink([REPLY_A]) } })).ok).toBe(false);
  });

  test("two live sessions' latest turns on this pane → refused", async () => {
    expect((await bind({ screens: { "w1:p2": ink([REPLY_B, REPLY_A]), "w1:p3": twoPanes["w1:p3"] } })).ok).toBe(false);
  });

  test("no live session's latest turn on screen (a fresh pane) → refused", async () => {
    expect((await bind({ screens: { "w1:p2": ink([]), "w1:p3": twoPanes["w1:p3"] } })).ok).toBe(false);
  });

  test("another Hermes pane cannot be read → refused", async () => {
    expect((await bind({ screens: { "w1:p2": twoPanes["w1:p2"], "w1:p3": null } })).ok).toBe(false);
  });

  test("another Hermes pane's read hangs → refused within the bound", async () => {
    const started = Date.now();
    expect((await bind({ screens: twoPanes, hang: "w1:p3" })).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the session store cannot be read → refused", async () => {
    expect((await bind({ screens: twoPanes, turns: null })).ok).toBe(false);
  });

  test("a latest turn below the probe floor never binds, even when it is the only match", async () => {
    const turns = [{ sessionId: A, text: "ok thanks", whole: true }];
    expect((await bind({ turns, screens: { "w1:p2": ink(["ok thanks"]), "w1:p3": ink([]) } })).ok).toBe(false);
  });

  test("a probe just at the floor binds", async () => {
    const text = "abcdefghij klmnopqrst uvwx"; // 24 letters folded
    const turns = [{ sessionId: A, text, whole: true }];
    expect(await bind({ turns, screens: { "w1:p2": ink([text]), "w1:p3": ink([]) } })).toEqual({ ok: true, sessionId: A });
  });

  test("the user turn scrolled off, the assistant's tail still on screen → binds", async () => {
    const long = `${"Here is the plan in full. ".repeat(20)}That is everything for the migration step.`;
    const turns = [{ sessionId: A, text: long, whole: true }];
    expect(await bind({ turns, screens: { "w1:p2": ink([long.slice(-120)]), "w1:p3": ink([]) } })).toEqual({ ok: true, sessionId: A });
  });

  test("the latest turn only in a panel past the split cut → no match", async () => {
    const rows = ink([]).split("\n").map((row) => `${row.padEnd(30)}│ ${""}`);
    rows[2] = `${"  agent side".padEnd(30)}│ ${REPLY_A}`;
    const turns = [{ sessionId: A, text: REPLY_A, whole: true }];
    expect((await bind({ turns, panes: [{ paneId: "w1:p2", session: A }], screens: { "w1:p2": rows.join("\n") } })).ok).toBe(false);
  });
});

describe("hermesLatestTurns (SPEC V29, V30)", () => {
  const SESSIONS =
    "create table sessions (id text primary key, source text, created_source text, started_at real, parent_session_id text, ended_at real, archived integer default 0, hidden integer default 0, last_activity_at real)";
  const MESSAGES =
    "create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)";

  // Rows as Hermes writes them: an owner surface is stored as `local`, its surface in `created_source`
  // (gateway/session_policy.py, STORED_AS_LOCAL); a legacy Ink row says `tui` with no `created_source`.
  test("live Ink sessions only, newest prose over the lineage, tool rows skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collie-hermes-bind-"));
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    db.run(SESSIONS);
    db.run(MESSAGES);
    const D = sid(4);
    const E = sid(5);
    const F = sid(6);
    const G = sid(7);
    const K = sid(8);
    const sessions: [string, string, string | null, number | null, number, number, string | null][] = [
      [A, "local", "tui", null, 0, 0, null], // live Ink, as the gateway stores it today
      [B, "tui", "tui", 5, 0, 0, null], // ended
      [C, "cron", null, null, 0, 0, null], // headless
      [D, "local", "tui", null, 1, 0, null], // archived
      [E, "local", "tui", null, 0, 0, A], // a fork of A with no turn of its own
      [F, "local", "tui", null, 0, 0, null], // live, no turn yet
      [G, "tui", null, null, 0, 0, null], // live Ink, a legacy row
      [K, "local", "cli", null, 0, 0, null], // live, but the classic CLI's, not Ink's
    ];
    for (const [id, source, created, ended, archived, hidden, parent] of sessions) {
      db.run("insert into sessions (id, source, created_source, started_at, ended_at, archived, hidden, parent_session_id) values (?, ?, ?, 1, ?, ?, ?, ?)", [id, source, created, ended, archived, hidden, parent]);
    }
    let row = 0;
    const msg = (session: string, role: string, content: string | null, extra: { active?: number; display_kind?: string } = {}) =>
      db.run("insert into messages (id, session_id, role, content, timestamp, active, display_kind) values (?, ?, ?, ?, 1, ?, ?)", [++row, session, role, content, extra.active ?? 1, extra.display_kind ?? null]);
    msg(A, "user", "desk A one");
    msg(A, "assistant", REPLY_A);
    msg(A, "assistant", null); // a bare tool call
    msg(A, "tool", "tool output");
    msg(A, "assistant", "rewound", { active: 0 });
    msg(A, "assistant", "hidden note", { display_kind: "hidden" });
    for (const id of [B, C, D, K]) msg(id, "assistant", REPLY_B);
    msg(G, "assistant", REPLY_B);
    db.close();

    const turns = hermesLatestTurns(dbPath);
    expect(turns?.map((turn) => [turn.sessionId, turn.text]).toSorted()).toEqual([
      [A, REPLY_A],
      [E, REPLY_A],
      [G, REPLY_B],
    ].toSorted());
    await rm(dir, { recursive: true, force: true });
  });

  test("an unreadable store answers null", () => {
    expect(hermesLatestTurns("/nonexistent/state.db")).toBeNull();
  });
});
