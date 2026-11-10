// The Hill across a crew (CREW_PROTOCOL.md §22, added in 1.29.0): an agent on a member posts a
// Decision on its lead's Hill, and follows it up from the member, with the same `collie hill` verbs.
//
// ONE HILL. Only the lead holds Decisions, mints their ids and pushes to the phone. A member's bridge
// keeps none: its walky socket takes the agent's `collie hill` call as before, reads the images on its
// own machine under every local hill rule (media.ts), and forwards the rest to its lead over three
// signed member → lead routes. The answer comes back the way every answer does: the operator's walky
// send, which the lead already routes to a member's pane (§21).
//
// WHO POSTED. The lead takes the member from the §8.6 signature (the router's verdict), never from the
// body. A body that names a session of another machine, as `from.address` or as `as`, is the uniform
// 401. A `replyTo` or an `about` that names a session of another machine is refused `bad_target`
// (`foreignTarget`): the tap is typed where `replyTo` points, with the person's authority, so a member
// may only point it at its own sessions. The labels a member sends are display data. The member's claim about its own pane stands in for
// the lead's `place()` only for the poster's own session, because a pane opened a second ago may not be
// in the lead's sweep yet; the instance token is checked again on the member when the answer is typed.
//
// SKEW. A member below 1.29.0 never calls these routes and keeps refusing `not_on_lead`. A member that
// knows its lead is below 1.29.0 refuses before it dials (`olderThanTricksCrew`). A lead that does not
// know the routes does not count them as signable either, so its admission answers the uniform 401: from
// a lead whose release is not known that 401 reads as an older lead too, and only from a lead known to be
// at the floor (`atTricksCrewFloor`) does it mean the signature was refused. Nothing is half posted: the images wait on the
// lead for 15 minutes and are then dropped, and the post is idempotent by its request id.

import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { HILL_ID_RE, HILL_MEDIA_BYTES_MAX, HILL_MEDIA_MAX, type HillDecision, type HillRefusalCode } from "../../web/src/lib/hill/wire.ts";
import { parseAddress } from "../walky/address.ts";
import { olderThanFloor, type CrewDialAnswer } from "../walky/crew.ts";
import { headerField, WALKY_HARNESS_MAX, WALKY_LABEL_MAX } from "../walky/types.ts";
import { hillImageMime, hillImageSize, type HillImageBytes } from "./media.ts";
import { readDecision, readPostFields, HILL_RAW_MAX } from "./parse.ts";
import type { HillAgentSender, HillOneAnswer, HillPlace, HillPostAnswer, HillService } from "./service.ts";

/**
 * The first release whose lead takes Decisions from its members (§22), and whose crew carries the
 * other tricks-and-Hill routes as they are built. Named for the whole feature, as the walky talky floor is.
 */
export const TRICKS_CREW_FIRST_VERSION = "1.29.0";

/**
 * Whether a lead's stated release is too old for Decisions from a member: below 1.29.0, or, on a build
 * made before 1.29.0 that carries the feature, below that build's own version. The rules of
 * `olderThanWalky`: a version that names no release, and no version at all, is never called older (the
 * lead's uniform 401 answers for it, read by `atTricksCrewFloor`).
 */
export function olderThanTricksCrew(version: string | null, own: string, compare: (a: string, b: string) => number): boolean {
  return olderThanFloor(version, own, compare, TRICKS_CREW_FIRST_VERSION);
}

/**
 * Whether a lead's stated release is KNOWN to take Decisions from a member: it names a release, and that
 * release is not below the floor. False for no version and for one that names no release. Only such a
 * lead's 401 means it refused this machine's signature: a lead below the floor, or one whose release is
 * not known, does not count the three routes as signable, so its admission refuses every call to them
 * with the uniform 401 (§8.6), and that 401 reads as an older lead.
 */
export function atTricksCrewFloor(version: string | null, own: string, compare: (a: string, b: string) => number): boolean {
  return version !== null && /^\d+\.\d+\.\d+/u.test(version) && !olderThanTricksCrew(version, own, compare);
}

/** The routes under `/crew/v1/`, as the member's crew client names them. */
export const CREW_HILL_MEDIA_ROUTE = "hill/media";
export const CREW_HILL_POST_ROUTE = "hill/post";
export const CREW_HILL_OP_ROUTE = "hill/op";

/** How long an image waits on the lead for the post that names it. */
export const HILL_HELD_MS = 15 * 60_000;
/** The most bytes of images the lead holds for one member at once, before their post. */
export const HILL_HELD_MEMBER_BYTES = 16 * 1024 * 1024;
/** The longest base64 text one image may be: {@link HILL_MEDIA_BYTES_MAX} bytes, written out. */
export const HILL_MEDIA_B64_MAX = Math.ceil(HILL_MEDIA_BYTES_MAX / 3) * 4;
// THE FORWARD'S TIME, in one place. `collie hill post` is a CLI call an agent waits on, so the whole
// forward (every image, then the post) has one budget, and the CLI waits a margin longer than that, so it
// never gives up on a post the member is still sending (a second post under a new request id would be a
// second card). Past the budget the member stops before the post, so nothing is posted.

/** How long the member waits for one image to reach its lead. A screenshot over a relayed link is slow. */
export const HILL_MEDIA_BUDGET_MS = 20_000;
/** How long the member waits for a post or a follow-up call. Always kept free for the post. */
export const HILL_CALL_BUDGET_MS = 8000;
/** The whole forward of one post, its images and the post together. */
export const HILL_FORWARD_BUDGET_MS = 45_000;
/** How long `collie hill post` waits for its answer: the forward's budget, plus reading the images and the socket. */
export const HILL_POST_ASK_MS = HILL_FORWARD_BUDGET_MS + 15_000;
/** The least time worth giving one more image; with less left, the forward stops before the post. */
const HILL_MEDIA_MIN_MS = 2000;

/** A Decision's answer as the routes carry it: what the router frames, a status and a JSON body. */
export interface HillCrewAnswer {
  readonly status: number;
  readonly body: object;
}

const UNAUTHORIZED: HillCrewAnswer = { status: 401, body: { error: "unauthorized" } };

function badRequest(error: string): HillCrewAnswer {
  return { status: 400, body: { error } };
}

/** A content refusal: the call was well formed and the lead said no, in a 200 with `ok: false`. */
function refused(code: HillRefusalCode | null, error: string): HillCrewAnswer {
  return { status: 200, body: code === null ? { ok: false, error } : { ok: false, code, error } };
}

const SHA256_RE = /^[0-9a-f]{64}$/u;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/u;

/** The SHA-256 of some bytes, lowercase hex: the name an image goes by on the way to the lead. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Standard base64 that decodes and writes back to itself, or null: no lenient decoding of junk. */
function strictBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64_RE.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
}

/**
 * The address a member named, when it is a pane address of that member's own machine. Null for an
 * address of another machine, `local`, a scope or anything that is not an address: the caller's 401.
 */
export function ownAddress(raw: string, memberId: string): string | null {
  if (raw !== raw.trim()) return null;
  const address = parseAddress(raw);
  return address !== null && address.kind === "pane" && address.memberId === memberId ? raw : null;
}

/**
 * Why a forwarded post's `replyTo` or `about` is refused, or null when both name nothing, `here` (for
 * `about`), or a pane of the signing member's own machine. Checked before the lead's `place()` is asked,
 * so a member learns nothing about which sessions of other machines are live.
 *
 * `replyTo` is where the person's tap is typed, with the person's authority, and the session it names
 * may read the Decision (`collie hill status`): a member naming a pane of the lead or of another member
 * would type an operator message of its choosing there. `about` only labels the card, but a label that
 * names another machine's session is a claim this member cannot make. Both are the agent's own words,
 * so the refusal is `bad_target` with words, not the 401 an identity claim (`from.address`, `as`) gets.
 */
export function foreignTarget(fields: JsonObject, memberId: string): string | null {
  for (const key of ["replyTo", "about"] as const) {
    const raw = fields[key];
    if (raw === undefined || raw === null) continue;
    const text = asJsonString(raw);
    // Not a string: the reader refuses the shape with its own words.
    if (text === undefined) continue;
    if (key === "about" && (text.trim() === "" || text.trim() === "here")) continue;
    if (ownAddress(text, memberId) === null) {
      return `\`${headerField(text, 80)}\` is not a session on this machine: a Decision from a crew member answers to, and is about, a session on that member only`;
    }
  }
  return null;
}

// ── On the lead: images held for a post ─────────────────────────────────────────────────────────────

interface HeldImage {
  readonly memberId: string;
  readonly image: HillImageBytes;
  at: number;
}

/**
 * The images members uploaded for a post they have not made yet, in memory only: by member and hash,
 * kept {@link HILL_HELD_MS} from the last upload, at most {@link HILL_HELD_MEMBER_BYTES} per member. A
 * lead restart drops them, and the member's next post uploads them again.
 */
export class HillHeldMedia {
  private readonly held = new Map<string, HeldImage>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(memberId: string, sha: string): string {
    return `${memberId}\u0000${sha}`;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.held) if (now - entry.at >= HILL_HELD_MS) this.held.delete(key);
  }

  /** The bytes this member holds here now, every image counted once. */
  bytesOf(memberId: string): number {
    this.sweep(this.now());
    let sum = 0;
    for (const entry of this.held.values()) if (entry.memberId === memberId) sum += entry.image.bytes.length;
    return sum;
  }

  /** Hold one image. The same hash again refreshes its time and costs nothing. False: the member's bytes are full. */
  put(memberId: string, sha: string, image: HillImageBytes): boolean {
    const now = this.now();
    this.sweep(now);
    const key = this.key(memberId, sha);
    const known = this.held.get(key);
    if (known !== undefined) {
      known.at = now;
      return true;
    }
    if (this.bytesOf(memberId) + image.bytes.length > HILL_HELD_MEMBER_BYTES) return false;
    this.held.set(key, { memberId, image, at: now });
    return true;
  }

  /** One held image of this member, or null when it is not held (never sent, past its time, or another member's). */
  get(memberId: string, sha: string): HillImageBytes | null {
    this.sweep(this.now());
    return this.held.get(this.key(memberId, sha))?.image ?? null;
  }

  /** Let go of images a post has kept. */
  drop(memberId: string, shas: readonly string[]): void {
    for (const sha of shas) this.held.delete(this.key(memberId, sha));
  }
}

// ── On the lead: the three routes ───────────────────────────────────────────────────────────────────

export interface HillCrewLeadDeps {
  readonly hill: Pick<HillService, "postDecision" | "status" | "withdraw" | "mineList">;
  readonly held: HillHeldMedia;
  /** The lead's own name for a member, from its sweep (the Crew page's), or null to keep the member's word. */
  readonly machineOf?: (memberId: string) => string | null;
}

/** The fields a forwarded post may never carry: the member's socket frame, the bridge's own `from`, and the paths. */
const FRAME_KEYS = new Set(["v", "op", "markers", "from", "images"]);

/**
 * The lead's half of §22: a member's image, post and follow-up call, each answered for the member the
 * router's signature check named, never for one a body names.
 */
export class HillCrewLead {
  constructor(private readonly deps: HillCrewLeadDeps) {}

  /** `POST /crew/v1/hill/media`: one image, sniffed and held by its hash for the post that names it. */
  media(body: JsonValue | undefined, memberId: string): HillCrewAnswer {
    const row = asJsonObject(body);
    const sha = asJsonString(row?.sha256);
    const b64 = asJsonString(row?.b64);
    if (sha === undefined || !SHA256_RE.test(sha) || b64 === undefined) return badRequest("an image is { sha256, b64 }, the hash as 64 lowercase hex");
    if (b64.length > HILL_MEDIA_B64_MAX) return refused("image_too_large", `an image is at most ${String(HILL_MEDIA_BYTES_MAX / (1024 * 1024))} MB`);
    const bytes = strictBase64(b64);
    if (bytes === null) return badRequest("the image is not standard base64");
    if (bytes.length > HILL_MEDIA_BYTES_MAX) return refused("image_too_large", `an image is at most ${String(HILL_MEDIA_BYTES_MAX / (1024 * 1024))} MB`);
    if (sha256Hex(bytes) !== sha) return badRequest("the image does not match its hash");
    // The hill's own rule, the one an agent's image on this machine meets: the leading bytes decide.
    const mime = hillImageMime(bytes);
    if (mime === null) return refused("bad_image", "an image is a PNG, JPEG or WebP image (read from its first bytes, not its name)");
    const size = hillImageSize(bytes, mime);
    const image: HillImageBytes = { mime, bytes, width: size?.width ?? null, height: size?.height ?? null };
    if (!this.deps.held.put(memberId, sha, image)) {
      return refused("bad_image", `the lead already holds ${String(HILL_HELD_MEMBER_BYTES / (1024 * 1024))} MB of images from this machine; post them, or wait 15 minutes`);
    }
    return { status: 200, body: { ok: true, sha256: sha, mime, width: image.width, height: image.height } };
  }

  /** `POST /crew/v1/hill/post`: one Decision, from a session of the signing member, on this lead's Hill. */
  post(body: JsonValue | undefined, memberId: string): HillCrewAnswer {
    const row = asJsonObject(body);
    const from = asJsonObject(row?.from);
    const fields = asJsonObject(row?.fields);
    const address = asJsonString(from?.address);
    if (row === undefined || from === undefined || fields === undefined || address === undefined) return badRequest("a post is { from: { address, harness, label, host }, fields, images }");
    if (ownAddress(address, memberId) === null) return UNAUTHORIZED;
    const foreign = foreignTarget(fields, memberId);
    if (foreign !== null) return refused("bad_target", foreign);
    // Images ride by hash, uploaded first: a path in the fields names a file on the member, never here.
    if (fields.images !== undefined) return badRequest("a forwarded post names its images by hash, never by path");
    const rawImages = row.images ?? [];
    if (!Array.isArray(rawImages) || rawImages.length > HILL_MEDIA_MAX) return refused("too_many_images", `a decision has at most ${String(HILL_MEDIA_MAX)} images`);
    const hashes: Array<{ readonly sha: string; readonly caption: string | null }> = [];
    for (const entry of rawImages) {
      const image = asJsonObject(entry);
      const sha = asJsonString(image?.sha256);
      const caption = image?.caption === undefined || image.caption === null ? null : asJsonString(image.caption);
      if (sha === undefined || !SHA256_RE.test(sha) || caption === undefined || (caption !== null && caption.length > HILL_RAW_MAX)) return badRequest("an image is { sha256, caption? }");
      hashes.push({ sha, caption });
    }
    // The member's fields, read by the same reader as a post on this machine. Each image stands in by a
    // name no file can have, so a view's `ref` counts it and the request id's digest covers the hash.
    const own: JsonObject = {};
    for (const [key, value] of Object.entries(fields)) if (!FRAME_KEYS.has(key)) own[key] = value;
    if (hashes.length > 0) own.images = hashes.map(({ sha, caption }): JsonObject => (caption === null ? { path: `crew:sha256:${sha}` } : { path: `crew:sha256:${sha}`, caption }));
    const read = readPostFields(own);
    if (!read.ok) return refused(read.code, read.error);
    const images: HillImageBytes[] = [];
    for (const { sha } of hashes) {
      const held = this.deps.held.get(memberId, sha);
      if (held === null) return refused("bad_image", `image ${sha.slice(0, 12)} is not held on the lead: send the post again`);
      images.push(held);
    }
    const label = headerField(asJsonString(from.label) ?? "", WALKY_LABEL_MAX);
    const harnessRaw = asJsonString(from.harness);
    const harness = harnessRaw === undefined || harnessRaw === "" ? null : headerField(harnessRaw, WALKY_HARNESS_MAX);
    const claimedHost = asJsonString(from.host);
    const host = this.deps.machineOf?.(memberId) ?? (claimedHost === undefined || claimedHost === "" ? memberId : headerField(claimedHost, 80));
    const sender: HillAgentSender = { kind: "agent", address, memberId, harness, label, host };
    const place: HillPlace = { address, label, host, unattended: false, reachable: true };
    const answer: HillPostAnswer = this.deps.hill.postDecision(sender, read.input, { own: place, images });
    if (!answer.ok) return refused(answer.code, answer.error);
    this.deps.held.drop(
      memberId,
      hashes.map(({ sha }) => sha),
    );
    return { status: 200, body: { ok: true, decision: answer.decision } };
  }

  /** `POST /crew/v1/hill/op`: a status, a withdraw or the list, for a session of the signing member. */
  op(body: JsonValue | undefined, memberId: string): HillCrewAnswer {
    const row = asJsonObject(body);
    const op = asJsonString(row?.op);
    const as = asJsonString(row?.as);
    if (row === undefined || as === undefined || (op !== "status" && op !== "withdraw" && op !== "list")) return badRequest("a call is { op: status | withdraw | list, id?, as }");
    if (ownAddress(as, memberId) === null) return UNAUTHORIZED;
    // Only the address keys a sender's Decisions; the other fields are display data and unused here.
    const sender: HillAgentSender = { kind: "agent", address: as, memberId, harness: null, label: "", host: null };
    if (op === "list") return { status: 200, body: { ok: true, decisions: this.deps.hill.mineList(sender) } };
    const id = asJsonString(row.id);
    if (id === undefined || !HILL_ID_RE.test(id)) return badRequest("a decision id is dc_ and 12 characters");
    const answer = op === "status" ? this.deps.hill.status(sender, id) : this.deps.hill.withdraw(sender, id);
    return { status: 200, body: answer };
  }
}

// ── On a member: the forward ───────────────────────────────────────────────────────────────────────

/** What the member's forward needs: one signed dial of its lead, and what it knows of that lead. */
export interface HillLeadLink {
  /** POST one body to `/crew/v1/<route>` on this member's lead, signed per §8.6, within `budgetMs`. */
  call(route: string, payload: string, budgetMs: number): Promise<CrewDialAnswer>;
  /** The lead's name, as `crew status` prints it, or null. */
  leadName(): string | null;
  /** Whether the lead's stated release is below {@link TRICKS_CREW_FIRST_VERSION}. False while it is not known. */
  leadOlder(): boolean;
  /** Whether the lead's stated release is known and at or above the floor ({@link atTricksCrewFloor}). */
  leadAtFloor(): boolean;
}

/** One image read on the member, to forward with its caption (already cleaned there). */
export type HillForwardImage = HillImageBytes & { readonly caption: string | null };

/** A list, or why it could not be had. */
export type HillListAnswer = { readonly ok: true; readonly decisions: readonly HillDecision[] } | { readonly ok: false; readonly error: string };

/** What `HillService` asks of a member's forward. */
export interface HillLeadForward {
  post(from: HillAgentSender, fields: JsonObject, requestId: string, images: readonly HillForwardImage[]): Promise<HillPostAnswer>;
  one(op: "status" | "withdraw", from: HillAgentSender, id: string): Promise<HillOneAnswer>;
  list(from: HillAgentSender): Promise<HillListAnswer>;
}

/** The code a forwarded post is refused with when the lead does not answer. */
export const LEAD_UNREACHABLE_CODE = "lead_unreachable";

/** What a member answers when its lead runs a release that takes no Decisions from other machines. */
export function hillLeadOlder(lead: string): string {
  return `the lead (${lead}) runs a Collie older than ${TRICKS_CREW_FIRST_VERSION}, which takes no Decisions from other machines: update the lead, or post from a session on the lead machine`;
}

/** What a member answers when nothing reached its lead: nothing was posted, and the retry is safe. */
export function hillLeadNotAnswering(lead: string, requestId: string): string {
  return `the lead (${lead}) is not answering; nothing was posted. Post again with --request-id ${requestId}: it posts once`;
}

/** What a member answers when the post may have reached its lead: the same request id posts once. */
export function hillLeadNotConfirmed(lead: string, requestId: string): string {
  return `the lead (${lead}) did not confirm the post. Post again with --request-id ${requestId}: it posts once`;
}

/** What a member answers a status, a withdraw or a list when its lead does not answer. */
export function hillLeadAway(lead: string): string {
  return `the lead (${lead}) is not answering; try again`;
}

const KNOWN_CODES: readonly HillRefusalCode[] = [
  "bad_title",
  "bad_summary",
  "bad_body",
  "bad_option",
  "bad_recommends",
  "bad_link",
  "bad_text_mode",
  "bad_target",
  "bad_supersedes",
  "too_many_open",
  "not_on_lead",
  "walky_off",
  "hill_off",
  "bad_image",
  "too_many_images",
  "image_too_large",
  "request_id_reused",
  "lead_unreachable",
];

/** A line of the lead's own words as this member prints it: one line, printable, cut. */
function leadWords(raw: string | undefined, fallback: string): string {
  return raw === undefined || raw.trim() === "" ? fallback : headerField(raw, 300);
}

/** What one dial came to, read the same way for every route. */
type Read = { readonly kind: "body"; readonly body: JsonObject } | { readonly kind: "refused" } | { readonly kind: "unknown" } | { readonly kind: "older" } | { readonly kind: "failed"; readonly error: string };

/** The words of a 401 from a lead known to take Decisions from a member. */
export const HILL_SIGNATURE_REFUSED = "the lead refused this machine's signature";

/**
 * One dial, read. A 401 (the crew client's `signature` refusal, or the status itself) is the signature
 * refused only from a lead KNOWN to be at the floor (`atFloor`): a lead below 1.29.0 does not count these
 * routes as signable and answers each call with the uniform 401, so from a lead whose release is not
 * known, or older, it reads as an older lead. A 404 (a collie that does not lead, or a lead built without
 * the routes) reads as older too. A 503 is a body the lead did not read: refused, nothing landed.
 */
function readDial(answer: CrewDialAnswer, atFloor: boolean): Read {
  const signature: Read = atFloor ? { kind: "failed", error: HILL_SIGNATURE_REFUSED } : { kind: "older" };
  if (answer.kind === "refused") return answer.reason === "signature" ? signature : { kind: "refused" };
  if (answer.kind === "unknown") return { kind: "unknown" };
  if (answer.status === 404) return { kind: "older" };
  if (answer.status === 401) return signature;
  // The lead turned the body away unread (busy reading other uploads, §8.6): nothing landed there.
  if (answer.status === 503) return { kind: "refused" };
  const body = asJsonObject(answer.body ?? undefined);
  if (answer.status === 200 && body !== undefined) return { kind: "body", body };
  return { kind: "failed", error: `the lead answered HTTP ${String(answer.status)}: ${leadWords(asJsonString(body?.error), "no reason")}` };
}

/** A content refusal the lead wrote, as this member answers it. */
function refusalOf(body: JsonObject): Extract<HillPostAnswer, { ok: false }> {
  const raw = asJsonString(body.code);
  const code = KNOWN_CODES.find((known) => known === raw) ?? null;
  return { ok: false, code, error: leadWords(asJsonString(body.error), "the lead refused the post") };
}

/** The member's forward: images first, then the post; status, withdraw and list in one call each. */
/** The forward's budgets ({@link HILL_FORWARD_BUDGET_MS} and its parts) and its clock; a test passes small ones. */
export interface HillForwardBudgets {
  readonly mediaMs: number;
  readonly callMs: number;
  readonly totalMs: number;
  readonly now?: () => number;
}

const FORWARD_BUDGETS: HillForwardBudgets = { mediaMs: HILL_MEDIA_BUDGET_MS, callMs: HILL_CALL_BUDGET_MS, totalMs: HILL_FORWARD_BUDGET_MS };

export class HillMemberForward implements HillLeadForward {
  constructor(
    private readonly link: HillLeadLink,
    private readonly budgets: HillForwardBudgets = FORWARD_BUDGETS,
  ) {}

  private lead(): string {
    return this.link.leadName() ?? "the lead";
  }

  async post(from: HillAgentSender, fields: JsonObject, requestId: string, images: readonly HillForwardImage[]): Promise<HillPostAnswer> {
    const lead = this.lead();
    if (this.link.leadOlder()) return { ok: false, code: "not_on_lead", error: hillLeadOlder(lead) };
    // Each image first, by its hash: nothing is posted until every one is held on the lead. All of it
    // inside one budget, with the post's own time kept free: an image that cannot have its time stops
    // the forward before the post, so nothing is posted and the same request id may go again.
    const now = this.budgets.now ?? Date.now;
    const deadline = now() + this.budgets.totalMs;
    const named: JsonObject[] = [];
    for (const image of images) {
      const left = deadline - now() - this.budgets.callMs;
      if (left < Math.min(HILL_MEDIA_MIN_MS, this.budgets.mediaMs)) return { ok: false, code: LEAD_UNREACHABLE_CODE, error: hillLeadNotAnswering(lead, requestId) };
      const sha = sha256Hex(image.bytes);
      const sent = readDial(await this.link.call(CREW_HILL_MEDIA_ROUTE, JSON.stringify({ sha256: sha, b64: Buffer.from(image.bytes).toString("base64") }), Math.min(this.budgets.mediaMs, left)), this.link.leadAtFloor());
      if (sent.kind === "older") return { ok: false, code: "not_on_lead", error: hillLeadOlder(lead) };
      if (sent.kind === "refused" || sent.kind === "unknown") return { ok: false, code: LEAD_UNREACHABLE_CODE, error: hillLeadNotAnswering(lead, requestId) };
      if (sent.kind === "failed") return { ok: false, code: null, error: sent.error };
      if (asJsonBoolean(sent.body.ok) !== true) return refusalOf(sent.body);
      named.push(image.caption === null ? { sha256: sha } : { sha256: sha, caption: image.caption });
    }
    const own: JsonObject = {};
    for (const [key, value] of Object.entries(fields)) if (!FRAME_KEYS.has(key)) own[key] = value;
    const payload = { from: { address: from.address, harness: from.harness, label: from.label, host: from.host }, fields: own, images: named };
    const posted = readDial(await this.link.call(CREW_HILL_POST_ROUTE, JSON.stringify(payload), this.budgets.callMs), this.link.leadAtFloor());
    if (posted.kind === "older") return { ok: false, code: "not_on_lead", error: hillLeadOlder(lead) };
    if (posted.kind === "refused") return { ok: false, code: LEAD_UNREACHABLE_CODE, error: hillLeadNotAnswering(lead, requestId) };
    if (posted.kind === "unknown") return { ok: false, code: LEAD_UNREACHABLE_CODE, error: hillLeadNotConfirmed(lead, requestId) };
    if (posted.kind === "failed") return { ok: false, code: null, error: posted.error };
    if (asJsonBoolean(posted.body.ok) !== true) return refusalOf(posted.body);
    const decision = readDecision(posted.body.decision);
    if (decision === null) return { ok: false, code: null, error: `the lead (${lead}) answered without a decision; check with: collie hill list` };
    return { ok: true, decision };
  }

  /** One call of the op route, read as far as the dial goes. */
  private async call(body: JsonObject): Promise<Read> {
    return readDial(await this.link.call(CREW_HILL_OP_ROUTE, JSON.stringify(body), this.budgets.callMs), this.link.leadAtFloor());
  }

  async one(op: "status" | "withdraw", from: HillAgentSender, id: string): Promise<HillOneAnswer> {
    const lead = this.lead();
    if (this.link.leadOlder()) return { ok: false, missing: false, error: hillLeadOlder(lead) };
    const read = await this.call({ op, id, as: from.address });
    if (read.kind === "older") return { ok: false, missing: false, error: hillLeadOlder(lead) };
    if (read.kind === "refused") return { ok: false, missing: false, error: hillLeadAway(lead) };
    if (read.kind === "unknown") return { ok: false, missing: false, error: op === "withdraw" ? `the lead (${lead}) did not confirm the withdraw; check with: collie hill status ${id}` : hillLeadAway(lead) };
    if (read.kind === "failed") return { ok: false, missing: false, error: read.error };
    if (asJsonBoolean(read.body.ok) === true) {
      const decision = readDecision(read.body.decision);
      return decision === null ? { ok: false, missing: false, error: `the lead (${lead}) answered without a decision` } : { ok: true, decision };
    }
    const error = leadWords(asJsonString(read.body.error), `no decision ${id} from this session`);
    return asJsonBoolean(read.body.missing) === true ? { ok: false, missing: true, error } : { ok: false, missing: false, error };
  }

  async list(from: HillAgentSender): Promise<HillListAnswer> {
    const lead = this.lead();
    if (this.link.leadOlder()) return { ok: false, error: hillLeadOlder(lead) };
    const read = await this.call({ op: "list", as: from.address });
    if (read.kind === "older") return { ok: false, error: hillLeadOlder(lead) };
    if (read.kind === "refused" || read.kind === "unknown") return { ok: false, error: hillLeadAway(lead) };
    if (read.kind === "failed") return { ok: false, error: read.error };
    const rows = read.body.decisions;
    if (asJsonBoolean(read.body.ok) !== true || !Array.isArray(rows)) return { ok: false, error: leadWords(asJsonString(read.body.error), `the lead (${lead}) answered without a list`) };
    return { ok: true, decisions: rows.flatMap((row) => readDecision(row) ?? []) };
  }
}
