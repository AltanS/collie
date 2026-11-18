import { bindingAgainst, type GenerationOf } from "./bound.ts";
import { redactText } from "../redact.ts";
import {
  partKey,
  PROBLEM_MAX,
  type TrickPart,
  type TrickPartKey,
  type TricksReply,
  type TricksRunsOn,
  type ParsedTrickDocument,
  type WireBound,
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
//
// A bound part (contract 2, bound.ts) carries `bound`, the sessions and instance tokens it is drawn in.
// It is sent only to a phone that asks for bound parts (`?bound=1`): an older phone reads no `bound` and
// would draw the part in every session. A change of `bound` moves the part's drawn rev like its value.

/** A line masked (again: the mask is idempotent) and cut to the wire's problem cap. */
export function problemLine(text: string): string {
  const flat = redactText(text).replace(/[\p{Cc}]/gu, " ").trim();
  return flat.length > PROBLEM_MAX ? `${flat.slice(0, PROBLEM_MAX - 1)}…` : flat;
}

/** What rides with the accepted parts of one document. */
/**
 * What `GET /api/tricks` adds for the host's own CLI and for nobody else: the runner's PATH, which
 * `collie doctor` prints. It is not in the phone's {@link TricksReply}, and the bridge sets it only
 * on a request from the local CLI (`isLocalRequest`, bridge/server.ts).
 */
export interface CliTricksExtra {
  path?: string;
}

export interface DocumentStamp {
  asOf: string;
  fresh: string;
}

function sameJson(a: WireTrickPart | WireTrickInfo | undefined, b: WireTrickPart | WireTrickInfo): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** The places where a trick shows one part (per session, for a bound one): every place but its pages. */
const ONE_PART_PLACES: ReadonlySet<string> = new Set(["belt", "menu", "status", "dashboard", "tabbar"]);

/**
 * The slots a part fills (review 12 M2): an unbound part of a one-part place fills the place, a bound one
 * fills the place in each session it is bound to, and a page fills none. Two parts of a trick in one slot
 * would both draw, so a refused part kept stale never shares a slot with one drawn now.
 */
function slotsOf(value: TrickPart, bound: readonly WireBound[] | undefined): string[] {
  // A float part fills the slot of its mode: a trick has one picture that stays and one that plays once, for every session.
  const at = value.at === "float" ? `float-${value.mode}` : value.at;
  if (value.at !== "float" && !ONE_PART_PLACES.has(at)) return [];
  return bound === undefined ? [at] : bound.map((entry) => `${at}@${entry.session}`);
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
  /**
   * The rev at which each part's VALUE (what the phone draws and taps) last changed (fault A). A new
   * `asOf`, a stale flag or a problem line moves the part's rev but not this one, so a tap sent from any
   * rev from here up to the part's rev was sent from what the part draws now.
   */
  private readonly drawnAt = new Map<string, number>();
  /**
   * Bridge only, never on the wire: each bound part's sessions with the pane's generation when the run's
   * facts were read (bound.ts, the binding generation). A session's generation null: checked by its token.
   */
  private readonly generations = new Map<string, Map<string, string | null>>();

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
    const rev = this.next();
    if (old === undefined || JSON.stringify(old.value) !== JSON.stringify(wire.value) || JSON.stringify(old.bound) !== JSON.stringify(wire.bound)) this.drawnAt.set(key, rev);
    this.parts.set(key, { ...wire, rev });
    return true;
  }

  /**
   * One stored part, and whether a phone that drew it at `rev` drew what it holds now (fault A): `rev`
   * lies between the rev its value last changed at and its own rev. Undefined when the part is not held.
   */
  held(key: TrickPartKey): { part: WireTrickPart; shows: (rev: number) => boolean } | undefined {
    const id = partKey(key);
    const part = this.parts.get(id);
    if (part === undefined) return undefined;
    const from = this.drawnAt.get(id) ?? part.rev;
    return { part, shows: (rev) => rev >= from && rev <= part.rev };
  }

  /** The keys of one trick's stored parts. */
  private keysOf(memberId: string, trick: string): string[] {
    return [...this.parts.values()].filter((p) => p.host === memberId && p.trick === trick).map((p) => partKey(p));
  }

  /**
   * Store the result of a document that parsed (`documentRefused` false). Accepted parts replace their
   * old value, refused parts keep theirs stale, and a part the document no longer has goes away. A refused
   * part whose slot an accepted part (or a stale one before it) took goes away too (review 12 M2).
   */
  applyDocument(memberId: string, trick: string, parsed: ParsedTrickDocument, stamp: DocumentStamp, bound?: ReadonlyMap<string, WireBound[]>, generations?: ReadonlyMap<string, string | null>): void {
    const keep = new Set<string>();
    const taken = new Set<string>();
    for (const accepted of parsed.parts) {
      const part = accepted.part.id;
      keep.add(partKey({ host: memberId, trick, part }));
      const sessions = bound?.get(part);
      for (const slot of slotsOf(accepted.part, sessions)) taken.add(slot);
      const wire: Omit<WireTrickPart, "rev"> = { host: memberId, trick, part, value: accepted.part, asOf: stamp.asOf, fresh: stamp.fresh };
      if (sessions !== undefined) wire.bound = sessions;
      this.put(wire);
      const key = partKey(wire);
      if (sessions === undefined) this.generations.delete(key);
      else this.generations.set(key, new Map(sessions.map((entry) => [entry.session, generations?.get(entry.session) ?? null])));
    }
    for (const part of parsed.refusedParts) {
      const key = partKey({ host: memberId, trick, part });
      const old = this.parts.get(key);
      if (old === undefined) continue;
      const slots = slotsOf(old.value, old.bound);
      if (slots.some((slot) => taken.has(slot))) continue;
      for (const slot of slots) taken.add(slot);
      keep.add(key);
      const why = parsed.refusals.find((r) => r.part === part)?.reason ?? "This part was refused.";
      const { rev: _rev, ...rest } = old;
      this.put({ ...rest, stale: true, problem: problemLine(why) });
    }
    for (const key of this.keysOf(memberId, trick)) {
      if (keep.has(key)) continue;
      this.forget(key);
      this.next();
    }
  }

  private forget(key: string): void {
    this.parts.delete(key);
    this.drawnAt.delete(key);
    this.generations.delete(key);
  }

  /** The generation a bound part's session was bound at, or null (no generation, or not bound there). */
  generationAt(key: string, session: string): string | null {
    return this.generations.get(key)?.get(session) ?? null;
  }

  /**
   * Hold every binding to its pane's generation now (bound.ts `bindingAgainst`): a session whose pane holds
   * another conversation for sure leaves the part, and a part with no session left goes, each with a rev,
   * so the phone loses the row. A session named since by the same agent is learned. Unsure changes nothing.
   */
  rebind(generationOf: GenerationOf): void {
    for (const [key, sessions] of this.generations) {
      const part = this.parts.get(key);
      if (part?.bound === undefined) continue;
      const gone = new Set<string>();
      for (const [session, held] of sessions) {
        const now = generationOf(session);
        const verdict = bindingAgainst(held, now);
        if (verdict === "changed") gone.add(session);
        else if (verdict === "same" && held !== null && now !== null && bindingAgainst(now, held) === "unsure") sessions.set(session, now);
      }
      if (gone.size === 0) continue;
      for (const session of gone) sessions.delete(session);
      const left = part.bound.filter((entry) => !gone.has(entry.session));
      if (left.length === 0) {
        this.forget(key);
        this.next();
        continue;
      }
      const { rev: _rev, ...rest } = part;
      this.put({ ...rest, bound: left });
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
    for (const key of keys) this.forget(key);
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

  /** Whether the part under a key is bound (carries `bound`), so a phone that did not ask for bound parts never hears of it. */
  isBound(key: string): boolean {
    return this.parts.get(key)?.bound !== undefined;
  }

  /** One trick's parts with a rev above `since`, and every key it has now. */
  trickParts(memberId: string, trick: string, since: number): TrickPartsSince {
    const mine = [...this.parts.values()].filter((p) => p.host === memberId && p.trick === trick);
    return { parts: mine.filter((p) => p.rev > since), present: mine.map((p) => partKey(p)) };
  }

  /**
   * `GET /api/tricks?since=`: the changed parts, the keys present, the list. Absent or a future `since` is
   * everything. A bound part and its key only with `bound` (the phone asked `?bound=1`).
   */
  reply(since: number | undefined, path?: string, runsOn?: TricksRunsOn | null, opts?: { readonly bound?: boolean }): TricksReply & CliTricksExtra {
    const from = since === undefined || since > this.counter ? -Infinity : since;
    const all = [...this.parts.values()].filter((p) => opts?.bound === true || p.bound === undefined);
    const out: TricksReply & CliTricksExtra = {
      rev: this.counter,
      tricks: [...this.infos.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      parts: all.filter((p) => p.rev > from),
      present: all.map((p) => partKey(p)),
    };
    if (path !== undefined) out.path = path;
    if (runsOn !== undefined && runsOn !== null) out.runsOn = runsOn;
    return out;
  }
}
