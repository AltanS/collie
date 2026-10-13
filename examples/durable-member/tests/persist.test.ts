// What the phone does survives a restart of the Bun example. A rename is kept in `titles.json` in its data folder, the
// way the Cloudflare member keeps it in SQLite (WIRE.md 7.8). A close archives the conversation in `closed.json` (7.9).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../app.ts";
import { TitleStore } from "../state.ts";
import { api, type Dial } from "./client.ts";
import { cleanup, firstAsk, pane, tmp, waitFor } from "./util.ts";

afterAll(cleanup);

const open = (dir: string, socket = "s.sock") =>
  startApp({ socket: join(dir, socket), storage: "memory", stepMs: 0, notesFile: join(dir, "notes.txt"), callerCheck: "off", seed: false });
const titleOf = async (d: Dial, kind: "tabs" | "workspaces", id: string) => (await api.snapshot(d)).body[kind].find((x) => x.id === id)?.title;

describe("persist: a rename survives a restart", () => {
  test("the names are written to titles.json, win over the code on the next start, and leave other names alone", async () => {
    const dir = tmp();
    const first = await open(dir);
    const d1: Dial = { socket: first.collie.address, version: 1 };
    expect(await titleOf(d1, "tabs", "triage:inbox")).toBe("Tickets");
    expect((await api.rename(d1, "tab", "triage:inbox", "  Open tickets  ")).body).toEqual({ ok: true });
    expect((await api.rename(d1, "workspace", "triage", "Help desk")).body).toEqual({ ok: true });
    expect(await titleOf(d1, "tabs", "triage:inbox")).toBe("Open tickets");
    expect(JSON.parse(readFileSync(join(dir, "titles.json"), "utf8"))).toEqual({ "tab/triage:inbox": "Open tickets", "workspace/triage": "Help desk" });
    await first.close();

    const second = await open(dir, "s2.sock");
    const d2: Dial = { socket: second.collie.address, version: 1 };
    expect(await titleOf(d2, "tabs", "triage:inbox")).toBe("Open tickets");
    expect(await titleOf(d2, "workspaces", "triage")).toBe("Help desk");
    expect(await titleOf(d2, "tabs", "triage:helpers")).toBe("Look-ups"); // never renamed: the name in the code
    await second.close();
  });

  test("a file that is not JSON, or not an object, is no names, and the next rename writes a good one", () => {
    const dir = tmp();
    const file = join(dir, "titles.json");
    writeFileSync(file, "{ not json");
    const broken = new TitleStore(file);
    expect(broken.get("tab", "a:b", "Fallback")).toBe("Fallback");
    broken.set("tab", "a:b", "New");
    expect(new TitleStore(file).get("tab", "a:b", "Fallback")).toBe("New");
    writeFileSync(file, "[1,2]");
    expect(new TitleStore(file).get("tab", "a:b", "Fallback")).toBe("Fallback");
    writeFileSync(file, JSON.stringify({ "tab/a:b": 4, "tab/c:d": "Kept" }));
    const mixed = new TitleStore(file);
    expect([mixed.get("tab", "a:b", "F"), mixed.get("tab", "c:d", "F")]).toEqual(["F", "Kept"]);
  });

  test("no rename, no file", async () => {
    const dir = tmp();
    const app = await open(dir);
    await app.close();
    expect(existsSync(join(dir, "titles.json"))).toBe(false);
  });
});

describe("persist: a close survives a restart", () => {
  test("the phone closes a ticket: its ask stops, it is written to closed.json, and the next start does not show it", async () => {
    const dir = tmp();
    const storage = join(dir, "store");
    const start = (socket: string, seed: boolean) =>
      startApp({ socket: join(dir, socket), storage, stepMs: 0, slowMs: 60_000, notesFile: join(dir, "notes.txt"), callerCheck: "off", seed });
    const first = await start("s.sock", true);
    const d1: Dial = { socket: first.collie.address, version: 1 };
    const panes = (await api.snapshot(d1)).body.panes;
    expect(panes.length).toBe(1);
    const ticket = panes[0]!.id;
    await waitFor("the ticket asks", () => firstAsk(d1, ticket));

    // The layout is this program's own, in code: it refuses to close a tab or a workspace.
    expect((await api.close(d1, "tab", "triage:inbox")).body.code).toBe("close-refused");
    expect((await api.close(d1, "workspace", "triage")).body.code).toBe("close-refused");
    expect(existsSync(join(dir, "closed.json"))).toBe(false);

    expect((await api.close(d1, "pane", ticket)).body).toEqual({ ok: true });
    const snap = (await api.snapshot(d1)).body;
    expect(snap.panes).toEqual([]);
    expect(snap.tabs.map((t) => t.id).sort()).toEqual(["triage:helpers", "triage:inbox"]);
    expect(JSON.parse(readFileSync(join(dir, "closed.json"), "utf8")).length).toBe(1);
    await first.close();

    const second = await start("s2.sock", false);
    const d2: Dial = { socket: second.collie.address, version: 1 };
    expect((await api.snapshot(d2)).body.panes).toEqual([]);
    await second.close();
  });
});

describe("persist: history keeps a closed conversation, and reopen brings it back (WIRE.md 7.16)", () => {
  test("history: a closed ticket is listed closed with all its items, across a restart, and reopen shows it again under the same pane id", async () => {
    const dir = tmp();
    const storage = join(dir, "store");
    const start = (socket: string, seed: boolean) =>
      startApp({ socket: join(dir, socket), storage, stepMs: 0, notesFile: join(dir, "notes.txt"), callerCheck: "off", seed });
    const first = await start("s.sock", true);
    const d1: Dial = { socket: first.collie.address, version: 1 };
    const ticket = (await api.snapshot(d1)).body.panes[0]!.id;
    expect((await api.hello(d1)).body.caps).toMatchObject({ history: true, reopen: true });
    // The conversation id the history serves it under is the pane's own id.
    expect((await pane(d1, ticket))?.sessionId).toBe(ticket);
    const ask = await waitFor("the ticket asks", () => firstAsk(d1, ticket));
    expect((await api.answer(d1, ticket, ask.id, "allow")).body).toEqual({ result: "taken" });
    // The look-up closes itself once it answered, so the ticket is the one pane left.
    await waitFor("the ticket is idle and its look-up closed", async () => {
      const panes = (await api.snapshot(d1)).body.panes;
      return panes.length === 1 && panes[0]!.state === "idle";
    });
    const live = await api.items(d1, ticket);
    expect(live.status).toBe(200);
    const kinds = live.body.items.map((item) => item.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("tool");
    expect(kinds.slice(-3)).toEqual(["markdown", "code", "link"]);

    expect((await api.close(d1, "pane", ticket)).body).toEqual({ ok: true });
    const listed = (await api.conversations(d1)).body.items;
    // Newest first: the look-up was made after the ticket. Both are closed now, each under its own name.
    expect(listed.map((row) => [row.title, row.subtitle, row.state])).toEqual([
      ["Look-up for Maria Lopez", "Why does sign-in fail right after a password reset?", "closed"],
      ["Maria Lopez", "Can't sign in after a password reset", "closed"],
    ]);
    const row = listed.find((x) => x.id === ticket)!;
    expect(row).toMatchObject({ workspaceId: "triage", tabId: "triage:inbox", items: live.body.items.length });
    expect(row.endedAt).toBeDefined();
    await first.close();

    // A restart: the ticket is not shown, and the program still serves all of it, from Pi's store.
    const second = await start("s2.sock", false);
    const d2: Dial = { socket: second.collie.address, version: 1 };
    expect((await api.snapshot(d2)).body.panes.map((p) => p.id).includes(ticket)).toBe(false);
    expect((await api.conversations(d2)).body.items.find((x) => x.id === ticket)?.state).toBe("closed");
    const after = await api.items(d2, ticket, { limit: 2 });
    expect(after.body.items.map((item) => item.id)).toEqual(live.body.items.slice(0, 2).map((item) => item.id));
    expect(after.body.more).toBe(true);
    const rest = await api.items(d2, ticket, { after: after.body.next });
    expect(rest.body.items.map((item) => item.id)).toEqual(live.body.items.slice(2).map((item) => item.id));

    // Reopen: the same pane id, off closed.json, and listed open.
    expect((await api.reopen(d2, ticket)).body).toEqual({ ok: true });
    expect(await pane(d2, ticket)).toMatchObject({ tabId: "triage:inbox", title: "Maria Lopez", subtitle: "Can't sign in after a password reset" });
    // The ticket is off closed.json; its look-up, closed by the program when it answered, stays on it.
    const lookup = listed[0]!.id.replace("conv-", "");
    expect(JSON.parse(readFileSync(join(dir, "closed.json"), "utf8"))).toEqual([lookup]);
    expect((await api.conversations(d2)).body.items.find((x) => x.id === ticket)?.state).toBe("open");
    expect((await api.reopen(d2, "conv-999")).body.code).toBe("no-such-target");
    await second.close();

    const third = await start("s3.sock", false);
    const d3: Dial = { socket: third.collie.address, version: 1 };
    expect((await api.snapshot(d3)).body.panes.map((p) => p.id).includes(ticket)).toBe(true);
    await third.close();
  });
});
