import { randomBytes } from "node:crypto";

import type { AuditEntry } from "./audit.ts";
import type { GateLevel } from "./crew/peer-gate.ts";
import type { JsonValue } from "./json.ts";
import { asJsonBoolean, asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import { createPairLimiter, type PairLimiter } from "./pair-limit.ts";
import {
  pairApproveAuditEntry,
  pairRequestAuditEntry,
  pairRequestRefusedAuditEntry,
  type PairRoute,
} from "./pair-audit.ts";
import { CODE_ALPHABET, hashesEqual, normalizeLabel, RegistryUnreadableError, sha256Hex } from "./pairing.ts";

// ── PAIR A NEW DEVICE BY A REQUEST A PAIRED PHONE APPROVES (ADR 0139) ─────────────────────────
//
// The second way to pair, beside `collie pair`. An unpaired browser asks the bridge for a request and
// shows a QR code, a 6-character code and a countdown. A browser that already holds a paired device
// token opens the QR's link, `/pair/approve?r=<publicId>`, and sees three codes. Exactly one is the
// code on the new device's screen. A tap on it enrols the new device through the same store function
// a `collie pair` claim uses (`PairingStore.enrolApproved`), and the new device collects its token on
// its next poll, once. A wrong tap, or "Not my device", ends the request for good.
//
// ── WHY THREE CODES AND NO "YES" ─────────────────────────────────────────────────────────────
// The link alone proves nothing: anybody can make a request and send its link to the operator. The
// tap on the right code proves the person holding the paired phone can see the other screen. A wrong
// tap is final, so a stranger's request survives a guess one time in three, and then only if the
// operator taps at all.
//
// ── WHAT IS HELD, AND WHERE ─────────────────────────────────────────────────────────────────
// Everything here is IN MEMORY. A bridge restart drops every request; the new device then sees its
// request gone and offers a new code. Three secrets, three rules:
//   • `publicId` (128 bit) is in the QR. It names the request to the approver and grants nothing alone.
//   • `pollSecret` (128 bit) is only in the answer to the request's creator. The bridge keeps its hash.
//     It is compared in constant time, and a wrong or missing one reads exactly like an unknown id.
//   • the token, minted on the right tap, waits here until the first poll with the right secret,
//     then the request is deleted. A request whose token was never collected is revoked by the sweep.
// None of the three, and not the code, is ever passed to an audit builder or a log line.
//
// ── WHO MAY DO WHAT ──────────────────────────────────────────────────────────────────────────
// Creating a request and polling it are open (no token): the asking browser holds none. Both still
// pass `checkAccess` in server.ts (the same `Origin` rule as `POST /api/pair`). Reading a request as an
// approver and answering it need a paired device token, through `guard` at the levels
// {@link pairApproveGateLevel} names: the host's local read credential, an unpaired browser, a
// header-allowlisted device with no token and a crew forward (which never carries a token) are all
// refused there. A crew member (`mode: peer`) serves no browser door and answers 404 to all four.

/** How long a request waits for the approver's tap. */
export const REQUEST_TTL_MS = 2 * 60 * 1000;
/** After an approval, how long the new device has at least to collect its token. */
export const COLLECT_GRACE_MS = 30 * 1000;
/** How long an ended request stays as a bare tombstone, so the poller learns how it ended. */
export const TOMBSTONE_MS = 2 * 60 * 1000;
/** The most tombstones kept; the oldest go first. */
export const MAX_TOMBSTONES = 64;
/** Open requests (waiting, or approved and not yet collected) across all sources. */
export const MAX_OPEN_REQUESTS = 3;
/** Requests one source address may create inside {@link REQUEST_SOURCE_WINDOW_MS}. */
export const REQUESTS_PER_SOURCE = 6;
/** The per-source window. Also the window of the global cap and of the global refusal's audit line. */
export const REQUEST_SOURCE_WINDOW_MS = 10 * 60 * 1000;
/**
 * Requests the bridge makes in one window, whatever the source. 30 is five sources at their own cap of
 * six, far above what a person pairing a few browsers needs, and low enough that a spray of sources
 * (an IPv6 range, a botnet behind an open door) makes at most three a minute: three audit lines and
 * three small entries a minute, not an unbounded stream.
 */
export const REQUESTS_PER_WINDOW = 30;
/** How long past its expiry a request may stay `answering` (an enrol that hangs) before the sweep ends it. */
export const ANSWER_MARGIN_MS = 30 * 1000;
/** The code on the new device's screen is this many characters of `CODE_ALPHABET`. */
export const REQUEST_CODE_LENGTH = 6;
/** A decoy differs from the real code, and from the other decoy, in at least this many positions. */
export const DECOY_MIN_DISTANCE = 3;
/** The header that carries the poll secret. Never a query parameter: a URL lands in logs. */
export const POLL_HEADER = "x-collie-pair-poll";

/** A request id or poll secret: 16 random bytes, base64url, 22 characters. */
const SECRET_FORM = /^[A-Za-z0-9_-]{22}$/;
/** Compared against when the id is unknown, so a miss costs the same compare as a hit. */
const DUMMY_HASH = sha256Hex("collie-pair-request-dummy");

/** The level `guard` asks of the approver: a read of the request is a `device-read`, an answer a `write`. */
export function pairApproveGateLevel(method: string): GateLevel {
  // A same-origin GET carries no `Origin`, so it cannot meet the write level's Origin rule; `device-read`
  // asks the same device factors (pairing token AND the header gate) with the read's access rule.
  return method === "GET" ? "device-read" : "write";
}

/**
 * The key a request is counted and replaced under: the `/api/pair` source key, with an IPv6 address cut
 * to its /64. One host commonly holds a whole /64, so a per-address key would let it walk past the cap
 * by changing the low 64 bits. An IPv4-mapped address, IPv4 and the bare `loopback` key pass unchanged.
 */
export function requestSourceKey(source: string): string {
  const address = source.split("%")[0]!.trim().toLowerCase();
  if (!address.includes(":") || !/^[0-9a-f:.]+$/.test(address)) return source;
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(address)) return address.slice(7);
  const halves = address.split("::");
  if (halves.length > 2) return source;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => "0"), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return source;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// ── What the bridge says about the asker ─────────────────────────────────────────────────────

/** The asking browser, as far as its User-Agent says: a family from a fixed list, never the raw string. */
export interface AskerInfo {
  readonly browser: string | null;
  readonly os: string | null;
}

const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bVivaldi\//, "Vivaldi"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|\bChrome\/|\bChromium\//, "Chrome"],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\bAndroid\b/, "Android"],
  [/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

/**
 * The browser and system family of a User-Agent, each a word from the two lists above or null. The
 * raw header never leaves this function: the approver sees one of a few known words, so a request
 * cannot put text of its own choosing on the approver's screen.
 */
export function askerFromUserAgent(ua: string | null): AskerInfo {
  const text = (ua ?? "").slice(0, 512);
  const pick = (table: readonly [RegExp, string][]): string | null => table.find(([re]) => re.test(text))?.[1] ?? null;
  let browser = pick(BROWSERS);
  if (browser === null && /\bSafari\//.test(text) && /\bVersion\//.test(text)) browser = "Safari";
  return { browser, os: pick(SYSTEMS) };
}

// ── The code and its two decoys ──────────────────────────────────────────────────────────────

/** How many positions two equal-length codes differ in. */
export function codeDistance(a: string, b: string): number {
  let d = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
  return d;
}

/** One code of {@link REQUEST_CODE_LENGTH} characters from the pairing alphabet (no look-alikes). */
function drawCode(random: (n: number) => Buffer): string {
  const bytes = random(REQUEST_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < REQUEST_CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/** The real code, and the three codes the approver picks from (the real one among them). */
export interface Choices {
  readonly code: string;
  readonly choices: [string, string, string];
}

/**
 * The real code and the three choices the approver sees, in an order fixed now. Each decoy is drawn at
 * random and kept only when it differs from the real code, and from the other decoy, in at least
 * {@link DECOY_MIN_DISTANCE} positions, so no choice is one slip of the eye from another.
 */
export function makeChoices(random: (n: number) => Buffer = randomBytes): Choices {
  const code = drawCode(random);
  const decoys: string[] = [];
  // Two random 6-character codes sit within distance 2 of each other about once in 2,000 draws, so
  // 200 tries fail only for a broken random source, and that is loud rather than a weak decoy.
  for (let tries = 0; decoys.length < 2; tries++) {
    if (tries >= 200) throw new Error("pair-request: could not draw decoys");
    const decoy = drawCode(random);
    if ([code, ...decoys].every((other) => codeDistance(decoy, other) >= DECOY_MIN_DISTANCE)) decoys.push(decoy);
  }
  const choices: [string, string, string] = [code, decoys[0]!, decoys[1]!];
  // Fisher-Yates over three, one byte per step. The bias of `% 3` and `% 2` on a byte is under 1%,
  // which tells a guesser nothing useful about where the real code sits.
  const order = random(2);
  for (let i = choices.length - 1; i > 0; i--) {
    const j = order[choices.length - 1 - i]! % (i + 1);
    const held = choices[i]!;
    choices[i] = choices[j]!;
    choices[j] = held;
  }
  return { code, choices };
}

// ── The book of requests ─────────────────────────────────────────────────────────────────────

type RequestState = "waiting" | "answering" | "approved" | "refused" | "expired";

interface Entry {
  readonly publicId: string;
  /** {@link requestSourceKey} of the browser that asked: one open request per source. */
  readonly source: string;
  readonly pollHash: string;
  readonly code: string;
  readonly choices: readonly [string, string, string];
  readonly asker: AskerInfo;
  readonly route: PairRoute;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: RequestState;
  /** Held from the right tap to the first poll. Never logged, never in an audit line. */
  token?: string;
  /** The token's hash, for a revoke of a device nobody collected (by credential, never by label). */
  tokenHash?: string;
  label?: string;
  /** Approved: the token must be collected by then, or the sweep revokes the device. */
  collectBy?: number;
  /** A final state: when it ended, for the tombstone's lifetime. */
  endedAt?: number;
}

/** A refusal at the door: how long until a try counts again, and whether to write the audit line. */
export interface RateRefusal {
  readonly ok: false;
  readonly retryAfterMs: number;
  /** First refusal of its burst (one source) or of its window (the global caps): audit it once. */
  readonly audit: boolean;
}

/** What {@link PairRequestBook.create} answers. */
export type CreateOutcome =
  | {
      ok: true;
      publicId: string;
      pollSecret: string;
      code: string;
      expiresAt: number;
      /** This source's earlier requests that the new one replaced (one open request per source). */
      replaced: number;
      /** Token hashes of devices approved for a replaced request and never collected: revoke them. */
      revoke: readonly string[];
    }
  | RateRefusal;

/** What {@link PairRequestBook.cancel} did: null for an unknown id or a wrong secret. */
export interface CancelOutcome {
  /** The request was still open, so its end is worth an audit line. */
  readonly wasOpen: boolean;
  /** The hash of a token approved and never collected, to revoke. */
  readonly revoke: string | null;
}

/** What {@link PairRequestBook.sweep} found: requests that ran out, and approved devices nobody collected. */
export interface SweepResult {
  readonly expired: number;
  /** Token hashes of approved devices nobody collected. */
  readonly uncollected: readonly string[];
}

/** The in-memory request store. Pure apart from its clock and random source, which are injected. */
export class PairRequestBook {
  private readonly entries = new Map<string, Entry>();
  private readonly limiter: PairLimiter;
  /** When each request of the last window was made, for {@link REQUESTS_PER_WINDOW}. */
  private creations: number[] = [];
  /** When the last global refusal was audited: one line per window, however many refusals. */
  private lastGlobalAuditAt: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Buffer = randomBytes,
    limiter?: PairLimiter,
    /** {@link REQUESTS_PER_WINDOW}; a test that is about another bound lifts it. */
    private readonly perWindow: number = REQUESTS_PER_WINDOW,
  ) {
    this.limiter = limiter ?? createPairLimiter(REQUESTS_PER_SOURCE, REQUEST_SOURCE_WINDOW_MS);
  }

  /** Requests still open: waiting or being answered, or approved with the token not yet collected. */
  openCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (isOpen(e)) n++;
    return n;
  }

  /** How many entries are held, tombstones included (for the bound test). */
  size(): number {
    return this.entries.size;
  }

  /**
   * End what ran out: a waiting request past its expiry becomes an `expired` tombstone, an approved one
   * whose token nobody collected by `collectBy` becomes one too and its label is handed back to revoke,
   * and a tombstone past {@link TOMBSTONE_MS} is dropped. Call before every read of the book.
   */
  sweep(): SweepResult {
    const now = this.now();
    let expired = 0;
    const uncollected: string[] = [];
    for (const [id, e] of this.entries) {
      if (e.state === "waiting" && now >= e.expiresAt) {
        end(e, "expired", now);
        expired++;
        continue;
      }
      // An enrol that hangs past the request's life (a registry write that never returns) does not
      // keep its place for ever: the request ends, and a late approve finds it gone (`approve`).
      if (e.state === "answering" && now >= e.expiresAt + ANSWER_MARGIN_MS) {
        end(e, "expired", now);
        expired++;
        continue;
      }
      if (e.state === "approved" && e.collectBy !== undefined && now >= e.collectBy) {
        if (e.tokenHash !== undefined) uncollected.push(e.tokenHash);
        end(e, "expired", now);
        continue;
      }
      if (e.endedAt !== undefined && now - e.endedAt >= TOMBSTONE_MS) this.entries.delete(id);
    }
    // Bound the tombstones, oldest first (a Map keeps insertion order).
    let tombstones = [...this.entries.values()].filter((e) => e.endedAt !== undefined).length;
    for (const [id, e] of this.entries) {
      if (tombstones <= MAX_TOMBSTONES) break;
      if (e.endedAt === undefined) continue;
      this.entries.delete(id);
      tombstones--;
    }
    return { expired, uncollected };
  }

  /**
   * Count one try from `source` against its own cap, {@link REQUESTS_PER_SOURCE} in the window, keyed by
   * {@link requestSourceKey}. Every try counts, a refused one and one with nobody to approve it too, so a
   * flood from one source stops here.
   */
  admit(source: string): { ok: true } | RateRefusal {
    const hit = this.limiter.hit(requestSourceKey(source), this.now());
    if (hit.allowed) return { ok: true };
    return { ok: false, retryAfterMs: hit.retryAfterMs ?? REQUEST_SOURCE_WINDOW_MS, audit: hit.first };
  }

  /**
   * Make a request for a browser at `source`, or say why not: {@link REQUESTS_PER_WINDOW} made in the
   * window whatever the source, or {@link MAX_OPEN_REQUESTS} open already. A new request replaces the
   * same source's open one first (one per source), so a browser that asks again never fills the cap
   * with its own old codes. A request being answered right now is left to its answer.
   */
  create(args: { source: string; route: PairRoute; asker: AskerInfo }): CreateOutcome {
    const now = this.now();
    const source = requestSourceKey(args.source);
    this.creations = this.creations.filter((t) => now - t < REQUEST_SOURCE_WINDOW_MS);
    if (this.creations.length >= this.perWindow) {
      return this.globalRefusal(now, this.creations[0]! + REQUEST_SOURCE_WINDOW_MS - now);
    }
    let replaced = 0;
    const revoke: string[] = [];
    for (const e of this.entries.values()) {
      if (e.source !== source) continue;
      if (e.state === "waiting") {
        end(e, "expired", now);
        replaced++;
      } else if (e.state === "approved") {
        if (e.tokenHash !== undefined) revoke.push(e.tokenHash);
        end(e, "expired", now);
        replaced++;
      }
    }
    if (this.openCount() >= MAX_OPEN_REQUESTS) {
      // The soonest open request to end frees a place.
      const soonest = Math.min(...[...this.entries.values()].filter(isOpen).map((e) => e.collectBy ?? e.expiresAt));
      return this.globalRefusal(now, soonest - now);
    }
    const publicId = this.random(16).toString("base64url");
    const pollSecret = this.random(16).toString("base64url");
    const { code, choices } = makeChoices(this.random);
    const expiresAt = now + REQUEST_TTL_MS;
    this.entries.set(publicId, {
      publicId,
      source,
      pollHash: sha256Hex(pollSecret),
      code,
      choices,
      asker: args.asker,
      route: args.route,
      createdAt: now,
      expiresAt,
      state: "waiting",
    });
    this.creations.push(now);
    return { ok: true, publicId, pollSecret, code, expiresAt, replaced, revoke };
  }

  /** A refusal by one of the two global caps, audited once per window. */
  private globalRefusal(now: number, retryAfterMs: number): RateRefusal {
    const audit = this.lastGlobalAuditAt === null || now - this.lastGlobalAuditAt >= REQUEST_SOURCE_WINDOW_MS;
    if (audit) this.lastGlobalAuditAt = now;
    return { ok: false, retryAfterMs: Math.max(1000, retryAfterMs), audit };
  }

  /**
   * The asking browser ends its own request (Cancel, or it left the page): null for an unknown id or a
   * wrong secret, after the same constant-time compare as {@link poll}. An open request ends; a device
   * approved for it and not yet collected is handed back to revoke.
   */
  cancel(publicId: string, secret: string | null): CancelOutcome | null {
    const e = this.matching(publicId, secret);
    if (e === null) return null;
    const now = this.now();
    if (e.state === "approved") {
      const revoke = e.tokenHash ?? null;
      end(e, "expired", now);
      return { wasOpen: true, revoke };
    }
    if (e.state === "waiting" || e.state === "answering") {
      end(e, "expired", now);
      return { wasOpen: true, revoke: null };
    }
    return { wasOpen: false, revoke: null };
  }

  /** The entry for `publicId` when `secret` is its poll secret, else null; constant time either way. */
  private matching(publicId: string, secret: string | null): Entry | null {
    const e = SECRET_FORM.test(publicId) ? this.entries.get(publicId) : undefined;
    const given = sha256Hex(secret ?? "");
    const match = hashesEqual(e?.pollHash ?? DUMMY_HASH, given);
    if (e === undefined || !match || secret === null || secret === "") return null;
    return e;
  }

  /**
   * The poller's view: null for an unknown id or a wrong secret (the same answer, after the same
   * constant-time compare), else the state. The approved state carries the token ONCE: the entry is
   * deleted in the same call, so the next poll is an unknown id.
   */
  poll(publicId: string, secret: string | null): PollView | null {
    const e = this.matching(publicId, secret);
    if (e === null) return null;
    const now = this.now();
    switch (e.state) {
      case "waiting":
      case "answering":
        return { state: "waiting", expiresInMs: Math.max(0, e.expiresAt - now) };
      case "approved": {
        const token = e.token;
        const label = e.label;
        this.entries.delete(publicId);
        if (token === undefined || label === undefined) return { state: "expired" };
        return { state: "approved", token, label };
      }
      case "refused":
        return { state: "refused" };
      case "expired":
        return { state: "expired" };
    }
  }

  /** What the approver's screen shows, or why it shows nothing. */
  approverView(publicId: string): ApproverView {
    const e = SECRET_FORM.test(publicId) ? this.entries.get(publicId) : undefined;
    if (e === undefined || e.state === "expired") return { kind: "gone" };
    if (e.state !== "waiting") return { kind: "answered" };
    return {
      kind: "open",
      asker: e.asker,
      route: e.route,
      choices: e.choices,
      expiresAt: e.expiresAt,
      expiresInMs: Math.max(0, e.expiresAt - this.now()),
    };
  }

  /**
   * Take the one answer a request gets. Synchronous, so two answers racing cannot both take it: the
   * first moves the request to `answering`, and the second sees `answered`.
   */
  take(publicId: string): { kind: "gone" } | { kind: "answered" } | { kind: "taken"; code: string; route: PairRoute } {
    const e = SECRET_FORM.test(publicId) ? this.entries.get(publicId) : undefined;
    if (e === undefined || e.state === "expired") return { kind: "gone" };
    if (e.state !== "waiting") return { kind: "answered" };
    if (this.now() >= e.expiresAt) {
      end(e, "expired", this.now());
      return { kind: "gone" };
    }
    e.state = "answering";
    return { kind: "taken", code: e.code, route: e.route };
  }

  /** The taken request ends refused: a wrong code, or "Not my device". Final. */
  refuse(publicId: string): void {
    const e = this.entries.get(publicId);
    if (e !== undefined) end(e, "refused", this.now());
  }

  /** The taken request could not be enrolled (the registry was unreadable): it waits again. */
  release(publicId: string): void {
    const e = this.entries.get(publicId);
    if (e !== undefined && e.state === "answering") e.state = "waiting";
  }

  /**
   * The taken request was enrolled: hold the token for the first poll. False when the request ended
   * while the enrol ran (cancelled, replaced, or swept past its margin): the caller then revokes the
   * device it just made, since no poll will ever collect it.
   */
  approve(publicId: string, token: string, label: string): boolean {
    const e = this.entries.get(publicId);
    if (e === undefined || e.state !== "answering") return false;
    e.state = "approved";
    e.token = token;
    e.tokenHash = sha256Hex(token);
    e.label = label;
    e.collectBy = Math.max(e.expiresAt, this.now() + COLLECT_GRACE_MS);
    return true;
  }
}

function isOpen(e: Entry): boolean {
  return e.state === "waiting" || e.state === "answering" || e.state === "approved";
}

/** Move an entry to a final state, keeping only what a tombstone needs: no code, no token. */
function end(e: Entry, state: "refused" | "expired", now: number): void {
  e.state = state;
  e.endedAt = now;
  delete e.token;
  delete e.tokenHash;
  delete e.label;
  delete e.collectBy;
}

/** The poller's answer. */
export type PollView =
  | { state: "waiting"; expiresInMs: number }
  | { state: "approved"; token: string; label: string }
  | { state: "refused" }
  | { state: "expired" };

/** The approver's answer. */
export type ApproverView =
  | { kind: "gone" }
  | { kind: "answered" }
  | {
      kind: "open";
      asker: AskerInfo;
      route: PairRoute;
      choices: readonly [string, string, string];
      expiresAt: number;
      expiresInMs: number;
    };

// ── The four routes, as pure handlers ────────────────────────────────────────────────────────
// server.ts matches the path, runs the access gate (`checkAccess` for the two open routes, `guard` at
// {@link pairApproveGateLevel} for the two approver routes), works out the source and the routes, and
// hands over here. These never see a socket, so `bun test` drives them with plain `Request`s.

/** What the routes need from the rest of the bridge. */
export interface PairRequestDeps {
  readonly book: PairRequestBook;
  /** Undefined when the bridge runs without a pairing store (a unit test's): every route then 503s. */
  readonly pairing:
    | {
        hasLiveDevice(): boolean;
        enrolApproved(label: string, expiresAt?: number): Promise<{ token: string; label: string }>;
      }
    | undefined;
  /**
   * Revoke the device holding the token with this hash (approved, never collected), through the same
   * path the device list's revoke takes, so its effects run once.
   */
  readonly revoke: (tokenHash: string) => Promise<void>;
  readonly audit: (entry: AuditEntry) => void;
  /** A crew member: it serves no browser door, so every route answers 404. */
  readonly isPeer: boolean;
}

const NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function answer(body: Record<string, JsonValue>, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...headers } });
}

const NOT_FOUND = (): Response => answer({ error: "not found" }, 404);
const UNAVAILABLE = (): Response =>
  new Response("pairing unavailable", { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });

/**
 * Run the sweep and act on it: one `pair-request-refused` line per request that ran out, and a revoke
 * (with its own audit line) per approved device that never collected its token. Every route runs it
 * first, and server.ts runs it on a timer, so an uncollected token does not outlive its window.
 */
export async function settlePairRequests(deps: PairRequestDeps): Promise<void> {
  const { expired, uncollected } = deps.book.sweep();
  for (let i = 0; i < expired; i++) deps.audit(pairRequestRefusedAuditEntry("expired"));
  for (const tokenHash of uncollected) {
    deps.audit(pairRequestRefusedAuditEntry("expired"));
    await revokeQuietly(deps, tokenHash);
  }
}

/** Revoke a device nobody holds the token of. A failure leaves it listed for the person to remove. */
async function revokeQuietly(deps: PairRequestDeps, tokenHash: string): Promise<void> {
  try {
    await deps.revoke(tokenHash);
  } catch (err) {
    console.warn(`[pair-request] could not revoke an uncollected device: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `POST /api/pair/request`: make a request, or say why not. */
export async function pairRequestCreateRoute(
  deps: PairRequestDeps,
  ctx: { readonly source: string; readonly route: PairRoute; readonly userAgent: string | null },
): Promise<Response> {
  if (deps.isPeer) return NOT_FOUND();
  if (deps.pairing === undefined) return UNAVAILABLE();
  await settlePairRequests(deps);
  // The source's cap first: every try counts, one with nobody to approve it too, so a script cannot
  // probe the bridge for free.
  const admitted = deps.book.admit(ctx.source);
  if (!admitted.ok) return rateAnswer(deps, admitted);
  let approver: boolean;
  try {
    approver = deps.pairing.hasLiveDevice();
  } catch (err) {
    if (err instanceof RegistryUnreadableError) return UNAVAILABLE();
    throw err;
  }
  if (!approver) return answer({ error: "no-approver" }, 409);
  const made = deps.book.create({ source: ctx.source, route: ctx.route, asker: askerFromUserAgent(ctx.userAgent) });
  if (!made.ok) return rateAnswer(deps, made);
  for (let i = 0; i < made.replaced; i++) deps.audit(pairRequestRefusedAuditEntry("replaced"));
  for (const tokenHash of made.revoke) await revokeQuietly(deps, tokenHash);
  deps.audit(pairRequestAuditEntry(ctx.route));
  return answer({
    publicId: made.publicId,
    pollSecret: made.pollSecret,
    code: made.code,
    expiresAt: made.expiresAt,
    expiresInMs: REQUEST_TTL_MS,
  });
}

function rateAnswer(deps: PairRequestDeps, refusal: RateRefusal): Response {
  if (refusal.audit) deps.audit(pairRequestRefusedAuditEntry("rate"));
  const seconds = Math.max(1, Math.ceil(refusal.retryAfterMs / 1000));
  return answer({ error: "rate-limited", retryAfter: seconds }, 429, { "retry-after": String(seconds) });
}

/**
 * `DELETE /api/pair/request/<publicId>` with the poll secret in {@link POLL_HEADER}: the asking browser
 * ends its own request (Cancel, or it left the page). A wrong secret is the same 404 as an unknown id.
 */
export async function pairRequestCancelRoute(deps: PairRequestDeps, publicId: string, secret: string | null): Promise<Response> {
  if (deps.isPeer) return NOT_FOUND();
  await settlePairRequests(deps);
  const done = deps.book.cancel(publicId, secret);
  if (done === null) return NOT_FOUND();
  if (done.wasOpen) deps.audit(pairRequestRefusedAuditEntry("cancelled"));
  if (done.revoke !== null) await revokeQuietly(deps, done.revoke);
  return answer({ state: "cancelled" });
}

/** `GET /api/pair/request/<publicId>` with the poll secret in {@link POLL_HEADER}. */
export async function pairRequestPollRoute(deps: PairRequestDeps, publicId: string, secret: string | null): Promise<Response> {
  if (deps.isPeer) return NOT_FOUND();
  await settlePairRequests(deps);
  const view = deps.book.poll(publicId, secret);
  if (view === null) return NOT_FOUND();
  return answer(view);
}

/** `GET /api/pair/approve/<publicId>`, behind the approver's gate. */
export async function pairApproveReadRoute(
  deps: PairRequestDeps,
  publicId: string,
  ctx: { readonly approverExpiresAt: number | undefined } = { approverExpiresAt: undefined },
): Promise<Response> {
  if (deps.isPeer) return NOT_FOUND();
  await settlePairRequests(deps);
  const view = deps.book.approverView(publicId);
  if (view.kind === "gone") return answer({ error: "gone" }, 404);
  if (view.kind === "answered") return answer({ error: "answered" }, 409);
  return answer({
    browser: view.asker.browser,
    os: view.asker.os,
    route: view.route.route,
    // Null when no front door on this machine passed a class on; JSON has no undefined.
    forwardedFrom: view.route.forwarded ?? null,
    choices: [...view.choices],
    expiresAt: view.expiresAt,
    expiresInMs: view.expiresInMs,
    // When the approver's own access ends, the new device's ends with it (ADR 0139). Null: no end.
    endsAt: ctx.approverExpiresAt ?? null,
  });
}

/** An approver's body, once it is one. */
export type ApproveBody = { kind: "refuse" } | { kind: "answer"; code: string; label: JsonValue | undefined };

/** Read an untrusted approve body: `{ refuse: true }`, or `{ code, label }`. Null when it is neither. */
export function parseApproveBody(body: JsonValue | undefined): ApproveBody | null {
  const fields = asJsonObject(body);
  if (fields === undefined) return null;
  if (asJsonBoolean(fields.refuse) === true) return { kind: "refuse" };
  const code = asJsonString(fields.code);
  if (code === undefined || code.length > 32) return null;
  return { kind: "answer", code, label: fields.label };
}

/** `POST /api/pair/approve/<publicId>`, behind the approver's gate. One answer per request. */
export async function pairApproveAnswerRoute(
  deps: PairRequestDeps,
  publicId: string,
  body: JsonValue | undefined,
  ctx: { readonly approver: string; readonly approverRoute: PairRoute; readonly approverExpiresAt?: number },
): Promise<Response> {
  if (deps.isPeer) return NOT_FOUND();
  if (deps.pairing === undefined) return UNAVAILABLE();
  await settlePairRequests(deps);
  const parsed = parseApproveBody(body);
  if (parsed === null) return answer({ error: "bad-request" }, 400);
  // A bad name is the approver's to fix, so it is checked before the request is taken: the request
  // keeps its one answer.
  const label = parsed.kind === "answer" ? normalizeLabel(parsed.label) : null;
  if (parsed.kind === "answer" && label === null) return answer({ error: "bad-label" }, 400);
  const taken = deps.book.take(publicId);
  if (taken.kind === "gone") return answer({ error: "gone" }, 404);
  if (taken.kind === "answered") return answer({ error: "answered" }, 409);
  if (parsed.kind === "refuse" || label === null) {
    deps.book.refuse(publicId);
    deps.audit(pairRequestRefusedAuditEntry("refused", ctx.approver));
    return answer({ state: "refused", reason: "refused" });
  }
  // Both sides hashed first, so the compare is constant-time and length-blind.
  if (!hashesEqual(sha256Hex(taken.code), sha256Hex(parsed.code.trim().toUpperCase()))) {
    deps.book.refuse(publicId);
    deps.audit(pairRequestRefusedAuditEntry("wrong-code", ctx.approver));
    return answer({ state: "refused", reason: "wrong-code" });
  }
  let enrolled: { token: string; label: string };
  try {
    // Never longer than the approver's own access: a device with an expiry cannot mint one without.
    enrolled = await deps.pairing.enrolApproved(label, ctx.approverExpiresAt);
  } catch (err) {
    // Nothing was written. The request waits again, so the approver can tap once more after the
    // outage; it still ends at its own expiry.
    deps.book.release(publicId);
    if (err instanceof RegistryUnreadableError) return UNAVAILABLE();
    throw err;
  }
  if (!deps.book.approve(publicId, enrolled.token, enrolled.label)) {
    // The request ended while the enrol ran (the asker cancelled or asked again, or the sweep ended a
    // hung answer): nobody will collect this token, so the device goes now.
    await revokeQuietly(deps, sha256Hex(enrolled.token));
    deps.audit(pairRequestRefusedAuditEntry("expired", ctx.approver));
    return answer({ error: "gone" }, 404);
  }
  deps.audit(
    pairApproveAuditEntry({ approver: ctx.approver, label: enrolled.label, asker: taken.route, approverRoute: ctx.approverRoute }),
  );
  return answer({ state: "approved", label: enrolled.label });
}

