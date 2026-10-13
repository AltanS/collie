// REAL_MODEL is off by default. These tests only check how it is wired: no model call, no key read, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { optionsFromEnv, startApp } from "../app.ts";
import { CredentialFile } from "../state.ts";
import { api } from "./client.ts";
import { cleanup, tmp } from "./util.ts";

const savedKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  delete process.env.REAL_MODEL;
  delete process.env.REAL_PROVIDER;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  cleanup();
});
// No seed: a ticket would call the real model.
const opts = () => ({ socket: join(tmp(), "s.sock"), storage: "memory", notesFile: join(tmp(), "n.txt"), seed: false });

describe("REAL_MODEL", () => {
  test("an OpenRouter model id from Pi's catalog starts the app, and the starters are there", async () => {
    process.env.REAL_MODEL = "google/gemini-3.1-flash-lite";
    const app = await startApp(opts());
    const snap = (await api.snapshot({ socket: app.collie.address, version: 1 })).body;
    expect(snap.starters!.map((s) => s.id)).toEqual(["sign-in", "double-charge", "new-address"]);
    await app.close();
  });
  test("an id Pi does not know fails at start, before anything listens", async () => {
    process.env.REAL_MODEL = "nobody/no-such-model";
    const o = opts();
    await expect(startApp(o)).rejects.toThrow("not an OpenRouter model id");
    await expect(api.hello({ socket: o.socket, version: 1 })).rejects.toBeTruthy(); // no socket
  });
});

describe("REAL_PROVIDER=openai, a ChatGPT sign-in or an OpenAI key", () => {
  // A stored sign-in with made-up tokens that do not expire for a day. No request is made, so none is checked.
  const signIn = { openai: { type: "oauth", access: "access-not-a-secret", refresh: "refresh-not-a-secret", expires: Date.now() + 86_400_000 } };

  test("a stored sign-in starts the app on an OpenAI model id, and the starters are there", async () => {
    process.env.REAL_MODEL = "gpt-4.1";
    process.env.REAL_PROVIDER = "openai";
    const o = opts();
    const authFile = join(tmp(), "auth.json");
    writeFileSync(authFile, JSON.stringify(signIn), { mode: 0o600 });
    const app = await startApp({ ...o, authFile });
    const snap = (await api.snapshot({ socket: app.collie.address, version: 1 })).body;
    expect(snap.starters!.map((s) => s.id)).toEqual(["sign-in", "double-charge", "new-address"]);
    await app.close();
  });
  test("without a sign-in or a key the start stops and says where to get one, before anything listens", async () => {
    process.env.REAL_MODEL = "gpt-4.1";
    process.env.REAL_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    const o = { ...opts(), authFile: join(tmp(), "none.json") };
    await expect(startApp(o)).rejects.toThrow("finds no sign-in");
    await expect(api.hello({ socket: o.socket, version: 1 })).rejects.toBeTruthy();
  });
  test("an id Pi's OpenAI catalog does not know, or a provider the app does not offer, fails at start", async () => {
    process.env.REAL_MODEL = "nobody/no-such-model";
    process.env.REAL_PROVIDER = "openai";
    await expect(startApp(opts())).rejects.toThrow("not an OpenAI model id");
    process.env.REAL_PROVIDER = "anthropic";
    await expect(startApp(opts())).rejects.toThrow("REAL_PROVIDER must be");
  });
  test("the sign-in file sits beside the other data", () => {
    expect(optionsFromEnv({ DM_DATA: "/d" }).authFile).toBe("/d/auth.json");
  });
});

describe("the credential file", () => {
  test("it reads what Pi's login wrote, writes a refreshed token back with mode 0600, and a delete removes the entry", async () => {
    const file = join(tmp(), "state", "auth.json");
    const store = new CredentialFile(file);
    expect(await store.read("openai")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    await store.modify("openai", async (current) => (current === undefined ? { type: "api_key", key: "sk-your-key-here" } : current));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
    await store.modify("openai", async () => ({ type: "oauth", access: "a2", refresh: "r2", expires: 1 }));
    expect(JSON.parse(readFileSync(file, "utf8")).openai.access).toBe("a2");
    await store.modify("openai", async () => undefined); // leave the entry unchanged
    expect((await store.read("openai"))?.type).toBe("oauth");
    await store.delete("openai");
    expect(await store.read("openai")).toBeUndefined();
  });
  test("two writes at once do not lose one", async () => {
    const store = new CredentialFile(join(tmp(), "auth.json"));
    await Promise.all([
      store.modify("a", async () => ({ type: "api_key", key: "one" })),
      store.modify("b", async () => ({ type: "api_key", key: "two" })),
    ]);
    expect((await store.list()).map((e) => e.providerId).sort()).toEqual(["a", "b"]);
  });
});
