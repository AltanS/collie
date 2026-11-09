import { redactText } from "../redact.ts";
import {
  partKey,
  PROBLEM_MAX,
  type TricksReply,
  type ParsedTrickDocument,
  type WireTrickInfo,
  type WireTrickPart,
} from "../../web/src/lib/tricks/schema.ts";

// THE PARTS, KEYED BY (memberId, trick, part), EACH WITH A REV (M94 slice 01, design §4 rule 5).
//
// The member id is this bridge's stable id (bridge/bridge-id.ts), resolved once at boot: the crew
// member id, or the install id on a solo install. Never the host name, so a host rename or a crew join
// orphans no part. It rides the wire in the part's `host` field (schema.ts `TrickPartKey`), a name kept
// from slice 1 so the phone's part keys need no change; the value is the member id.
//
// One counter per bridge. Every change takes the next number: a part's value, its `asOf`, its stale
// flag or problem, a part going away, and any change to a trick's entry in the list (its switch, state,
// error or refusals). The counter's value is `tricksRev` on the snapshot; the phone asks
// `GET /api/tricks?since=<the rev it holds>` and gets the parts whose rev is above it plus every key now
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

function sameJson(a: WireTrickPart | WireTrickInfo | undefined, b: WireTrickPart | WireTrickInfo): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** One trick's parts changed since a rev, and every key it has now. */
export interface TrickPartsSince {
  parts: WireTrickPart[];
  present: string[];
}

export class TricksStore {
  private counter: number;
  private readonly parts = new Map<string, WireTrickPart>();
  private readonly infos = new Map<string, WireTrickInfo>();

  constructor(base: number) {
    this.counter = base;
  }

  /** `tricksRev`: the rev of the newest change. */
  get rev(): number {
    return this.counter;
  }

  private next(): number {
    this.counter += 1;
    return this.counter;
  }

  /** Put a part, taking a new rev only when something but the rev changed. True when it changed. */
  private put(wire: Omit<WireTrickPart, "rev">): boolean {
    const key = partKey(wire);
    const old = this.parts.get(key);
    if (old !== undefined && sameJson({ ...old, rev: 0 }, { ...wire, rev: 0 })) return false;
    this.parts.set(key, { ...wire, rev: this.next() });
    return true;
  }

  /** The keys of one trick's stored parts. */
  private keysOf(memberId: string, trick: string): string[] {
    return [...this.parts.values()].filter((p) => p.host === memberId && p.trick === trick).map((p) => partKey(p));
  }

  /**
   * Store the result of a document that parsed (`documentRefused` false). Accepted parts replace their
   * old value, refused parts keep theirs stale, and a part the document no longer has goes away.
   */
  applyDocument(memberId: string, trick: string, parsed: ParsedTrickDocument, stamp: DocumentStamp): void {
    const keep = new Set<string>();
    for (const accepted of parsed.parts) {
      const part = accepted.part.id;
      keep.add(partKey({ host: memberId, trick, part }));
      this.put({ host: memberId, trick, part, value: accepted.part, asOf: stamp.asOf, fresh: stamp.fresh });
    }
    for (const part of parsed.refusedParts) {
      const key = partKey({ host: memberId, trick, part });
      const old = this.parts.get(key);
      if (old === undefined) continue;
      keep.add(key);
      const why = parsed.refusals.find((r) => r.part === part)?.reason ?? "This part was refused.";
      const { rev: _rev, ...rest } = old;
      this.put({ ...rest, stale: true, problem: problemLine(why) });
    }
    for (const key of this.keysOf(memberId, trick)) {
      if (keep.has(key)) continue;
      this.parts.delete(key);
      this.next();
    }
  }

  /** A run failed or its document was refused whole: every part of the trick stays, stale. */
  markStale(memberId: string, trick: string, problem: string): void {
    for (const key of this.keysOf(memberId, trick)) {
      const old = this.parts.get(key);
      if (old === undefined) continue;
      const { rev: _rev, ...rest } = old;
      this.put({ ...rest, stale: true, problem: problemLine(problem) });
    }
  }

  /** Drop every part of a trick (switched off, folder gone). */
  dropParts(memberId: string, trick: string): void {
    const keys = this.keysOf(memberId, trick);
    for (const key of keys) this.parts.delete(key);
    if (keys.length > 0) this.next();
  }

  /** Set a trick's entry in the list. Takes a rev only when it changed. */
  setInfo(info: WireTrickInfo): void {
    if (sameJson(this.infos.get(info.id), info)) return;
    this.infos.set(info.id, info);
    this.next();
  }

  /** Forget a trick whose folder is gone, with its parts. */
  removeTrick(memberId: string, id: string): void {
    this.dropParts(memberId, id);
    if (this.infos.delete(id)) this.next();
  }

  /** The trick ids the list holds. */
  trickIds(): string[] {
    return [...this.infos.keys()];
  }

  /** One trick's parts with a rev above `since`, and every key it has now. */
  trickParts(memberId: string, trick: string, since: number): TrickPartsSince {
    const mine = [...this.parts.values()].filter((p) => p.host === memberId && p.trick === trick);
    return { parts: mine.filter((p) => p.rev > since), present: mine.map((p) => partKey(p)) };
  }

  /** `GET /api/tricks?since=`: the changed parts, the keys present, the list. Absent or a future `since` is everything. */
  reply(since: number | undefined, path?: string): TricksReply {
    const from = since === undefined || since > this.counter ? -Infinity : since;
    const all = [...this.parts.values()];
    const out: TricksReply = {
      rev: this.counter,
      tricks: [...this.infos.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      parts: all.filter((p) => p.rev > from),
      present: all.map((p) => partKey(p)),
    };
    if (path !== undefined) out.path = path;
    return out;
  }
}
