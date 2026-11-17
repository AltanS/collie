// THE LEAK TEST (M105 spec 03, task 4). Five things must not leave the bridge through the local API: an
// email, a folder path, a pairing code, a sign-in address and a message text. The fixture world
// (fixtures/reads-world.ts) puts all five in EVERY field the phone's bodies carry them in: the agents'
// titles and subtitles, the terminal title, the space and tab names, the cwd, the session file, the
// todos, subagents and jobs, the account's folder, start line, email and plan, and a Hill card's summary,
// body, options, links, media caption, recommendation, target and answer. Then every operation runs, the
// answers are serialized, and no needle may be found. `machines` (spec 04) has needles of its own, an
// address, a host name, a key, a path and a user name, in every field of the Machines page's rows and of
// the crew overview (fixtures/reads-world.ts `machineBodies`).
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

import { memoryHillReceipts } from "../hill/receipts.ts";
import { HillService, type HillAgentSender, type HillPlace } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import { hillSessionName } from "../hill/walky.ts";
import type { JsonObject } from "../json.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { idOf } from "./ids.ts";
import { buildTable, type OperationContext, type OperationTable } from "./operations.ts";
import { buildReads } from "./reads.ts";
import { machineSourcesOf } from "./world.ts";
import { accountRow, decision, depsOf, keyOf, MACHINE, MACHINE_NEEDLES, machineBodies, NEEDLES, pane, world, type World } from "./fixtures/reads-world.ts";

function ctx(): OperationContext {
  return { signal: new AbortController().signal, offered: ["hello", "sessions", "brief", "read", "accounts", "hill.list", "machines", "events"], standing: () => true, claimWait: () => () => undefined };
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
/** A run token as `hello` carries it (spec 05). */
const HELLO_TOKEN = "Tk".repeat(21) + "x";
const ID_SIDE = idOf(MACHINE, "w2:p1", "m4n8");

/** A world with the needles everywhere, plus a field the bridge may add later on each object. */
function leakyWorld(): World {
  const w = world();
  const future = { futureField: NEEDLES.message };
  w.panes = w.panes.map((source) => ({ ...source, pane: Object.assign({}, source.pane, future) }));
  w.accounts = [Object.assign(accountRow(), future), Object.assign(accountRow({ id: "acc_fixture2", label: "play", folder: NEEDLES.parent }), future)];
  w.hill = [Object.assign(decision(), future)];
  const bodies = machineBodies();
  w.machines = machineSourcesOf(
    bodies.rows.map((row) => Object.assign(row, future)),
    { ...bodies.crew, members: bodies.crew.members.map((member) => Object.assign(member, future)) },
  );
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
    const answer = await serialized(tableOf(leakyWorld()), "hello", { token: HELLO_TOKEN });
    expectClean(answer, [NEEDLES.folderName]);
    // The run token the hello named is never in its answer (spec 05, decision 1).
    expect(answer).not.toContain(HELLO_TOKEN);
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

  test("machines: no address, host name, key, path or user name, whatever field of the census holds it", async () => {
    const text = await serialized(tableOf(leakyWorld()), "machines");
    expectClean(text, [NEEDLES.folderName, ...Object.values(MACHINE_NEEDLES), "8443", "@", "/", "crew-a"]);
    // Not vacuous: the bodies the answer was built from hold every needle, in every text field.
    const w = leakyWorld();
    const body = JSON.stringify(w.machines);
    for (const needle of Object.values(MACHINE_NEEDLES)) expect(body).toContain(needle);
    const member = w.machines[1]!.member!;
    for (const field of ["name", "address", "reason", "mux", "host", "conflict"] as const) expect(JSON.stringify(member[field])).toMatch(/100\.64\.10\.9|lodge\.example\.invalid|dev-user|sha256:|\/home\/dev/u);
    expect(JSON.stringify(w.machines[1]!.row.sample?.disks)).toContain(MACHINE_NEEDLES.path);
    expect(text).toContain('"label":"lodge"');
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
      serialized(table, "hello", { token: HELLO_TOKEN }),
      serialized(table, "sessions"),
      serialized(table, "brief", { session: ID_MAIN }),
      serialized(table, "accounts"),
      serialized(table, "hill.list"),
      serialized(table, "machines"),
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

describe("hill.list through the real HillService list road (security read 1, item 2)", () => {
  // The Hill's own list renames an open card's sender with `paneName`, which falls back to the title the
  // agent wrote and to the terminal title. The secrets sit in exactly those two places and in the stored
  // `from.label`; the road is checked live (the list really carries each secret), and no answer may.
  const TITLE_SECRET = `${NEEDLES.message} for ${NEEDLES.email}`;
  const TERMINAL_SECRET = `${NEEDLES.pairing} ${NEEDLES.signIn}`;
  const STORED_SECRET = `stored ${NEEDLES.message} ${NEEDLES.pairing}`;

  function hillWorld() {
    const w = world();
    w.panes = [
      // No name of a person's: `paneName` falls to the agent's own title.
      { muxSession: "main", pane: pane("w1:p1", { paneLabel: undefined, agentTitle: TITLE_SECRET, terminalTitle: undefined }) },
      // No title of the agent's: `paneName` falls to the terminal title.
      { muxSession: "main", pane: pane("w3:p1", { paneLabel: undefined, agentTitle: undefined, terminalTitle: TERMINAL_SECRET }) },
    ];
    w.instances = new Map([
      [keyOf("main", "w1:p1"), "k3f9"],
      [keyOf("main", "w3:p1"), "p5s6"],
    ]);
    const live: HillPlace[] = [
      { address: "local/w1:p1#k3f9", label: "lodge#main", host: "lodge", unattended: false },
      { address: "local/w3:p1#p5s6", label: "lodge#main", host: "lodge", unattended: false },
      // Live for walky, but no pane of this bridge's views: the stored `from.label` stays on the card.
      { address: "local/w9:p9#abcd", label: "lodge#main", host: "lodge", unattended: false },
    ];
    const place = (address: string): HillPlace | null => live.find((one) => one.address === address) ?? null;
    let n = 0;
    const hill = new HillService({
      store: new HillStore(null, () => 1000),
      receipts: memoryHillReceipts(),
      place,
      send: async () => "typed",
      crewMode: () => "solo",
      walkyOn: () => true,
      memberId: MACHINE,
      machine: "lodge",
      now: () => 1000,
      mintId: () => {
        n += 1;
        return `dc_leak${String(n).padStart(8, "0")}`;
      },
      sessionName: hillSessionName({ place, views: () => w.panes.map((source) => source.pane), memberId: null, redact: false }),
    });
    const sender = (address: string): HillAgentSender => ({ kind: "agent", address, memberId: MACHINE, harness: "claude", label: STORED_SECRET, host: "lodge" });
    for (const [i, address] of ["local/w1:p1#k3f9", "local/w3:p1#p5s6", "local/w9:p9#abcd"].entries()) {
      const posted = hill.post(sender(address), {
        requestId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        title: "Deploy window",
        summary: NEEDLES.message,
        options: [{ intent: "go", label: "Go" }],
      });
      if (!posted.ok) throw new Error(posted.error);
    }
    w.hill = null;
    return { w, hill };
  }

  test("the road is live: the Hill's own list carries each secret in the sender's label", () => {
    const { hill } = hillWorld();
    const labels = hill.list().open.map((card) => card.from.label);
    expect(labels.some((label) => label.includes(NEEDLES.message) && label.includes(NEEDLES.email))).toBe(true);
    expect(labels.some((label) => label.includes(NEEDLES.pairing))).toBe(true);
    expect(labels.some((label) => label.includes("stored"))).toBe(true);
  });

  test("no secret reaches hill.list: the labels are labelOf the pane, or the fixed word for a pane not here", async () => {
    const { w, hill } = hillWorld();
    const deps = { ...depsOf(w), hillOpen: () => hill.list().open };
    const table = buildTable({ version: () => "9.9.9-test", bus: w.bus, reads: buildReads(deps) });
    const text = await serialized(table, "hill.list");
    for (const needle of [NEEDLES.email, NEEDLES.pairing, NEEDLES.signIn, NEEDLES.message, "stored", "QWERTY", "example.invalid"]) expect(text).not.toContain(needle);
    const cards = parseJsonObject(text)?.cards;
    const labels = (Array.isArray(cards) ? cards : []).map((card) => asJsonString(asJsonObject(asJsonObject(card)?.sender)?.label));
    expect(labels).toEqual(["claude", "claude", "agent"]);
  });
});
