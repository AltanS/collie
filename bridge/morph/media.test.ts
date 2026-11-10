import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deniedFoldersSync, HillMediaStore, MEDIA_DIR } from "../hill/media.ts";
import { HOST } from "../host.ts";
import { HILL_MEDIA_HEADERS, HILL_MEDIA_MISSING, MORPH_OFF_TEXT, morphMediaRoute } from "../server.ts";
import { readMorphSession, MORPH_MEDIA_BYTES_MAX } from "../../web/src/lib/morph/wire.ts";
import { keepPictures, MORPH_SET_TOO_LARGE, MORPH_TOO_MANY_IMAGES, type MorphMinters } from "./media.ts";
import { MorphService, readShowFields, type MorphServiceDeps } from "./service.ts";
import { morphDir, MorphStore } from "./store.ts";

// Morph's pictures: the hill's reading and keeping, Morph's own caps, and the route that serves them.

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

const SESSION = "local/%1#aaaa";

interface Rig {
  readonly morph: MorphService;
  readonly state: string;
  readonly work: string;
  readonly mediaRoot: string;
}

function rig(opts: { brokenStore?: boolean; noMedia?: boolean } = {}): Rig {
  const state = folder("morph-state-");
  const work = folder("morph-work-");
  let n = 0;
  const mint: MorphMinters = {
    set: () => `dc_${String((n += 1)).padStart(12, "0")}`,
    media: () => `im_${String((n += 1)).padStart(16, "0")}`,
  };
  // A state folder under a FILE: every write of the state file fails, as a full disk would.
  const blocker = opts.brokenStore === true ? file(work, "blocker", new Uint8Array([1])) : null;
  const store = new MorphStore(blocker === null ? morphDir(state) : join(blocker, "morph"), Date.now, () => undefined);
  const media = new HillMediaStore(morphDir(state), deniedFoldersSync([state]), () => undefined);
  const deps: MorphServiceDeps = {
    store,
    place: (address) => ({ address }),
    sessionsKnown: () => false,
    crewMode: () => "solo",
    binary: "/home/op/apps/collie/bin/collie",
    mint,
  };
  const morph = new MorphService(opts.noMedia === true ? deps : { ...deps, media });
  return { morph, state, work, mediaRoot: join(morphDir(state), MEDIA_DIR) };
}

const view = (refs: number) => [{ kind: "para", text: "Two layouts" }, ...Array.from({ length: refs }, (_, i) => ({ kind: "image", attrs: { ref: String(i) } }))];

describe("a show with pictures", () => {
  posix("keeps the pictures under a minted set id, serves them on the route with the hill's headers", async () => {
    const r = rig();
    const one = file(r.work, "a.png", png(120));
    const two = file(r.work, "b.png", png(140, 800, 600));
    const answer = r.morph.show(SESSION, { view: view(2), title: null, images: [{ path: one, caption: "Now" }, { path: two, caption: null }] });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const screen = answer.session.view;
    expect(screen?.set).toMatch(/^dc_[a-z0-9]{12}$/);
    expect(screen?.media?.map((m) => [m.mime, m.bytes, m.width, m.height, m.caption])).toEqual([
      ["image/png", 120, 390, 844, "Now"],
      ["image/png", 140, 800, 600, undefined],
    ]);
    // What the phone reads back is what was served: the wire reader takes the screen whole.
    expect(readMorphSession(JSON.parse(JSON.stringify(answer.session)))?.view?.media).toHaveLength(2);
    const set = screen!.set!;
    const first = screen!.media![0]!;
    expect(readdirSync(join(r.mediaRoot, set)).toSorted()).toEqual(screen!.media!.map((m) => m.id).toSorted());
    const res = morphMediaRoute(r.morph, set, first.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    for (const [name, value] of Object.entries(HILL_MEDIA_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(120));
  });

  test("the route answers one 404 for every miss, and checks both ids before any path", async () => {
    const r = rig();
    for (const [set, id] of [
      ["dc_000000000000", "im_0000000000000000"],
      ["..", "im_0000000000000000"],
      ["dc_000000000000", "../state.json"],
    ] as const) {
      const res = morphMediaRoute(r.morph, set, id);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(HILL_MEDIA_MISSING);
    }
    expect(await morphMediaRoute(undefined, "dc_000000000000", "im_0000000000000000").text()).toBe(MORPH_OFF_TEXT);
  });

  posix("a new show replaces the set, and the old folder goes with the write", () => {
    const r = rig();
    const one = file(r.work, "a.png", png());
    const first = r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: one, caption: null }] });
    const firstSet = first.ok ? first.session.view?.set : undefined;
    expect(firstSet).toBeDefined();
    const second = r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: one, caption: null }] });
    const secondSet = second.ok ? second.session.view?.set : undefined;
    expect(secondSet).not.toBe(firstSet);
    expect(readdirSync(r.mediaRoot)).toEqual([secondSet!]);
    // A show with no pictures holds no set, so the last folder goes too.
    expect(r.morph.show(SESSION, { view: view(0), title: null }).ok).toBe(true);
    expect(readdirSync(r.mediaRoot)).toEqual([]);
  });
});

describe("Morph's own caps refuse the whole command, and nothing is written", () => {
  posix("more than four pictures", () => {
    const r = rig();
    const one = file(r.work, "a.png", png());
    const answer = r.morph.show(SESSION, { view: view(0), title: null, images: Array.from({ length: 5 }, () => ({ path: one, caption: null })) });
    expect(answer).toMatchObject({ ok: false, code: "too_many_images", error: MORPH_TOO_MANY_IMAGES });
    expect(existsSync(r.mediaRoot)).toBe(false);
    expect(readShowFields({ images: Array.from({ length: 5 }, () => ({ path: one })) })).toMatchObject({ code: "too_many_images" });
  });

  posix("a picture past 2 MB, by its size and by the bytes read", () => {
    const r = rig();
    const big = file(r.work, "big.png", png(MORPH_MEDIA_BYTES_MAX + 1));
    expect(r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: big, caption: null }] })).toMatchObject({ ok: false, code: "image_too_large" });
    expect(existsSync(r.mediaRoot)).toBe(false);
  });

  posix("a GIF beside a good PNG: the type is the sniffed bytes, and one bad picture refuses both", () => {
    const r = rig();
    const good = file(r.work, "good.png", png());
    const gif = file(r.work, "fake.png", GIF);
    const answer = r.morph.show(SESSION, { view: view(2), title: null, images: [{ path: good, caption: null }, { path: gif, caption: null }] });
    expect(answer).toMatchObject({ ok: false, code: "bad_image" });
    expect(existsSync(r.mediaRoot)).toBe(false);
    expect(r.morph.status(SESSION).view).toBeUndefined();
  });

  posix("a path inside Collie's own state folder (the hill's rule, through the hill's read)", () => {
    const r = rig();
    const inside = file(r.state, "shot.png", png());
    expect(r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: inside, caption: null }] })).toMatchObject({ ok: false, code: "bad_image" });
  });

  posix("a caption that is not one line", () => {
    const r = rig();
    const one = file(r.work, "a.png", png());
    expect(r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: one, caption: "two\nlines" }] })).toMatchObject({ ok: false, code: "bad_image" });
    expect(existsSync(r.mediaRoot)).toBe(false);
  });

  posix("the set's total on disk", () => {
    const r = rig();
    const one = file(r.work, "a.png", png(400));
    const keep = new HillMediaStore(morphDir(r.state), [], () => undefined);
    const mint: MorphMinters = { set: () => "dc_aaaaaaaaaaaa", media: () => `im_${String(Math.random()).slice(2, 18).padEnd(16, "0")}` };
    const answer = keepPictures({ keep, mint, held: null, added: [{ path: one, caption: null }, { path: one, caption: null }], limits: { count: 4, bytes: 1000, setBytes: 700 } });
    expect(answer).toEqual({ ok: false, code: "image_too_large", error: MORPH_SET_TOO_LARGE });
    expect(existsSync(r.mediaRoot)).toBe(false);
  });

  posix("a screen whose view or choice is refused reads no picture", () => {
    const r = rig();
    const one = file(r.work, "a.png", png());
    expect(r.morph.show(SESSION, { view: view(2), title: null, images: [{ path: one, caption: null }] })).toMatchObject({ ok: false, code: "bad_view" });
    expect(r.morph.show(SESSION, { view: view(0), title: null, images: [{ path: one, caption: null }], choice: { options: [{ label: "A", preview: 3 }] } })).toMatchObject({ ok: false, code: "bad_choice" });
    expect(existsSync(r.mediaRoot)).toBe(false);
  });

  posix("a state file that cannot be written takes the pictures back", () => {
    const r = rig({ brokenStore: true });
    const one = file(r.work, "a.png", png());
    expect(r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: one, caption: null }] })).toMatchObject({ ok: false, code: "unsaved" });
    expect(readdirSync(r.mediaRoot)).toEqual([]);
  });

  test("a bridge with no media store refuses a picture and keeps everything else", () => {
    const r = rig({ noMedia: true });
    expect(r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: "/tmp/a.png", caption: null }] })).toMatchObject({ ok: false, code: "bad_image" });
    expect(r.morph.show(SESSION, { view: view(0), title: null }).ok).toBe(true);
  });
});

describe("the decision block", () => {
  test("is stored on the screen beside the view, with a preview naming a picture ref", () => {
    const r = rig({ noMedia: true });
    const answer = r.morph.show(SESSION, { view: view(0), title: null, choice: { question: "Ship?", options: [{ label: "Yes", value: "Ship it." }, { label: "No" }], recommends: { option: 0 } } });
    expect(answer.ok && answer.session.view?.choice).toEqual({ question: "Ship?", options: [{ label: "Yes", value: "Ship it." }, { label: "No" }], recommends: { option: 0 } });
  });

  test("the socket's fields read `choice` and `images`, and refuse a picture without a path", () => {
    expect(readShowFields({ view: [], choice: { options: [] } })).toMatchObject({ choice: { options: [] }, images: [] });
    expect(readShowFields({ view: [], images: [{ caption: "x" }] })).toMatchObject({ code: "bad_image" });
    expect(readShowFields({ view: [], images: "a.png" })).toMatchObject({ code: "bad_image" });
  });
});

describe("a block set with pictures", () => {
  posix("adds to the screen's set under a new set id: a ref counts the whole set, and the old folder goes", () => {
    const r = rig();
    const one = file(r.work, "a.png", png(120));
    const two = file(r.work, "b.png", png(140));
    r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: one, caption: "Now" }] });
    const first = r.morph.status(SESSION).view;
    const answer = r.morph.set(SESSION, { id: "after", node: { kind: "image", attrs: { ref: "1" } }, place: { kind: "end" }, images: [{ path: two, caption: "Next" }] });
    expect(answer.ok).toBe(true);
    const screen = r.morph.status(SESSION).view;
    expect(screen?.set).not.toBe(first?.set);
    expect(screen?.media?.map((m) => m.caption)).toEqual(["Now", "Next"]);
    expect(readdirSync(r.mediaRoot)).toEqual([screen!.set!]);
  });

  posix("past four in all, or a view the new pictures would break, is refused, and no set is written", () => {
    const r = rig();
    const pics = Array.from({ length: 4 }, (_, i) => file(r.work, `${String(i)}.png`, png(100 + i)));
    r.morph.show(SESSION, { view: view(4), title: null, images: pics.map((path) => ({ path, caption: null })) });
    const held = r.morph.status(SESSION).view;
    const extra = file(r.work, "x.png", png(90));
    expect(r.morph.set(SESSION, { id: "x", node: { kind: "image", attrs: { ref: "4" } }, place: { kind: "end" }, images: [{ path: extra, caption: null }] })).toMatchObject({ ok: false, code: "too_many_images" });
    expect(r.morph.status(SESSION).view).toEqual(held);
    expect(readdirSync(r.mediaRoot)).toEqual([held!.set!]);
  });

  posix("a picture refused by a set leaves the screen and its set as they were", () => {
    const r = rig();
    r.morph.show(SESSION, { view: view(1), title: null, images: [{ path: file(r.work, "a.png", png(120)), caption: null }] });
    const held = r.morph.status(SESSION).view;
    const gif = file(r.work, "g.gif", GIF);
    expect(r.morph.set(SESSION, { id: "g", node: { kind: "image", attrs: { ref: "1" } }, place: { kind: "end" }, images: [{ path: gif, caption: null }] })).toMatchObject({ ok: false, code: "bad_image" });
    expect(r.morph.status(SESSION).view).toEqual(held);
    expect(existsSync(join(r.mediaRoot, held!.set!))).toBe(true);
    expect(readdirSync(r.mediaRoot)).toEqual([held!.set!]);
  });
});
