import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deniedFoldersSync, HillMediaStore, MEDIA_DIR } from "../hill/media.ts";
import { HOST } from "../host.ts";
import { HILL_MEDIA_HEADERS, HILL_MEDIA_MISSING, VIEW_OFF_TEXT, trickViewsMediaRoute } from "../server.ts";
import { readTrickViewSession, VIEW_MEDIA_BYTES_MAX } from "../../web/src/lib/agent-view/wire.ts";
import { keepPictures, VIEW_SET_TOO_LARGE, VIEW_TOO_MANY_IMAGES, type ViewMinters } from "./media.ts";
import { AgentViewService, readShowFields, type AgentViewServiceDeps, type ViewGate } from "./service.ts";
import { trickViewsDir, AgentViewStore, VIEWS_FOLDER } from "./store.ts";

// Agent views' pictures: the hill's reading and keeping, the view's own caps, and the route that serves them.

const posix = test.skipIf(HOST.platform === "win32");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));

/** A PNG's signature and IHDR, enough for the sniff and the size, padded to `size` bytes. */
function png(size = 96, width = 390, height = 844): Uint8Array<ArrayBuffer> {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii("IHDR"), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, ...be32(0)];
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head);
  return out;
}

const GIF = new Uint8Array([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0]);

function file(dir: string, name: string, bytes: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const T = "morph";
const SESSION = "local/%1#aaaa";
const SECOND = "local/%2#bbbb";

interface Rig {
  readonly service: AgentViewService;
  readonly state: string;
  readonly work: string;
  readonly mediaRoot: string;
  /** The gate's state, and the pane marks, which a test moves. */
  readonly world: { shut: boolean; readonly marks: Map<string, string> };
}

/** The person's switch is on for both sessions when the rig is handed over, as the phone leaves it. */
async function rig(opts: { brokenStore?: boolean; noMedia?: boolean } = {}): Promise<Rig> {
  const state = folder("view-state-");
  const work = folder("view-work-");
  let n = 0;
  const mint: ViewMinters = {
    set: () => `dc_${String((n += 1)).padStart(12, "0")}`,
    media: () => `im_${String((n += 1)).padStart(16, "0")}`,
  };
  const store = new AgentViewStore(trickViewsDir(state), Date.now, () => undefined);
  const media = new HillMediaStore(trickViewsDir(state), deniedFoldersSync([state]), () => undefined);
  const world = {
    shut: false,
    marks: new Map<string, string>([
      [SESSION, "claude\u0000id:conv-1"],
      [SECOND, "claude\u0000id:conv-2"],
    ]),
  };
  const gate = (): ViewGate => (world.shut ? { ok: false, code: "trick_off", error: "the trick is off" } : { ok: true, name: "Morph", rules: "Draw one screen.\n" });
  const deps: AgentViewServiceDeps = {
    store,
    place: (address) => ({ address }),
    sessionsKnown: () => false,
    crewMode: () => "solo",
    binary: "/home/op/apps/collie/bin/collie",
    gate: { check: gate, fresh: async () => gate() },
    rulesIdOf: (trick) => `rid-${trick}`,
    helpOf: () => ["help"],
    paneMark: (session) => world.marks.get(session) ?? null,
    mint,
  };
  const service = new AgentViewService(opts.noMedia === true ? deps : { ...deps, media });
  for (const session of [SESSION, SECOND]) {
    const switched = await service.switch({ trick: T, session, on: true }, null);
    if (!switched.ok) throw new Error(`switch refused: ${switched.error}`);
  }
  // A state folder with a FILE where the view files go: every later write fails, as a full disk would.
  if (opts.brokenStore === true) {
    rmSync(join(trickViewsDir(state), VIEWS_FOLDER), { recursive: true, force: true });
    writeFileSync(join(trickViewsDir(state), VIEWS_FOLDER), "a file where the folder goes");
  }
  return { service, state, work, mediaRoot: join(trickViewsDir(state), MEDIA_DIR), world };
}

const view = (refs: number) => [{ kind: "para", text: "Two layouts" }, ...Array.from({ length: refs }, (_, i) => ({ kind: "image", attrs: { ref: String(i) } }))];

describe("a show with pictures", () => {
  posix("lead addition 6: keeps the pictures under a minted set id, serves them on the route with the hill's headers, and only while the view is on, open and fresh", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png(120));
    const two = file(r.work, "b.png", png(140, 800, 600));
    const answer = await r.service.show(T, SESSION, { view: view(2), title: null, images: [{ path: one, caption: "Now" }, { path: two, caption: null }] });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const screen = answer.session.view;
    expect(screen?.set).toMatch(/^dc_[a-z0-9]{12}$/);
    expect(screen?.media?.map((m) => [m.mime, m.bytes, m.width, m.height, m.caption])).toEqual([
      ["image/png", 120, 390, 844, "Now"],
      ["image/png", 140, 800, 600, undefined],
    ]);
    // What the phone reads back is what was served: the wire reader takes the screen whole.
    expect(readTrickViewSession(JSON.parse(JSON.stringify(answer.session)))?.view?.media).toHaveLength(2);
    const set = screen!.set!;
    const first = screen!.media![0]!;
    expect(readdirSync(join(r.mediaRoot, set)).toSorted()).toEqual(screen!.media!.map((m) => m.id).toSorted());
    const res = trickViewsMediaRoute(r.service, set, first.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    for (const [name, value] of Object.entries(HILL_MEDIA_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(120));
    // The service serves a picture only for a view that is on, passes the gate, and is not stale.
    expect(r.service.mediaFile(set, first.id)).toEqual({ bytes: png(120), mime: "image/png" });
    r.world.shut = true;
    expect(r.service.mediaFile(set, first.id)).toBeNull();
    expect(trickViewsMediaRoute(r.service, set, first.id).status).toBe(404);
    r.world.shut = false;
    expect(r.service.mediaFile(set, first.id)).not.toBeNull();
    r.world.marks.set(SESSION, "claude\u0000id:conv-9");
    expect(r.service.mediaFile(set, first.id)).toBeNull();
    r.world.marks.set(SESSION, "claude\u0000id:conv-1");
    expect(r.service.mediaFile(set, first.id)).not.toBeNull();
    // The person's switch going off ends the screen, and its pictures with the next write.
    await r.service.switch({ trick: T, session: SESSION, on: false }, null);
    expect(r.service.mediaFile(set, first.id)).toBeNull();
    expect(readdirSync(r.mediaRoot)).toEqual([]);
  });

  test("lead addition 6: the route answers one 404 for every miss, and checks both ids before any path", async () => {
    const r = await rig();
    for (const [set, id] of [
      ["dc_000000000000", "im_0000000000000000"],
      ["..", "im_0000000000000000"],
      ["dc_000000000000", "../state.json"],
    ] as const) {
      const res = trickViewsMediaRoute(r.service, set, id);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(HILL_MEDIA_MISSING);
    }
    expect(await trickViewsMediaRoute(undefined, "dc_000000000000", "im_0000000000000000").text()).toBe(VIEW_OFF_TEXT);
  });

  posix("a new show replaces the set, and the old folder goes with the write", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png());
    const first = await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: one, caption: null }] });
    const firstSet = first.ok ? first.session.view?.set : undefined;
    expect(firstSet).toBeDefined();
    const second = await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: one, caption: null }] });
    const secondSet = second.ok ? second.session.view?.set : undefined;
    expect(secondSet).not.toBe(firstSet);
    expect(readdirSync(r.mediaRoot)).toEqual([secondSet!]);
    // A show with no pictures holds no set, so the last folder goes too.
    expect((await r.service.show(T, SESSION, { view: view(0), title: null })).ok).toBe(true);
    expect(readdirSync(r.mediaRoot)).toEqual([]);
  });
});

describe("the media folder is pruned with the write that drops a set", () => {
  posix("`clear` removes the screen's set folder, and only that session's", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png());
    const mine = await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: one, caption: null }] });
    const other = await r.service.show(T, SECOND, { view: view(1), title: null, images: [{ path: one, caption: null }] });
    const mineSet = mine.ok ? mine.session.view?.set : undefined;
    const otherSet = other.ok ? other.session.view?.set : undefined;
    expect(readdirSync(r.mediaRoot).toSorted()).toEqual([mineSet!, otherSet!].toSorted());
    expect((await r.service.clear(T, SESSION)).ok).toBe(true);
    expect(readdirSync(r.mediaRoot)).toEqual([otherSet!]);
    expect((await r.service.clear(T, SECOND)).ok).toBe(true);
    expect(readdirSync(r.mediaRoot)).toEqual([]);
  });

  posix("a screen replaced by a show with no picture, or by another picture, loses its old set folder", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png());
    const first = await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: one, caption: null }] });
    const firstSet = first.ok ? first.session.view?.set : undefined;
    expect(readdirSync(r.mediaRoot)).toEqual([firstSet!]);
    // A block set with a new picture writes a new set under a new id; the replaced set is no longer named.
    const added = await r.service.set(T, SESSION, { id: "b2", node: { kind: "image", attrs: { ref: "1" } }, place: { kind: "end" }, images: [{ path: one, caption: null }] });
    const addedSet = added.ok ? added.session.view?.set : undefined;
    expect(addedSet).toBeDefined();
    expect(addedSet).not.toBe(firstSet);
    expect(readdirSync(r.mediaRoot)).toEqual([addedSet!]);
    expect((await r.service.show(T, SESSION, { view: view(0), title: null })).ok).toBe(true);
    expect(readdirSync(r.mediaRoot)).toEqual([]);
  });
});

describe("The view's own caps refuse the whole command, and nothing is written", () => {
  posix("more than four pictures", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png());
    const answer = await r.service.show(T, SESSION, { view: view(0), title: null, images: Array.from({ length: 5 }, () => ({ path: one, caption: null })) });
    expect(answer).toMatchObject({ ok: false, code: "too_many_images", error: VIEW_TOO_MANY_IMAGES });
    expect(existsSync(r.mediaRoot)).toBe(false);
    expect(readShowFields({ images: Array.from({ length: 5 }, () => ({ path: one })) })).toMatchObject({ code: "too_many_images" });
  });

  posix("a picture past 2 MB, by its size and by the bytes read", async () => {
    const r = await rig();
    const big = file(r.work, "big.png", png(VIEW_MEDIA_BYTES_MAX + 1));
    expect(await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: big, caption: null }] })).toMatchObject({ ok: false, code: "image_too_large" });
    expect(existsSync(r.mediaRoot)).toBe(false);
  });

  posix("a GIF beside a good PNG: the type is the sniffed bytes, and one bad picture refuses both", async () => {
    const r = await rig();
    const good = file(r.work, "good.png", png());
    const gif = file(r.work, "fake.png", GIF);
    const answer = await r.service.show(T, SESSION, { view: view(2), title: null, images: [{ path: good, caption: null }, { path: gif, caption: null }] });
    expect(answer).toMatchObject({ ok: false, code: "bad_image" });
    expect(existsSync(r.mediaRoot)).toBe(false);
    expect(r.service.status(T, SESSION).view).toBeUndefined();
  });

  posix("a path inside Collie's own state folder (the hill's rule, through the hill's read)", async () => {
    const r = await rig();
    const inside = file(r.state, "shot.png", png());
    expect(await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: inside, caption: null }] })).toMatchObject({ ok: false, code: "bad_image" });
  });

  posix("a caption that is not one line", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png());
    expect(await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: one, caption: "two\nlines" }] })).toMatchObject({ ok: false, code: "bad_image" });
    expect(existsSync(r.mediaRoot)).toBe(false);
  });

  posix("the set's total on disk", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png(400));
    const keep = new HillMediaStore(trickViewsDir(r.state), [], () => undefined);
    const mint: ViewMinters = { set: () => "dc_aaaaaaaaaaaa", media: () => `im_${String(Math.random()).slice(2, 18).padEnd(16, "0")}` };
    const answer = keepPictures({ keep, mint, held: null, added: [{ path: one, caption: null }, { path: one, caption: null }], limits: { count: 4, bytes: 1000, setBytes: 700 } });
    expect(answer).toEqual({ ok: false, code: "image_too_large", error: VIEW_SET_TOO_LARGE });
    expect(existsSync(r.mediaRoot)).toBe(false);
  });

  posix("a screen whose view or choice is refused reads no picture", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png());
    expect(await r.service.show(T, SESSION, { view: view(2), title: null, images: [{ path: one, caption: null }] })).toMatchObject({ ok: false, code: "bad_view" });
    expect(await r.service.show(T, SESSION, { view: view(0), title: null, images: [{ path: one, caption: null }], choice: { options: [{ label: "A", preview: 3 }] } })).toMatchObject({ ok: false, code: "bad_choice" });
    expect(existsSync(r.mediaRoot)).toBe(false);
  });

  posix("a state file that cannot be written takes the pictures back", async () => {
    const r = await rig({ brokenStore: true });
    const one = file(r.work, "a.png", png());
    expect(await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: one, caption: null }] })).toMatchObject({ ok: false, code: "unsaved" });
    expect(readdirSync(r.mediaRoot)).toEqual([]);
  });

  test("a bridge with no media store refuses a picture and keeps everything else", async () => {
    const r = await rig({ noMedia: true });
    expect(await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: "/tmp/a.png", caption: null }] })).toMatchObject({ ok: false, code: "bad_image" });
    expect((await r.service.show(T, SESSION, { view: view(0), title: null })).ok).toBe(true);
  });
});

describe("the decision block", () => {
  test("is stored on the screen beside the view, with a preview naming a picture ref", async () => {
    const r = await rig({ noMedia: true });
    const answer = await r.service.show(T, SESSION, { view: view(0), title: null, choice: { question: "Ship?", options: [{ label: "Yes", detail: "Ship it." }, { label: "No" }], recommends: { option: 0 } } });
    expect(answer.ok && answer.session.view?.choice).toEqual({ question: "Ship?", options: [{ label: "Yes", detail: "Ship it." }, { label: "No" }], recommends: { option: 0 } });
  });

  test("the socket's fields read `choice` and `images`, and refuse a picture without a path", () => {
    expect(readShowFields({ view: [], choice: { options: [] } })).toMatchObject({ choice: { options: [] }, images: [] });
    expect(readShowFields({ view: [], images: [{ caption: "x" }] })).toMatchObject({ code: "bad_image" });
    expect(readShowFields({ view: [], images: "a.png" })).toMatchObject({ code: "bad_image" });
  });
});

describe("a block set with pictures", () => {
  posix("adds to the screen's set under a new set id: a ref counts the whole set, and the old folder goes", async () => {
    const r = await rig();
    const one = file(r.work, "a.png", png(120));
    const two = file(r.work, "b.png", png(140));
    await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: one, caption: "Now" }] });
    const first = r.service.status(T, SESSION).view;
    const answer = await r.service.set(T, SESSION, { id: "after", node: { kind: "image", attrs: { ref: "1" } }, place: { kind: "end" }, images: [{ path: two, caption: "Next" }] });
    expect(answer.ok).toBe(true);
    const screen = r.service.status(T, SESSION).view;
    expect(screen?.set).not.toBe(first?.set);
    expect(screen?.media?.map((m) => m.caption)).toEqual(["Now", "Next"]);
    expect(readdirSync(r.mediaRoot)).toEqual([screen!.set!]);
  });

  posix("past four in all, or a view the new pictures would break, is refused, and no set is written", async () => {
    const r = await rig();
    const pics = Array.from({ length: 4 }, (_, i) => file(r.work, `${String(i)}.png`, png(100 + i)));
    await r.service.show(T, SESSION, { view: view(4), title: null, images: pics.map((path) => ({ path, caption: null })) });
    const held = r.service.status(T, SESSION).view;
    const extra = file(r.work, "x.png", png(90));
    expect(await r.service.set(T, SESSION, { id: "x", node: { kind: "image", attrs: { ref: "4" } }, place: { kind: "end" }, images: [{ path: extra, caption: null }] })).toMatchObject({ ok: false, code: "too_many_images" });
    expect(r.service.status(T, SESSION).view).toEqual(held);
    expect(readdirSync(r.mediaRoot)).toEqual([held!.set!]);
  });

  posix("a picture refused by a set leaves the screen and its set as they were", async () => {
    const r = await rig();
    await r.service.show(T, SESSION, { view: view(1), title: null, images: [{ path: file(r.work, "a.png", png(120)), caption: null }] });
    const held = r.service.status(T, SESSION).view;
    const gif = file(r.work, "g.gif", GIF);
    expect(await r.service.set(T, SESSION, { id: "g", node: { kind: "image", attrs: { ref: "1" } }, place: { kind: "end" }, images: [{ path: gif, caption: null }] })).toMatchObject({ ok: false, code: "bad_image" });
    expect(r.service.status(T, SESSION).view).toEqual(held);
    expect(existsSync(join(r.mediaRoot, held!.set!))).toBe(true);
    expect(readdirSync(r.mediaRoot)).toEqual([held!.set!]);
  });
});
