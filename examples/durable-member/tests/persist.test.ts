// A rename the phone makes survives a restart of the Bun example: the names are kept in `titles.json` in its data
// folder, the way the Cloudflare member keeps them in SQLite (WIRE.md 7.8).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, TitleStore } from "../app.ts";
import { api, type Dial } from "./client.ts";
import { cleanup, tmp } from "./util.ts";

afterAll(cleanup);

const open = (dir: string, socket = "s.sock") =>
  startApp({ socket: join(dir, socket), storage: "memory", stepMs: 0, notesFile: join(dir, "notes.txt"), callerCheck: "off", seed: false });
const titleOf = async (d: Dial, kind: "tabs" | "workspaces", id: string) => (await api.snapshot(d)).body[kind].find((x) => x.id === id)?.title;

describe("persist: a rename survives a restart", () => {
  test("the names are written to titles.json, win over the code on the next start, and leave other names alone", async () => {
    const dir = tmp();
    const first = await open(dir);
    const d1: Dial = { socket: first.collie.address, version: 1 };
    expect(await titleOf(d1, "tabs", "triage:inbox")).toBe("Inbox");
    expect((await api.rename(d1, "tab", "triage:inbox", "  Tickets  ")).body).toEqual({ ok: true });
    expect((await api.rename(d1, "workspace", "triage", "Support")).body).toEqual({ ok: true });
    expect(await titleOf(d1, "tabs", "triage:inbox")).toBe("Tickets");
    expect(JSON.parse(readFileSync(join(dir, "titles.json"), "utf8"))).toEqual({ "tab/triage:inbox": "Tickets", "workspace/triage": "Support" });
    await first.close();

    const second = await open(dir, "s2.sock");
    const d2: Dial = { socket: second.collie.address, version: 1 };
    expect(await titleOf(d2, "tabs", "triage:inbox")).toBe("Tickets");
    expect(await titleOf(d2, "workspaces", "triage")).toBe("Support");
    expect(await titleOf(d2, "tabs", "triage:helpers")).toBe("Helpers"); // never renamed: the name in the code
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
