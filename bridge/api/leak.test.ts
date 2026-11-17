// THE LEAK TEST (M105 spec 03, task 4). Five things must not leave the bridge through the local API: an
// email, a folder path, a pairing code, a sign-in address and a message text. The fixture world
// (fixtures/reads-world.ts) puts all five in EVERY field the phone's bodies carry them in: the agents'
// titles and subtitles, the terminal title, the space and tab names, the cwd, the session file, the
// todos, subagents and jobs, the account's folder, start line, email and plan, and a Hill card's summary,
// body, options, links, media caption, recommendation, target and answer. Then every operation runs, the
// answers are serialized, and no needle may be found.
//
// What is allowed, and why the fixture is built around it:
//  - `sessions.folder` is the folder NAME (`secret-project`), the last part of the cwd. The path and its
//    parent are never allowed, and the name is not allowed in any other answer.
//  - `sessions.label` may hold a name a person chose; the fixture's person-chosen names are harmless words,
//    and the program-written titles (where the needles sit) must not reach the label.
//  - A Hill card's title is allowed (the spec lists it); the fixture's title is a harmless phrase.
//  - `read` carries screen text. The mask is best effort (decision 17): it catches the shapes
//    bridge/redact.ts knows, so what this test asserts of `read` is what the mask guarantees, a secret
//    written as `password=<value>`. An email, a path or a sentence on a screen is not a secret shape and
//    passes: that is the stated limit of the mask, and the docs say so.

import { describe, expect, test } from "bun:test";

import type { JsonObject } from "../json.ts";
import { idOf } from "./ids.ts";
import { buildTable, type OperationContext, type OperationTable } from "./operations.ts";
import { buildReads } from "./reads.ts";
import { accountRow, decision, depsOf, keyOf, MACHINE, NEEDLES, pane, world, type World } from "./fixtures/reads-world.ts";

function ctx(): OperationContext {
  return { signal: new AbortController().signal, offered: ["hello", "sessions", "brief", "read", "accounts", "hill.list", "events"], standing: () => true, claimWait: () => () => undefined };
}

function tableOf(w: World): OperationTable {
  return buildTable({ version: () => "9.9.9-test", bus: w.bus, reads: buildReads(depsOf(w)) });
}

async function serialized(table: OperationTable, op: string, args: JsonObject = {}): Promise<string> {
  const result = await table.get(op)!.run(args, ctx());
  if (!result.ok) throw new Error(`${op} refused: ${result.code}`);
  return JSON.stringify(result.answer);
}

const ID_MAIN = idOf(MACHINE, "w1:p1", "k3f9");
const ID_SIDE = idOf(MACHINE, "w2:p1", "m4n8");

/** A world with the needles everywhere, plus a field the bridge may add later on each object. */
function leakyWorld(): World {
  const w = world();
  const future = { futureField: NEEDLES.message };
  w.panes = w.panes.map((source) => ({ ...source, pane: Object.assign({}, source.pane, future) }));
  w.accounts = [Object.assign(accountRow(), future), Object.assign(accountRow({ id: "acc_fixture2", label: "play", folder: NEEDLES.parent }), future)];
  w.hill = [Object.assign(decision(), future)];
  // The screens hold every needle too; the secret-shaped one is the one the mask must take.
  const screen = [`$ cat notes`, `${NEEDLES.message} for ${NEEDLES.email} in ${NEEDLES.path}`, `password=${NEEDLES.pairing}`, `visit ${NEEDLES.signIn}`].join("\n");
  w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: screen, truncated: false });
  w.screens.set(keyOf("side", "w2:p1"), { ok: true, text: screen, truncated: false });
  // The bus carries events for both sessions.
  w.bus.publish({ type: "session.status", session: ID_MAIN, data: { state: "blocked" } });
  w.bus.publish({ type: "ask.open", session: ID_MAIN });
  w.bus.publish({ type: "turn.end", session: ID_SIDE });
  return w;
}

const FORBIDDEN_EVERYWHERE = [NEEDLES.email, NEEDLES.path, NEEDLES.parent, NEEDLES.pairing, NEEDLES.signIn, NEEDLES.message, NEEDLES.plan, "QWERTY", "example.invalid", "futureField"];

function expectClean(text: string, extra: readonly string[] = []): void {
  for (const needle of [...FORBIDDEN_EVERYWHERE, ...extra]) expect(text).not.toContain(needle);
}

describe("no needle in any answer of the local API", () => {
  test("the fixture really holds every needle in the fields the phone's bodies carry", () => {
    const w = leakyWorld();
    const body = JSON.stringify([w.panes.map((source) => source.pane), w.accounts, w.hill]);
    for (const needle of [NEEDLES.email, NEEDLES.path, NEEDLES.pairing, NEEDLES.signIn, NEEDLES.message, NEEDLES.plan]) expect(body).toContain(needle);
    const main = w.panes[0]!.pane;
    for (const field of ["workspaceLabel", "tabLabel", "cwd", "agentTitle", "terminalTitle", "subtitle", "hint", "badge", "agentSession", "todos", "subagents", "jobs"] as const) {
      expect(JSON.stringify(main[field])).toMatch(/example\.invalid|\/home\/ada|ABCD-1234-EFGH|please deploy the vault/u);
    }
  });

  test("hello", async () => {
    expectClean(await serialized(tableOf(leakyWorld()), "hello"), [NEEDLES.folderName]);
  });

  test("sessions: the folder NAME is the one allowed trace of the path", async () => {
    const text = await serialized(tableOf(leakyWorld()), "sessions");
    expectClean(text);
    expect(text).toContain(`"folder":"${NEEDLES.folderName}"`);
    expect(text).toContain('"label":"claude"');
  });

  test("brief, for every session", async () => {
    const table = tableOf(leakyWorld());
    for (const session of [ID_MAIN, ID_SIDE]) expectClean(await serialized(table, "brief", { session }), [NEEDLES.folderName]);
  });

  test("accounts", async () => {
    const text = await serialized(tableOf(leakyWorld()), "accounts");
    expectClean(text, [NEEDLES.folderName]);
    expect(text).toContain('"signedIn":true');
  });

  test("hill.list", async () => {
    const text = await serialized(tableOf(leakyWorld()), "hill.list");
    expectClean(text, [NEEDLES.folderName]);
    expect(text).toContain("Deploy window");
  });

  test("events, with the bus's events published", async () => {
    const w = leakyWorld();
    const text = await serialized(tableOf(w), "events", { after: "other.0" });
    expect(text).toContain("turn.end");
    expectClean(text, [NEEDLES.folderName]);
  });

  test("read: what the mask guarantees, a secret written as password=<value>, is not in the text", async () => {
    const w = leakyWorld();
    const table = tableOf(w);
    for (const session of [ID_MAIN, ID_SIDE]) {
      const text = await serialized(table, "read", { session });
      expect(text).not.toContain(NEEDLES.pairing);
      expect(text).toContain("password=");
      // And the answer is plain text: no escape travels.
      expect(text).not.toContain("\\u001b");
    }
  });

  test("every operation at once: nothing but read's own screen carries an email or a path", async () => {
    const w = leakyWorld();
    const table = tableOf(w);
    const answers = await Promise.all([
      serialized(table, "hello"),
      serialized(table, "sessions"),
      serialized(table, "brief", { session: ID_MAIN }),
      serialized(table, "accounts"),
      serialized(table, "hill.list"),
      serialized(table, "events", { after: "other.0" }),
    ]);
    const all = answers.join("\n");
    for (const needle of [NEEDLES.email, NEEDLES.path, NEEDLES.parent, NEEDLES.pairing, NEEDLES.signIn, NEEDLES.message, NEEDLES.plan]) expect(all).not.toContain(needle);
  });

  test("a program-written title never becomes the label, even on a pane with no name of a person's", async () => {
    const w = leakyWorld();
    w.panes = [{ muxSession: "main", pane: pane("w1:p1", { agentTitle: NEEDLES.message, terminalTitle: NEEDLES.email }) }];
    const text = await serialized(tableOf(w), "sessions");
    expect(text).toContain('"label":"claude"');
    expectClean(text);
  });
});
