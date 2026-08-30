import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import type { JsonObject, JsonValue } from "./json.ts";
import type { ActivityLedger } from "./activity.ts";
import { type AuditDetail, type AuditEntry, AuditLog } from "./audit.ts";
import { isLoopbackBindHost, type Config } from "./config.ts";
import { apiError, type ApiErrorBody, type ApiErrorDetail, type ErrorCode } from "./error-codes.ts";
import { MUX_CAPABILITIES, type MuxCapability, type MuxCapabilityDeclaration } from "./mux/capabilities.ts";
import type { MuxAdapter, MuxAck, MuxGrid } from "./mux/types.ts";
import { computeEtag, gzipJsonResponse, notModified } from "./http-cache.ts";
import { pluginRoot } from "./root.ts";
import type { NotifyPrefs, NotifyPrefsStore } from "./notify-prefs.ts";
import { createOperatorCommands } from "./operator-commands.ts";
import { createOperatorKeys } from "./operator-keys.ts";
import { createOperatorQuickReplies } from "./operator-quick-replies.ts";
import {
  DEFAULT_PROMPT_TAIL_LINES,
  verifyExpectedPrompt,
  type PromptBindingResult,
} from "./prompt-binding.ts";
import type { Push, PushSubscription } from "./push.ts";
import { RefreshCoalescer } from "./refresh.ts";
import { herdTagFor, type SessionRegistry, type SessionRuntime, widenedPanes } from "./sessions.ts";
import type { Snooze } from "./snooze.ts";
import { imageExtFromBytes, SNIFF_BYTES } from "./uploads.ts";
import type { UpdateMonitor } from "./update.ts";
import type { StateEngine } from "./state-engine.ts";
import { adapterFor, buildJournalRegistry } from "./journal/registry.ts";
import { TranscriptStore } from "./journal/store.ts";
import type { JournalAdapter } from "./journal/types.ts";
import {
  bearerToken,
  normalizeLabel,
  toDeviceWire,
  type ClaimFailure,
  type PairingStore,
} from "./pairing.ts";
import { modeForWire } from "./pack/mode.ts";
import type { PackRuntime } from "./pack/config.ts";
import type { PackLead } from "./pack/lead.ts";
import { packDeviceOf, packGate } from "./pack/peer-gate.ts";
import { selectHostFrom, type HostSelector } from "./pack/registry.ts";
import type { PackHandler, PackSurface } from "./pack/router.ts";
import type { PackTlsOptions } from "./pack/transport.ts";
import { createSttAdmission, sttCapability, transcribeRequest } from "./stt/http.ts";
import type { SttProvider } from "./stt/provider.ts";
import { MAX_UPLOAD_BYTES, uploadTooLarge } from "./uploads.ts";
import { MUX_LOGO_PATH, toPaneWire } from "./types.ts";
import type {
  ActionResponse,
  AgentView,
  BridgeConfig,
  CreateResponse,
  DeviceAuth,
  OperatorCommand,
  MuxConfig,
  OperatorKeyRow,
  OperatorQuickReplyRow,
  PackStatusResponse,
  PaneHistoryResponse,
  PaneReadResponse,
  PaneWire,
  SnapshotResponse,
  SttCapability,
  UploadResponse,
} from "./types.ts";

// Hard cap the runtime enforces on ANY request body (Bun.serve maxRequestBodySize). Bigger than the
// upload cap + overhead so the handler's own 413 fires first for honest clients; this cuts off a
// chunked or lying client that never sends an accurate Content-Length.
const MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024; // 12 MB
// Upper bound on the pane-read `lines` param — don't trust the client (or Herdr) to cap it.
const MAX_READ_LINES = 10_000;
const MAX_EXPECTED_PROMPT_CHARS = 8192;
const PROMPT_BINDING_BLANK_LINE_HEADROOM = 6;
// Image type is sniffed from magic bytes in uploadPane — never from the client-supplied MIME.

// The built PWA lives in web/dist (Vite output). If it's missing, the bridge still runs the API
// — only the static UI 503s with a hint to build. Anchored on the resolved checkout root, NOT on
// this module's directory: under `bun build --compile` that is the embedded `/$bunfs` root and the
// served directory would vanish (see bridge/root.ts).
const WEB_DIR = join(pluginRoot(), "web", "dist");

// A Map for the same reason {@link IMAGE_EXT} is one: the key is derived from a request path.
const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
]);

// Strict CSP. Scripts are external, hashed bundles (script-src 'self'); pane text is rendered by
// React as text nodes, never markup, so terminal output can't inject. 'unsafe-inline' is allowed
// for styles only (the toast library injects a <style> tag) — it can't execute code.
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; " +
  "manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'";

// Hardening headers set on EVERY response (static + API), applied centrally in the fetch wrapper.
// nosniff stops content-type confusion; no-referrer keeps the tailnet URL out of any Referer.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} satisfies Record<string, string>;

// Loopback Host/Origin forms (with an optional port). Loopback is always trusted — only tailscaled
// (or a co-located proxy) can reach the bridge's port, so a loopback caller is the on-host operator.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Whether a TCP peer address is loopback. Unlike the `Host` header — which the client writes —
 * this comes from the kernel and cannot be forged.
 *
 * Bun gives IPv4 peers as `127.0.0.1` and IPv6 peers as `::1`; a dual-stack listener can also report
 * an IPv4 peer in v4-mapped form (`::ffff:127.0.0.1`). A null/absent address is treated as loopback
 * (the bind gate in config.ts is the primary control).
 */
export function isLoopbackPeer(address: string | null | undefined): boolean {
  if (!address) return true;
  const a = address.trim().toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

const PANE_ROUTE = /^\/api\/pane\/([^/]+)(?:\/(reply|keys|upload|close|rename|history|focus))?$/;

/**
 * A pairing claim's refusal, as an error code.
 *
 * Pairing has always answered with a machine-readable word rather than a sentence, so this is a
 * rename and nothing more — each catalogue entry's English IS the word this map's key spells. It is
 * a total `Record`, so a new {@link ClaimFailure} fails `tsc` here rather than reaching a phone as
 * an unnamed refusal.
 */
const PAIRING_ERROR_CODES = {
  "no-pending": "pairing.no_pending",
  expired: "pairing.expired",
  exhausted: "pairing.exhausted",
  "bad-code": "pairing.bad_code",
  "duplicate-label": "pairing.duplicate_label",
} satisfies Record<ClaimFailure, ErrorCode>;

/**
 * The host selector every request takes when this collie has no trust store — i.e. the only one a
 * solo instance ever sees. Named rather than parsed so that on solo the `?host=` grammar is never
 * applied to a URL at all: not a lookup, not a regex, not a branch a client can steer (§11).
 */
const LOCAL_HOST: HostSelector = { kind: "local" };
// Turns per history page. "Show entire history" means the WHOLE conversation, so the client asks for
// everything and this ceiling is a safety net against a pathological log, not the normal path — a
// 1400-turn session is ~1.4 MB raw / ~400 KB gzipped, which a tailnet link serves fine. The default
// only applies when a caller omits `limit` entirely.
const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 5000;
// A tab supports rename + close — an action group like the pane route. The `/api/tab` POST above
// (create) is an exact match on `/api/tab`, so it never collides with this `/api/tab/<id>/<action>`.
const TAB_ACTION_ROUTE = /^\/api\/tab\/([^/]+)\/(rename|close)$/;

/**
 * Header the web app sets on its own pane reads, and the ONLY thing that lets a read mark a pane
 * seen. See {@link marksPaneSeen} for why a header, of all things, is the check.
 */
export const SEEN_HEADER = "x-collie-seen";

/**
 * Whether this request proves it came from Collie's own page, and may therefore stamp the pane as
 * seen (bridge/activity.ts).
 *
 * This exists because marking-seen made a **read-level GET mutate server state**, which it never did
 * before. `checkAccess` deliberately does not demand an `Origin` on reads — browsers omit it on
 * same-origin GETs, so demanding one would reject the real client — and that exemption was safe only
 * while reads had no side effects. Without this check, a page the operator visits while on the
 * tailnet could fire `<img src="https://collie…/api/pane/w1:p1">` at guessable pane ids and silently
 * clear the "Ready · unseen" section: the response is opaque to the attacker, but the write lands,
 * and the operator simply stops being told their agents finished.
 *
 * A custom request header is the check because a no-cors cross-site request **cannot set one** —
 * doing so promotes it to a preflighted CORS request, and the bridge answers no preflight. Our own
 * same-origin `fetch` sets it freely.
 *
 * Write actions (reply/keys/upload/close/rename) need no header: they already cleared
 * `guard(…, "write")`, which requires an `Origin`. `history` is a read despite being an action
 * segment, so it needs the header like any other read.
 */
export function marksPaneSeen(req: Request, action: string | undefined): boolean {
  if (req.headers.get(SEEN_HEADER) !== null) return true;
  return action !== undefined && action !== "history";
}

/**
 * The `/api/config` body. Pure, and exported for that reason: the handler lives inside `Bun.serve`,
 * which `bun test` cannot stand up (CLAUDE.md), so the shape is asserted here instead.
 *
 * `mode` is present only when this collie is in a pack — see {@link modeForWire}. A solo instance's
 * body is byte-identical to the pre-federation one, which is the whole zero-tax point; a client
 * reads the mode as `mode ?? "solo"`.
 */
/**
 * Who is asking for a session-scoped route, and everything that differs between them.
 *
 * There are exactly two implementations and there must never be a third: the browser at this
 * collie's front door, and a lead over an admitted pack link (PACK_PROTOCOL.md §5). Each route
 * handler below is written once and consumes this — so the answer to "does a peer run the same code
 * my phone does?" is structural rather than a promise.
 */
interface RouteCaller {
  /**
   * `(host, session)` → the runtime to act on, or the Response refusing/answering it. For a browser
   * this may resolve to *another machine*, in which case the request is forwarded and the peer's own
   * response comes back here (§9.1). For a pack caller it is always local.
   */
  resolve(): Promise<SessionRuntime | Response>;
  /** The caller's own authorisation at this level, or `null` to proceed. */
  gate(level: "read" | "write"): Response | null;
  /** The device a write is attributed to. */
  device(): string | null;
  /** Where a write's audit line lands — the peer's is pre-stamped `via:"pack"` + originator (§12). */
  readonly audit: AuditLog;
}

/**
 * One adapter's declaration, as the phone reads it (M10/06).
 *
 * Takes the two fields off {@link MuxAdapter} rather than the adapter itself, so this stays a pure
 * function `bun test` can call — and so it is obvious that publishing capabilities cannot reach into
 * a multiplexer.
 *
 * `notes` is filtered to the ABSENT capabilities. A note on a supported one explains nothing to an
 * operator (Herdr ships one, about how its scrollback depth is known), and shipping it would put
 * developer prose on the wire for every page load of the reference adapter.
 */
export function muxConfigBody(mux: MuxPublication): MuxConfig {
  const decl = mux.capabilities;
  const notes: Partial<Record<MuxCapability, string>> = {};
  for (const cap of MUX_CAPABILITIES) {
    if (decl.supports[cap]) continue;
    const note = decl.notes[cap];
    if (note !== undefined) notes[cap] = note;
  }
  const wire: MuxConfig = {
    name: mux.mux,
    capabilities: { ...decl.supports },
    unsupportedKeys: [...decl.unsupportedKeys],
    notes,
    // Unconditional, like `capabilities`: the declaration is total, so there is nothing to omit and
    // an absent key means "a bridge too old to know", which the phone already reads as `"many"`.
    spaces: decl.spaces,
  };
  // Assigned only when the adapter actually has a mark — the key's ABSENCE is what tells the phone
  // to render its text alone, so a bridge that published `logoUrl` unconditionally would point every
  // header at a 404.
  if (mux.logo !== undefined) wire.logoUrl = MUX_LOGO_PATH;
  // Unconditional, unlike the mark: every adapter answers this, and it is the whole point of the
  // field that the phone can tell "this bridge says push" from "this bridge is too old to say".
  wire.topologyLatency = decl.topologyLatency;
  return wire;
}

/**
 * What publishing an adapter needs off it — its name, its declaration, and its mark.
 *
 * The three FIELDS rather than the {@link MuxAdapter} itself, so this stays a pure shape `bun test`
 * can build by hand, and so it is structurally obvious that publishing a config cannot reach into a
 * multiplexer.
 */
interface MuxPublication {
  readonly mux: string;
  readonly capabilities: MuxCapabilityDeclaration;
  readonly logo?: string;
}

/**
 * `GET /api/mux/logo.svg` — the active adapter's mark, as the adapter wrote it.
 *
 * Pure + exported: the handler lives inside `Bun.serve`, which `bun test` cannot stand up, so the
 * headers are asserted against this instead.
 *
 * The two headers this adds beyond {@link secure}'s are the SVG-serving hardening, and they are not
 * decoration. An SVG is a document, not a picture: served same-origin it could in principle carry
 * script, so `Content-Security-Policy: sandbox` drops the whole response into an opaque origin with
 * scripting off. `nosniff` (already on every response) then keeps a browser from re-deciding what
 * these bytes are. Collie's own three logos contain no script — bridge/mux/logo.test.ts pins that
 * for each of them — but the bytes come from an ADAPTER, and the next adapter's author is not
 * necessarily in this repo.
 *
 * Caching follows the dist rule (see {@link cacheControlFor}): the path is not content-addressed and
 * its bytes change with a release, so `no-cache` + a strong ETag means a warm client spends a 304
 * and no body, while a rebuilt bridge is picked up on the next load rather than at the end of some
 * max-age.
 */
export function muxLogoResponse(svg: string, ifNoneMatch: string | null): Response {
  const etag = computeEtag(svg);
  const headers = {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "no-cache",
    "content-security-policy": "sandbox",
    etag,
  };
  if (notModified(ifNoneMatch, etag)) {
    // RFC 7232 §4.1: a 304 echoes the validators and carries no body.
    return secure(new Response(null, { status: 304, headers }));
  }
  return secure(new Response(svg, { headers }));
}

export function bridgeConfigBody(opts: {
  push: boolean;
  vapidPublicKey: string;
  build: string;
  mode: PackRuntime["mode"];
  /**
   * The active adapter, when there is one. Optional so the pack-mode assertions below (and any
   * caller that has no session registry) stay about the pack and nothing else; the real handler
   * always passes it.
   */
  mux?: MuxPublication;
  /**
   * The operator's own palette rows. Omitted entirely when there are none, so an operator who never
   * wrote a `commands.toml` ships the same payload as before — the same reasoning `mode` follows.
   */
  operatorCommands?: readonly OperatorCommand[];
  /** The operator's own Keys-tray rows. Same omit-when-empty rule as `operatorCommands`. */
  operatorKeys?: readonly OperatorKeyRow[];
  /** The operator's own Quick-dock groups. Same omit-when-empty rule as `operatorCommands`. */
  operatorQuickReplies?: readonly OperatorQuickReplyRow[];
  /**
   * Speech-to-text, when a provider resolved. Omitted entirely otherwise — an operator who
   * configured none ships the same payload as before, the same rule `mode` follows.
   */
  stt?: SttCapability;
}): BridgeConfig {
  const mode = modeForWire(opts.mode);
  const mine = opts.operatorCommands ?? [];
  const myKeys = opts.operatorKeys ?? [];
  const myReplies = opts.operatorQuickReplies ?? [];
  const wire: BridgeConfig = {
    push: opts.push,
    vapidPublicKey: opts.vapidPublicKey,
    build: opts.build,
  };
  // Assigned, never conditionally spread: a solo instance's body must carry NEITHER key, byte for
  // byte as before the pack existed (PACK_PROTOCOL.md §11).
  if (mode !== undefined) wire.mode = mode;
  if (mine.length > 0) wire.operatorCommands = [...mine];
  if (myKeys.length > 0) wire.operatorKeys = [...myKeys];
  if (myReplies.length > 0) wire.operatorQuickReplies = [...myReplies];
  // Appended last, and unconditional once an adapter is in hand: unlike `mode`, this is not
  // omit-when-default. There is no default to omit — "no mux key" already means something on the
  // phone (an older bridge, read as fully capable), so a Herdr bridge staying silent here would be
  // indistinguishable from one that cannot answer.
  if (opts.mux !== undefined) wire.mux = muxConfigBody(opts.mux);
  // Appended after the mux block, and omit-when-absent for the reason `mode` is: no key means no
  // microphone, which is precisely true of a collie with no provider configured.
  if (opts.stt !== undefined) wire.stt = opts.stt;
  return wire;
}

export function startServer(opts: {
  cfg: Config;
  registry: SessionRegistry;
  push: Push;
  snooze: Snooze;
  notifyPrefs: NotifyPrefsStore;
  updateMonitor: UpdateMonitor;
  audit: AuditLog;
  activity: ActivityLedger;
  /** Resolved once at startup in index.ts, before anything is wired. Solo is `SOLO_RUNTIME`. */
  pack: PackRuntime;
  /**
   * The federated surface, supplied by index.ts **only** when a trust store exists. Undefined on
   * every solo instance, and the paths it owns are declared in `bridge/pack/router.ts` rather than
   * here — deliberately, so this file names no pack route and `solo-baseline.test.ts` can prove by
   * grep that solo registers nothing (PACK_PROTOCOL.md §11, "`/pack/v1/*`: not routed at all").
   *
   * A **factory**, not a handler, for one reason: a peer's `/pack/v1/*` must answer exactly what its
   * own `/api/*` would, and the only way to guarantee that is to hand the pack router the very
   * closures this file serves browsers from — the snapshot body, and the session-scoped route block.
   * Two assemblies that "agree" would be two assemblies that drift.
   */
  packRouter?: (surface: PackSurface) => PackHandler;
  /**
   * The **deposed** answer, when this collie has learned the crown has moved (PACK_PROTOCOL.md
   * §18.12). Returns a `Response` for every request it should swallow and `null` otherwise — so an
   * instance that has not been deposed passes `undefined` and this file's dispatch is byte-identical
   * to today's.
   *
   * A closure rather than a route, for the reason `packRouter` is one: the paths it owns are declared
   * in `bridge/pack/deposed.ts`, so this file names none of them and `solo-baseline.test.ts` can keep
   * proving by grep that the route table here is exactly today's.
   */
  deposed?: (req: Request, url: URL) => Response | null;
  /**
   * The peer listener's pinned-mTLS options, supplied **only** by a peer that could build them
   * (`bridge/pack/transport.ts`). Absent on solo and on a lead, so this file's `Bun.serve` call is
   * byte-identical to today's for every instance that is not a peer (§11).
   */
  tls?: PackTlsOptions;
  /**
   * The lead runtime, supplied **only** when this collie leads a pack with at least one enrolled
   * member. Its presence is exactly the condition under which `servers` goes on the wire and every
   * session and pane gains a `host` (PACK_PROTOCOL.md §9.2, §11) — undefined here means the snapshot
   * body that leaves this file is the object literal it has always been.
   */
  packLead?: PackLead;
  /**
   * The Pack overview body (`GET /api/pack`), or `null` when this collie is not a lead with a pack.
   *
   * A CLOSURE, and it is composed in index.ts rather than here, for the reason `packRouter` is one:
   * this file may name no pack state. What it holds instead is a question it can ask on the request
   * path — the answer is assembled by `bridge/pack/status-wire.ts` from the trust store this process
   * already read and the per-peer beliefs the sweep already maintains, so asking it dials nobody and
   * opens no file (PACK_PROTOCOL.md §10.1, §11).
   *
   * `undefined` on every solo instance and on every peer, `null` from the closure whenever the mode
   * says the same thing at request time — both are the route's 404, and a lead that has just lost its
   * last member stops answering without this file learning why.
   */
  packStatus?: () => PackStatusResponse | null;
  /**
   * The lead's per-peer notification coordinators, supplied under the same condition as
   * {@link startServer} `packLead`. The two notification-policy routes below fan across it exactly as
   * they fan across `registry.all()` — snooze and prefs are one pack-wide setting the lead owns
   * (PACK_PROTOCOL.md §5), and the lead being the only sender is what makes that fan complete.
   * Structurally typed, not the class: this file needs "fan a pref change, list the live slots".
   */
  peerNotifier?: { applyPrefs(): void; tags(): string[] };
  /**
   * Device pairing (bridge/pairing.ts). Always supplied by index.ts — it is not an opt-in feature
   * flag: the store reads its own registry off disk, and an empty registry means "nothing paired",
   * which enforces nothing. Optional here only so the existing tests can build a server without it.
   *
   * It is deliberately NOT threaded into the pack surface. `/pack/v1/*` is admitted by pinned mutual
   * TLS plus the pack secret and shares nothing with a browser credential (PACK_PROTOCOL.md §6,
   * ADR 0013) — a lead does not hold one of this collie's pairing tokens and must never need one.
   *
   * **ONE EXCEPTION, added 2026-08-20, and the rule above survives verbatim** (RFC §16, decision 5;
   * PACK_PROTOCOL.md §18.14). `POST /pack/v1/pairing` carries a lead's registry — **hashes only** — to
   * the one member it has named DEPUTY, so that member's standby door can check a phone's bearer
   * credential when the lead is gone. What is unchanged: **no pack request is ever admitted by a
   * pairing token**, and that route is admitted by the pack's own two factors plus a role check like
   * every other one. What is new: a browser credential's hash rides a pack route and lands on a
   * peer's disk — in `standby-devices.json`, its own file, **never** merged into
   * `paired-devices.json`, because `PairingStore.enforced()` is "the registry is non-empty" and a
   * merge would arm the deputy's own write gate for its own operator. The reasoning, at length, is in
   * `bridge/pack/standby-devices.ts`.
   */
  pairing?: PairingStore;
  /**
   * Speech-to-text, asked for per request rather than resolved once.
   *
   * A FUNCTION, not a provider, because the settings behind it are re-read behind an mtime check
   * (`bridge/stt/config.ts`) — `collie stt setup` must go live without a `systemctl restart`, the
   * same posture `commands.toml` has. `null` from it is the feature being off, which is also the
   * whole of what makes this optional here: an instance that never calls it registers the route and
   * answers 503, and one that was never given it does the same.
   */
  stt?: () => Promise<SttProvider | null>;
}) {
  const { cfg, registry, push, snooze, notifyPrefs, updateMonitor, audit, activity, pack } = opts;
  const pairing = opts.pairing;
  const stt = opts.stt ?? (async () => null);
  // One gate per Bun server, not per request: two slow uploads and their two provider calls share
  // the same bounded process-local capacity (bridge/stt/http.ts).
  const sttAdmission = createSttAdmission();
  /** Who the requester is, across both device gates — see {@link requestDevice}. */
  const whois = (req: Request): DeviceAuth => requestDevice(req, cfg, pairing);
  const packLead = opts.packLead;
  const packStatus = opts.packStatus;
  const peerNotifier = opts.peerNotifier;
  // One journal registry + store for the process. The store's cache is keyed by absolute path, so
  // sharing it across herdr sessions AND across harnesses is correct — two sessions can front panes
  // whose agents write into the same root. Which harnesses have journals at all is decided in
  // journal/registry.ts, never here.
  // One reader per process; it owns the mtime cache that keeps commands.toml off the hot path.
  const operatorCommands = createOperatorCommands(cfg.commandsFile);
  // Its sibling, on the same contract: one reader, one mtime cache, keys.toml off the hot path.
  const operatorKeys = createOperatorKeys(cfg.keysFile);
  // The third on that contract: the Quick dock's groups, quick-replies.toml off the hot path.
  const operatorQuickReplies = createOperatorQuickReplies(cfg.quickRepliesFile);
  const journals = cfg.transcript ? buildJournalRegistry(cfg.journalRoots) : null;
  const transcripts = cfg.transcript ? new TranscriptStore() : null;
  /** Does this agent have a journal at all — the snapshot's History-affordance gate. */
  const hasJournal = (agent: string) => adapterFor(journals ?? {}, agent) !== undefined;

  /** One in-flight "look now" per session — see bridge/refresh.ts for why it coalesces. */
  const refreshes = new RefreshCoalescer();

  /**
   * Take a fresh look at one session's multiplexer, then make the bridge re-read it.
   *
   * TWO STEPS AND BOTH ARE NEEDED. `mux.refresh()` moves the ADAPTER's own clock — the census that
   * would otherwise discover an out-of-band change up to its declared bound later. `pokeNow()` moves
   * the BRIDGE's: the snapshot the phone polls is the state engine's, and an adapter that is now
   * up to date changes nothing the phone can see until the engine has polled it.
   *
   * Never throws. A multiplexer that did not answer leaves the herd exactly as stale as it already
   * was, which the disconnected banner is already saying — a refresh failing is not news.
   */
  const lookNow = async (rt: SessionRuntime): Promise<void> => {
    try {
      await rt.herdr.refresh();
    } catch (err) {
      console.warn(`[refresh] ${rt.name}: ${errorText(err)}`);
    }
    rt.engine.pokeNow();
  };

  /**
   * This collie's own snapshot body — the whole of what `/api/snapshot` answered before packs
   * existed, and (with `device` omitted) exactly what a peer serves its lead on `/pack/v1/snapshot`.
   *
   * `undefined` means the session name is unknown, which every caller turns into the same 404 it
   * always did. Nothing federated happens in here: the host tag and the `servers` array are added
   * afterwards, by the lead and only by a lead, so a solo instance's bytes are untouched (§11).
   */
  const localSnapshot = (
    sessionName: string | undefined,
    device: DeviceAuth | null,
    widen = false,
  ): SnapshotResponse | undefined => {
    const rt = registry.get(sessionName);
    if (!rt) return undefined;
    const { workspaces, tabs, bridge } = rt.engine.current();
    // Attach each pane's activity timestamps. Done here rather than in the state engine so the
    // engine stays a pure Herdr-poller with no knowledge of the ledger — and so the two numbers
    // are read at serialise time, i.e. as fresh as the request. The ledger is keyed by SESSION, so
    // the runtime whose panes are being serialised is the one that has to be asked — which is why
    // this takes the runtime rather than closing over the ambient one.
    const withActivity = (from: SessionRuntime, p: AgentView): AgentView => {
      const a = activity.get(from.name, p.paneId);
      return a ? { ...p, lastActiveAt: a.activeAt, lastSeenAt: a.seenAt } : p;
    };
    // The one place a pane leaves the bridge: the session ref is stripped to a presence flag here,
    // so an agent-reported filesystem path never reaches a browser (see toPaneWire). The flag is
    // computed against the registry, so a harness Herdr detects but Collie has no journal for
    // doesn't advertise a History button that can only ever come back empty. withActivity runs
    // FIRST: it returns an AgentView, which is what toPaneWire consumes, and the two timestamps
    // then ride through its rest-spread onto the wire shape.
    //
    // WIDENING (`?sessions=all`) IS A READ, AND ONLY OF THE PANE LISTS. Herdr can run several named
    // sessions on this machine, each its own server; until now the phone could look at exactly one
    // of them at a time, which made "what needs me?" a question you had to ask once per session.
    // Widened, the two pane lists hold every local session's panes, each tagged with the session it
    // came from so the phone can address it (types.ts states why ALL of them are tagged, never just
    // the non-primary ones).
    //
    // NOTHING ELSE IN THE BODY WIDENS, and that is the same shape the pack merge already has rather
    // than a shortcut: a peer contributes its `agents` and `shellPanes` and nothing more
    // (pack/merge.ts `PeerSnapshotBody`), because `workspaces`, `tabs` and `bridge` are statements
    // about one link the phone reads one at a time. `bridge`, `workspaces` and `tabs` here stay the
    // AMBIENT session's — the one `?s=` named — exactly as they are today. So the triage lists
    // widen and the navigation tree does not, one dimension down from a pack, where the same is
    // already true of every peer.
    //
    // The ORDER is the registry's own — primary first, then alphabetical — so it matches the
    // `sessions` array below and does not depend on which runtime happened to be spawned first.
    const sources = widen ? registry.ordered() : [rt];
    const paneList = (pick: (rtx: SessionRuntime) => AgentView[]): PaneWire[] => {
      const wired = sources.map((from) => ({
        name: from.name,
        panes: pick(from).map((p) => toPaneWire(withActivity(from, p), hasJournal)),
      }));
      // Not widened is not "widened with one source": an unwidened body must carry NO `session` key
      // at all, which is the whole backward-compatibility claim (solo-baseline.test.ts).
      return widen ? widenedPanes(wired) : wired.flatMap((w) => w.panes);
    };
    // `device` is ASSIGNED below, never conditionally spread: an off deployment sends no such key.
    const body: SnapshotResponse = {
      bridge,
      agents: paneList((from) => from.engine.current().agents),
      shellPanes: paneList((from) => from.engine.current().shellPanes),
      workspaces,
      tabs,
      sessions: registry.list(),
      notifications: { snoozedUntil: snooze.until() },
      update: updateMonitor.status(),
      ts: Date.now(),
    };
    // Only report device state when the feature is on, so an off deployment sends nothing new.
    if (device !== null) body.device = device;
    return body;
  };

  /**
   * This collie's own `(session)` resolution: the identical `registry.get` call the bridge made
   * before packs existed, plus the 404 it always answered. Named once so that BOTH the browser's host
   * gate and the peer's pack dispatch reach a local runtime through the same expression — two
   * spellings of "the primary session, or 404" would be two chances to disagree about what `?session=`
   * means, and §5 says a peer resolves it with today's exact semantics.
   */
  const localRuntime = (session: string | undefined, acceptEncoding: string | null): SessionRuntime | Response =>
    registry.get(session) ??
    jsonError(apiError("session.unknown", { session: session ?? "" }), 404, acceptEncoding);

  /**
   * Everything session-scoped: the pane family, tab create/rename/close, workspace create.
   *
   * ── ONE BLOCK, TWO CALLERS, NO SECOND HANDLER SET ────────────────────────────
   * A browser reaches it through `Bun.serve`'s dispatch below; a LEAD reaches it through this
   * collie's `/pack/v1/*` surface, which hands over this very closure (PACK_PROTOCOL.md §5: "a 1:1
   * re-exposure of the routes the phone already calls, dispatched into the same handlers"). Not a
   * copy that agrees — the same code, so `reply` cannot acquire a pack-only behaviour and `history`
   * cannot acquire a host parameter.
   *
   * What differs between the two callers is *only* who is asking, which is exactly the
   * {@link RouteCaller} it takes: how the caller's request resolves to a runtime (a browser's may
   * resolve to another machine and be forwarded), how the caller is authorised (a browser by
   * `guard()`, a lead by the pack link plus the peer's own device policy — §12), and which audit log
   * the write lands in (the peer's is stamped `via:"pack"`).
   *
   * `null` ⇒ not a session-scoped path; the caller carries on with its own routing.
   */
  const serveSessionRoute = async (
    req: Request,
    url: URL,
    caller: RouteCaller,
  ): Promise<Response | null> => {
    const { pathname } = url;

    // ── "Look now" ────────────────────────────────────────────────────────
    // A READ, and gated as one. It changes nothing — `mux.refresh()` takes a listing and moves a
    // timer (mux/types.ts) — so gating it behind a device would refuse the one thing a read-only
    // phone most obviously may do: ask for a fresh screen. Coalesced so a burst (foreground +
    // visibility + a pull, one operator act) costs one listing.
    if (pathname === "/api/refresh" && req.method === "POST") {
      const denied = caller.gate("read");
      if (denied) return denied;
      const rt = await caller.resolve();
      if (rt instanceof Response) return rt;
      // A refresh is a phone asking to be shown something, which is attention by any reading.
      rt.engine.noteAttention();
      await refreshes.run(rt.name, () => lookNow(rt));
      return json({ ok: true } satisfies ActionResponse, req.headers.get("accept-encoding"));
    }

    // ── Structural creates: new tab / new space (each opens a fresh shell pane) ──
    if (pathname === "/api/tab" && req.method === "POST") {
      const denied = caller.gate("write");
      if (denied) return denied;
      const rt = await caller.resolve();
      if (rt instanceof Response) return rt;
      return createTab(rt.herdr, rt.engine, req, caller.audit, caller.device(), rt.name);
    }
    if (pathname === "/api/workspace" && req.method === "POST") {
      const denied = caller.gate("write");
      if (denied) return denied;
      const rt = await caller.resolve();
      if (rt instanceof Response) return rt;
      return createWorkspace(rt.herdr, rt.engine, req, caller.audit, caller.device(), rt.name);
    }

    // ── Tab actions: rename (set its label) / close (kill it + every pane in it) ──
    const tabMatch = pathname.match(TAB_ACTION_ROUTE);
    if (tabMatch && req.method === "POST") {
      const denied = caller.gate("write");
      if (denied) return denied;
      const rt = await caller.resolve();
      if (rt instanceof Response) return rt;
      const tabId = decodeURIComponent(tabMatch[1]!);
      const action = tabMatch[2];
      const device = caller.device();
      if (action === "close") return closeTab(rt.herdr, rt.engine, tabId, req, caller.audit, device, rt.name);
      return renameTab(rt.herdr, rt.engine, tabId, req, caller.audit, device, rt.name);
    }

    // ── Per-pane read / send ─────────────────────────────────────────────
    const paneMatch = pathname.match(PANE_ROUTE);
    if (paneMatch) {
      const paneId = decodeURIComponent(paneMatch[1]!);
      const action = paneMatch[2];
      // Reading a pane is allowed for any access-gated client; every action (reply/keys/upload/
      // close) types into or restructures a terminal, so it additionally needs an authorised device.
      // `history` is a READ despite being an action segment — it only ever reads a log off disk.
      const isRead = !action || action === "history";
      const denied = caller.gate(isRead ? "read" : "write");
      if (denied) return denied;
      const rt = await caller.resolve();
      if (rt instanceof Response) return rt;
      const { herdr, name: session } = rt;
      // You are in this pane: reading it, replying, sending keys, browsing its history. That is
      // the whole definition of "seen" (.adr/0003), and this is the one place every such request
      // passes through. It cannot false-positive from background polling — the dashboard loader
      // only ever fetches /api/snapshot; paneLoader is the sole reader of pane text — nor from a
      // cross-site request forged at a guessed pane id (see marksPaneSeen).
      //
      // Gated on the request actually being ROUTED below. PANE_ROUTE constrains `action` to the
      // known set, so the only way to reach here unrouted is a method mismatch (a GET at /reply, a
      // POST at /history) — which 405s. Without this a malformed request still marked the pane seen.
      //
      // ── AND IT IS RECORDED EXACTLY ONCE, ON THE OWNING HOST ────────────────
      // A pane on a peer never reaches this line on the LEAD: `caller.resolve()` returned the peer's
      // forwarded response above. It reaches it on the PEER, through the pack dispatch, against the
      // peer's own ledger — which is what makes "seen" one shared fact (.adr/0003) rather than two
      // machines' guesses, and why the `x-collie-seen` header is forwarded verbatim.
      const routed = isRead ? req.method === "GET" : req.method === "POST";
      if (routed && marksPaneSeen(req, action)) activity.noteSeen(session, paneId);
      // A pane request means a phone is looking at this collie — the second of the two routes that
      // stamp attention (state-engine.ts § noteAttention). It is stamped HERE rather than at the
      // browser's dispatch so that a pane the lead FORWARDED to a peer counts on the peer, where
      // the census that attention tightens actually runs.
      if (routed) rt.engine.noteAttention();
      // Every action is a write; attribute it to the authorised device for the audit trail.
      // `history` is a read, so it gets no device attribution (nothing is written to attribute).
      const device = isRead ? null : caller.device();
      const audit_ = caller.audit;

      if (!action && req.method === "GET") return readPane(herdr, cfg, paneId, url, req);
      if (action === "history" && req.method === "GET")
        return paneHistory(cfg, journals, transcripts, rt.engine, paneId, url, req);
      if (action === "reply" && req.method === "POST") return replyPane(herdr, cfg, paneId, req, audit_, device, session);
      if (action === "keys" && req.method === "POST") return keysPane(herdr, cfg, paneId, req, audit_, device, session);
      if (action === "upload" && req.method === "POST") return uploadPane(cfg, paneId, req, audit_, device, session);
      if (action === "close" && req.method === "POST") return closePane(herdr, rt.engine, paneId, req, audit_, device, session);
      if (action === "rename" && req.method === "POST") return renamePane(herdr, rt.engine, paneId, req, audit_, device, session);
      if (action === "focus" && req.method === "POST") return focusPane(herdr, rt.engine, paneId, req, audit_, device, session);
      return text("method not allowed", 405);
    }

    return null;
  };

  // A peer answers its lead with its OWN view and never a merged one — a pack link never forwards a
  // `host=` because a peer has no peers (§4). Hence `localSnapshot`, not the merged body below.
  //
  // The second closure is the per-pane half of the same idea (§5): the lead's request is dispatched
  // into the block above, authorised by the PEER's own gate (bridge/pack/peer-gate.ts) and audited in
  // the PEER's own log with `via:"pack"` and the originating member (§12). The lead's verdict is not
  // an input — it never crosses the wire.
  const packHandler = opts.packRouter?.({
    // Never widened, and stated rather than defaulted: a peer answers its lead with the session the
    // lead asked for, and no lead asks for more than one yet. Turning this on is a PACK_PROTOCOL
    // change (§7.1, additive-optional) and belongs in the commit that also teaches the sweep to ask
    // and `merge.ts` to carry the tag — not to a default argument that quietly widens a wire the
    // spec has not been amended for.
    snapshot: (session) => localSnapshot(session, null, false),
    dispatch: async (req, url, from) => {
      const session = url.searchParams.get("session") ?? undefined;
      const device = packDeviceOf(req);
      const routed = await serveSessionRoute(req, url, {
        resolve: async () => localRuntime(session, null),
        gate: (level) => {
          const verdict = packGate(level, cfg, device);
          return verdict.ok ? null : text(verdict.reason, 403);
        },
        device: () => device,
        audit: audit.scoped({ via: "pack", from }),
      });
      // Deliberately UNCODED. This is the pack link's own 404, answered to a LEAD and never to a
      // browser, and `/pack/v1/*` is a separately-versioned surface (PACK_PROTOCOL.md, ADR 0025) —
      // it keeps today's body in this release. Error codes are the phone's vocabulary, not the
      // pack's.
      return routed ?? jsonError({ error: "not found" }, 404, null);
    },
  });
  // Per-session background notifications live in each session's runtime (built by the factory in
  // index.ts, wired to its StateEngine transitions). The routes here only fan preference changes and
  // snooze-clears across every live session's coordinator.

  // Present ONLY on a peer that pins its lead; ASSIGNED below rather than conditionally spread, so
  // solo and lead keep the zero-tax shape — an absent key, not a disabled one.
  // `ca` is copied out of its readonly array because Bun's `TLSOptions` wants a mutable one.
  const listenerTls = opts.tls === undefined ? undefined : { ...opts.tls, ca: [...opts.tls.ca] };

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    // Runtime cap on any request body — a chunked/lying client is cut off here even if its
    // Content-Length is absent or false. The upload handler still does its own precise check.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // When TLS is present the handshake itself is the first factor: an unpinned or absent client
    // certificate never reaches `fetch` at all, so nothing below has to defend against it.
    tls: listenerTls,

    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // The federated surface, before anything else. It answers only the prefix it owns and returns
      // null otherwise, so this is not a branch a browser request can take. Its admission is two
      // independent factors and shares nothing with `checkAccess()` below — a pack credential never
      // admits an `/api/*` request and a browser credential never admits a pack one
      // (PACK_PROTOCOL.md §6, ADR 0013).
      if (packHandler) {
        const packed = await packHandler(req, url);
        if (packed) return secure(packed);
      }

      // The peer-address check, and it sits HERE — after the federated surface, before the front
      // door — so that the exemption is granted by the surface that has its own admission rather
      // than by a path literal this file must never carry (solo-baseline.test.ts).
      //
      // Everything below trusts headers a client writes (`Tailscale-User-Login`,
      // COLLIE_DEVICE_HEADER, Origin/Host), which are only untamperable while the sole client is the
      // local front door. A pack request is not that, and does not need to be: it was already
      // admitted by pinned mutual TLS plus the pack secret and answered above (PACK_PROTOCOL.md §6,
      // ADR 0013). A pack path the handler DECLINED falls through to here and is refused like any
      // other remote caller. `COLLIE_ALLOW_NON_LOOPBACK_BIND=1` turns the check off wholesale, which
      // is what that flag has always meant.
      if (!cfg.allowNonLoopbackBind && !isLoopbackPeer(server.requestIP(req)?.address)) {
        return text("non-loopback peer rejected", 403);
      }

      // A DEPOSED collie serves one page and fails its health check (§18.12). It sits AFTER the
      // federated surface on purpose: the machine that just deposed this one must still be able to
      // reach `/pack/v1/*` here — that is how it was told, and how it will be told again — while the
      // app, the PWA and `/api/*` are gone. Everything below this line is the front door, and a
      // deposed collie has none.
      const deposedAnswer = opts.deposed?.(req, url);
      if (deposedAnswer) return secure(deposedAnswer);

      // Session-scoped routes accept an optional `?session=<name>`; absent → the primary session
      // (identical to pre-multi-session behaviour). The name is only ever a registry Map lookup — it
      // never builds a path. An unknown name is a 404. Global routes below ignore the param entirely.
      const sessionName = url.searchParams.get("session") ?? undefined;
      const unknownSession = () =>
        jsonError(
          apiError("session.unknown", { session: sessionName ?? "" }),
          404,
          req.headers.get("accept-encoding"),
        );

      // The host dimension of the `(host, session, paneId)` address (§4), read exactly where the
      // session name is and by the same rule: a client-supplied value that is ONLY ever a registry
      // key. Parsed only when this collie has a trust store — the same predicate the pack surface
      // mounts on — so a solo instance never applies the grammar to a URL and `?h=` stays a
      // parameter that provably does not exist there (§11).
      const host = packHandler ? selectHostFrom(url) : LOCAL_HOST;

      /**
       * The `(host, session)` target of a session-scoped route, or the Response refusing it.
       *
       * An unknown host is a 404, mirroring `unknownSession()` exactly (§4) — and so is an
       * ill-formed one, which is the shape a probe takes (a path, a URL, an IP). A *known* peer is
       * FORWARDED, and the peer's own answer is what comes back (§5, §9.1): the load-bearing part is
       * that it is never silently served from the LEAD's registry, because pane ids collide across
       * machines and `?h=laptop` + `w1:p1` must never type into the desk's `w1:p1`.
       *
       * The forward is the only asynchrony this adds, and it is why `target()` is async: a local
       * request does not await a thing it did not do — `registry.get` is still one Map lookup.
       */
      const target = async (): Promise<SessionRuntime | Response> => {
        if (host.kind !== "local") {
          const resolved = packLead?.resolve(host, sessionName);
          if (resolved === undefined) {
            return jsonError(
              apiError("host.unknown", { host: host.kind === "member" ? host.id : host.raw }),
              404,
              req.headers.get("accept-encoding"),
            );
          }
          if (resolved.kind === "peer") {
            // The lead's own record of the forward (§12): one line, the same `action` the peer will
            // write, plus the target host — two independent logs of one event, neither depending on
            // the other machine's disk.
            return secure(
              await packLead!.forward(req, url, resolved, {
                device: whois(req).device,
                audit: (entry) => {
                  // Assigned, never conditionally spread: an entry without a pane or session must
                  // carry NO such key rather than record it as `undefined`.
                  const row: AuditEntry = {
                    action: entry.action,
                    host: entry.host,
                    device: whois(req).device,
                    detail: { forwarded: entry.outcome },
                  };
                  if (entry.paneId !== undefined) row.paneId = entry.paneId;
                  if (entry.session !== undefined) row.session = entry.session;
                  audit.record(row);
                },
              }),
            );
          }
          return resolved.runtime;
        }
        return localRuntime(sessionName, req.headers.get("accept-encoding"));
      };

      // ── Live state (polled by the client) ────────────────────────────────
      if (pathname === "/api/snapshot") {
        const gate = checkAccess(req, cfg);
        if (!gate.ok) return text(gate.reason, 403);
        const device = whois(req);
        // A BROWSER poll is a phone looking; the lead's own sweep of a peer is not, which is why
        // this stamp sits here rather than inside `localSnapshot` (that closure also serves
        // `/pack/v1/snapshot`, and a lead sweeps on its own clock whether or not anybody is reading
        // it — stamping there would pin every peer at `watched` for the life of the pack).
        registry.get(sessionName)?.engine.noteAttention();
        // `?sessions=all` WIDENS the pane lists to every local session (see localSnapshot). One
        // exact spelling and nothing else is accepted: the parameter is a switch, not a list, and a
        // typo must read as "no" rather than as some third behaviour. It does NOT replace `?session=`
        // — the ambient session still decides `bridge`, `workspaces`, `tabs` and the 404 below, so a
        // widened view of an unknown session is still an unknown session.
        const widen = url.searchParams.get("sessions") === "all";
        const body = localSnapshot(sessionName, device.enforced ? device : null, widen);
        if (!body) return unknownSession();
        // The ONE place the lead re-serialises (§9.2). With no pack this is the identity function's
        // absence: `body` goes out as assembled, same keys, same order, same bytes, same ETag.
        // The merged body's ETag is then the lead's own assertion about its own merged view — a
        // peer's ETag is never recomputed here, because no peer body is re-hashed on this path.
        // Tag every snapshot poll with the on-disk build id so an open client notices a live rebuild
        // between polls — the no-service-worker self-update path (web/src/lib/self-update.ts).
        return withBuildHeader(
          json(packLead ? packLead.merge(body) : body, req.headers.get("accept-encoding")),
          await buildId(),
        );
      }

      // ── Session-scoped routes: the pane family, tabs, workspaces ─────────
      // The block itself lives above, shared with the pack surface (§5). What a browser supplies is
      // its own gate (`guard`), its own device attribution, this collie's audit log, and the host
      // gate — which is the one thing a pack caller never has, because a peer has no peers (§4).
      const sessionRouted = await serveSessionRoute(req, url, {
        resolve: target,
        gate: (level) => guard(req, cfg, level, pairing),
        device: () => whois(req).device,
        audit,
      });
      if (sessionRouted) return sessionRouted;

      // ── Misc API ─────────────────────────────────────────────────────────
      if (pathname === "/api/config") {
        // Read-level, like the other non-terminal endpoints. Nothing Collie puts here is a
        // credential — the VAPID public key is handed to every browser by design — but the payload
        // is no longer entirely Collie's: operatorCommands is operator-authored text, and any read
        // client sees it verbatim (`.env.example` says so where it is set).
        // It was also the one route that skipped checkAccess entirely, so COLLIE_PUBLIC_HOSTS
        // didn't cover it and a rebound DNS name could still read the build id. The client only ever
        // calls this same-origin, and a refusal can't be mistaken for an outage: ConnectionBanner
        // short-circuits to AuthErrorBanner before its red-state probe runs. Noted in #32.
        const denied = guard(req, cfg, "read", pairing);
        if (denied) return denied;
        // Re-read per request behind an mtime check, like buildId() — editing commands.toml is live,
        // with no restart. The path is cfg's, never the request's.
        const mine = await operatorCommands();
        const myKeys = await operatorKeys();
        const myReplies = await operatorQuickReplies();
        // The PRIMARY session's adapter, because one collie drives one multiplexer: every session in
        // the registry is built by the same factory off the same `cfg.mux`, so which runtime answers
        // is not a choice. `?.` only because `get()` is total over a Map — the primary is created
        // eagerly in the constructor and never disposed.
        const activeMux = registry.get();
        // Re-resolved per request for the same reason `commands.toml` is: `collie stt setup` is
        // live, and this is where the phone learns whether to draw a microphone at all. `?? undefined`
        // because "no provider" must OMIT the key, never send a null one (PACK_PROTOCOL.md §11).
        const sttWire = (await sttCapability(await stt())) ?? undefined;
        return json(
          bridgeConfigBody({
            push: push.enabled,
            vapidPublicKey: push.publicKey,
            build: await buildId(),
            mode: pack.mode,
            operatorCommands: mine,
            operatorKeys: myKeys,
            operatorQuickReplies: myReplies,
            mux: activeMux?.herdr,
            stt: sttWire,
          }),
          req.headers.get("accept-encoding"),
        );
      }
      if (pathname === MUX_LOGO_PATH && req.method === "GET") {
        // Read-level, exactly like the `/api/config` block that publishes its URL — an image the
        // header shows is part of the same answer, and gating it harder than the config that names
        // it would only ever produce a broken image beside a rendered name. Both device gates stay
        // where they are (writes), so a read-only device still sees the mark.
        const denied = guard(req, cfg, "read", pairing);
        if (denied) return denied;
        // The PRIMARY session's adapter, for the reason `/api/config` gives: one collie drives one
        // multiplexer, so which runtime answers is not a choice.
        const logo = registry.get()?.herdr.logo;
        // 404 rather than an empty 200, and rather than a stand-in: an adapter with no mark
        // publishes no `logoUrl`, so nothing in a current client can even ask this. Reaching here
        // means a stale page holding a URL this bridge no longer serves — and "there is no picture"
        // is the true answer to that.
        if (logo === undefined) return text("this multiplexer has no logo", 404);
        return muxLogoResponse(logo, req.headers.get("if-none-match"));
      }
      if (pathname === "/api/subscribe" && req.method === "POST") {
        // Read-level: registering for push isn't terminal-driving, so a read-only device may still
        // subscribe to notifications.
        const denied = guard(req, cfg, "read", pairing);
        if (denied) return denied;
        let body: JsonValue;
        try {
          // SAFETY: `Request.json()` output IS a JsonValue by construction; `isPushSubscription`
          // checks every field this route stores before a byte of it is persisted.
          body = (await req.json()) as JsonValue;
        } catch {
          return text("bad subscription", 400);
        }
        if (!isPushSubscription(body)) return text("bad subscription", 400);
        await push.addSubscription(body, {
          replaces: supersededEndpoint(body),
          userAgent: req.headers.get("user-agent") ?? undefined,
        });
        return secure(new Response(null, { status: 204 }));
      }
      if (pathname === "/api/notifications/snooze" && req.method === "POST") {
        // Managing your own notification quiet-hours isn't terminal-driving — read-level, like subscribe.
        const denied = guard(req, cfg, "read", pairing);
        if (denied) return denied;
        let body: JsonValue;
        try {
          // SAFETY: `Request.json()` output IS a JsonValue by construction; `snoozedUntil` is
          // checked to be a number (or null) below before it is stored.
          body = (await req.json()) as JsonValue;
        } catch {
          return text("bad request", 400);
        }
        const parsed = parseSnoozeRequest(body);
        if (!parsed.ok) return text("bad snoozedUntil", 400);
        await snooze.set(parsed.until);
        // Snoozing should also clear whatever's already on the lock screen — across every session,
        // since snooze is bridge-wide. Each session owns its own notification slot (tag).
        if (snooze.isMuted()) {
          for (const rt of registry.all()) {
            void push.send({ type: "clear", tag: herdTagFor(rt.isPrimary, rt.name) });
          }
          // …and across every peer's slot. A snooze that only quiets the lead's own sessions is the
          // bug the operator finds at 3am. Nothing is asked of the peer to make this work: the lead
          // raised those alerts and owns the subscription, so an unreachable peer is irrelevant here
          // — there is no policy to deliver and nothing to queue for reconnect (§5).
          for (const tag of peerNotifier?.tags() ?? []) void push.send({ type: "clear", tag });
        }
        return json({ snoozedUntil: snooze.until() }, req.headers.get("accept-encoding"));
      }
      if (pathname === "/api/notifications/prefs") {
        // Which agent statuses push (bridge-wide). Read-level like snooze — managing your own
        // notification preferences isn't terminal-driving.
        if (req.method === "GET") {
          const denied = guard(req, cfg, "read", pairing);
          if (denied) return denied;
          return json(notifyPrefs.current(), req.headers.get("accept-encoding"));
        }
        if (req.method === "POST") {
          const denied = guard(req, cfg, "read", pairing);
          if (denied) return denied;
          let body: JsonValue;
          try {
            // SAFETY: `Request.json()` output IS a JsonValue by construction;
            // `parseNotifyPrefsPatch` rejects anything that is not three optional booleans.
            body = (await req.json()) as JsonValue;
          } catch {
            return text("bad request", 400);
          }
          const patch = parseNotifyPrefsPatch(body);
          if (!patch) return text("bad prefs", 400);
          const updated = await notifyPrefs.set(patch);
          // Prefs may have just disabled a kind — retract any pending/outstanding alerts of it, in
          // every live session (prefs are bridge-wide; each session has its own coordinator).
          for (const rt of registry.all()) rt.notifications.applyPrefs();
          // Same fan, one dimension out — a disabled kind must retract on every host, not just here.
          peerNotifier?.applyPrefs();
          return json(updated, req.headers.get("accept-encoding"));
        }
        return text("method not allowed", 405);
      }
      if (pathname === "/api/update/check" && req.method === "POST") {
        // Force an immediate upstream check (the "check for updates" button), instead of waiting for
        // the periodic timer. Read-level — checking a version isn't terminal-driving — and idempotent
        // (the monitor de-dupes concurrent checks). Returns the fresh status the client revalidates on.
        const denied = guard(req, cfg, "read", pairing);
        if (denied) return denied;
        await updateMonitor.checkRelease();
        return json(updateMonitor.status(), req.headers.get("accept-encoding"));
      }

      // ── Speech-to-text (bridge/stt/) ─────────────────────────────────────
      if (pathname === "/api/stt" && req.method === "POST") {
        // WRITE-gated, exactly like typing into a pane — and for the same reason. This route's whole
        // purpose is to put words in the composer, and the audio leaves the host for an
        // operator-configured endpoint. A read-only device watches; it does not speak.
        const denied = guard(req, cfg, "write", pairing);
        if (denied) return denied;
        // Deliberately NOT session- or pane-scoped: the transcript is text handed back to the
        // phone, which then decides what to do with it. Nothing here touches a terminal, so there is
        // no pane to attribute it to and no `x-collie-seen` meaning to claim.
        const { response, attempt } = await transcribeRequest(await stt(), req, sttAdmission);
        // One line per attempt, and route metadata only: the recording, the transcript and the
        // provider's own words never reach the audit log.
        audit.record({ action: "stt", device: whois(req).device, detail: { ...attempt } });
        return secure(response);
      }

      // ── Device pairing (bridge/pairing.ts) ───────────────────────────────
      if (pathname === "/api/pair" && req.method === "POST") {
        if (!pairing) return text("pairing unavailable", 503);
        // THE BOOTSTRAP, and the one write-shaped route that is deliberately not write-gated: a
        // device that has never paired holds no token, so gating this on one would make pairing
        // unreachable. It is not ungoverned — `checkAccess(…, "write")` still demands a same-origin
        // `Origin` (so no cross-site page can drive it), and the credential it hands out is worthless
        // without a code the operator read off their own terminal in the last ten minutes, behind a
        // five-attempt counter. The header device gate is skipped for the same reason and with the
        // same reasoning: it answers "is this device allowlisted", which is the question pairing
        // exists to stop asking.
        const gate = checkAccess(req, cfg, "write");
        if (!gate.ok) return text(gate.reason, 403);
        let body: JsonValue;
        try {
          // SAFETY: `Request.json()` output IS a JsonValue by construction; `parsePairRequest`
          // re-checks every field of it before any of it is used.
          body = (await req.json()) as JsonValue;
        } catch {
          return jsonError(apiError("pairing.bad_request"), 400, req.headers.get("accept-encoding"));
        }
        const parsed = parsePairRequest(body);
        if (!parsed) {
          return jsonError(apiError("pairing.bad_request"), 400, req.headers.get("accept-encoding"));
        }
        const claimed = await pairing.claim(parsed.code, parsed.label);
        if (!claimed.ok) {
          // Every failure is one status and one machine-readable reason; the client turns the reason
          // into the sentence that says what to do next. No timing or count is leaked back — the
          // attempts remaining are the operator's business, on the operator's terminal.
          // The `error` string is still the bare reason word it has always been — the catalogue
          // entry for each pairing code IS that word — so `recoverPairFailure` in the web app keeps
          // matching it byte for byte while `code` says the same thing the way every other surface
          // now says it.
          return jsonError(
            apiError(PAIRING_ERROR_CODES[claimed.reason]),
            400,
            req.headers.get("accept-encoding"),
          );
        }
        audit.record({ action: "pair", device: parsed.label, detail: { label: parsed.label } });
        // The ONLY time this token exists outside the requesting device. Nothing stores it here.
        return json({ token: claimed.token, label: parsed.label }, req.headers.get("accept-encoding"));
      }
      if (pathname === "/api/pack" && req.method === "GET") {
        // Read-level, exactly like `/api/devices` and `/api/config`: this is a report about machines
        // the operator already owns, and it drives nothing. Every field is a fact this process was
        // already holding — the route reads no disk, dials no member, and cannot start a call.
        const denied = guard(req, cfg, "read", pairing);
        if (denied) return denied;
        // 404 for a solo instance AND for a peer, from one closure. A peer is not a front door
        // (ADR 0013), and a solo instance has no pack to describe — the phone's move is the same in
        // both cases, so the refusal is too. Not a 403: nothing was withheld, there is nothing here.
        const body = packStatus?.() ?? null;
        if (body === null) {
          return jsonError(apiError("pack.not_lead"), 404, req.headers.get("accept-encoding"));
        }
        return json(body, req.headers.get("accept-encoding"));
      }
      if (pathname === "/api/devices" && req.method === "GET") {
        if (!pairing) return text("pairing unavailable", 503);
        // Read-level, so an unpaired device can still see whether pairing is on and which devices
        // hold credentials. Labels are the operator's own names for their own phones; the token
        // hashes never reach this shape (see toDeviceWire).
        const denied = guard(req, cfg, "read", pairing);
        if (denied) return denied;
        const current = pairing.resolve(bearerToken(req.headers))?.label ?? null;
        return json(
          { enforced: pairing.enforced(), current, devices: toDeviceWire(pairing.registry(), current) },
          req.headers.get("accept-encoding"),
        );
      }
      if (pathname === "/api/devices/revoke" && req.method === "POST") {
        if (!pairing) return text("pairing unavailable", 503);
        // A write: revoking is exactly as consequential as typing into a terminal, so it needs a
        // paired device (and the header gate, if configured). Revoking YOURSELF is allowed — that is
        // how a device un-pairs — and it is the last device leaving that switches enforcement back
        // off, which is the only way this feature can't strand an operator.
        const denied = guard(req, cfg, "write", pairing);
        if (denied) return denied;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError(apiError("pairing.bad_request"), 400, req.headers.get("accept-encoding"));
        }
        // SAFETY: `body` is this handler's own `req.json()` output — a JsonValue by construction;
        // `normalizeLabel` refuses anything that is not a usable string.
        const label = normalizeLabel(asJsonRecord(body as JsonValue)?.label);
        if (label === null) {
          return jsonError(apiError("pairing.bad_request"), 400, req.headers.get("accept-encoding"));
        }
        if (!(await pairing.revoke(label))) {
          return jsonError(apiError("device.unknown"), 404, req.headers.get("accept-encoding"));
        }
        audit.record({ action: "device.revoke", device: whois(req).device, detail: { label } });
        const current = pairing.resolve(bearerToken(req.headers))?.label ?? null;
        return json(
          { enforced: pairing.enforced(), current, devices: toDeviceWire(pairing.registry(), current) },
          req.headers.get("accept-encoding"),
        );
      }

      // ── Reserved for a fronting proxy's sign-in page ─────────────────────
      // `/auth/` is the one path the service worker always passes to the network (web/src/lib/
      // sw-routes.ts), so it is the only address an installed PWA can reach when a proxy in front of
      // the bridge refuses a stale session. Collie never routes it. If a request gets this far, no
      // proxy claimed it — say so, instead of letting the SPA fallback answer with the app shell and
      // leave the operator staring at the UI they were trying to escape.
      if (isReservedAuthPath(pathname)) return reservedAuthPlaceholder();

      // ── Static PWA (with SPA fallback) ───────────────────────────────────
      return serveStatic(pathname);
    },
  });

  console.log(`[bridge] listening on http://${cfg.host}:${cfg.port}  (poll ${cfg.pollMs}ms)`);
  if (cfg.deviceHeader) {
    console.log(
      `[bridge] per-device auth ON: trusting '${cfg.deviceHeader}', ${cfg.deviceAllowlist.length} device(s) allowlisted`,
    );
  }
  for (const w of startupWarnings(cfg)) console.warn(w);

  return server;
}

/**
 * The security-posture warnings emitted once at startup, as plain strings (each already prefixed
 * `[bridge] WARNING:`). Pure + exported so the exact set that fires for a given {@link Config} is
 * unit-testable without standing up Bun.serve; the bootstrap in {@link startServer} just logs each
 * via `console.warn`. The identity-gate advice forks on {@link Config.skipServe}: behind a reverse
 * proxy the `Tailscale-User-Login` header is never injected, so trustedUser is inert (nag toward
 * COLLIE_DEVICE_HEADER instead), whereas under `tailscale serve` an empty trustedUser is the open
 * door Variant A closes.
 */
export function startupWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  if (!isLoopbackBindHost(cfg.host)) {
    warnings.push(
      `[bridge] WARNING: bound to ${cfg.host} via COLLIE_ALLOW_NON_LOOPBACK_BIND — the identity, device and same-origin gates are all client-settable on a wide bind, and the peer-address check is off. Whatever fronts this port is now the only control.`,
    );
  }
  if (cfg.deviceHeader && cfg.deviceAllowlist.length === 0) {
    warnings.push(
      `[bridge] WARNING: COLLIE_DEVICE_HEADER set but COLLIE_DEVICE_ALLOWLIST is empty — every device is read-only`,
    );
  }
  if (cfg.skipServe) {
    // Reverse-proxy mode: no tailscale serve injects Tailscale-User-Login, so checkAccess never has
    // an identity to enforce — trustedUser is dead config. Only nag when it's set (a likely mistake).
    if (cfg.trustedUser) {
      warnings.push(
        `[bridge] WARNING: COLLIE_TRUSTED_USER has no effect under COLLIE_SKIP_SERVE=1 — without tailscale serve in front, the Tailscale-User-Login header is never injected. Use COLLIE_DEVICE_HEADER for per-device auth (see DEPLOYMENT.md → Variant C).`,
      );
    }
  } else if (!cfg.trustedUser) {
    warnings.push(
      `[bridge] WARNING: COLLIE_TRUSTED_USER is empty — any tailnet device/user that reaches the bridge gets full write access. Set it to your tailnet login (see README → Variant A).`,
    );
  } else if (cfg.trustedUserOptional) {
    warnings.push(
      `[bridge] WARNING: COLLIE_TRUSTED_USER_OPTIONAL=1 — a request with no Tailscale-User-Login is accepted, so any TAGGED tailnet node (which serve injects no identity for) gets full write access. Unset it outside host-local development.`,
    );
  }
  if (cfg.allowAnyHost) {
    warnings.push(
      `[bridge] WARNING: COLLIE_ALLOW_ANY_HOST=1 — Host-header validation is OFF, so a DNS-rebound page can reach this bridge as if it were same-origin. Unset it and set COLLIE_PUBLIC_HOSTS to the host(s) you serve on.`,
    );
  } else if (
    cfg.publicHosts.length === 0 &&
    cfg.tailscaleHosts.length === 0 &&
    cfg.allowedOrigins.length === 0
  ) {
    warnings.push(
      `[bridge] WARNING: no non-loopback Host is allowed — every request except one addressed to localhost/127.0.0.1 will be rejected with "host not allowed". Set COLLIE_PUBLIC_HOSTS to the exact host(s) you serve on (required behind your own reverse proxy).`,
    );
  }
  return warnings;
}

async function readPane(
  herdr: MuxAdapter,
  cfg: Config,
  paneId: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  // Clamp to a sane ceiling — don't trust the client (or Herdr) to bound an enormous read.
  const lines =
    Number.isFinite(linesParam) && linesParam > 0
      ? Math.min(linesParam, MAX_READ_LINES)
      : cfg.readLines;
  try {
    // "ansi" so the client can render a faithful, colored terminal mirror. It is also, as far as we
    // have probed, why this read leaves the operator's terminal alone: a `recent` read only harvests
    // an alt-screen pane — scrolling it up and back — in `text` format. `lines` here is whatever the
    // web app asked for (600 for the history view), well past any pane's height, so switching this
    // to `strip` would move someone's screen on every revalidate — see the adapter's `readGrid`.
    const read = await herdr.readGrid(paneId, { scope: "recent", lines, styling: "preserve" });
    if (!read.ok) return text(`${herdr.mux} read failed: ${read.detail}`, 502);
    const data = paneReadResponse(paneId, read.value);
    // ETag is derived from the serialised body — if content hasn't changed the client gets a 304
    // and skips the whole transfer (the big win on a cellular link).
    const bodyStr = JSON.stringify(data);
    const etag = computeEtag(bodyStr);
    // Tag pane polls too (both the 304 and the full body), so a client that only has a pane open —
    // not the home snapshot — still observes a live rebuild between polls.
    const build = await buildId();
    if (notModified(req.headers.get("if-none-match"), etag)) {
      // RFC 7232 §4.1: 304 MUST echo the ETag; body MUST be empty.
      return withBuildHeader(
        secure(
          new Response(null, {
            status: 304,
            headers: { etag, "cache-control": "no-store" },
          }),
        ),
        build,
      );
    }
    return withBuildHeader(
      secure(gzipJsonResponse(data, req.headers.get("accept-encoding"), { etag })),
      build,
    );
  } catch (err) {
    return text(`${herdr.mux} read failed: ${errorText(err)}`, 502);
  }
}

/**
 * Map a multiplexer's grid to the REST response body. Pure + exported so the `revision` passthrough
 * (the client's prompt-select race guard depends on it) is covered by the bridge unit tests without
 * standing up Bun.serve / a socket.
 */
export function paneReadResponse(paneId: string, read: MuxGrid): PaneReadResponse {
  return { paneId, text: read.text, truncated: read.truncated, revision: read.revision };
}

/**
 * Parse the history page params. Pure + exported so the clamping is unit-tested without Bun.serve.
 * `before` is an opaque cursor (a turn's uuid) that only ever reaches an in-memory `findIndex`, so it
 * needs no validation beyond length — it never touches the filesystem.
 */
/** One page request off the query string: a clamped size and an optional opaque cursor. */
export type HistoryParams = { limit: number; before?: string };

export function historyParams(url: URL): HistoryParams {
  const raw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_HISTORY_LIMIT) : DEFAULT_HISTORY_LIMIT;
  const before = url.searchParams.get("before");
  const params: HistoryParams = { limit };
  // Assigned, never conditionally spread: an absent/oversized cursor must leave the key OFF, which
  // is what the store reads as "newest page".
  if (before && before.length <= 100) params.before = before;
  return params;
}

/**
 * GET /api/pane/:id/history — the conversation history the pane's terminal cannot provide.
 *
 * The session ref is resolved HERE, from the live snapshot, keyed by pane id — the client never sends
 * one. That is the whole safety story for a route that reads files: the only client-controlled inputs
 * are a pane id (a Map lookup) and an opaque cursor (an array lookup). Which harness knows how to
 * read the log is the registry's decision, so this route stays agent-agnostic.
 */
async function paneHistory(
  cfg: Config,
  journals: Record<string, JournalAdapter> | null,
  transcripts: TranscriptStore | null,
  engine: StateEngine,
  paneId: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const accept = req.headers.get("accept-encoding");
  const unavailable = (reason: "disabled" | "no-session" | "no-log") =>
    json({ paneId, available: false, reason } satisfies PaneHistoryResponse, accept);

  if (!cfg.transcript || transcripts === null || journals === null) return unavailable("disabled");

  const { agents, shellPanes } = engine.current();
  const pane = [...agents, ...shellPanes].find((a) => a.paneId === paneId);
  // No pane, or an agent that named no session (a shell, or a harness whose integration isn't
  // installed): nothing to read, and that's an ordinary answer rather than an error.
  if (!pane?.agentSession) return unavailable("no-session");
  // An agent with no adapter has no journal. Same answer — the UI shouldn't distinguish "this
  // harness isn't supported" from "this pane never started one"; both mean there's nothing to show.
  const adapter = adapterFor(journals, pane.agent);
  if (adapter === undefined) return unavailable("no-session");

  try {
    const page = await transcripts.page(adapter, pane.agentSession, historyParams(url));
    if (page === null) return unavailable("no-log");
    return json({ paneId, available: true, ...page } satisfies PaneHistoryResponse, accept);
  } catch (err) {
    return text(`transcript read failed: ${errorText(err)}`, 502);
  }
}

/** Just the two port calls a reply needs — the real adapter in the bridge, a fake in tests. */
export interface ReplySender {
  typeText(paneId: string, text: string): Promise<MuxAck>;
  sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck>;
}

/** Outcome of the two-step send. `textDelivered` is only meaningful on the failure branch. */
export type ReplyOutcome =
  | { ok: true; textDelivered: boolean }
  | ({ ok: false; textDelivered: boolean } & ApiErrorBody);

/**
 * The reply's two one-shot RPCs — type the text, then send the submit key(s) — as a pure function so
 * the partial-failure branch is unit-testable with a fake client. The important case: if the text
 * lands but the submit keypress fails, we surface a distinct, actionable error and `textDelivered:
 * true` so the client knows NOT to resend (which would duplicate the already-typed text). Pure +
 * exported.
 */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Pause between typing and Enter so the TUI accepts the submit key (preview-action polls ~350ms). */
const REPLY_SETTLE_MS = 350;

export async function sendReplySteps(
  client: ReplySender,
  paneId: string,
  txt: string,
  submit: boolean,
  submitKeys: string[],
  sleep: SleepFn = defaultSleep,
): Promise<ReplyOutcome> {
  let textDelivered = false;
  // One shape for both ways a step can fail — a refusal the adapter returned and an exception it
  // let escape — so the partial-delivery branch cannot drift between them.
  const failed = (reason: string): ReplyOutcome =>
    textDelivered && submit
      ? {
          // Text is already in the pane — only the submit failed. Tell the operator to check/submit
          // it by hand rather than resend, and flag textDelivered so a resend-on-error UI holds off.
          ok: false,
          textDelivered: true,
          ...apiError("reply.not_submitted"),
        }
      : // The multiplexer's own words are the sentence, so they ride in `detail.reason` too — a
        // translated line has no other way to quote them.
        { ok: false, textDelivered, ...apiError("reply.send_failed", { reason }) };
  try {
    if (txt) {
      const typed = await client.typeText(paneId, txt);
      if (!typed.ok) return failed(typed.detail);
      textDelivered = true;
    }
    if (submit) {
      if (txt) await sleep(REPLY_SETTLE_MS);
      const sent = await client.sendKeys(paneId, submitKeys);
      if (!sent.ok) return failed(sent.detail);
    }
    return { ok: true, textDelivered };
  } catch (err) {
    return failed(errorText(err));
  }
}

export async function replyPane(
  herdr: MuxAdapter,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: JsonValue;
  try {
    // SAFETY: `Request.json()` output IS a JsonValue by construction. Every field is checked below
    // before it is used — which is the point: the shape this used to be *declared* as was the
    // client's claim, never a fact.
    body = (await req.json()) as JsonValue;
  } catch {
    return text("bad body", 400);
  }
  const fields = asJsonRecord(body) ?? {};
  const expected = expectedPrompt(fields);
  if (!expected.ok) return text("bad expected_prompt", 400);
  // `text`/`submit` are CHECKED, not assumed. They used only to be declared string/boolean, so a
  // body that lied handed a non-string to `pane.send_text` (herdr refused it one layer down) or
  // made `submit ?? true` follow a truthiness path nobody wrote. A malformed write is refused here,
  // with nothing typed and nothing submitted.
  if (fields.text !== undefined && typeof fields.text !== "string") return text("bad text", 400);
  if (fields.submit !== undefined && typeof fields.submit !== "boolean") return text("bad submit", 400);
  const txt = fields.text ?? "";
  const submit = fields.submit ?? true;
  const ae = req.headers.get("accept-encoding");
  const binding = expected.present
    ? await checkPromptBinding(herdr, cfg, paneId, expected.value)
    : null;
  if (binding && !binding.ok) {
    audit.record({
      action: "reply",
      paneId,
      session,
      device,
      detail: {
        text: txt,
        submit,
        submitted: false,
        textDelivered: false,
        promptBinding: binding.audit,
      },
    });
    return promptBindingFailure(binding, ae);
  }
  const outcome = await sendReplySteps(herdr, paneId, txt, submit, cfg.submitKeys);
  const replyDetail: AuditDetail = {
    text: txt,
    submit,
    submitted: outcome.ok,
    textDelivered: outcome.textDelivered,
  };
  // Assigned, never conditionally spread: an unbound reply records no `promptBinding` key.
  if (binding) replyDetail.promptBinding = binding.audit;
  // Audit the attempt regardless of outcome — text may have landed even when the submit failed.
  audit.record({
    action: "reply",
    paneId,
    session,
    device,
    detail: replyDetail,
  });
  if (outcome.ok) return json({ ok: true } satisfies ActionResponse, ae);
  const failure: ActionResponse = {
    ok: false,
    error: outcome.error,
    textDelivered: outcome.textDelivered,
    code: outcome.code,
  };
  // Assigned, never conditionally spread: a refusal with nothing to interpolate carries NO `detail`
  // key rather than an empty object the client would have to tell apart from a real one.
  if (outcome.detail !== undefined) failure.detail = outcome.detail;
  return json(failure, ae);
}

export async function keysPane(
  herdr: MuxAdapter,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: JsonValue;
  try {
    // SAFETY: `Request.json()` output IS a JsonValue by construction. Every field is checked below
    // before it is used — which is the point: the shape this used to be *declared* as was the
    // client's claim, never a fact.
    body = (await req.json()) as JsonValue;
  } catch {
    return text("bad body", 400);
  }
  const fields = asJsonRecord(body) ?? {};
  const expected = expectedPrompt(fields);
  if (!expected.ok) return text("bad expected_prompt", 400);
  const keys = Array.isArray(fields.keys) ? fields.keys.filter((k): k is string => typeof k === "string") : [];
  if (keys.length === 0) return text("no keys", 400);
  const ae = req.headers.get("accept-encoding");
  const binding = expected.present
    ? await checkPromptBinding(herdr, cfg, paneId, expected.value)
    : null;
  if (binding && !binding.ok) {
    audit.record({
      action: "keys",
      paneId,
      session,
      device,
      detail: { keys, promptBinding: binding.audit },
    });
    return promptBindingFailure(binding, ae);
  }
  const keysDetail: AuditDetail = { keys };
  // Assigned, never conditionally spread: an unbound send records no `promptBinding` key.
  if (binding) keysDetail.promptBinding = binding.audit;
  const sent = await herdr.sendKeys(paneId, keys);
  if (sent.ok) {
    audit.record({
      action: "keys",
      paneId,
      session,
      device,
      detail: keysDetail,
    });
    return json({ ok: true } satisfies ActionResponse, ae);
  }
  if (binding) {
    audit.record({
      action: "keys",
      paneId,
      session,
      device,
      detail: { keys, sent: false, promptBinding: binding.audit },
    });
  }
  return json(
    { ok: false, ...apiError("keys.send_failed", { reason: sent.detail }) } satisfies ActionResponse,
    ae,
  );
}

type ExpectedPrompt =
  | { ok: true; present: false }
  | { ok: true; present: true; value: string }
  | { ok: false };

function expectedPrompt(body: JsonObject): ExpectedPrompt {
  if (!Object.prototype.hasOwnProperty.call(body, "expected_prompt")) {
    return { ok: true, present: false };
  }
  const value = body.expected_prompt;
  if (typeof value !== "string" || value.length > MAX_EXPECTED_PROMPT_CHARS) {
    return { ok: false };
  }
  return { ok: true, present: true, value };
}

type PromptBindingCheck =
  | {
      ok: true;
      audit: { checked: true; passed: true; expected: string };
    }
  | {
      ok: false;
      error: string;
      detail?: ApiErrorDetail;
      status: 409 | 502;
      code: ErrorCode;
      audit: {
        checked: true;
        passed: false;
        expected: string;
        reason: Extract<PromptBindingResult, { ok: false }>["reason"] | "read_failed";
      };
    };

/**
 * The binding check's "the read didn't happen" answer, for both ways it can not happen — a refusal
 * the adapter returned and an exception it let escape. One shape, one wording, one audit reason.
 */
function readFailed(
  herdr: MuxAdapter,
  expected: string,
  detail: string,
): Extract<PromptBindingCheck, { ok: false }> {
  return {
    ok: false,
    ...apiError("prompt.read_failed", { mux: herdr.mux, detail }),
    status: 502,
    audit: { checked: true, passed: false, expected, reason: "read_failed" },
  };
}

// There is deliberately no expected_blocked flag. agent_status is not carried by pane.read, only by
// session.snapshot, so checking it would cost a second RPC before the write and widen the very
// window this feature exists to shrink. The region check already subsumes it: if the exact prompt
// text is still on screen, that prompt is still what the pane is showing.
async function checkPromptBinding(
  herdr: MuxAdapter,
  cfg: Config,
  paneId: string,
  expected: string,
): Promise<PromptBindingCheck> {
  let fresh: MuxGrid;
  try {
    const expectedRawLines = expected.split(/\r\n?|\n/).length;
    const bindingReadLines = Math.min(
      MAX_READ_LINES,
      Math.max(
        cfg.readLines,
        expectedRawLines + DEFAULT_PROMPT_TAIL_LINES + PROMPT_BINDING_BLANK_LINE_HEADROOM,
      ),
    );
    // Keep this coupled to readPane(): use its recent scope and preserved styling so the bridge
    // verifies the same kind of pane data the GET handler serves. The line count deliberately does
    // not follow cfg.readLines alone because a small legal setting may not contain the expected
    // region; include room for the accepted tail and for blank separator lines normalization drops.
    const read = await herdr.readGrid(paneId, {
      scope: "recent",
      lines: bindingReadLines,
      styling: "preserve",
    });
    if (!read.ok) return readFailed(herdr, expected, read.detail);
    fresh = read.value;
  } catch (err) {
    return readFailed(herdr, expected, errorText(err));
  }

  const result = verifyExpectedPrompt(fresh.text, expected);
  if (!result.ok) {
    return {
      ok: false,
      ...apiError("prompt_changed"),
      status: 409,
      audit: { checked: true, passed: false, expected, reason: result.reason },
    };
  }

  // This is a mitigation, not a guarantee. The re-read and the send_keys are two separate herdr
  // RPCs, so a TOCTOU window remains by construction; it shrinks from seconds (poll interval + push
  // latency + human reaction time) to the few milliseconds between two local RPCs. It removes the
  // human-latency portion of the window, which is where essentially all of the real risk lives.
  // Closing the window completely would need a conditional-input primitive in herdr (send_keys with
  // a precondition rejected atomically server-side), which does not exist today.
  return { ok: true, audit: { checked: true, passed: true, expected } };
}

function promptBindingFailure(
  result: Extract<PromptBindingCheck, { ok: false }>,
  acceptEncoding: string | null,
): Response {
  const failure: ActionResponse = { ok: false, error: result.error, code: result.code };
  // Assigned, never conditionally spread: a refusal with nothing to interpolate carries no `detail`.
  if (result.detail !== undefined) failure.detail = result.detail;
  return json(failure, acceptEncoding, result.status);
}

/**
 * A phone just changed this herd's shape or its names — take a fresh look before answering.
 *
 * WHY EVERY MUTATING ROUTE ENDS HERE. The phone's next act after a tab rename is to revalidate, and
 * what it revalidates is the STATE ENGINE's snapshot. Without this the engine would still be holding
 * the pre-change herd, and the strip would keep the old label until the adapter's census caught up —
 * up to the bound the adapter declares (`topologyLatency`), which on a censusing multiplexer is long
 * enough for an operator to conclude the rename did not work and do it again.
 *
 * The create routes already hand back the identity they created, and that stays: it is what lets the
 * phone navigate into a new pane at once. This is about the STRIP being right, which no create
 * response can carry.
 *
 * Cheap where it is already fresh — a pushing adapter's `refresh()` resolves immediately (see the
 * port) — so this costs a listing only on the adapters that actually needed one.
 */
async function settleTopology(herdr: MuxAdapter, engine: StateEngine): Promise<void> {
  try {
    await herdr.refresh();
  } catch (err) {
    // A refresh that could not happen leaves the herd exactly as stale as it already was, and the
    // write it follows SUCCEEDED — reporting a failure here would tell the operator their rename
    // did not land when it did.
    console.warn(`[refresh] after a write: ${errorText(err)}`);
  }
  engine.pokeNow();
}

// Close a pane ("kill the agent"). Structural op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
async function closePane(
  herdr: MuxAdapter,
  engine: StateEngine,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  const closed = await herdr.closePane(paneId);
  if (!closed.ok) {
    return json(
      { ok: false, ...apiError("pane.close_failed", { reason: closed.detail }) } satisfies ActionResponse,
      ae,
    );
  }
  audit.record({ action: "pane.close", paneId, session, device, detail: {} });
  await settleTopology(herdr, engine);
  return json({ ok: true } satisfies ActionResponse, ae);
}

/**
 * Put a pane on the OPERATOR's own screen — the "Show in terminal" row, and nothing else.
 *
 * The only route in the bridge that moves a human's terminal, and it exists because the alternative
 * — following the phone's navigation automatically — would move it as a side effect of scrolling a
 * list. It is a write like any other: same device gate, same audit line, no body to validate.
 *
 * `unsupported` arrives here as a failure with the adapter's own sentence, and that is correct
 * BEHIND a UI that hides the row when the capability is absent: the row is gone, so this answer is
 * only ever seen by a client whose config is stale.
 */
async function focusPane(
  herdr: MuxAdapter,
  engine: StateEngine,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  const focused = await herdr.setFocus(paneId);
  if (!focused.ok) {
    return json(
      { ok: false, ...apiError("pane.focus_failed", { reason: focused.detail }) } satisfies ActionResponse,
      ae,
    );
  }
  audit.record({ action: "pane.focus", paneId, session, device, detail: {} });
  // `focused` is a fact the snapshot reports, so moving it is a change the phone's next poll must
  // carry — otherwise the pane the operator just showed on their terminal would keep reading as
  // unfocused for as long as the adapter's declared bound (ADR 0031).
  await settleTopology(herdr, engine);
  return json({ ok: true } satisfies ActionResponse, ae);
}

// Set or clear a pane's label. Structural metadata op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
// The body's `label` must be a string or null; a blank string clears (so a user can wipe a label by
// saving an empty field), which we send to Herdr as `label: null`.
async function renamePane(
  herdr: MuxAdapter,
  engine: StateEngine,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  let body: JsonValue;
  try {
    // SAFETY: `Request.json()` output IS a JsonValue by construction. Every field is checked below
    // before it is used — which is the point: the shape this used to be *declared* as was the
    // client's claim, never a fact.
    body = (await req.json()) as JsonValue;
  } catch {
    return text("bad body", 400);
  }
  const fields = asJsonRecord(body) ?? {};
  if (fields.label !== null && typeof fields.label !== "string") return text("bad label", 400);
  const trimmed = typeof fields.label === "string" ? fields.label.trim() : "";
  const label = trimmed.length > 0 ? trimmed : null;
  const renamed = await herdr.renamePane(paneId, label);
  if (!renamed.ok) {
    return json(
      { ok: false, ...apiError("pane.rename_failed", { reason: renamed.detail }) } satisfies ActionResponse,
      ae,
    );
  }
  audit.record({ action: "pane.rename", paneId, session, device, detail: { label } });
  await settleTopology(herdr, engine);
  return json({ ok: true } satisfies ActionResponse, ae);
}

/**
 * Validate an untrusted tab-rename body's `label`. A tab label is a NON-null, NON-empty string:
 * herdr's `tab.rename` rejects `null`, and an empty string is stored literally (a blank tab chip)
 * rather than clearing to the default number — both live-verified 2026-07-19. So, unlike a pane label
 * (where a blank field clears to `null`), Collie has no "clear" for a tab and rejects a blank label.
 * Pure + exported so the rule is unit-testable without standing up Bun.serve.
 */
export function normalizeTabLabel(
  v: JsonValue | undefined,
): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof v !== "string") return { ok: false, error: "bad label" };
  const label = v.trim();
  if (!label) return { ok: false, error: "label required" };
  return { ok: true, label };
}

// Set a tab's label. Structural metadata op — strictly less powerful than the text/keys injection the
// bridge already allows, so it stays within the existing remote-shell threat model. A tab has no
// "clear" (see normalizeTabLabel): a blank label is a 400, not a reset to the tab number.
async function renameTab(
  herdr: MuxAdapter,
  engine: StateEngine,
  tabId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  let body: JsonValue;
  try {
    // SAFETY: `Request.json()` output IS a JsonValue by construction. Every field is checked below
    // before it is used — which is the point: the shape this used to be *declared* as was the
    // client's claim, never a fact.
    body = (await req.json()) as JsonValue;
  } catch {
    return text("bad body", 400);
  }
  const parsed = normalizeTabLabel(asJsonRecord(body)?.label);
  if (!parsed.ok) return text(parsed.error, 400);
  const renamed = await herdr.renameTab(tabId, parsed.label);
  if (!renamed.ok) {
    return json(
      { ok: false, ...apiError("tab.rename_failed", { reason: renamed.detail }) } satisfies ActionResponse,
      ae,
    );
  }
  audit.record({ action: "tab.rename", session, device, detail: { tabId, label: parsed.label } });
  await settleTopology(herdr, engine);
  return json({ ok: true } satisfies ActionResponse, ae);
}

// Close a tab, killing every pane inside it (live-verified 2026-07-19: the tab's panes disappear with
// it — see HERDR_API.md). Structural op — no more powerful than closing those panes one-by-one, which
// the bridge already allows via pane.close — so it stays within the existing remote-shell threat
// model. No body: the tab id is in the path.
async function closeTab(
  herdr: MuxAdapter,
  engine: StateEngine,
  tabId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  const closed = await herdr.closeTab(tabId);
  if (!closed.ok) {
    return json(
      { ok: false, ...apiError("tab.close_failed", { reason: closed.detail }) } satisfies ActionResponse,
      ae,
    );
  }
  audit.record({ action: "tab.close", session, device, detail: { tabId } });
  await settleTopology(herdr, engine);
  return json({ ok: true } satisfies ActionResponse, ae);
}

// Create a new tab in a workspace, opening a fresh shell pane (you then launch your own agent in
// it). Structural — no more privilege than typing into an existing pane (you can already spawn a
// shell that way). `cwd` omitted => inherits the workspace dir. session.* stays unexposed.
async function createTab(
  herdr: MuxAdapter,
  engine: StateEngine,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: JsonValue;
  try {
    // SAFETY: `Request.json()` output IS a JsonValue by construction. Every field is checked below
    // before it is used — which is the point: the shape this used to be *declared* as was the
    // client's claim, never a fact.
    body = (await req.json()) as JsonValue;
  } catch {
    return text("bad body", 400);
  }
  const fields = asJsonRecord(body) ?? {};
  // Each field is CHECKED rather than declared: a non-string `workspaceId` used to reach `.trim()`
  // and throw a TypeError out of the handler.
  const workspaceId = typeof fields.workspaceId === "string" ? fields.workspaceId.trim() : undefined;
  const tabLabel = typeof fields.label === "string" ? fields.label : undefined;
  const cwd = typeof fields.cwd === "string" ? fields.cwd : undefined;
  const ae = req.headers.get("accept-encoding");
  if (!workspaceId) {
    return json({ ok: false, ...apiError("tab.workspace_required") } satisfies CreateResponse, ae);
  }
  const outcome = await herdr.createTab({ spaceId: workspaceId, label: tabLabel, cwd });
  if (!outcome.ok) {
    return json(
      { ok: false, ...apiError("tab.create_failed", { reason: outcome.detail }) } satisfies CreateResponse,
      ae,
    );
  }
  const created = outcome.value;
  // The adapter answers with the space id when the create call doesn't carry a label back; the
  // snapshot we already hold knows the real one, and that lookup is cheaper than a round trip.
  const workspaceLabel =
    engine.current().workspaces.find((w) => w.workspaceId === created.spaceId)?.label ??
    created.spaceLabel;
  audit.record({
    action: "tab.create",
    paneId: created.paneId,
    session,
    device,
    detail: { workspaceId, label: tabLabel, cwd },
  });
  await settleTopology(herdr, engine);
  return json({
    ok: true,
    pane: {
      paneId: created.paneId,
      workspaceId: created.spaceId,
      workspaceLabel,
      tabId: created.tabId,
      cwd: created.cwd,
    },
  } satisfies CreateResponse, ae);
}

// Create a new workspace ("space") with a fresh shell pane. `cwd` defaults to the user's home dir
// when the client doesn't specify one (typing a path on a phone is painful) — it's a shell, so you
// can cd from there. Same structural-only threat model as createTab.
async function createWorkspace(
  herdr: MuxAdapter,
  engine: StateEngine,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: JsonValue;
  try {
    // SAFETY: `Request.json()` output IS a JsonValue by construction. Every field is checked below
    // before it is used — which is the point: the shape this used to be *declared* as was the
    // client's claim, never a fact.
    body = (await req.json()) as JsonValue;
  } catch {
    return text("bad body", 400);
  }
  const fields = asJsonRecord(body) ?? {};
  // Checked, not declared — see createTab.
  const cwd = (typeof fields.cwd === "string" ? fields.cwd.trim() : "") || homedir();
  const label = typeof fields.label === "string" ? fields.label : undefined;
  const ae = req.headers.get("accept-encoding");
  const outcome = await herdr.createSpace({ cwd, label });
  if (!outcome.ok) {
    return json(
      { ok: false, ...apiError("workspace.create_failed", { reason: outcome.detail }) } satisfies CreateResponse,
      ae,
    );
  }
  const created = outcome.value;
  audit.record({
    action: "workspace.create",
    paneId: created.paneId,
    session,
    device,
    detail: { label, cwd },
  });
  await settleTopology(herdr, engine);
  return json({
    ok: true,
    pane: {
      paneId: created.paneId,
      workspaceId: created.spaceId,
      workspaceLabel: created.spaceLabel,
      tabId: created.tabId,
      cwd: created.cwd,
    },
  } satisfies CreateResponse, ae);
}

// Save an uploaded image to a host file and return its absolute path. The client then references
// that path in a message; Claude Code / Codex read images by path (the terminal can't take a
// pasted image over the socket). Validated by MIME and size; the filename is server-generated.
async function uploadPane(
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  // Reject an oversize upload by its declared Content-Length BEFORE buffering — req.formData()
  // reads the whole body into memory first, so a 100 MB "image" would be materialised just to fail
  // the size check below. Multipart adds a boundary + part headers, so allow a small slack.
  if (uploadTooLarge(req.headers.get("content-length"))) {
    return secure(
      new Response(
        JSON.stringify({
          ok: false,
          ...apiError("upload.too_large", { maxBytes: MAX_UPLOAD_BYTES }),
        } satisfies UploadResponse),
        { status: 413, headers: { "content-type": "application/json; charset=utf-8" } },
      ),
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text("expected multipart form data", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ ok: false, ...apiError("upload.no_file") } satisfies UploadResponse, ae);
  }
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const ext = imageExtFromBytes(head);
  if (!ext) {
    // The client's own Content-Type rides along as the DETAIL only — it names what the operator
    // thought they sent, and the decision above never consulted it.
    return json(
      { ok: false, ...apiError("upload.bad_type", { type: file.type || "unknown" }) } satisfies UploadResponse,
      ae,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json(
      { ok: false, ...apiError("upload.too_large", { maxBytes: MAX_UPLOAD_BYTES }) } satisfies UploadResponse,
      ae,
    );
  }
  try {
    const dir = join(cfg.stateDir, "uploads");
    // 0700 — uploads (and the state dir they live under) may hold sensitive images; keep them
    // owner-only. recursive:true applies the mode to any intermediate dirs it creates too.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const safePane = paneId.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = `${safePane}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const fullPath = join(dir, filename);
    await Bun.write(fullPath, file);
    audit.record({
      action: "upload",
      paneId,
      session,
      device,
      detail: { filename: file.name, size: file.size, saved: filename },
    });
    return json({ ok: true, path: fullPath } satisfies UploadResponse, ae);
  } catch (err) {
    return json(
      { ok: false, ...apiError("upload.write_failed", { reason: errorText(err) }) } satisfies UploadResponse,
      ae,
    );
  }
}

/**
 * Access gate for the API:
 *  - Host allowlist (fail-closed): the request's Host header must be a loopback form, an explicit
 *    COLLIE_PUBLIC_HOSTS entry, a ctl-discovered Tailscale host (COLLIE_TAILSCALE_HOSTS), or the
 *    host of an allowed origin — otherwise rejected, BEFORE any Origin logic. This defeats DNS
 *    rebinding (Host==Origin==evil.example). COLLIE_ALLOW_ANY_HOST=1 is the explicit opt-out.
 *  - Same-origin only (Origin host must equal Host) — defeats cross-site requests/CSRF. Browsers
 *    omit Origin on same-origin GETs (so the snapshot poll passes); they send it on POSTs.
 *    localhost and explicitly-configured origins are also allowed.
 *  - Origin required for writes: a state-changing (`level === "write"`) request with no Origin is
 *    trusted only from loopback (curl on the host). Browsers always send Origin on fetch/SW POSTs,
 *    so a missing Origin on a remote write is a non-browser or Origin-stripped request — reject it.
 *  - Tailscale identity: when a trusted user is configured under `tailscale serve`, the request
 *    must carry a matching `Tailscale-User-Login`. A missing header is rejected too — serve injects
 *    none for tagged nodes. Under COLLIE_SKIP_SERVE=1 or COLLIE_TRUSTED_USER_OPTIONAL=1, only a
 *    mismatch is rejected.
 */
export function checkAccess(
  req: Request,
  cfg: Config,
  level: "read" | "write" = "read",
): { ok: true } | { ok: false; reason: string } {
  const host = req.headers.get("host") ?? "";

  // Host-header allowlist — ALWAYS ON, before the Origin logic, so a rebinding request
  // (Host==Origin==evil) never reaches it. COLLIE_ALLOW_ANY_HOST=1 is the operator's explicit opt-out.
  if (!cfg.allowAnyHost && !isHostAllowed(host, cfg)) {
    return { ok: false, reason: "host not allowed" };
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: "bad origin" };
    }
    const allowed =
      originHost === host ||
      LOOPBACK_HOST.test(originHost) ||
      cfg.allowedOrigins.includes(origin);
    if (!allowed) return { ok: false, reason: "cross-origin rejected" };
  } else if (level === "write" && !LOOPBACK_HOST.test(host)) {
    // A write with no Origin header from a non-loopback Host isn't a real browser request — refuse.
    return { ok: false, reason: "origin required" };
  }

  if (cfg.trustedUser) {
    const login = req.headers.get("tailscale-user-login");
    if (login) {
      if (login !== cfg.trustedUser) return { ok: false, reason: "identity not trusted" };
    } else if (!cfg.skipServe && !cfg.trustedUserOptional) {
      // Fail closed: `tailscale serve` injects no Tailscale-User-* for TAGGED nodes, so an absent
      // header is not "a loopback caller" — it is any tagged node on the tailnet.
      return { ok: false, reason: "identity required" };
    }
  }
  return { ok: true };
}

/**
 * Whether a Host header is one the bridge will answer to under the fail-closed host allowlist: a
 * loopback form, an explicit COLLIE_PUBLIC_HOSTS entry, a discovered Tailscale host (bare or with
 * port), or the host of a configured allowed origin. Pure + exported for tests.
 */
export function isHostAllowed(host: string, cfg: Config): boolean {
  if (!host) return false;
  if (LOOPBACK_HOST.test(host)) return true;
  if (cfg.publicHosts.includes(host)) return true;
  const bare = host.replace(/:\d+$/, "");
  if (cfg.tailscaleHosts.some((h) => h === host || h === bare)) return true;
  return cfg.allowedOrigins.some((o) => {
    try {
      return new URL(o).host === host;
    } catch {
      return false;
    }
  });
}

/**
 * Combined API gate used by every handler. A request must always pass {@link checkAccess}
 * (same-origin / CSRF + optional Tailscale identity). A `"write"` request — one that types into a
 * terminal or creates panes — must additionally come from an authorised device (see
 * {@link deviceAuth}). Returns a 403 Response to short-circuit on denial, or null to proceed.
 *
 * Exported for tests: {@link deviceAuth} being correct in isolation proves nothing if this wiring
 * regresses, and the write/read asymmetry below is exactly what a device gate stands or falls on.
 */
export function guard(
  req: Request,
  cfg: Config,
  level: "read" | "write",
  pairing?: PairingGate,
): Response | null {
  const gate = checkAccess(req, cfg, level);
  if (!gate.ok) return text(gate.reason, 403);
  if (level !== "write") return null;
  if (!deviceAuth(req, cfg).authorized) return text("device not authorised", 403);
  // The second, independent write factor. Distinct refusal text on purpose: "not authorised" is the
  // operator's proxy allowlist, "not paired" is this device's own missing credential, and the two
  // are fixed in completely different places.
  if (pairing !== undefined && pairing.enforced() && pairing.resolve(bearerToken(req.headers)) === null) {
    return text("device not paired", 403);
  }
  return null;
}

/**
 * The bridge's dependency on {@link PairingStore}, structurally: two synchronous questions asked on
 * the request path. Named here rather than importing the class so the gate wiring below states
 * exactly what it needs — and so a test can pass a two-line object.
 */
export interface PairingGate {
  /** Whether a bearer token is required for writes (i.e. at least one device is paired). */
  enforced(): boolean;
  /** The device this token belongs to, or null. */
  resolve(token: string | null): { label: string } | null;
}

/**
 * Who this request is, across BOTH device gates — the value that lands in the audit log and in the
 * snapshot's `device` field.
 *
 * A pairing label is preferred over the header name because it is the stronger claim: the label was
 * chosen by someone holding a code the operator read off a terminal, whereas the header is whatever
 * the proxy asserts. When pairing is off this returns exactly what {@link deviceAuth} always did, so
 * a deployment that never pairs anything sees no change at all — including the `device` field's
 * absence from the snapshot.
 */
export function requestDevice(req: Request, cfg: Config, pairing?: PairingGate): DeviceAuth {
  const header = deviceAuth(req, cfg);
  if (pairing === undefined || !pairing.enforced()) return header;
  const paired = pairing.resolve(bearerToken(req.headers));
  return {
    enforced: true,
    device: paired?.label ?? header.device,
    // Both gates apply, so authorisation is their conjunction — an allowlisted header on an unpaired
    // device is still read-only, and vice versa.
    authorized: header.authorized && paired !== null,
  };
}

/**
 * Optional per-device authorisation, layered on top of {@link checkAccess}. Off by default; enabled
 * by setting COLLIE_DEVICE_HEADER to the header a trusted upstream proxy injects, carrying an opaque
 * device identifier. The header is trusted only because the bridge binds loopback behind the proxy,
 * so a direct client can't forge it (the same trust basis as the Tailscale identity header). Matrix:
 *
 *   - feature off (no header configured) → not enforced, fully authorised (today's behaviour).
 *   - header absent                      → read-only, same as an unlisted device. Configuring the
 *                                          header is the operator asserting that the proxy sets it
 *                                          on every request, so a request without one did not come
 *                                          through that proxy and must not drive a terminal.
 *   - header present, value allowlisted  → authorised; the session is attributed to that device.
 *   - header present, value not listed   → read-only. The "unknown" sentinel is never authorised,
 *                                          and an empty allowlist makes every device read-only — a
 *                                          fail-closed default for a security toggle you turned on.
 *
 * "Read-only" is the whole scope of this gate, deliberately: {@link guard} consults it only for
 * `"write"`, so a header-less caller still reads panes. That is the existing design (a read-only
 * device is meant to watch), and this function does not change it. What changes is that a missing
 * header no longer counts as the operator.
 *
 * The absent-header case deliberately has no loopback exemption. It looks like the natural place for
 * one, but every supported front door is a proxy co-located with the bridge (tailscale serve and the
 * documented reverse proxies all connect to 127.0.0.1), so a loopback peer says nothing about
 * whether the caller is the operator on the host or a remote client whose proxy failed to inject the
 * header. Driving a pane from the host is still one flag away: send an allowlisted id yourself.
 */
export function deviceAuth(req: Request, cfg: Config): DeviceAuth {
  if (!cfg.deviceHeader) return { enforced: false, device: null, authorized: true };
  const raw = req.headers.get(cfg.deviceHeader);
  const device = raw?.trim() ? raw.trim() : null;
  if (!device) return { enforced: true, device: null, authorized: false };
  const authorized = device !== "unknown" && cfg.deviceAllowlist.includes(device);
  return { enforced: true, device, authorized };
}

// Apply the shared hardening headers (nosniff / no-referrer) to any response. Every response the
// bridge emits funnels through json(), text(), serveStatic(), or a handful of inline responses —
// all of which pass through here — so the headers are set exactly once, consistently.
function secure(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

function json<TBody>(data: TBody, acceptEncoding: string | null, status = 200): Response {
  const response = gzipJsonResponse(data, acceptEncoding);
  if (status === 200) return secure(response);
  return secure(new Response(response.body, { status, headers: response.headers }));
}

/**
 * A JSON error body with a non-200 status (e.g. an unknown-session 404). The body is tiny (below the
 * gzip threshold), so a plain uncompressed JSON response is the whole story — no need for the gzip
 * path. `acceptEncoding` is accepted for call-site symmetry with {@link json} but not needed here.
 *
 * It takes a BODY rather than a message so a caller must have gone through {@link apiError} to get
 * one — which is what keeps a refusal's English and its code in the catalogue together. The bare
 * `{ error }` shape stays legal for the one caller that must not carry a code: the pack link's 404.
 */
function jsonError(
  body: ApiErrorBody | { error: string },
  status: number,
  _acceptEncoding: string | null,
): Response {
  return secure(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

/** The message of a thrown value, without assuming the `catch` handed us an Error. */
function errorText<T>(err: T): string {
  return err instanceof Error ? err.message : String(err);
}

/** The headers {@link serveStatic} composes. `.html` and `sw.js` each add one more. */
type StaticHeaders = {
  "content-type": string;
  "cache-control": string;
  "content-security-policy"?: string;
  "service-worker-allowed"?: string;
} & Record<string, string>;

function text(body: string, status: number): Response {
  return secure(new Response(body, { status }));
}

/**
 * Validate an untrusted `/api/pair` body. Both fields must be present strings; the label is bounded
 * and flattened by {@link normalizeLabel} (it is echoed into the audit log and the UI), and the code
 * is only length-bounded here — its actual verification is a constant-time hash compare, and telling
 * a caller "that isn't even code-shaped" would be a free oracle. Pure + exported because the handler
 * lives inside `Bun.serve`, which `bun test` cannot stand up (CLAUDE.md).
 */
/** The record inside a parsed JSON body, or null when the body isn't one (a scalar, an array). */
function asJsonRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/** A `/api/pair/claim` body, once it is one. */
type PairRequest = { code: string; label: string };

/**
 * Validate an untrusted /api/notifications/snooze body's `snoozedUntil`.
 *
 * ABSENCE IS NOT `null`, and the difference is the whole contract: an explicit `null` CLEARS the
 * snooze, while an omitted field is a malformed request (400) — collapsing the two would let an
 * empty body silently unmute every session's notifications. A number is a deadline in epoch ms and
 * is passed through unjudged; `Snooze.set` already treats a past one as "not muted".
 *
 * Pure + exported because the handler lives inside `Bun.serve`, which `bun test` cannot stand up
 * (CLAUDE.md) — same reason as {@link parsePairRequest} and {@link parseNotifyPrefsPatch}.
 */
export function parseSnoozeRequest(v: JsonValue | undefined): SnoozeRequest {
  const record = asJsonRecord(v);
  // A body that is not an object at all has no field to read, so it lands on the same refusal an
  // omitted field does (and never on a property access against `null`, which used to throw).
  const until = record === null ? undefined : record.snoozedUntil;
  if (until === null) return { ok: true, until: null };
  if (typeof until !== "number") return { ok: false };
  return { ok: true, until };
}

/** {@link parseSnoozeRequest}'s answer. `until: null` is the explicit clear. */
export type SnoozeRequest = { ok: true; until: number | null } | { ok: false };

export function parsePairRequest(v: JsonValue | undefined): PairRequest | null {
  const o = asJsonRecord(v);
  if (o === null) return null;
  if (typeof o.code !== "string" || o.code.length === 0 || o.code.length > 64) return null;
  const label = normalizeLabel(o.label);
  if (label === null) return null;
  return { code: o.code, label };
}

/**
 * Validate an untrusted /api/notifications/prefs body into a partial patch. Only the known keys are
 * considered and each, if present, must be a boolean — a non-boolean value is rejected (null return
 * → 400). Unknown keys are ignored. An empty patch is valid (a no-op that echoes current prefs).
 * Pure + exported so the validation is unit-testable without Bun.serve.
 */
export function parseNotifyPrefsPatch(v: JsonValue | undefined): Partial<NotifyPrefs> | null {
  const o = asJsonRecord(v);
  if (o === null) return null;
  const patch: Partial<NotifyPrefs> = {};
  for (const key of ["blocked", "done", "updates"] as const) {
    if (!(key in o)) continue;
    const value = o[key];
    if (typeof value !== "boolean") return null;
    patch[key] = value;
  }
  return patch;
}

// Shape-check an untrusted /api/subscribe body before persisting it (a malformed sub would be
// stored keyed on `undefined` and silently never fire).
function isPushSubscription(v: JsonValue | undefined): v is JsonValue & PushSubscription {
  const o = asJsonRecord(v);
  if (o === null) return false;
  const keys = asJsonRecord(o.keys);
  return (
    typeof o.endpoint === "string" &&
    keys !== null &&
    typeof keys.p256dh === "string" &&
    typeof keys.auth === "string"
  );
}

/**
 * The endpoint a subscribe body says it supersedes (`replaces`) — the row the same device last
 * registered, which nothing else can identify (bridge/push.ts, SubscriptionMeta).
 *
 * A bad value is IGNORED rather than rejected: the subscription itself is well-formed and must be
 * stored, and a client that got this field wrong would otherwise lose push entirely over a
 * housekeeping hint. The cap is only there so a junk field can't be persisted at length.
 */
function supersededEndpoint(body: JsonValue | undefined): string | undefined {
  const replaces = asJsonRecord(body)?.replaces;
  if (typeof replaces !== "string" || replaces === "" || replaces.length > 2048) return undefined;
  return replaces;
}

// Build id of the bundle currently on disk (written by the Vite build to dist/build-info.json).
// Surfaced via the X-Collie-Build header and /api/config so a stale, service-worker-cached client
// can tell it's behind. Cached by file mtime so a frontend rebuild (live, no restart) is picked up.
let buildCache: { id: string; mtime: number } | null = null;
async function buildId(): Promise<string> {
  try {
    const f = Bun.file(join(WEB_DIR, "build-info.json"));
    const mtime = f.lastModified;
    if (!buildCache || buildCache.mtime !== mtime) {
      // SAFETY: `build-info.json` is written by this repo's own Vite build, next to the bundle it
      // stamps; a missing/garbled file lands in the `catch` below and reads as "unknown".
      const data = (await f.json()) as { id?: string };
      buildCache = { id: data.id ?? "unknown", mtime };
    }
    return buildCache.id;
  } catch {
    return "unknown";
  }
}

// The response header carrying the on-disk bundle's build id. A polling client reads it off every
// snapshot/pane response (web/src/lib/server-build.ts) to notice a live rebuild WITHOUT a service
// worker — the plain-HTTP deployments where the SW can't register, so the SW-based auto-reload never
// runs (see web/src/lib/self-update.ts). Also set on static responses (serveStatic). A named constant
// so both sides agree on the spelling.
export const BUILD_HEADER = "x-collie-build";

/**
 * Attach the current bundle's build id to a response so a polling client can observe a server-side
 * rebuild continuously, not just on a full document load. Pure given the id (the disk read stays in
 * buildId(), mtime-cached) — exported for unit tests.
 */
export function withBuildHeader(res: Response, id: string): Response {
  res.headers.set(BUILD_HEADER, id);
  return res;
}

/**
 * Resolve a request pathname to an absolute path under `webDir`, or null if it escapes. Pure +
 * exported for tests. The `full === webDir || full.startsWith(webDir + sep)` check rejects both
 * `..` traversal AND a sibling dir that merely shares the prefix (e.g. `web/dist-x` vs `web/dist`) —
 * a bare `startsWith(webDir)` would let the latter through.
 */
export function resolveStaticPath(
  pathname: string,
  webDir: string = WEB_DIR,
): { rel: string; full: string } | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(webDir, rel));
  if (full !== webDir && !full.startsWith(webDir + sep)) return null;
  return { rel, full };
}

/**
 * The namespace reserved for the operator's front door. Matches `/auth` with or without a trailing
 * slash and anything beneath it — a proxy may serve one page or a whole flow. Kept in lockstep with
 * the service worker's navigation denylist (`web/src/lib/sw-routes.ts`); if these two disagree, an
 * installed PWA either can't reach the proxy or can't reach Collie. Pure + exported for tests.
 */
export function isReservedAuthPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

/**
 * What `/auth/` says when nothing is in front of the bridge. Deliberately a 404: the path is
 * reserved, not implemented — Collie has no sign-in of its own and must not imply otherwise. Plain
 * HTML with no inline style or script (the strict CSP forbids both) and a link home, because in an
 * installed PWA this page may be the only thing on screen and there is no address bar to leave it.
 * Unauthenticated by design: it sits outside every gate, since the reason to be here is that a gate
 * refused you.
 */
function reservedAuthPlaceholder(): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Nothing configured here — Collie</title>
</head>
<body>
<h1>Nothing is configured at this address</h1>
<p>Collie reserves <code>/auth/</code> for a reverse proxy sitting in front of it, so that an
installed app has somewhere to reach a sign-in or device-enrolment page. Collie itself serves
nothing here and has no sign-in of its own.</p>
<p>If you are the operator: point this path at your proxy's sign-in flow. See <em>Serving Collie
behind your own reverse proxy</em> in the README.</p>
<p><a href="/">Back to Collie</a></p>
</body>
</html>
`;
  return secure(
    new Response(body, {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP,
        "cache-control": "no-store",
      },
    }),
  );
}

async function serveStatic(pathname: string): Promise<Response> {
  const resolved = resolveStaticPath(pathname);
  if (!resolved) return text("forbidden", 403);
  let { rel, full } = resolved;

  let file = Bun.file(full);
  if (!(await file.exists())) {
    // SPA fallback: extension-less paths fall back to index.html; missing assets 404.
    if (extname(rel) === "") {
      rel = "index.html";
      full = join(WEB_DIR, "index.html");
      file = Bun.file(full);
      if (!(await file.exists())) {
        return text("frontend not built — run `bun run build` in web/", 503);
      }
    } else {
      return text("not found", 404);
    }
  }

  const ext = extname(full);
  const headers: StaticHeaders = {
    "content-type": CONTENT_TYPES.get(ext) ?? "application/octet-stream",
    [BUILD_HEADER]: await buildId(), // which bundle the server is serving (vs the client's stamp)
    "cache-control": cacheControlFor(rel),
  };
  if (ext === ".html") headers["content-security-policy"] = CSP;
  if (rel === "sw.js") headers["service-worker-allowed"] = "/";
  return secure(new Response(file, { headers }));
}

/**
 * Cache-Control for a served dist file, keyed by its path relative to web/dist. Hashed assets under
 * `assets/` are content-addressed, so cache them hard + immutable. EVERYTHING else — index.html,
 * sw.js, manifest.webmanifest, build-info.json, the favicons — is MUTABLE across a rebuild and must
 * always be revalidated (`no-cache`), so neither the browser NOR an intermediary reverse proxy can
 * pin a stale copy. This matters most for sw.js: a proxy that heuristically caches it (it shipped
 * with no Cache-Control before) starves `registration.update()` and wedges the whole SW update
 * pipeline — the exact failure the API-observed self-update (web/src/lib/self-update.ts) works around,
 * but which this header prevents at the source. Pure + exported for unit tests.
 */
export function cacheControlFor(rel: string): string {
  return rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}
