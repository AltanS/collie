import { redactText } from "../redact.ts";
import {
  partKey,
  PROBLEM_MAX,
  type ModsReply,
  type ParsedModDocument,
  type WireModInfo,
  type WireModPart,
} from "../../web/src/lib/mods/schema.ts";

// THE PARTS, KEYED BY (host, mod, part), EACH WITH A REV (M94 slice 01, design §4 rule 5).
//
// One counter per bridge. Every change takes the next number: a part's value, its `asOf`, its stale
// flag or problem, a part going away, and any change to a mod's entry in the list (its switch, state,
// error or refusals). The counter's value is `modsRev` on the snapshot; the phone asks
// `GET /api/mods?since=<the rev it holds>` and gets the parts whose rev is above it plus every key now
// present, so a part that went away is the key it holds and the list lacks.
//
// The counter STARTS at the bridge's start time in ms, not at 0. A phone that held rev 57 from the
// bridge before a restart would otherwise ask `since=57` of a bridge at rev 12 and miss parts 1 to 12;
// with a clock base every rev of the new process is above every rev of the old one. A `since` above
// the counter (a clock that went back) is answered with every part.
//
// Last good per part: a part the new document refused, or every part of a run that failed, keeps its
// last accepted value and is marked `stale` with one masked line of why.

/** A line masked (again: the mask is idempotent) and cut to the wire's problem cap. */
export function problemLine(text: string): string {
  const flat = redactText(text).replace(/[\p{Cc}]/gu, " ").trim();
  return flat.length > PROBLEM_MAX ? `${flat.slice(0, PROBLEM_MAX - 1)}…` : flat;
}

/** What rides with the accepted parts of one document. */
export interface DocumentStamp {
  asOf: string;
  fresh: string;
}

function sameJson(a: WireModPart | WireModInfo | undefined, b: WireModPart | WireModInfo): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** One mod's parts changed since a rev, and every key it has now. */
export interface ModPartsSince {
  parts: WireModPart[];
  present: string[];
}

export class ModsStore {
  private counter: number;
  private readonly parts = new Map<string, WireModPart>();
  private readonly infos = new Map<string, WireModInfo>();

  constructor(base: number) {
    this.counter = base;
  }

  /** `modsRev`: the rev of the newest change. */
  get rev(): number {
    return this.counter;
  }

  private next(): number {
    this.counter += 1;
    return this.counter;
  }

  /** Put a part, taking a new rev only when something but the rev changed. True when it changed. */
  private put(wire: Omit<WireModPart, "rev">): boolean {
    const key = partKey(wire);
    const old = this.parts.get(key);
    if (old !== undefined && sameJson({ ...old, rev: 0 }, { ...wire, rev: 0 })) return false;
    this.parts.set(key, { ...wire, rev: this.next() });
    return true;
  }

  /** The keys of one mod's stored parts. */
  private keysOf(host: string, mod: string): string[] {
    return [...this.parts.values()].filter((p) => p.host === host && p.mod === mod).map((p) => partKey(p));
  }

  /**
   * Store the result of a document that parsed (`documentRefused` false). Accepted parts replace their
   * old value, refused parts keep theirs stale, and a part the document no longer has goes away.
   */
  applyDocument(host: string, mod: string, parsed: ParsedModDocument, stamp: DocumentStamp): void {
    const keep = new Set<string>();
    for (const accepted of parsed.parts) {
      const part = accepted.part.id;
      keep.add(partKey({ host, mod, part }));
      this.put({ host, mod, part, value: accepted.part, asOf: stamp.asOf, fresh: stamp.fresh });
    }
    for (const part of parsed.refusedParts) {
      const key = partKey({ host, mod, part });
      const old = this.parts.get(key);
      if (old === undefined) continue;
      keep.add(key);
      const why = parsed.refusals.find((r) => r.part === part)?.reason ?? "This part was refused.";
      const { rev: _rev, ...rest } = old;
      this.put({ ...rest, stale: true, problem: problemLine(why) });
    }
    for (const key of this.keysOf(host, mod)) {
      if (keep.has(key)) continue;
      this.parts.delete(key);
      this.next();
    }
  }

  /** A run failed or its document was refused whole: every part of the mod stays, stale. */
  markStale(host: string, mod: string, problem: string): void {
    for (const key of this.keysOf(host, mod)) {
      const old = this.parts.get(key);
      if (old === undefined) continue;
      const { rev: _rev, ...rest } = old;
      this.put({ ...rest, stale: true, problem: problemLine(problem) });
    }
  }

  /** Drop every part of a mod (switched off, folder gone). */
  dropParts(host: string, mod: string): void {
    const keys = this.keysOf(host, mod);
    for (const key of keys) this.parts.delete(key);
    if (keys.length > 0) this.next();
  }

  /** Set a mod's entry in the list. Takes a rev only when it changed. */
  setInfo(info: WireModInfo): void {
    if (sameJson(this.infos.get(info.id), info)) return;
    this.infos.set(info.id, info);
    this.next();
  }

  /** Forget a mod whose folder is gone, with its parts. */
  removeMod(host: string, id: string): void {
    this.dropParts(host, id);
    if (this.infos.delete(id)) this.next();
  }

  /** The mod ids the list holds. */
  modIds(): string[] {
    return [...this.infos.keys()];
  }

  /** One mod's parts with a rev above `since`, and every key it has now. */
  modParts(host: string, mod: string, since: number): ModPartsSince {
    const mine = [...this.parts.values()].filter((p) => p.host === host && p.mod === mod);
    return { parts: mine.filter((p) => p.rev > since), present: mine.map((p) => partKey(p)) };
  }

  /** `GET /api/mods?since=`: the changed parts, the keys present, the list. Absent or a future `since` is everything. */
  reply(since: number | undefined, path?: string): ModsReply {
    const from = since === undefined || since > this.counter ? -Infinity : since;
    const all = [...this.parts.values()];
    const out: ModsReply = {
      rev: this.counter,
      mods: [...this.infos.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      parts: all.filter((p) => p.rev > from),
      present: all.map((p) => partKey(p)),
    };
    if (path !== undefined) out.path = path;
    return out;
  }
}
