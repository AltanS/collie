// REAL_MODEL is off by default. These tests only check how it is wired: no model call, no key read, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startApp } from "../app.ts";
import { api } from "./client.ts";
import { cleanup, tmp } from "./util.ts";

afterEach(() => {
  delete process.env.REAL_MODEL;
  cleanup();
});
// No seed: a ticket would call the real model.
const opts = () => ({ socket: join(tmp(), "s.sock"), storage: "memory", notesFile: join(tmp(), "n.txt"), seed: false });

describe("REAL_MODEL", () => {
  test("an OpenRouter model id from Pi's catalog starts the app, and the starters are there", async () => {
    process.env.REAL_MODEL = "google/gemini-3.1-flash-lite";
    const app = await startApp(opts());
    const snap = (await api.snapshot({ socket: app.collie.address, version: 1 })).body;
    expect(snap.starters!.map((s) => s.id)).toEqual(["new-triage", "two-notes"]);
    await app.close();
  });
  test("an id Pi does not know fails at start, before anything listens", async () => {
    process.env.REAL_MODEL = "nobody/no-such-model";
    const o = opts();
    await expect(startApp(o)).rejects.toThrow("not an OpenRouter model id");
    await expect(api.hello({ socket: o.socket, version: 1 })).rejects.toBeTruthy(); // no socket
  });
});
