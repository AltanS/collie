import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DecisionMedia } from "../../web/src/lib/tricks/schema.ts";
import type { HillDecision, HillImageInput, HillPostInput, HillState } from "../../web/src/lib/hill/wire.ts";
import { HILL_MEDIA_BYTES_MAX, HILL_STATES } from "../../web/src/lib/hill/wire.ts";
import { HOST, isBelow } from "../host.ts";
import { headerField } from "../walky/types.ts";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { DEFAULT_DECISION_PRIORITY, DEFAULT_DECISION_TEXT, pointer, type Refusal, type TrickDecision } from "../../web/src/lib/tricks/schema.ts";
import { BY_THE_TRICK, TRICK_OFF, type HillOneAnswer, type HillPostAnswer, type HillTrickSender } from "../hill/service.ts";
import { hillDir } from "../hill/store.ts";

// A TRICK POSTS INTO THE HILL (M94, M96): after a run that succeeded, the runner hands the document's
// decisions here, and this module makes the hill agree with them.
//
// ONE SENDER PER TRICK. `from` is stamped here from the trick's manifest (`kind: "trick"`, its id, its
// name, the tricks host), never taken from the document. Each decision carries its document `key` as
// `from.trickKey`, so the answer comes back to the trick as a tap on `hill/<key>`.
//
// DIFF BY KEY, against the trick's decisions this module posted:
//   * a new key posts once. The `requestId` is derived from (trick, key, content hash, generation, the
//     key's post count), so a bridge restart or a second run with the same content posts nothing twice:
//     the hill answers a repeated request id with the decision it already holds. The count is saved
//     after the post, so a bridge that stops in between derives the same id again; it also keeps a
//     content that comes back (A, then B, then A) from meeting its own first post.
//   * the same key with changed content (anything the person sees: title, summary, body, options,
//     recommends, text mode, links, priority, about, replyTo, and each image's bytes and caption) posts
//     the new version with `supersedes` while the old one is open, and as a fresh decision once the old
//     one closed.
//   * a key the document no longer lists is withdrawn, "by the trick".
//   * a key the person answered or dismissed stays closed while its content hash is unchanged. To ask
//     again the trick changes the content, or drops the key for a run and lists it again (a drop moves
//     the generation, so the request id is new).
//   * a key that closed without the person (`undeliverable`, `expired` or `withdrawn` by someone other
//     than the trick) posts again on a later run that still lists it, at most once per
//     {@link REASK_AFTER_MS} per key, counted from its last post.
//   * a decision the parser refused, or that names no live session, or that the hill refused, changes
//     nothing for its key: the version on the hill stays as it is. Each such one is a refusal.
//   * a failed or timed-out run never reaches this module (service.ts): the last good decisions stay.
//
// IMAGES. A decision's `media` names files in the trick's own folder, relative to it. The runner takes
// the folder's real path once per run, joins each name to it, and hands the hill `images: [{ path,
// caption }]` with that folder as the sender's `imageRoot`: the one root inside the config folder the
// hill reads a trick's image from (bridge/hill/media.ts, "A TRICK'S OWN FOLDER"). Every other rule is
// the hill's: four images, 2 MB each, PNG, JPEG or WebP by the first bytes, no symlink. An image the
// hill refuses refuses that one decision, as any other refusal of the hill does. The content hash
// holds a SHA-256 of each file's bytes and its caption, so a new screenshot under the same key asks
// again; the digest is cached by path, inode, size and mtime for the bridge's lifetime, so an
// unchanged file is read once.
//
// SWITCHED OFF OR REMOVED: every open decision of the trick is withdrawn at once, "the trick is off".
//
// THE MAP. `<stateDir>/hill/tricks.json` keeps, per trick, the generation and per key the decision id,
// the content hash and the state last seen:
//   { "v": 1, "tricks": { "<trickId>": { "gen": 0, "keys": { "<key>": { "decisionId", "hash", "state", "seq", "at" } } } } }
// Beside the hill's own files, not in the trick's state folder (that folder is its program's). Written
// whole to a temp file and renamed, 0600 in a 0700 folder, and only when something changed, so a
// bridge whose tricks list no decisions writes no file.

/** The map file's name inside the hill folder. */
export const TRICKS_MAP_FILE = "tricks.json";

/** The hex characters of a content hash kept in the map and handed to the program as `seen`. */
export const CONTENT_HASH_HEX = 16;

/** The least time between two posts of a key that closed without the person. */
export const REASK_AFTER_MS = 10 * 60_000;
/** States a decision reaches without the person: its key may ask again. */
const REASKABLE: ReadonlySet<HillState> = new Set(["undeliverable", "expired", "withdrawn"]);

/** A key's last known decision on the hill. */
export interface TrickHillEntry {
  readonly decisionId: string;
  readonly hash: string;
  readonly state: HillState;
  /** How many times this key was posted in this generation: the next post's request id takes it. */
  readonly seq: number;
  /** When it was last posted, epoch ms. Absent in a map written before re-asks: it may ask at once. */
  readonly at?: number;
}

interface TrickHillRecord {
  gen: number;
  keys: Record<string, TrickHillEntry>;
}

/** What this module needs of the hill (bridge/hill/service.ts `HillService`). */
export interface TrickHillPort {
  postDecision(from: HillTrickSender, input: HillPostInput): HillPostAnswer;
  withdraw(from: HillTrickSender, id: string, reason: string): HillOneAnswer;
  decision(id: string): HillDecision | undefined;
}

export interface TrickHillDeps {
  readonly stateDir: string;
  readonly hill: TrickHillPort;
  /**
   * The walky address of the live session a facts scope key (`host:paneId`) names now, or null when it
   * names none on this machine. The hill resolves the address to its session again at post time.
   */
  addressOf(scopeKey: string): string | null;
  readonly warn?: (line: string) => void;
  readonly now?: () => number;
}

/** The trick a run belongs to, as the runner knows it. */
export interface TrickHillTrick {
  readonly id: string;
  /** The manifest's name: the sender's label. */
  readonly name: string;
  /** The tricks host name (facts.ts `tricksHostName`). */
  readonly host: string;
  /** The trick's own folder, `<configDir>/tricks/<id>`: where its decisions' images are. */
  readonly dir: string;
}

/** One image of a decision as the content hash sees it: a digest of the file's bytes, and its caption. */
export interface DecisionImageDigest {
  readonly bytes: string;
  readonly caption: string | null;
}

/** How many file digests the cache keeps. Twenty decisions of four images is 80 per trick. */
const FILE_DIGESTS_MAX = 512;

/** A file's digest by path, with the inode, size and mtime it was read at. For the bridge's lifetime. */
const fileDigests = new Map<string, { readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly digest: string }>();

/**
 * A SHA-256 of one image file's bytes, read once while its inode, size and mtime stay. A file the hill
 * would refuse unread (missing, not a regular file, a path through a symlink, over the cap) is a short
 * marker instead, so the hash still moves when it changes and nothing past the cap is read.
 */
export function imageFileDigest(path: string): string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return "missing";
  }
  if (!st.isFile()) return "not-a-file";
  if (st.size > HILL_MEDIA_BYTES_MAX) return `too-large:${String(st.size)}`;
  const held = fileDigests.get(path);
  if (held !== undefined && held.ino === st.ino && held.size === st.size && held.mtimeMs === st.mtimeMs) return held.digest;
  let digest: string;
  try {
    if (realpathSync(path) !== path) return "not-the-real-path";
    digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "unreadable";
  }
  fileDigests.delete(path);
  if (fileDigests.size >= FILE_DIGESTS_MAX) {
    const oldest = fileDigests.keys().next().value;
    if (oldest !== undefined) fileDigests.delete(oldest);
  }
  fileDigests.set(path, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, digest });
  return digest;
}

/** What one run's decisions are, as the parser left them. */
export interface TrickHillRun {
  readonly decisions: readonly TrickDecision[];
  /** Keys the parser refused alone: their version on the hill stays as it is. */
  readonly refusedKeys: readonly string[];
}

/**
 * The content hash of a decision: everything the person sees, defaults filled, in a fixed order, as hex.
 * Not the key, not `expiresAt`. `images` are the decision's media as digests of their bytes, with their
 * captions ({@link imageFileDigest}); a decision with none hashes as it did before images.
 */
export function decisionContentHash(decision: TrickDecision, images: readonly DecisionImageDigest[] = []): string {
  const fields = {
    title: decision.title,
    summary: decision.summary,
    body: decision.body ?? "",
    options: (decision.options ?? []).map((option) => [option.intent, option.label, option.detail ?? null, option.confirm ?? null]),
    recommends: decision.recommends == null ? null : [decision.recommends.intent, decision.recommends.why],
    text: decision.text ?? DEFAULT_DECISION_TEXT,
    links: (decision.links ?? []).map((link) => [link.label, link.href]),
    priority: decision.priority ?? DEFAULT_DECISION_PRIORITY,
    about: decision.about ?? null,
    replyTo: decision.replyTo ?? null,
  };
  const seen = images.length === 0 ? fields : { ...fields, images: images.map((image) => [image.bytes, image.caption]) };
  return createHash("sha256").update(JSON.stringify(seen)).digest("hex").slice(0, CONTENT_HASH_HEX);
}

/** The request id of one post: a UUID-shaped SHA-256 of the trick, the key, the hash, the generation and the key's post count. */
export function trickRequestId(trickId: string, key: string, hash: string, gen: number, seq: number): string {
  const hex = createHash("sha256").update(`collie-trick-hill\0${trickId}\0${key}\0${hash}\0${String(gen)}\0${String(seq)}`).digest("hex");
  // Version 4 and the RFC 4122 variant, so it reads as any canonical UUID the hill takes.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isHillState(value: string | undefined): value is HillState {
  return HILL_STATES.some((state) => state === value);
}

/** The map as read off disk; an entry that does not read is dropped. */
function readMap(raw: string): Map<string, TrickHillRecord> {
  const out = new Map<string, TrickHillRecord>();
  const file = parseJsonObject(raw);
  const tricks = asJsonObject(file?.tricks);
  if (file?.v !== 1 || tricks === undefined) return out;
  for (const [id, value] of Object.entries(tricks)) {
    const row = asJsonObject(value);
    const gen = asJsonNumber(row?.gen);
    const keys = asJsonObject(row?.keys);
    if (gen === undefined || !Number.isSafeInteger(gen) || gen < 0 || keys === undefined) continue;
    const record: TrickHillRecord = { gen, keys: {} };
    for (const [key, entryValue] of Object.entries(keys)) {
      const entry = asJsonObject(entryValue);
      const decisionId = asJsonString(entry?.decisionId);
      const hash = asJsonString(entry?.hash);
      const state = asJsonString(entry?.state);
      const seq = asJsonNumber(entry?.seq);
      if (decisionId === undefined || hash === undefined || !isHillState(state) || seq === undefined || !Number.isSafeInteger(seq) || seq < 0) continue;
      const at = asJsonNumber(entry?.at);
      record.keys[key] = at === undefined ? { decisionId, hash, state, seq } : { decisionId, hash, state, seq, at };
    }
    out.set(id, record);
  }
  return out;
}

export class TrickHill {
  private readonly warn: (line: string) => void;
  private readonly path: string;
  private readonly dir: string;
  private map: Map<string, TrickHillRecord>;

  private readonly now: () => number;

  constructor(private readonly deps: TrickHillDeps) {
    this.warn = deps.warn ?? ((line) => console.warn(`[tricks] ${line}`));
    this.now = deps.now ?? Date.now;
    this.dir = hillDir(deps.stateDir);
    this.path = join(this.dir, TRICKS_MAP_FILE);
    this.map = this.load();
  }

  private load(): Map<string, TrickHillRecord> {
    if (!existsSync(this.path)) return new Map();
    try {
      return readMap(readFileSync(this.path, "utf8"));
    } catch (err) {
      this.warn(`${this.path} could not be read, starting with no trick decisions: ${err instanceof Error ? err.message : String(err)}`);
      return new Map();
    }
  }

  private save(): void {
    const tricks: Record<string, TrickHillRecord> = {};
    for (const [id, record] of this.map) tricks[id] = record;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, tricks })}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
    } catch (err) {
      this.warn(`could not save ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The keys a trick has on the hill now, as this module last saw them. For a test and the doctor. */
  entries(trickId: string): Readonly<Record<string, TrickHillEntry>> {
    return this.map.get(trickId)?.keys ?? {};
  }

  /** The content hash of the decision the person answered: `seen` on the trick's tap. */
  seenOf(trickId: string, decisionId: string): string | undefined {
    const keys = this.map.get(trickId)?.keys ?? {};
    return Object.values(keys).find((entry) => entry.decisionId === decisionId)?.hash;
  }

  private sender(trick: Pick<TrickHillTrick, "id" | "name" | "host">, key: string, imageRoot: string | null = null): HillTrickSender {
    const sender: HillTrickSender = { kind: "trick", trickId: trick.id, trickKey: key, label: trick.name, host: trick.host };
    return imageRoot === null ? sender : { ...sender, imageRoot };
  }

  /**
   * A key's entry with its state read fresh off the hill. The hill keeps only its newest closed
   * decisions, so a closed one it no longer holds stays as this map last saw it; an open one it no
   * longer holds (its file was set aside) is undefined, and the key posts again.
   */
  private refreshed(entry: TrickHillEntry): TrickHillEntry | undefined {
    const held = this.deps.hill.decision(entry.decisionId);
    if (held === undefined) return entry.state === "open" ? undefined : entry;
    return held.state === entry.state ? entry : { ...entry, state: held.state };
  }

  /**
   * Make the hill agree with one successful run's decisions. Answers the refusals to add to the trick's
   * own (the list `collie trick check` and the Settings row read). Never throws.
   */
  sync(trick: TrickHillTrick, run: TrickHillRun): Refusal[] {
    const refusals: Refusal[] = [];
    const before = JSON.stringify(this.map.get(trick.id) ?? null);
    const record: TrickHillRecord = this.map.get(trick.id) ?? { gen: 0, keys: {} };
    const keys: Record<string, TrickHillEntry> = {};
    for (const [key, entry] of Object.entries(record.keys)) {
      const fresh = this.refreshed(entry);
      if (fresh !== undefined) keys[key] = fresh;
    }
    const listed = new Set([...run.decisions.map((decision) => decision.key), ...run.refusedKeys]);

    // Dropped keys first, so their open decisions leave room under the hill's cap.
    let dropped = false;
    for (const [key, entry] of Object.entries(keys)) {
      if (listed.has(key)) continue;
      if (entry.state === "open") {
        const out = this.deps.hill.withdraw(this.sender(trick, key), entry.decisionId, BY_THE_TRICK);
        if (!out.ok && !out.missing) {
          refusals.push({ code: "target", path: "/decisions", reason: `The decision "${key}" could not be withdrawn: ${out.error}.`, decision: key });
          continue;
        }
      }
      delete keys[key];
      dropped = true;
    }
    // A drop moves the generation, so a key listed again later posts as a new decision.
    const gen = dropped ? record.gen + 1 : record.gen;

    // The trick folder's real path, once per run and only when a decision names an image.
    const root = run.decisions.some((decision) => (decision.media ?? []).length > 0) ? realFolder(trick.dir) : null;
    run.decisions.forEach((decision, index) => {
      const path = pointer("/decisions", index);
      const named = imageInputs(root, decision.media ?? []);
      if (!named.ok) {
        refusals.push({ code: "target", path: pointer(path, "media"), reason: `${named.reason}, so the decision "${decision.key}" was not posted.`, decision: decision.key });
        return;
      }
      const images = named.images;
      const hash = decisionContentHash(
        decision,
        images.map((image) => ({ bytes: imageFileDigest(image.path), caption: image.caption ?? null })),
      );
      const held = keys[decision.key];
      // Unchanged: open stays open, and an answered or dismissed one stays closed. One that closed without
      // the person asks again, once per REASK_AFTER_MS.
      if (held !== undefined && held.hash === hash && !this.mayReask(held)) return;
      const replyTo = this.address(decision.replyTo, path, "replyTo", decision.key, refusals);
      const about = this.address(decision.about, path, "about", decision.key, refusals);
      if (replyTo === undefined || about === undefined) return;
      const input: HillPostInput = {
        requestId: trickRequestId(trick.id, decision.key, hash, gen, held?.seq ?? 0),
        title: decision.title,
        summary: decision.summary,
        body: decision.body ?? "",
        options: decision.options ?? [],
        text: decision.text ?? DEFAULT_DECISION_TEXT,
        recommends: decision.recommends ?? null,
        links: decision.links ?? [],
        priority: decision.priority ?? DEFAULT_DECISION_PRIORITY,
        about,
        replyTo,
        supersedes: held?.state === "open" ? held.decisionId : null,
        expiresAt: decision.expiresAt ?? null,
      };
      if (images.length > 0) input.images = images;
      const answer = this.deps.hill.postDecision(this.sender(trick, decision.key, images.length > 0 ? root : null), input);
      if (!answer.ok) {
        refusals.push(hillRefusal(answer, path, decision, images));
        return;
      }
      keys[decision.key] = { decisionId: answer.decision.id, hash, state: answer.decision.state, seq: (held?.seq ?? 0) + 1, at: this.now() };
    });

    const next: TrickHillRecord = { gen, keys };
    const empty = gen === 0 && Object.keys(keys).length === 0;
    if (empty) this.map.delete(trick.id);
    else this.map.set(trick.id, next);
    if (JSON.stringify(empty ? null : next) !== before) this.save();
    return refusals;
  }

  /** Whether an unchanged key may post again: it closed without the person, and its last post is old enough. */
  private mayReask(held: TrickHillEntry): boolean {
    return REASKABLE.has(held.state) && this.now() - (held.at ?? 0) >= REASK_AFTER_MS;
  }

  /** A scope key as a walky address: null when absent, undefined (and a refusal) when it names no live session. */
  private address(scopeKey: string | undefined, path: string, field: "replyTo" | "about", key: string, refusals: Refusal[]): string | null | undefined {
    if (scopeKey === undefined) return null;
    const address = this.deps.addressOf(scopeKey);
    if (address !== null) return address;
    refusals.push({ code: "target", path: pointer(path, field), reason: `"${scopeKey}" names no live agent session on this machine, so the decision "${key}" was not posted.`, decision: key });
    return undefined;
  }

  /**
   * The trick is switched off or removed: every open decision of it is withdrawn, "the trick is off".
   * Answered and dismissed keys are kept, so the same content stays closed when it comes back.
   */
  off(trick: Pick<TrickHillTrick, "id" | "name" | "host">): void {
    const record = this.map.get(trick.id);
    if (record === undefined) return;
    let changed = false;
    const keys: Record<string, TrickHillEntry> = {};
    for (const [key, entry] of Object.entries(record.keys)) {
      const fresh = this.refreshed(entry);
      if (fresh === undefined) {
        changed = true;
        continue;
      }
      if (fresh.state !== "open") {
        keys[key] = fresh;
        changed ||= fresh.state !== entry.state;
        continue;
      }
      const out = this.deps.hill.withdraw(this.sender(trick, key), fresh.decisionId, TRICK_OFF);
      if (!out.ok && !out.missing) {
        keys[key] = fresh;
        continue;
      }
      changed = true;
    }
    if (!changed) return;
    // The generation moves, so the same content posts again as a new decision when the trick is back.
    this.map.set(trick.id, { gen: record.gen + 1, keys });
    this.save();
  }

  /** Every trick this map knows that `present` does not hold is off (removed while the bridge was down, too). */
  prune(present: ReadonlySet<string>, host: string): void {
    for (const id of this.map.keys()) {
      if (!present.has(id)) this.off({ id, name: id, host });
    }
  }

  /** Whether the map holds an open decision of this trick. */
  hasOpen(trickId: string): boolean {
    return Object.values(this.map.get(trickId)?.keys ?? {}).some((entry) => entry.state === "open");
  }
}

/** A folder's real path, or null when it cannot be resolved. */
function realFolder(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * A decision's media as the hill's image inputs: each file joined to the trick folder's real path. A
 * sentence instead when the folder could not be resolved or a name leaves it (the schema already
 * refuses `..`; this is the second look).
 */
function imageInputs(root: string | null, media: readonly DecisionMedia[]): { readonly ok: true; readonly images: HillImageInput[] } | { readonly ok: false; readonly reason: string } {
  if (media.length === 0) return { ok: true, images: [] };
  if (root === null) return { ok: false, reason: "The trick folder could not be read for its images" };
  const images: HillImageInput[] = [];
  for (const item of media) {
    const path = join(root, item.file);
    if (!isBelow(HOST, root, path)) return { ok: false, reason: `"${item.file}" is not inside the trick folder` };
    images.push(item.caption === undefined ? { path } : { path, caption: item.caption });
  }
  return { ok: true, images };
}

/**
 * The refusal for a post the hill refused, with the hill's words. An image the hill refused is named by
 * its file in the trick folder, not by the long path the hill read, and points at that media entry.
 */
function hillRefusal(answer: Extract<HillPostAnswer, { ok: false }>, path: string, decision: TrickDecision, images: readonly HillImageInput[]): Refusal {
  const key = decision.key;
  if (answer.code === "too_many_open") return { code: "count", path, reason: `The hill refused it: ${answer.error}.`, decision: key };
  const isImage = answer.code === "bad_image" || answer.code === "image_too_large" || answer.code === "too_many_images";
  const at = isImage ? images.findIndex((image) => answer.error.startsWith(`${headerField(image.path, 120)}: `)) : -1;
  const image = images[at];
  const file = decision.media?.[at]?.file;
  if (image === undefined || file === undefined) return { code: "target", path: isImage ? pointer(path, "media") : path, reason: `The hill refused it: ${answer.error}.`, decision: key };
  const why = answer.error.slice(headerField(image.path, 120).length + 2);
  return { code: answer.code === "image_too_large" ? "size" : "target", path: pointer(pointer(path, "media"), at), reason: `The hill refused the image "${file}": ${why}.`, decision: key };
}

/**
 * A facts scope key (`host:paneId`) as the walky address of the live agent session in that pane, or
 * null. Only a session of this machine (`host` is the tricks host name): the facts list no other. The
 * address goes through `place`, the hill's own probe (bridge/hill/walky.ts `walkyPlace`), so it carries
 * the session's instance token and the hill takes it as it is.
 */
export function scopeKeyAddress(scopeKey: string, host: string, walkyMember: string, place: (address: string) => { readonly address: string } | null): string | null {
  const colon = scopeKey.indexOf(":");
  if (colon <= 0 || scopeKey.slice(0, colon) !== host) return null;
  const paneId = scopeKey.slice(colon + 1);
  if (paneId === "") return null;
  return place(`${walkyMember}/${paneId}`)?.address ?? null;
}
