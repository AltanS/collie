import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { HILL_ID_RE, HILL_MEDIA_BYTES_MAX, HILL_MEDIA_ID_RE, type HillDecision, type HillMedia } from "../../web/src/lib/hill/wire.ts";
import { hillImageMime } from "../hill/media.ts";
import { readDecision } from "../hill/parse.ts";
import { strictBase64 } from "../tricks/propose-wire.ts";
import type { CopyRole } from "./standby-launchers.ts";
import { tricksCopyKept } from "./standby-tricks.ts";
import { CARRIED_OK } from "./carry-notices.ts";

// THE LEAD'S OPEN DECISIONS, CARRIED TO ITS DEPUTY AS INERT DATA (CREW_PROTOCOL §25).
//
// Beside the tricks copy (standby-tricks.ts), the lead keeps a copy of its Hill's open Decisions on its
// deputy: each as the record the lead's Hill stores, its pictures, the ids of the Decisions that closed,
// the Hill's switch, and the trick map entries of the trick Decisions. The copy shows nowhere and answers
// nothing. It lands under `<stateDir>/standby-hill/`, which the deputy's own Hill never reads; only the
// person's takeover tap merges it into the deputy's Hill (`hill-adopt.ts`).
//
// ── THE LAYOUT ────────────────────────────────────────────────────────────────────────────────────
//   <stateDir>/standby-hill/                0700
//     index.json                            0600  what the lead sent last, and which pictures are held
//     media/<decisionId>/<mediaId>          0600  one picture, its type read from its bytes here
//
// ── THE WIRE (lead → deputy, the tricks copy's gate) ──────────────────────────────────────────────
//   POST /crew/v1/hill-copy          { seq, on, decisions, closed, tricks }   → { applied, need: { media } }
//   POST /crew/v1/hill-copy/media    { decisionId, mediaId, b64 | gone }      → { held }
//
// ── COLLIE'S OWN CARDS ────────────────────────────────────────────────────────────────────────────
// A Decision of Collie's own reads only from this machine's own store (hill/parse.ts). From the wire,
// the one kind taken is the notice that a carried trick did not start (`ref.type` `carried`), with its
// single OK answer, which only closes it. Any other Collie card is dropped and counted: a new version
// or a proposal acts on files that never cross, and a lead must not place a card that acts here. A
// record with a group of cards never lands either: only the lead's postCollie mints one.
//
// ── THE CLOSED IDS ────────────────────────────────────────────────────────────────────────────────
// The deputy keeps every closed id the same lead named, newest first, up to {@link HILL_CLOSED_IDS_MAX}.
// A Decision whose id is in that list is never held as open again, so a late or replayed list cannot
// bring an answered Decision back.

export const STANDBY_HILL_DIRNAME = "standby-hill";
export const STANDBY_HILL_VERSION = 1;

/** The report's fields on `hello` and `snapshot`. */
export const HILL_DIGEST_FIELD = "hillDigest";
export const HILL_SEQ_FIELD = "hillSeq";
export const HILL_NEED_FIELD = "hillNeed";

/** The most open Decisions one list carries. */
export const CARRIED_DECISIONS_MAX = 500;
/** The most closed ids a list names, and the deputy keeps. */
export const HILL_CLOSED_IDS_MAX = 500;
/** Every carried picture together, newest Decision first. A picture past it stays on the lead. */
export const CARRY_MEDIA_TOTAL_MAX = 32 * 1024 * 1024;
/** The body caps of the two routes. */
export const HILL_LIST_BODY_MAX = 8 * 1024 * 1024;
export const HILL_MEDIA_BODY_MAX = 3 * 1024 * 1024;

const HASH_RE = /^[0-9a-f]{64}$/u;

/** The digest of a list as it crosses the wire: the lead's over what it sends, the deputy's over what it took. */
export function hillCopyDigest(on: boolean, decisions: readonly JsonValue[], closed: readonly string[], tricks: JsonObject): string {
  return createHash("sha256").update(JSON.stringify({ on, decisions, closed, tricks })).digest("hex");
}

/** The deputy's report, as it rides `hello` and `snapshot`. */
export interface HillReport {
  readonly digest: string;
  readonly seq: number;
  readonly need: number;
}

export function parseHillReport(value: JsonValue | undefined): HillReport | null {
  const body = asJsonObject(value);
  const digest = asJsonString(body?.[HILL_DIGEST_FIELD]);
  const seq = asJsonNumber(body?.[HILL_SEQ_FIELD]);
  const need = asJsonNumber(body?.[HILL_NEED_FIELD]);
  if (digest === undefined || !HASH_RE.test(digest) || seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { digest, seq, need: need !== undefined && Number.isSafeInteger(need) && need > 0 ? need : 0 };
}

export function hillReportFields(report: HillReport | null): JsonObject {
  if (report === null) return {};
  return { [HILL_DIGEST_FIELD]: report.digest, [HILL_SEQ_FIELD]: report.seq, [HILL_NEED_FIELD]: report.need };
}

/** One list as the deputy reads it. `decisions` are the raw records, each read again by `readDecision`. */
export interface HillList {
  seq: number;
  on: boolean;
  decisions: JsonValue[];
  closed: string[];
  tricks: JsonObject;
  /** The digest of the list as it arrived, before anything was left out. */
  digest: string;
}

/** The body of `POST /crew/v1/hill-copy`, or null. Records are read one by one at apply. */
export function parseHillList(value: JsonValue | undefined): HillList | null {
  const body = asJsonObject(value);
  const seq = asJsonNumber(body?.seq);
  const on = asJsonBoolean(body?.on);
  const tricks = asJsonObject(body?.tricks);
  if (body === undefined || seq === undefined || !Number.isSafeInteger(seq) || seq <= 0 || on === undefined || tricks === undefined) return null;
  if (!Array.isArray(body.decisions) || body.decisions.length > CARRIED_DECISIONS_MAX) return null;
  if (!Array.isArray(body.closed) || body.closed.length > HILL_CLOSED_IDS_MAX) return null;
  const closed: string[] = [];
  for (const item of body.closed) {
    const id = asJsonString(item);
    if (id === undefined || !HILL_ID_RE.test(id)) return null;
    closed.push(id);
  }
  const decisions = [...body.decisions];
  return { seq, on, decisions, closed, tricks, digest: hillCopyDigest(on, decisions, closed, tricks) };
}

/** One picture: its bytes, or word that the lead no longer has it. */
export type MediaPush = { decisionId: string; mediaId: string; bytes: Uint8Array } | { decisionId: string; mediaId: string; gone: true };

/** The body of `POST /crew/v1/hill-copy/media`, or null. Both ids are checked before a path is ever built. */
export function parseMediaPush(value: JsonValue | undefined): MediaPush | null {
  const body = asJsonObject(value);
  const decisionId = asJsonString(body?.decisionId);
  const mediaId = asJsonString(body?.mediaId);
  if (body === undefined || decisionId === undefined || !HILL_ID_RE.test(decisionId) || mediaId === undefined || !HILL_MEDIA_ID_RE.test(mediaId)) return null;
  if (body.gone === true) return { decisionId, mediaId, gone: true };
  const b64 = asJsonString(body.b64);
  if (b64 === undefined || b64.length > Math.ceil((HILL_MEDIA_BYTES_MAX * 4) / 3) + 4) return null;
  const bytes = strictBase64(b64);
  return bytes === null ? null : { decisionId, mediaId, bytes };
}

/** One picture of the plan: whose it is and what its record says. */
export interface PlannedMedia {
  readonly decisionId: string;
  readonly media: HillMedia;
}

/** The key of one picture in the index. */
export function mediaKey(decisionId: string, mediaId: string): string {
  return `${decisionId}/${mediaId}`;
}

/**
 * The pictures that are carried, in list order (newest Decision first), within
 * {@link CARRY_MEDIA_TOTAL_MAX}. Lead and deputy run it on the same list, so both agree on what is owed.
 */
export function mediaPlan(decisions: readonly HillDecision[]): PlannedMedia[] {
  const out: PlannedMedia[] = [];
  let left = CARRY_MEDIA_TOTAL_MAX;
  for (const decision of decisions) {
    for (const media of decision.media) {
      if (media.bytes > HILL_MEDIA_BYTES_MAX || media.bytes > left) continue;
      left -= media.bytes;
      out.push({ decisionId: decision.id, media });
    }
  }
  return out;
}

/** What is held of one picture: its bytes are here, or it is settled as left on the lead. */
export type MediaHeld = "held" | "left";

/** The whole index. */
export interface HillIndex {
  version: number;
  crewId: string;
  from: string;
  seq: number;
  at: number;
  digest: string;
  on: boolean;
  /** The open Decisions, newest first, each read and checked. */
  decisions: HillDecision[];
  /** Closed ids from this lead, newest first. */
  closed: string[];
  tricks: JsonObject;
  /** Collie cards of the last list that this copy does not hold (see readCarriedRecord). */
  dropped: number;
  media: Map<string, MediaHeld>;
}

function serializeIndex(index: HillIndex): string {
  const media: JsonObject = {};
  for (const [key, held] of index.media) media[key] = held;
  const doc = {
    version: index.version,
    crewId: index.crewId,
    from: index.from,
    seq: index.seq,
    at: index.at,
    digest: index.digest,
    on: index.on,
    decisions: index.decisions,
    closed: index.closed,
    tricks: index.tricks,
    dropped: index.dropped,
    media,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** A record off the wire: an open Decision this copy may hold, `"dropped"` for a Collie card it may not, or null. */
export function readCarriedRecord(entry: JsonValue): HillDecision | "dropped" | null {
  const read = readDecision(entry, { collie: true });
  if (read === null || read.state !== "open") return null;
  // A group of cards is minted only by the lead's own postCollie (crew slice 8), for a card that acts on its files.
  if (read.group !== undefined) return "dropped";
  if (read.from.kind !== "collie") return read;
  const only = read.options.length === 1 ? read.options[0] : undefined;
  return read.from.ref?.type === "carried" && only?.intent === CARRIED_OK ? read : "dropped";
}

/** Parse the index. `null` for anything this reader does not understand, which reads as no copy. */
export function parseHillIndex(raw: string | null): HillIndex | null {
  if (raw === null) return null;
  const doc = parseJsonObject(raw);
  const crewId = asJsonString(doc?.crewId);
  const from = asJsonString(doc?.from);
  const seq = asJsonNumber(doc?.seq);
  const digest = asJsonString(doc?.digest);
  const on = asJsonBoolean(doc?.on);
  const tricks = asJsonObject(doc?.tricks);
  if (doc === undefined || asJsonNumber(doc.version) !== STANDBY_HILL_VERSION || crewId === undefined || crewId === "" || from === undefined || from === "") return null;
  if (seq === undefined || !Number.isSafeInteger(seq) || digest === undefined || !HASH_RE.test(digest) || on === undefined || tricks === undefined) return null;
  if (!Array.isArray(doc.decisions) || !Array.isArray(doc.closed)) return null;
  const decisions = doc.decisions.flatMap((entry) => {
    const read = readCarriedRecord(entry);
    return read === null || read === "dropped" ? [] : [read];
  });
  const dropped = asJsonNumber(doc.dropped);
  const closed = doc.closed.flatMap((entry) => {
    const id = asJsonString(entry);
    return id !== undefined && HILL_ID_RE.test(id) ? [id] : [];
  });
  const media = new Map<string, MediaHeld>();
  for (const [key, value] of Object.entries(asJsonObject(doc.media) ?? {})) if (value === "held" || value === "left") media.set(key, value);
  return {
    version: STANDBY_HILL_VERSION,
    crewId,
    from,
    seq,
    at: asJsonNumber(doc.at) ?? 0,
    digest,
    on,
    decisions,
    closed,
    tricks,
    dropped: dropped !== undefined && Number.isSafeInteger(dropped) && dropped > 0 ? dropped : 0,
    media,
  };
}

/** How many pictures of the plan the deputy still lacks. */
export function hillNeed(index: HillIndex | null): string[] {
  if (index === null) return [];
  return mediaPlan(index.decisions)
    .map((p) => mediaKey(p.decisionId, p.media.id))
    .filter((key) => index.media.get(key) === undefined);
}

export function hillReportOf(index: HillIndex | null): HillReport | null {
  if (index === null) return null;
  return { digest: index.digest, seq: index.seq, need: hillNeed(index).length };
}

export type HillListAnswer = { ok: true; need: string[] } | { ok: false; code: "stale" };
export type MediaAnswer = { ok: true } | { ok: false; code: "unknown" | "mismatch"; reason: string };

/**
 * The copy of the Hill on the deputy's disk. Only a crew route from this machine's own lead, while a
 * warrant names this machine, writes it; the deputy's Hill never reads it.
 */
export class StandbyHillStore {
  readonly dir: string;
  private cached: HillIndex | null = null;
  private loaded = false;
  private holdDepth = 0;
  /** The last write in line ({@link serial}). */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(stateDir, STANDBY_HILL_DIRNAME);
  }

  private get indexPath(): string {
    return join(this.dir, "index.json");
  }

  private mediaPath(decisionId: string, mediaId: string): string {
    return join(this.dir, "media", decisionId, mediaId);
  }

  async load(): Promise<HillIndex | null> {
    if (this.loaded) return this.cached;
    this.cached = parseHillIndex(await readFile(this.indexPath, "utf8").catch(() => null));
    this.loaded = true;
    return this.cached;
  }

  report(): HillReport | null {
    return hillReportOf(this.cached);
  }

  private async saveIndex(next: HillIndex): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => {});
    const tmp = `${this.indexPath}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, serializeIndex(next), { mode: 0o600 });
    await rename(tmp, this.indexPath);
    this.cached = next;
    this.loaded = true;
  }

  /**
   * Take a list from `from`, this machine's lead. A `seq` not above the one held from the same lead is
   * refused (`stale`). A record that does not read, is not open, or names an id this lead said closed is
   * left out. Pictures the new list does not carry are removed.
   */
  async applyList(input: { from: string; crewId: string; list: HillList }): Promise<HillListAnswer> {
    const held = await this.load();
    const same = held !== null && held.from === input.from && held.crewId === input.crewId;
    if (same && input.list.seq <= held.seq) return { ok: false, code: "stale" };
    const closed = [...new Set([...input.list.closed, ...(same ? held.closed : [])])].slice(0, HILL_CLOSED_IDS_MAX);
    const shut = new Set(closed);
    const decisions: HillDecision[] = [];
    let dropped = 0;
    for (const entry of input.list.decisions) {
      const read = readCarriedRecord(entry);
      if (read === "dropped") dropped += 1;
      if (read === null || read === "dropped" || shut.has(read.id) || decisions.some((d) => d.id === read.id)) continue;
      decisions.push(read);
    }
    const plan = new Set(mediaPlan(decisions).map((p) => mediaKey(p.decisionId, p.media.id)));
    const media = new Map<string, MediaHeld>();
    if (same) for (const [key, state] of held.media) if (plan.has(key)) media.set(key, state);
    const next: HillIndex = { version: STANDBY_HILL_VERSION, crewId: input.crewId, from: input.from, seq: input.list.seq, at: this.now(), digest: input.list.digest, on: input.list.on, decisions, closed, tricks: input.list.tricks, dropped, media };
    await this.saveIndex(next);
    await this.pruneMedia(next);
    return { ok: true, need: hillNeed(next) };
  }

  private async pruneMedia(index: HillIndex): Promise<void> {
    const root = join(this.dir, "media");
    for (const decisionId of await names(root)) {
      for (const mediaId of await names(join(root, decisionId))) {
        if (index.media.get(mediaKey(decisionId, mediaId)) !== "held") await removeTree(join(root, decisionId, mediaId));
      }
      if ((await names(join(root, decisionId))).length === 0) await removeTree(join(root, decisionId));
    }
  }

  /**
   * Take one picture. It must be one the plan carries, of exactly the size its record says, and its first
   * bytes must say the type its record says: the lead's word for the type is never taken. A picture that
   * fails, or that the lead says it no longer has, is settled as left, so it is not asked for again.
   */
  async applyMedia(push: MediaPush): Promise<MediaAnswer> {
    const index = await this.load();
    const key = mediaKey(push.decisionId, push.mediaId);
    const planned = index === null ? undefined : mediaPlan(index.decisions).find((p) => p.decisionId === push.decisionId && p.media.id === push.mediaId);
    if (index === null || planned === undefined) return { ok: false, code: "unknown", reason: "this list carries no such picture" };
    if (index.media.get(key) === "held") return { ok: true };
    if ("gone" in push) {
      await this.markMedia(key, "left");
      return { ok: true };
    }
    const { bytes } = push;
    if (bytes.length !== planned.media.bytes || bytes.length > HILL_MEDIA_BYTES_MAX || hillImageMime(bytes) !== planned.media.mime) {
      await this.markMedia(key, "left");
      return { ok: false, code: "mismatch", reason: "the picture is not the type and size its Decision records" };
    }
    const path = this.mediaPath(push.decisionId, push.mediaId);
    await mkdir(join(this.dir, "media", push.decisionId), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
    await this.markMedia(key, "held");
    return { ok: true };
  }

  private async markMedia(key: string, state: MediaHeld): Promise<void> {
    const index = this.cached;
    if (index === null) return;
    const media = new Map(index.media);
    media.set(key, state);
    await this.saveIndex({ ...index, media });
  }

  /** The bytes of one held picture, read again and its type read from its bytes again, or null. */
  async mediaBytes(decisionId: string, media: HillMedia): Promise<Uint8Array | null> {
    if (!HILL_ID_RE.test(decisionId) || !HILL_MEDIA_ID_RE.test(media.id)) return null;
    if ((await this.load())?.media.get(mediaKey(decisionId, media.id)) !== "held") return null;
    const path = this.mediaPath(decisionId, media.id);
    const st = await lstat(path).catch(() => null);
    if (st === null || !st.isFile() || st.size !== media.bytes) return null;
    const bytes = new Uint8Array(await readFile(path).catch(() => Buffer.alloc(0)));
    return bytes.length === media.bytes && hillImageMime(bytes) === media.mime ? bytes : null;
  }

  /** How many open Decisions the copy holds, for the standby page. */
  async openCount(): Promise<number> {
    return (await this.load())?.decisions.length ?? 0;
  }

  /**
   * Run one write after every write before it (review 7 R5): a list, a part, a state, a picture, a
   * reconcile. A takeover's {@link hold} waits for the write that runs, and every write after it finds the
   * copy held.
   */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Whether a takeover holds the copy now: then it takes nothing from the lead (§25). */
  held(): boolean {
    return this.holdDepth > 0;
  }

  /**
   * Hold the copy against a role change and the lead's writes while the person's tap adopts it. Every write
   * from now on finds it held; the answer comes once the write that ran when it was asked has ended.
   */
  async hold(): Promise<() => void> {
    this.holdDepth += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.holdDepth -= 1;
    };
    await this.writes;
    return release;
  }

  async clear(): Promise<void> {
    await removeTree(this.dir);
    this.cached = null;
    this.loaded = true;
  }

  /** Clear the copy when it is not this machine's any more: the tricks copy's own rule. */
  reconcile(role: CopyRole): Promise<boolean> {
    return this.serial(() => this.reconcileNow(role));
  }

  private async reconcileNow(role: CopyRole): Promise<boolean> {
    if (this.holdDepth > 0) return false;
    const index = await this.load();
    const present = index !== null || (await lstat(this.dir).catch(() => null)) !== null;
    if (!present) return false;
    if (index !== null && tricksCopyKept(index, role)) return false;
    if (index === null && role.deputy && !role.leads) return false;
    await this.clear();
    return true;
  }
}

async function names(dir: string): Promise<string[]> {
  return await readdir(dir).catch(() => []);
}

async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
