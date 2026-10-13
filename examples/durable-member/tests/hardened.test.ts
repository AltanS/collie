// The hardened wire: the hello service, the path cap, the private folder and socket, a live instance, the
// request id bound to its payload, and the cleaned flag. SDK only. No Pi Durable here.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "./client.ts";
import { Receipts } from "../../../packages/durable-sdk/src/core/receipts.ts";
import { type AskInput, cut, openCollie, type PaneHandle, type PermissionAskInput } from "../../../packages/durable-sdk/src/index.ts";
import { withNarrowUmask } from "../../../packages/durable-sdk/src/socket.ts";
import { cleanup, tmp, waitFor } from "./util.ts";

afterAll(cleanup);
const open = (socket: string, more: object = {}) => openCollie({ callerCheck: "off", socket, hostName: "t", ...more });
const withUmask = async <T>(mask: number, fn: () => Promise<T>) => {
  const before = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(before);
  }
};
const modeOf = (p: string) => lstatSync(p).mode & 0o7777;

describe("hello and the path", () => {
  // Refusing a server that does not say it is the adapter's job: bridge/mux/durable/protocol.test.ts.
  test("hello carries service collie-durable", async () => {
    const c = await open(join(tmp(), "s.sock"));
    c.ready();
    const hello = (await api.hello({ socket: c.address, version: 1 })).body;
    expect(hello.service).toBe("collie-durable");
    await c.close();
  });

  test("the path cap is 103 bytes: 103 starts, 104 is refused", async () => {
    const base = `${tmp()}/`;
    const at = (n: number) => `${base}${"s".repeat(n - Buffer.byteLength(base))}`;
    const ok = await open(at(103));
    expect(Buffer.byteLength(ok.address)).toBe(103);
    await ok.close();
    await expect(open(at(104))).rejects.toThrow("103");
  });
});

describe("the private folder and socket", () => {
  test("a folder the SDK makes is exactly 0700, whatever the umask, and the socket is exactly 0600", async () => {
    for (const mask of [0o000, 0o022, 0o277]) {
      const parent = join(tmp(), "a");
      mkdirSync(parent); // made first: a umask like 0277 would take the owner's write bit from a folder made under it
      const dir = join(parent, "run");
      const c = await withUmask(mask, () => open(join(dir, "s.sock")));
      expect([mask, modeOf(dir)]).toEqual([mask, 0o700]);
      expect([mask, modeOf(c.address)]).toEqual([mask, 0o600]);
      expect(lstatSync(c.address).isSocket()).toBe(true);
      await c.close();
    }
  });

  test("the socket is bound under umask 0177 and the umask is put back, also when the bind throws", () => {
    const before = process.umask();
    expect(withNarrowUmask(() => process.umask())).toBe(0o177);
    expect(process.umask()).toBe(before);
    expect(() => withNarrowUmask(() => { throw new Error("bind failed"); })).toThrow("bind failed");
    expect(process.umask()).toBe(before);
  });

  test("an existing folder must be a real folder of this user with mode 0700", async () => {
    const root = tmp();
    for (const mode of [0o755, 0o770, 0o701, 0o707, 0o750]) {
      const dir = join(root, `m${mode.toString(8)}`);
      mkdirSync(dir);
      chmodSync(dir, mode);
      await expect(open(join(dir, "s.sock"))).rejects.toThrow("0700");
      expect(modeOf(dir)).toBe(mode); // not taken over, not chmodded
      expect(existsSync(join(dir, "s.sock"))).toBe(false);
    }
    const good = join(root, "good");
    mkdirSync(good, { mode: 0o700 });
    const c = await open(join(good, "s.sock"));
    await c.close();

    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(root, "link"));
    await expect(open(join(root, "link", "s.sock"))).rejects.toThrow("symlink");
    expect(existsSync(join(real, "s.sock"))).toBe(false);

    writeFileSync(join(root, "plain"), "x");
    await expect(open(join(root, "plain", "s.sock"))).rejects.toThrow();
    if (process.getuid!() !== 0) await expect(open("/usr/dm-never.sock")).rejects.toThrow("belongs to user");
  });
});

describe("a stale socket and a live one", () => {
  const deadSocket = async (path: string) => {
    const child = Bun.spawn(["bun", "-e", `import{createServer}from"node:net";createServer().listen(${JSON.stringify(path)},()=>console.log("up"))`], { stdout: "pipe", stderr: "inherit" });
    await waitFor("socket file", () => existsSync(path));
    child.kill("SIGKILL");
    await child.exited;
  };

  test("a second instance on a live socket refuses to start and leaves the first alone", async () => {
    const path = join(tmp(), "s.sock");
    const first = await open(path);
    first.ready();
    const inode = statSync(path).ino;
    await expect(open(path)).rejects.toThrow("another instance");
    expect(statSync(path).ino).toBe(inode);
    expect((await api.hello({ socket: path, version: 1 })).status).toBe(200);
    await first.close();
  });

  test("only a dead socket is unlinked: a dead one goes, a symlink to it stays, and so does a file", async () => {
    const dir = tmp();
    const dead = join(dir, "dead.sock");
    await deadSocket(dead);
    symlinkSync(dead, join(dir, "link.sock"));
    await expect(open(join(dir, "link.sock"))).rejects.toThrow("not a socket");
    expect(lstatSync(join(dir, "link.sock")).isSymbolicLink()).toBe(true);
    expect(existsSync(dead)).toBe(true);

    const c = await open(dead);
    c.ready();
    expect((await api.hello({ socket: dead, version: 1 })).status).toBe(200);
    await c.close();
    expect(existsSync(dead)).toBe(false);
  });
});

describe("a request id is bound to its payload", () => {
  const sent: string[] = [];
  const options = [
    { id: "allow", label: "Allow", effect: "allow" as const },
    { id: "deny", label: "Deny", effect: "deny" as const },
  ];
  const ask = (id: string): AskInput => ({ id, kind: "permission", toolCallId: `c-${id}`, itemId: `c-${id}`, title: "t", options });
  const hold = (p: PaneHandle, a: AskInput) => void p.ask(a).catch(() => {});
  let gate!: () => void;
  const gated = new Promise<void>((ok) => (gate = ok));
  let entered = 0;

  test("another pane, ask, revision, option, note, turn, text or starter under the same id is 409 request-id-reused", async () => {
    const c = await open(join(tmp(), "s.sock"));
    const tab = c.workspace("w", { title: "W" }).tab("t", { title: "T" });
    const p1 = tab.pane("p1", { title: "1", harness: "x" });
    const p2 = tab.pane("p2", { title: "2", harness: "x" });
    for (const p of [p1, p2]) {
      p.onSend((text) => void sent.push(text));
      p.onAbort(() => {});
    }
    c.starters([
      { id: "s1", label: "1", run: async () => ({ paneId: "p1" }) },
      { id: "s2", label: "2", run: async () => ({ paneId: "p2" }) },
    ]);
    c.ready();
    const d = { socket: c.address, version: 1 };
    const turn1 = (await api.snapshot(d)).body.panes.find((p) => p.id === "p1")!.turnId;
    const turn2 = (await api.snapshot(d)).body.panes.find((p) => p.id === "p2")!.turnId;
    const reused = (r: { status: number; body: { code?: string } }) => [r.status, r.body.code];
    const REUSED = [409, "request-id-reused"];

    // answer
    for (const p of [p1, p2]) for (const id of ["a1", "a2"]) hold(p, ask(id));
    expect((await api.answer(d, "p1", "a1", "allow", { requestId: "r-ans", revision: 1, note: "n" })).body).toEqual({ result: "taken" });
    expect(reused(await api.answer(d, "p1", "a1", "deny", { requestId: "r-ans", revision: 1, note: "n" }))).toEqual(REUSED); // option
    expect(reused(await api.answer(d, "p1", "a2", "allow", { requestId: "r-ans", revision: 1, note: "n" }))).toEqual(REUSED); // ask
    expect(reused(await api.answer(d, "p2", "a1", "allow", { requestId: "r-ans", revision: 1, note: "n" }))).toEqual(REUSED); // pane
    expect(reused(await api.answer(d, "p1", "a1", "allow", { requestId: "r-ans", revision: 2, note: "n" }))).toEqual(REUSED); // revision, not stale
    expect(reused(await api.answer(d, "p1", "a1", "allow", { requestId: "r-ans", revision: 1, note: "other" }))).toEqual(REUSED); // note
    expect((await api.answer(d, "p1", "a1", "allow", { requestId: "r-ans", revision: 1, note: "n" })).body).toEqual({ result: "taken", replayed: true });

    // send
    expect((await api.send(d, "p1", "hello", { turnId: turn1, requestId: "r-send" })).body).toEqual({ ok: true });
    expect(reused(await api.send(d, "p1", "other text", { turnId: turn1, requestId: "r-send" }))).toEqual(REUSED); // text
    expect(reused(await api.send(d, "p1", "hello", { turnId: "some-other-turn", requestId: "r-send" }))).toEqual(REUSED); // turn, not stale
    expect(reused(await api.send(d, "p1", "hello", { askId: "a2", requestId: "r-send" }))).toEqual(REUSED); // ask for turn
    expect(reused(await api.send(d, "p2", "hello", { turnId: turn2, requestId: "r-send" }))).toEqual(REUSED); // pane
    expect((await api.send(d, "p1", "hello", { turnId: turn1, requestId: "r-send" })).body).toEqual({ ok: true, replayed: true });
    expect(sent).toEqual(["hello"]);

    // abort
    expect((await api.abort(d, "p1", { turnId: turn1, requestId: "r-abort" })).status).toBe(200);
    expect(reused(await api.abort(d, "p1", { turnId: "some-other-turn", requestId: "r-abort" }))).toEqual(REUSED);
    expect(reused(await api.abort(d, "p2", { turnId: turn2, requestId: "r-abort" }))).toEqual(REUSED);

    // starter
    expect((await api.start(d, "s1", "r-start")).body).toEqual({ paneId: "p1" });
    expect(reused(await api.start(d, "s2", "r-start"))).toEqual(REUSED);
    expect((await api.start(d, "s1", "r-start")).body).toEqual({ paneId: "p1", replayed: true });
    await c.close();
  });

  test("also while the first is still in flight: the other payload gets the 409 at once, the same payload waits and replays", async () => {
    const c = await open(join(tmp(), "s.sock"));
    const p = c.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    const texts: string[] = [];
    p.onSend(async (text) => {
      entered++;
      await gated;
      texts.push(text);
    });
    c.starters([
      { id: "slow", label: "slow", run: async () => (await gated, { paneId: "p" }) },
      { id: "other", label: "other", run: async () => ({ paneId: "p" }) },
    ]);
    c.ready();
    const d = { socket: c.address, version: 1 };
    const turnId = (await api.snapshot(d)).body.panes[0]!.turnId;

    const first = api.send(d, "p", "first", { turnId, requestId: "r-fly" });
    await waitFor("handler entered", () => entered > 0);
    const clash = await api.send(d, "p", "second", { turnId, requestId: "r-fly" });
    expect([clash.status, clash.body.code]).toEqual([409, "request-id-reused"]);
    const same = api.send(d, "p", "first", { turnId, requestId: "r-fly" });

    const startA = api.start(d, "slow", "r-fly-start");
    await Bun.sleep(100); // the first start has taken its place in the memory
    const startClash = await api.start(d, "other", "r-fly-start");
    expect([startClash.status, startClash.body.code]).toEqual([409, "request-id-reused"]);

    gate();
    expect((await first).body).toEqual({ ok: true });
    expect((await same).body).toEqual({ ok: true, replayed: true });
    expect((await startA).body).toEqual({ paneId: "p" });
    expect(texts).toEqual(["first"]);
    await c.close();
  });

  test("the memory keeps a digest, not the payload, and a failure leaves nothing behind", async () => {
    const r = new Receipts();
    expect(await r.run("a", "d1", async () => ({ ok: true }))).toEqual({ ok: true });
    await expect(r.run("a", "d2", async () => ({ ok: true }))).rejects.toMatchObject({ status: 409, code: "request-id-reused" });
    await expect(r.run("b", "d1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await r.run("b", "d9", async () => ({ ok: true }))).toEqual({ ok: true }); // the failed id is free
  });
});

describe("cleaned asks and invisible characters", () => {
  const options = [{ id: "allow", label: "Allow", effect: "allow" as const }];
  const mk = async () => {
    const c = await open(join(tmp(), "s.sock"));
    const p = c.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    c.ready();
    return { c, p, d: { socket: c.address, version: 1 } };
  };
  const input = (id: string, over: Partial<PermissionAskInput> = {}): AskInput => ({ id, kind: "permission", toolCallId: id, itemId: id, title: "plain", options, ...over });

  test("cleaning removes zero-width, joiner, byte order mark and tag characters", () => {
    expect(cut("a​‌‍⁠﻿b\u{e0041}\u{e007f}c‮d", 100)).toBe("abcd");
    expect(cut("keep é 中 \u{1f600}", 100)).toBe("keep é 中 \u{1f600}");
  });

  test("an ask whose title or reason was cleaned or cut carries cleaned: true; a clean one carries nothing", async () => {
    const { c, p, d } = await mk();
    for (const [id, over] of [
      ["zw-title", { title: "write​ /etc/passwd" }],
      ["tag-reason", { reason: "hidden: \u{e0049}\u{e0067}" }],
      ["long-title", { title: "x".repeat(400) }],
      ["long-reason", { reason: "y".repeat(5000) }],
      ["bidi", { title: "ok ‮ txt.exe" }],
      ["control", { title: "a\u0007b" }],
    ] as [string, Partial<PermissionAskInput>][]) {
      p.ask(input(id, over)).catch(() => {});
    }
    p.ask(input("clean", { reason: "line one\nline two\ttab" })).catch(() => {});
    const asks = (await api.snapshot(d)).body.panes[0]!.openAsks;
    for (const a of asks) expect([a.id, a.cleaned]).toEqual([a.id, a.id === "clean" ? undefined : true]);
    expect(Object.hasOwn(asks.find((a) => a.id === "clean")!, "cleaned")).toBe(false);
    expect(asks.find((a) => a.id === "zw-title")!.title).toBe("write /etc/passwd");
    await c.close();
  });

  test("push words are cleaned and cut to 60 and 120 characters, a part that is empty is left out, and no words leave no key", async () => {
    const { c, p, d } = await mk();
    p.ask(input("words", { push: { title: `Needs​ a yes${"x".repeat(100)}`, line: `  ${"l".repeat(300)}` } })).catch(() => {});
    p.ask(input("title-only", { push: { title: "Needs a yes", line: "\u0007" } })).catch(() => {});
    p.ask(input("empty", { push: { title: "", line: "​" } })).catch(() => {});
    p.ask(input("none")).catch(() => {});
    const asks = (await api.snapshot(d)).body.panes[0]!.openAsks;
    const by = (id: string) => asks.find((a) => a.id === id)!;
    expect([...(by("words").push?.title ?? "")]).toHaveLength(60);
    expect(by("words").push?.title?.startsWith("Needs a yes")).toBe(true);
    expect(by("words").push?.line).toBe("l".repeat(120));
    expect(by("title-only").push).toEqual({ title: "Needs a yes" });
    expect(Object.hasOwn(by("empty"), "push")).toBe(false);
    expect(Object.hasOwn(by("none"), "push")).toBe(false);
    // The words are not the card's text: the card was not cut, so it carries no `cleaned`.
    expect(by("words").cleaned).toBeUndefined();
    await c.close();
  });

  test("a program may set cleaned itself, and an update keeps it", async () => {
    const { c, p, d } = await mk();
    p.ask(input("own", { cleaned: true })).catch(() => {});
    p.ask(input("later")).catch(() => {});
    expect(p.updateAsk("later", { title: "now​ dirty" })).toBe(true);
    expect(p.updateAsk("own", { reason: "more" })).toBe(true);
    const asks = (await api.snapshot(d)).body.panes[0]!.openAsks;
    expect(asks.map((a) => [a.id, a.revision, a.cleaned])).toEqual([["own", 2, true], ["later", 2, true]]);
    await c.close();
  });

  test("a big reply (several MiB) crosses the socket whole, in order", async () => {
    const { c, p, d } = await mk();
    for (let i = 0; i < 100; i++) p.event({ type: "item", item: { id: `i${i}`, kind: "reply", text: `${i}:${"z".repeat(60_000)}` } });
    const r = await api.events(d, "p", 0, "old-epoch");
    expect(r.status).toBe(200);
    const items = r.body.events.filter((e) => e.type === "item");
    expect(items).toHaveLength(100);
    expect(items.every((e, i) => e.type === "item" && "text" in e.item && e.item.text.startsWith(`${i}:z`) && e.item.text.length === 60_000 + `${i}:`.length)).toBe(true);
    await c.close();
  });
});
