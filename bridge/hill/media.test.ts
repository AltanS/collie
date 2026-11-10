import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import type { BeaconMatcher } from "../beacon/decorate.ts";
import { HOST } from "../host.ts";
import { HILL_MEDIA_HEADERS, HILL_MEDIA_MISSING, HILL_OFF_TEXT, hillMediaRoute } from "../server.ts";
import type { WalkyHost, WalkyPane } from "../walky/deliver.ts";
import { WalkyLog } from "../walky/log.ts";
import { WalkyService } from "../walky/service.ts";
import { walkySocketPath, WalkyServer, type PlaceTarget } from "../walky/socket.ts";
import { HILL_MEDIA_BYTES_MAX, type HillImageInput, type HillMedia, type HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { parseJsonObject, type JsonObject, type JsonValue } from "../../web/src/lib/json.ts";
import { deniedFoldersSync, hillImageMime, hillImageSize, HillMediaStore, MEDIA_DIR, mintMediaId, readPostedImage } from "./media.ts";
import { readDecision, readPostFields } from "./parse.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HillService, type HillAgentSender, type HillServiceDeps } from "./service.ts";
import { DECISIONS_FILE, HILL_CLOSED_KEPT, hillDir, HillStore } from "./store.ts";
import { walkyPlace, walkySend } from "./walky.ts";

import { spaceOf } from "../walky/space.ts";

/** One unnamed space on one machine: every fixture pane shares it, and no rule reads it yet. */
const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });

// Images on a Decision (M96): what the bridge agrees to read from a path an agent names, how it keeps
// the bytes, when it lets them go, and how the phone reads them back.

const posix = test.skipIf(HOST.platform === "win32");
const roots: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh folder by its real path, removed after the test. */
function folder(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** The bytes of ASCII text. */
function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

function bytes(...parts: number[][]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(parts.flat());
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];

/** A PNG's signature and IHDR, enough for the sniff and the size. */
function png(width = 390, height = 240, padding = 64): Uint8Array<ArrayBuffer> {
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii("IHDR"), be32(width), be32(height), [8, 2, 0, 0, 0], be32(0), Array.from({ length: padding }, () => 0));
}

/** A JPEG with an APP0 segment, then a baseline start-of-frame. */
function jpeg(width = 640, height = 480): Uint8Array<ArrayBuffer> {
  return bytes([0xff, 0xd8], [0xff, 0xe0], be16(16), ascii("JFIF"), [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xc0], be16(17), [8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9]);
}

function webpX(width = 800, height = 600): Uint8Array<ArrayBuffer> {
  return bytes(ascii("RIFF"), le24(22), [0], ascii("WEBP"), ascii("VP8X"), [10, 0, 0, 0], [0, 0, 0, 0], le24(width - 1), le24(height - 1));
}

function webpLossy(width = 320, height = 200): Uint8Array {
  return bytes(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii("VP8 "), [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(width), le16(height));
}

function webpLossless(width = 100, height = 50): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return bytes(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii("VP8L"), [0, 0, 0, 0], [0x2f], [bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]);
}

const GIF = bytes(ascii("GIF89a"), [1, 0, 1, 0, 0, 0, 0]);
const SVG = bytes(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
const HTML = bytes(ascii("<!doctype html><script>fetch('/api/pair')</script>"));

function file(dir: string, name: string, content: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("reading a posted image", () => {
  test("PNG, JPEG and WebP are kept, typed by their bytes, with the size off the header", () => {
    const dir = folder("hill-img-");
    expect(readPostedImage(file(dir, "a.png", png(390, 240)), [])).toMatchObject({ ok: true, mime: "image/png", width: 390, height: 240 });
    expect(readPostedImage(file(dir, "b.jpg", jpeg(640, 480)), [])).toMatchObject({ ok: true, mime: "image/jpeg", width: 640, height: 480 });
    expect(readPostedImage(file(dir, "c.webp", webpX(800, 600)), [])).toMatchObject({ ok: true, mime: "image/webp", width: 800, height: 600 });
    // The name does not decide: a PNG saved as `.txt` is a PNG.
    expect(readPostedImage(file(dir, "d.txt", png()), [])).toMatchObject({ ok: true, mime: "image/png" });
  });

  test("the three WebP kinds and a JPEG with no frame marker: size when cheap, null when not", () => {
    expect(hillImageSize(webpLossy(320, 200), "image/webp")).toEqual({ width: 320, height: 200 });
    expect(hillImageSize(webpLossless(100, 50), "image/webp")).toEqual({ width: 100, height: 50 });
    expect(hillImageSize(bytes([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0]), "image/jpeg")).toBeNull();
    expect(hillImageSize(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBeNull();
  });

  test("SVG, GIF, HTML under a .png name and an empty file are refused as bad_image", () => {
    const dir = folder("hill-img-");
    for (const [name, content] of [
      ["a.svg", SVG],
      ["b.gif", GIF],
      ["shot.png", HTML],
      ["empty.png", new Uint8Array()],
    ] as const) {
      const read = readPostedImage(file(dir, name, content), []);
      expect(read).toMatchObject({ ok: false, code: "bad_image" });
      if (!read.ok) expect(read.error).toContain("not a PNG, JPEG or WebP");
    }
    expect(hillImageMime(GIF)).toBeNull();
  });

  test("a file over 2 MB is image_too_large; exactly 2 MB is kept", () => {
    const dir = folder("hill-img-");
    const big = new Uint8Array(HILL_MEDIA_BYTES_MAX + 1);
    big.set(png());
    expect(readPostedImage(file(dir, "big.png", big), [])).toMatchObject({ ok: false, code: "image_too_large" });
    expect(readPostedImage(file(dir, "edge.png", big.subarray(0, HILL_MEDIA_BYTES_MAX)), [])).toMatchObject({ ok: true, mime: "image/png" });
  });

  posix("a symlink, a symlinked folder, a folder, a missing file, a FIFO and a device are refused with the reason", () => {
    const dir = folder("hill-img-");
    const real = file(dir, "real.png", png());
    symlinkSync(real, join(dir, "link.png"));
    mkdirSync(join(dir, "shots"));
    file(join(dir, "shots"), "a.png", png());
    symlinkSync(join(dir, "shots"), join(dir, "via"));
    const reason = (path: string) => {
      const read = readPostedImage(path, []);
      expect(read.ok).toBe(false);
      return read.ok ? "" : read.error;
    };
    expect(reason(join(dir, "link.png"))).toContain("is a symlink");
    expect(reason(join(dir, "via", "a.png"))).toContain("symlinked folder");
    expect(reason(join(dir, "shots"))).toContain("is a folder");
    expect(reason(join(dir, "missing.png"))).toContain("no such file");
    expect(reason("/dev/zero")).toContain("not a regular file");
    if (spawnSync("mkfifo", [join(dir, "pipe.png")]).status === 0) expect(reason(join(dir, "pipe.png"))).toContain("not a regular file");
    expect(readPostedImage(real, [])).toMatchObject({ ok: true });
  });

  test("only an absolute, normal path: relative, `..`, `.`, a NUL and a very long path are refused", () => {
    const dir = folder("hill-img-");
    file(dir, "a.png", png());
    for (const path of ["a.png", "./a.png", `${dir}/../${dir.split("/").at(-1)!}/a.png`, `${dir}/./a.png`, `${dir}/a.png\0`, `/${"x".repeat(5000)}`, ""]) {
      expect(readPostedImage(path, [])).toMatchObject({ ok: false, code: "bad_image" });
    }
  });

  test("Collie's own folders, a .git folder and a state secret's name are refused even when the bytes are an image", () => {
    const state = folder("hill-state-");
    const repo = folder("hill-repo-");
    mkdirSync(join(repo, ".git"));
    const inState = file(state, "shot.png", png());
    const inGit = file(join(repo, ".git"), "shot.png", png());
    const secret = file(repo, "paired-devices.json", png());
    const denied = deniedFoldersSync([state]);
    for (const path of [inState, inGit, secret]) {
      const read = readPostedImage(path, denied);
      expect(read).toMatchObject({ ok: false, code: "bad_image" });
      if (!read.ok) expect(read.error).toContain("Collie's own folders");
    }
  });
});

describe("the media folder", () => {
  posix("keeps each file 0600 in a 0700 folder named by the decision id, and reads it back by the recorded size and type", () => {
    const state = folder("hill-state-");
    const media = new HillMediaStore(hillDir(state), []);
    const id = "im_aaaaaaaaaaaaaaaa";
    expect(media.save("dc_abcdefabcdef", [{ id, bytes: png() }])).toBe(true);
    const root = join(hillDir(state), MEDIA_DIR);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "dc_abcdefabcdef")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "dc_abcdefabcdef", id)).mode & 0o777).toBe(0o600);
    expect(media.bytesOf("dc_abcdefabcdef", { id, mime: "image/png", bytes: png().length })).toEqual(png());
    // A recorded size or type that does not match the file serves nothing.
    expect(media.bytesOf("dc_abcdefabcdef", { id, mime: "image/png", bytes: 3 })).toBeNull();
    expect(media.bytesOf("dc_abcdefabcdef", { id, mime: "image/jpeg", bytes: png().length })).toBeNull();
    // Ids off their pattern never build a path.
    expect(media.save("../x", [{ id, bytes: png() }])).toBe(false);
    expect(media.save("dc_abcdefabcdef", [{ id: "../../a", bytes: png() }])).toBe(false);
    expect(media.bytesOf("..", { id, mime: "image/png", bytes: png().length })).toBeNull();
    expect(media.bytesOf("dc_abcdefabcdef", { id: "../dc_abcdefabcdef", mime: "image/png", bytes: png().length })).toBeNull();
    media.remove("dc_abcdefabcdef");
    expect(existsSync(join(root, "dc_abcdefabcdef"))).toBe(false);
  });

  test("prune removes every folder whose decision is not held", () => {
    const state = folder("hill-state-");
    const media = new HillMediaStore(hillDir(state), []);
    expect(media.prune(new Set())).toBe(0);
    media.save("dc_aaaaaaaaaaaa", [{ id: mintMediaId(), bytes: png() }]);
    media.save("dc_bbbbbbbbbbbb", [{ id: mintMediaId(), bytes: png() }]);
    mkdirSync(join(hillDir(state), MEDIA_DIR, "stray"));
    expect(media.prune(new Set(["dc_aaaaaaaaaaaa"]))).toBe(2);
    expect(readdirSync(join(hillDir(state), MEDIA_DIR))).toEqual(["dc_aaaaaaaaaaaa"]);
  });

  test("a media id is im_ and 16 characters of [a-z0-9], every letter equally likely", () => {
    for (let i = 0; i < 50; i++) expect(mintMediaId()).toMatch(/^im_[a-z0-9]{16}$/);
    expect(mintMediaId(() => new Uint8Array(24).fill(255).map((_, i) => (i === 0 ? 255 : i)))).toMatch(/^im_[a-z0-9]{16}$/);
  });
});

// ── The service ──────────────────────────────────────────────────────────────────────────────────

const POSTER: HillAgentSender = { kind: "agent", address: "local/%1#aaaa", memberId: null, harness: "agent-x", label: "repo#one", host: "desk" };

interface Rig {
  readonly hill: HillService;
  readonly store: HillStore;
  readonly media: HillMediaStore;
  readonly state: string;
  readonly work: string;
  readonly audit: AuditEntry[];
  /** The clock the store and the service read; a test moves `now`. */
  readonly time: { now: number };
}

function rig(opts: { media?: boolean; failPut?: boolean } = {}): Rig {
  const state = folder("hill-state-");
  const work = folder("hill-work-");
  const audit: AuditEntry[] = [];
  const media = new HillMediaStore(hillDir(state), deniedFoldersSync([state]), () => undefined);
  let n = 0;
  let m = 0;
  const time = { now: 1000 };
  const store = new HillStore(hillDir(state), () => time.now, () => undefined, (ids) => {
    for (const id of ids) media.remove(id);
  });
  if (opts.failPut === true) store.put = () => false;
  const deps: HillServiceDeps = {
    store,
    receipts: memoryHillReceipts(),
    place: (address) => (address.startsWith("local/%1") ? { address: "local/%1#aaaa", label: "repo#one", host: "desk", unattended: false } : null),
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => time.now,
    mintId: () => {
      n += 1;
      return `dc_test${String(n).padStart(8, "0")}`;
    },
    mintMediaId: () => {
      m += 1;
      return `im_test${String(m).padStart(12, "0")}`;
    },
    audit: (entry) => audit.push(entry),
  };
  const hill = new HillService(opts.media === false ? deps : { ...deps, media });
  return { hill, store, media, state, work, audit, time };
}

let seq = 0;
function input(images: HillImageInput[], over: Partial<HillPostInput> = {}): HillPostInput {
  seq += 1;
  return { requestId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, title: "Ship it?", summary: "The leg is green.", options: [{ intent: "yes", label: "Yes" }], images, ...over };
}

function mediaFolder(r: Rig, id: string): string {
  return join(hillDir(r.state), MEDIA_DIR, id);
}

describe("a post with images", () => {
  test("keeps each image under a minted id, in order, with its caption; the audit has the count and the bytes, never a path", () => {
    const r = rig();
    const a = file(r.work, "a.png", png(390, 240));
    const b = file(r.work, "b.jpg", jpeg());
    const answer = r.hill.post(POSTER, input([{ path: a, caption: "  The \u0007 card\nafter  " }, { path: b }]));
    if (!answer.ok) throw new Error(answer.error);
    expect(answer.decision.media).toEqual([
      { id: "im_test000000000001", kind: "image", mime: "image/png", bytes: png().length, width: 390, height: 240, caption: "The  card after" },
      { id: "im_test000000000002", kind: "image", mime: "image/jpeg", bytes: jpeg().length, width: 640, height: 480 },
    ]);
    expect(readdirSync(mediaFolder(r, answer.decision.id)).toSorted()).toEqual(["im_test000000000001", "im_test000000000002"]);
    expect(r.hill.mediaFile(answer.decision.id, "im_test000000000001")).toEqual({ mime: "image/png", bytes: png(390, 240) });
    expect(r.audit).toEqual([{ action: "hill.post", detail: { decisionId: answer.decision.id, options: 1, images: 2, imageBytes: png().length + jpeg().length } }]);
    expect(JSON.stringify(r.audit)).not.toContain(r.work);
    // The decisions file reads back with its media.
    const stored = parseJsonObject(readFileSync(join(hillDir(r.state), "decisions.json"), "utf8"));
    const rows = stored?.decisions;
    expect(Array.isArray(rows) ? readDecision(rows[0])?.media : null).toEqual(answer.decision.media);
  });

  test("a fifth image is too_many_images; one bad image refuses the whole post and keeps nothing", () => {
    const r = rig();
    const a = file(r.work, "a.png", png());
    const five = r.hill.post(POSTER, input([{ path: a }, { path: a }, { path: a }, { path: a }, { path: a }]));
    expect(five).toMatchObject({ ok: false, code: "too_many_images" });
    const svg = file(r.work, "x.svg", SVG);
    expect(r.hill.post(POSTER, input([{ path: a }, { path: svg }]))).toMatchObject({ ok: false, code: "bad_image" });
    const big = new Uint8Array(HILL_MEDIA_BYTES_MAX + 10);
    big.set(png());
    expect(r.hill.post(POSTER, input([{ path: file(r.work, "big.png", big) }]))).toMatchObject({ ok: false, code: "image_too_large" });
    expect(r.hill.post(POSTER, input([{ path: a, caption: "x".repeat(81) }]))).toMatchObject({ ok: false, code: "bad_image" });
    expect(r.store.all()).toEqual([]);
    expect(existsSync(join(hillDir(r.state), MEDIA_DIR))).toBe(false);
    expect(r.audit).toEqual([]);
  });

  test("four images are fine; a repeat of the request id answers the stored decision without reading again", () => {
    const r = rig();
    const a = file(r.work, "a.png", png());
    const post = input([{ path: a }, { path: a }, { path: a }, { path: a }]);
    const first = r.hill.post(POSTER, post);
    if (!first.ok) throw new Error(first.error);
    expect(first.decision.media).toHaveLength(4);
    rmSync(a);
    expect(r.hill.post(POSTER, post)).toEqual(first);
  });

  test("a bridge with no media folder refuses images and still takes a post without them", () => {
    const r = rig({ media: false });
    const a = file(r.work, "a.png", png());
    expect(r.hill.post(POSTER, input([{ path: a }]))).toMatchObject({ ok: false, code: "bad_image", error: "this bridge keeps no images" });
    expect(r.hill.post(POSTER, input([]))).toMatchObject({ ok: true, decision: { media: [] } });
  });

  test("a decision that cannot be saved leaves no images behind", () => {
    const r = rig({ failPut: true });
    const a = file(r.work, "a.png", png());
    expect(r.hill.post(POSTER, input([{ path: a }]))).toMatchObject({ ok: false });
    expect(existsSync(mediaFolder(r, "dc_test00000001"))).toBe(false);
  });

  test("an image inside the bridge's state folder is refused, whatever its bytes", () => {
    const r = rig();
    const inside = file(r.state, "shot.png", png());
    expect(r.hill.post(POSTER, input([{ path: inside }]))).toMatchObject({ ok: false, code: "bad_image" });
  });
});

// ── A trick's own folder (M94): the one root inside the config folder, for a trick's post only ───

describe("a trick's own folder", () => {
  /** A state folder, a config folder with two trick folders, and a folder outside both. */
  function layout() {
    const root = folder("hill-trick-");
    const state = join(root, "state");
    const config = join(root, "config");
    const legs = join(config, "tricks", "legs");
    const other = join(config, "tricks", "other");
    const outside = join(root, "outside");
    for (const dir of [state, legs, other, outside]) mkdirSync(dir, { recursive: true });
    const denied = deniedFoldersSync([state, config]);
    const never = deniedFoldersSync([state, join(state, "hill", MEDIA_DIR)]);
    return { root, state, config, legs, other, outside, denied, never };
  }

  test("a file in the trick's folder is read with its root; without the root it is refused as Collie's own", () => {
    const l = layout();
    const shot = file(l.legs, "shot.png", png());
    mkdirSync(join(l.legs, "shots"));
    const nested = file(join(l.legs, "shots"), "b.webp", webpX());
    expect(readPostedImage(shot, l.denied, { root: l.legs, never: l.never })).toMatchObject({ ok: true, mime: "image/png" });
    expect(readPostedImage(nested, l.denied, { root: l.legs, never: l.never })).toMatchObject({ ok: true, mime: "image/webp" });
    const without = readPostedImage(shot, l.denied);
    expect(without).toMatchObject({ ok: false, code: "bad_image" });
    if (!without.ok) expect(without.error).toContain("Collie's own folders");
  });

  test("the root lifts nothing else: another trick's folder, the config folder itself, the state folder", () => {
    const l = layout();
    const allowed = { root: l.legs, never: l.never };
    for (const path of [file(l.other, "shot.png", png()), file(l.config, "shot.png", png()), file(l.state, "shot.png", png())]) {
      expect(readPostedImage(path, l.denied, allowed), path).toMatchObject({ ok: false, code: "bad_image" });
    }
  });

  test("every other check holds inside the folder: the bytes, the cap, a .git folder, a secret's name, the manifest", () => {
    const l = layout();
    const allowed = { root: l.legs, never: l.never };
    const big = new Uint8Array(HILL_MEDIA_BYTES_MAX + 1);
    big.set(png());
    mkdirSync(join(l.legs, ".git"));
    writeFileSync(join(l.legs, "trick.toml"), 'id = "legs"\n');
    expect(readPostedImage(join(l.legs, "trick.toml"), l.denied, allowed)).toMatchObject({ ok: false, code: "bad_image" });
    expect(readPostedImage(file(l.legs, "page.png", HTML), l.denied, allowed)).toMatchObject({ ok: false, code: "bad_image" });
    expect(readPostedImage(file(l.legs, "big.png", big), l.denied, allowed)).toMatchObject({ ok: false, code: "image_too_large" });
    expect(readPostedImage(file(join(l.legs, ".git"), "a.png", png()), l.denied, allowed)).toMatchObject({ ok: false, code: "bad_image" });
    expect(readPostedImage(file(l.legs, "paired-devices.json", png()), l.denied, allowed)).toMatchObject({ ok: false, code: "bad_image" });
  });

  posix("a symlink in the folder that points out, a symlinked folder in it, and `../` out of it are refused", () => {
    const l = layout();
    const allowed = { root: l.legs, never: l.never };
    const away = file(l.outside, "away.png", png());
    const sibling = file(l.other, "shot.png", png());
    symlinkSync(away, join(l.legs, "out.png"));
    symlinkSync(sibling, join(l.legs, "sibling.png"));
    symlinkSync(l.outside, join(l.legs, "via"));
    const reason = (path: string) => {
      const read = readPostedImage(path, l.denied, allowed);
      expect(read.ok, path).toBe(false);
      return read.ok ? "" : read.error;
    };
    expect(reason(join(l.legs, "out.png"))).toContain("is a symlink");
    expect(reason(join(l.legs, "sibling.png"))).toContain("is a symlink");
    expect(reason(join(l.legs, "via", "away.png"))).toContain("symlinked folder");
    expect(reason(`${l.legs}/../other/shot.png`)).toContain("no . or ..");
    // The same file, named by its normal path, is another trick's: still Collie's own.
    expect(reason(sibling)).toContain("Collie's own folders");
  });

  test("a root that is not one trick's folder lifts nothing: the config folder itself, inside the state folder, a relative or `..` root", () => {
    const l = layout();
    const inConfig = file(l.legs, "shot.png", png());
    const stateTrick = join(l.state, "tricks", "legs");
    mkdirSync(stateTrick, { recursive: true });
    const inState = file(stateTrick, "shot.png", png());
    expect(readPostedImage(inConfig, l.denied, { root: l.config, never: l.never })).toMatchObject({ ok: false, code: "bad_image" });
    expect(readPostedImage(inState, l.denied, { root: stateTrick, never: l.never })).toMatchObject({ ok: false, code: "bad_image" });
    expect(readPostedImage(inConfig, l.denied, { root: "config/tricks/legs", never: l.never })).toMatchObject({ ok: false, code: "bad_image" });
    expect(readPostedImage(inConfig, l.denied, { root: `${l.legs}/../legs`, never: l.never })).toMatchObject({ ok: false, code: "bad_image" });
  });

  /** A hill with a media folder that denies the state and the config folders, as bridge/index.ts makes it. */
  function trickHill(l: ReturnType<typeof layout>): HillService {
    let n = 0;
    return new HillService({
      store: new HillStore(hillDir(l.state), () => 1000),
      receipts: memoryHillReceipts(),
      place: (address) => (address.startsWith("local/%1") ? { address: "local/%1#aaaa", label: "repo#one", host: "desk", unattended: false } : null),
      send: async () => "typed",
      crewMode: () => "solo",
      walkyOn: () => true,
      memberId: "m_aaaaaaaaaa",
      machine: "desk",
      mintId: () => `dc_trk${String((n += 1)).padStart(9, "0")}`,
      media: new HillMediaStore(hillDir(l.state), deniedFoldersSync([l.state, l.config]), () => undefined),
    });
  }

  test("through the service: a trick's post reads its own folder; an agent's post naming the same file is refused", () => {
    const l = layout();
    const hill = trickHill(l);
    const shot = file(l.legs, "shot.png", png(390, 240));
    const trick = { kind: "trick", trickId: "legs", trickKey: "case-8", label: "Browser leg", memberId: "desk" } as const;
    const posted = hill.postDecision({ ...trick, imageRoot: l.legs }, input([{ path: shot, caption: "the red case" }]));
    expect(posted).toMatchObject({ ok: true, decision: { media: [{ mime: "image/png", width: 390, height: 240, caption: "the red case" }] } });
    if (posted.ok) expect(hill.mediaFile(posted.decision.id, posted.decision.media[0]!.id)?.bytes).toEqual(png(390, 240));
    // The root is never stored on the decision.
    if (posted.ok) expect(JSON.stringify(posted.decision)).not.toContain("imageRoot");
    expect(hill.post(POSTER, input([{ path: shot }]))).toMatchObject({ ok: false, code: "bad_image" });
    // An agent sender that carries a root anyway gets none.
    // SAFETY: a deliberate widening for the test: HillAgentSender has no `imageRoot`, so only a cast can
    // add one, and the service must ignore it on an agent's post.
    const smuggled = { ...POSTER, imageRoot: l.legs } as HillAgentSender;
    expect(hill.postDecision(smuggled, input([{ path: shot }]))).toMatchObject({ ok: false, code: "bad_image" });
    // A trick with no root, or another trick's root, takes the agent's rules.
    expect(hill.postDecision(trick, input([{ path: shot }]))).toMatchObject({ ok: false, code: "bad_image" });
    expect(hill.postDecision({ ...trick, imageRoot: l.other }, input([{ path: shot }]))).toMatchObject({ ok: false, code: "bad_image" });
  });

  test("a root off the socket is not a field: readPostFields drops it", () => {
    const read = readPostFields({ requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f", title: "Look", summary: "s", imageRoot: "/x", images: [{ path: "/x/a.png", root: "/x" }] });
    if (!read.ok) throw new Error(read.error);
    expect(read.input.images).toEqual([{ path: "/x/a.png" }]);
    expect(JSON.stringify(read.input)).not.toContain("root");
  });
});

describe("images leave with their decision", () => {
  test("when the decision leaves the stored closed list, its folder goes", () => {
    const r = rig();
    const a = file(r.work, "a.png", png());
    const first = r.hill.post(POSTER, input([{ path: a }]));
    if (!first.ok) throw new Error(first.error);
    expect(r.hill.withdraw(POSTER, first.decision.id).ok).toBe(true);
    expect(existsSync(mediaFolder(r, first.decision.id))).toBe(true);
    // HILL_CLOSED_KEPT newer closed decisions push the first one out of the file.
    for (let i = 0; i < HILL_CLOSED_KEPT; i++) {
      r.time.now += 1;
      const next = r.hill.post(POSTER, input([]));
      if (!next.ok) throw new Error(next.error);
      r.time.now += 1;
      r.hill.withdraw(POSTER, next.decision.id);
    }
    expect(r.store.get(first.decision.id)).toBeUndefined();
    expect(existsSync(mediaFolder(r, first.decision.id))).toBe(false);
  });

  test("the sweep, and the start, remove a folder whose decision is gone", () => {
    const r = rig();
    const a = file(r.work, "a.png", png());
    const kept = r.hill.post(POSTER, input([{ path: a }]));
    if (!kept.ok) throw new Error(kept.error);
    r.media.save("dc_orphan000000", [{ id: "im_aaaaaaaaaaaaaaaa", bytes: png() }]);
    r.hill.sweep();
    expect(readdirSync(join(hillDir(r.state), MEDIA_DIR))).toEqual([kept.decision.id]);
    r.media.save("dc_orphan000001", [{ id: "im_aaaaaaaaaaaaaaaa", bytes: png() }]);
    expect(r.hill.pruneMedia()).toBe(1);
    expect(readdirSync(join(hillDir(r.state), MEDIA_DIR))).toEqual([kept.decision.id]);
  });

  test("a decisions file set aside at the start prunes nothing, at the start or from the sweep", () => {
    const state = folder("hill-state-");
    mkdirSync(hillDir(state), { recursive: true });
    writeFileSync(join(hillDir(state), DECISIONS_FILE), JSON.stringify({ v: 2, decisions: [] }));
    const media = new HillMediaStore(hillDir(state), deniedFoldersSync([state]), () => undefined);
    media.save("dc_fromnewer001", [{ id: "im_aaaaaaaaaaaaaaaa", bytes: png() }]);
    const store = new HillStore(hillDir(state), () => 1000, () => undefined);
    const hill = new HillService({ store, receipts: memoryHillReceipts(), media, place: () => null, send: async () => "typed", crewMode: () => "solo", walkyOn: () => true, memberId: "m_aaaaaaaaaa", machine: "desk", now: () => 1000 });
    expect(hill.pruneMedia()).toBe(0);
    hill.sweep();
    expect(readdirSync(join(hillDir(state), MEDIA_DIR))).toEqual(["dc_fromnewer001"]);
  });

  test("an entry this build cannot read keeps its folder; one with no id it can tell stops pruning", () => {
    const state = folder("hill-state-");
    mkdirSync(hillDir(state), { recursive: true });
    const media = new HillMediaStore(hillDir(state), deniedFoldersSync([state]), () => undefined);
    media.save("dc_fromnewer001", [{ id: "im_aaaaaaaaaaaaaaaa", bytes: png() }]);
    media.save("dc_orphan000000", [{ id: "im_aaaaaaaaaaaaaaaa", bytes: png() }]);
    const deps = { receipts: memoryHillReceipts(), media, place: () => null, send: async (): Promise<"typed"> => "typed", crewMode: (): "solo" => "solo", walkyOn: () => true, memberId: "m_aaaaaaaaaa", machine: "desk", now: () => 1000 };
    writeFileSync(join(hillDir(state), DECISIONS_FILE), JSON.stringify({ v: 1, decisions: [{ v: 2, id: "dc_fromnewer001" }, "no id here"] }));
    const blind = new HillService({ ...deps, store: new HillStore(hillDir(state), () => 1000) });
    expect(blind.pruneMedia()).toBe(0);
    expect(readdirSync(join(hillDir(state), MEDIA_DIR)).toSorted()).toEqual(["dc_fromnewer001", "dc_orphan000000"]);
    writeFileSync(join(hillDir(state), DECISIONS_FILE), JSON.stringify({ v: 1, decisions: [{ v: 2, id: "dc_fromnewer001" }] }));
    const sighted = new HillService({ ...deps, store: new HillStore(hillDir(state), () => 1000) });
    expect(sighted.pruneMedia()).toBe(1);
    expect(readdirSync(join(hillDir(state), MEDIA_DIR))).toEqual(["dc_fromnewer001"]);
  });
});

describe("the posted fields", () => {
  test("images are read off the socket as paths and captions; a fifth, or a wrong shape, is refused before the service", () => {
    const base = { requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f", title: "T", summary: "S" };
    expect(readPostFields({ ...base, images: [{ path: "/a.png", caption: "one" }, { path: "/b.png" }] })).toMatchObject({ ok: true, input: { images: [{ path: "/a.png", caption: "one" }, { path: "/b.png" }] } });
    expect(readPostFields(base)).toMatchObject({ ok: true, input: { images: [] } });
    expect(readPostFields({ ...base, images: Array.from({ length: 5 }, () => ({ path: "/a.png" })) })).toMatchObject({ ok: false, code: "too_many_images" });
    const wrong: JsonValue[] = ["/a.png", [{ caption: "x" }], [{ path: 3 }], [{ path: "/a.png", caption: 4 }], [{ path: "/".repeat(5000) }]];
    for (const images of wrong) {
      expect(readPostFields({ ...base, images })).toMatchObject({ ok: false, code: "bad_image" });
    }
  });

  test("a stored decision with a media entry off the contract fails its reader", () => {
    const good: JsonObject = { id: "im_aaaaaaaaaaaaaaaa", kind: "image", mime: "image/png", bytes: 10, width: 1, height: 1 };
    const kept: HillMedia = { id: "im_aaaaaaaaaaaaaaaa", kind: "image", mime: "image/png", bytes: 10, width: 1, height: 1 };
    const row = (media: JsonValue) => {
      const r = rig();
      const answer = r.hill.post(POSTER, input([]));
      if (!answer.ok) throw new Error(answer.error);
      const stored = parseJsonObject(JSON.stringify(answer.decision));
      return stored === undefined ? null : readDecision({ ...stored, media });
    };
    expect(row([good])?.media).toEqual([kept]);
    expect(row([{ ...good, caption: "c" }])?.media).toEqual([{ ...kept, caption: "c" }]);
    for (const bad of [[{ ...good, id: "../x" }], [{ ...good, mime: "image/svg+xml" }], [{ ...good, kind: "video" }], [{ ...good, bytes: -1 }], [good, good], [good, { ...good, id: "im_b" }]]) {
      expect(row(bad)).toBeNull();
    }
  });
});

// ── The route ───────────────────────────────────────────────────────────────────────────────────

describe("GET /api/hill/media/<decision>/<media>", () => {
  test("serves the bytes with the stored type and the picture headers", async () => {
    const r = rig();
    const answer = r.hill.post(POSTER, input([{ path: file(r.work, "a.webp", webpX()) }]));
    if (!answer.ok) throw new Error(answer.error);
    const res = hillMediaRoute(r.hill, answer.decision.id, answer.decision.media[0]!.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    for (const [name, value] of Object.entries(HILL_MEDIA_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get("content-security-policy")).toStartWith("default-src 'none'");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(webpX());
  });

  test("an unknown id, an id off its pattern and a traversal in either id are the same 404", async () => {
    const r = rig();
    const answer = r.hill.post(POSTER, input([{ path: file(r.work, "a.png", png()) }]));
    if (!answer.ok) throw new Error(answer.error);
    const did = answer.decision.id;
    const mid = answer.decision.media[0]!.id;
    for (const [d, m] of [
      ["dc_zzzzzzzzzzzz", mid],
      [did, "im_zzzzzzzzzzzzzzzz"],
      ["..", mid],
      [did, ".."],
      ["%2e%2e", mid],
      [did, "..%2fdecisions.json"],
      [`${did}/../${did}`, mid],
      [did, `../${did}/${mid}`],
      ["DC_ABCDEFABCDEF", mid],
      [did, `${mid}.tmp`],
    ] as const) {
      const res = hillMediaRoute(r.hill, d, m);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(HILL_MEDIA_MISSING);
    }
    expect(hillMediaRoute(undefined, did, mid).status).toBe(404);
    expect(await hillMediaRoute(undefined, did, mid).text()).toBe(HILL_OFF_TEXT);
  });

  test("a file changed on disk after it was kept is not served", () => {
    const r = rig();
    const answer = r.hill.post(POSTER, input([{ path: file(r.work, "a.png", png()) }]));
    if (!answer.ok) throw new Error(answer.error);
    const did = answer.decision.id;
    const mid = answer.decision.media[0]!.id;
    writeFileSync(join(mediaFolder(r, did), mid), HTML);
    expect(hillMediaRoute(r.hill, did, mid).status).toBe(404);
  });

  test("the route sits behind the read gate, before `?host=` is looked at", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const head = "const hillImage = pathname.match(HILL_IMAGE_ROUTE);";
    const at = src.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    expect(src.indexOf(head, at + head.length)).toBe(-1);
    const body = src.slice(at, src.indexOf("if (pathname ===", at));
    expect(body).toContain('req.method === "GET"');
    expect(body.indexOf('browserGate("read")')).toBeGreaterThan(-1);
    expect(body.indexOf('browserGate("read")')).toBeLessThan(body.indexOf('host.kind === "member"'));
    expect(body.indexOf('browserGate("read")')).toBeLessThan(body.indexOf("hillMediaRoute("));
  });
});

// ── End to end over the walky socket ────────────────────────────────────────────────────────────

const matcher: BeaconMatcher = {
  namespace: "tmux",
  scope: async () => "/tmp/tmux-1/default",
  matches: (pane, marker, scope) => marker.scope === scope && pane.paneId === marker.pane,
  notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
};
const target: PlaceTarget = { session: "main", matcher, paneIds: () => ["%1"] };
const panes: WalkyPane[] = [{ session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE }];

function overSocket(path: string, line: JsonObject): Promise<JsonObject | undefined> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const at = buffer.indexOf("\n");
      if (at >= 0) {
        socket.end();
        resolve(parseJsonObject(buffer.slice(0, at)));
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify(line)}\n`);
  });
}

describe("end to end", () => {
  posix("an image path rides the socket, the bridge reads the file, and the phone reads the bytes", async () => {
    const state = folder("hill-e2e-");
    const work = folder("hill-e2e-work-");
    const host: WalkyHost = { panes: () => panes, send: async () => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
    const walky = new WalkyService({ log: new WalkyLog(join(state, "walky")), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
    const media = new HillMediaStore(hillDir(state), deniedFoldersSync([state]));
    const hill = new HillService({
      store: new HillStore(hillDir(state), () => 1000),
      receipts: memoryHillReceipts(),
      place: walkyPlace(walky, null),
      send: walkySend(walky, { sleep: async () => undefined }),
      crewMode: () => "solo",
      walkyOn: () => true,
      memberId: "m_aaaaaaaaaa",
      machine: "desk",
      media,
    });
    const server = new WalkyServer({ socketPath: walkySocketPath(state), service: walky, targets: () => [target], log: () => undefined, hill });
    expect(await server.start()).toBe(true);
    stops.push(() => server.stop());
    const markers = [{ namespace: "tmux", scope: "/tmp/tmux-1/default", pane: "%1" }];
    const shot = file(work, "a.png", png(390, 240));
    const line = { v: 1, op: "hill.post", markers, requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f", title: "Look", summary: "The card after.", images: [{ path: shot, caption: "after" }] };
    const answer = await overSocket(walkySocketPath(state), line);
    expect(answer).toMatchObject({ ok: true, decision: { media: [{ kind: "image", mime: "image/png", width: 390, height: 240, caption: "after" }] } });
    const decision = hill.list().open[0]!;
    expect(readDecision(answer?.decision)?.media).toEqual(decision.media);
    const res = hillMediaRoute(hill, decision.id, decision.media[0]!.id);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(390, 240));

    const refused = await overSocket(walkySocketPath(state), { ...line, requestId: "11111111-1111-4111-8111-111111111111", images: [{ path: file(work, "b.png", HTML) }] });
    expect(refused).toMatchObject({ ok: false, hill: true, code: "bad_image" });
  });
});
