import { hostname } from "node:os";
import { join } from "node:path";

import { DEFAULT_PORT, envBool, nonLoopbackBindRefusal, resolveBridgeHost } from "../bridge/config.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import type { AuditLog } from "../bridge/audit.ts";
import {
  acceptEnrollment,
  approvePromotion,
  cancelPromotion,
  commitPackChange,
  dropMembersBehind,
  isLeading,
  leavePack,
  liveHandover,
  markSecretDelivered,
  mintInvite,
  parseEnrollResponse,
  parseRoster,
  promoteSelf,
  removeMember,
  rotatePackSecret,
  rosterEntryOf,
  selfIdentity,
  updateMemberAddress,
  createTrustStore,
  identityMinter,
  type IdentityMinter,
  type RosterEntry,
  PACK_PROTOCOL_VERSION,
} from "../bridge/pack/enrollment.ts";
import { bindIsWildcard } from "../bridge/pack/config.ts";
import { mintMemberId, normalizeFingerprint, randomToken, type RandomSource } from "../bridge/pack/identity.ts";
import { signDial, signRequest } from "../bridge/pack/signing.ts";
import { dialTls } from "../bridge/pack/transport.ts";
import { deriveMode } from "../bridge/pack/mode.ts";
import { packOpsPath, PackOpsStore, type OpsRecord } from "../bridge/pack/ops-store.ts";
import {
  packHelloBudget,
  packTimeoutBudget,
  packTimeoutClampWarning,
  PeerClient,
  sweepPeers,
  type HelloResult,
  type PackFetch,
  type PackLink,
  type PeerOutcome,
} from "../bridge/pack/peer-client.ts";
// The route literals live on the router that serves them, so a verb and its handler can never drift
// apart. Everything below the enrollment POST goes through `PeerClient`, which composes the prefix
// itself — hence one path constant here and route NAMES ("secret", "lead", "leave") at the call sites.
import { PACK_ENROLL_PATH } from "../bridge/pack/router.ts";
import { currentWarrant } from "../bridge/pack/warrant.ts";
import {
  parseStandbyDevices,
  standbyDevicesPath,
  type StandbyDevices,
} from "../bridge/pack/standby-devices.ts";
import { packRuntimePath, parseMarker, rosterDrift } from "../bridge/pack/staleness.ts";
import { TrustStore, type TrustedMember, type TrustStoreData } from "../bridge/pack/trust-store.ts";
import { deriveConfigRoot, discoverSessionSockets, herdTagFor } from "../bridge/sessions.ts";
import { collieVersionBare, DEFAULT_SERVE_PORT, type CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { dropEnvAssignments } from "./push-keys.ts";
import {
  deposedLines,
  deputyUnreachableLines,
  leadContactLines,
  leadDeputyLines,
  memberRePinLines,
  memberWarrantLines,
  pairingCollisionLines,
  peerWarrantLines,
  standbyDoorLines,
} from "./pack-status-deputy.ts";
import type { Tone, TonedLine, Ui } from "./render.ts";
// Type-only, so it is erased: the runtime edge to `cli/remote.ts` is the dynamic import in `cmdPack`.
import type { PackAddDeps } from "./remote.ts";
import type { Exec, Files } from "./sys.ts";
import { tailnetName } from "./tailnet.ts";

// The pack verbs: `pack invite`, `join`, `leave`, `pack status`, `pack rotate`, `pack remove`,
// `promote`, `reconnect` — the ONLY way a machine enters or leaves a pack (M4/07).
//
// ── WHAT LIVES HERE AND WHAT DOES NOT ────────────────────────────────────────
// Nothing in this file decides what a trust store should contain. Every mutation is one of the pure
// transitions in `bridge/pack/enrollment.ts`, committed through `commitPackChange`, so the engine's
// exhaustive failure matrix tests the production path and this module is left holding argument
// parsing, ordering, and the words an operator reads. Where a verb needs the far side, it goes
// through `PeerClient` over an injected `fetch` — never a bare one, and never a second dial path that
// could forget the `Authorization` header (PACK_PROTOCOL.md §6).
//
// ── SECRETS NEVER TOUCH ARGV (§8.3) ──────────────────────────────────────────
// `/proc/<pid>/cmdline` is mode 444 and `ps -eo args` is world-readable — the concrete leak ADR 0001
// records. So the ONLY credential any verb accepts on a command line is the enrollment token, which is
// single-use and lives ten minutes, and even that prefers `-` (stdin) or `@<path>` (a 0600 file); the
// literal form warns on stderr. The pack secret is never an argument, never printed and never
// interpolated into a message: it moves from the 0600 trust store, into memory, onto an admitted link.
//
// ── EVERY MUTATION RESTARTS THE SERVICE, ON PURPOSE ──────────────────────────
// `TrustStore` reads its file once per process (bridge/pack/trust-store.ts) and the running bridge
// resolves its mode, its push gate and its peer roster at construction. A verb that only rewrote the
// file would leave a peer still publishing, still pushing and still solo until something else
// happened to restart it. So the verbs that change membership restart the local service through the
// injected `restart`, and say so in their output.

/** Where the verbs reach the world. Every field is a seam `cli/pack.test.ts` supplies a fake for. */
export interface PackDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly exec: Exec;
  readonly files: Files;
  /** This collie's trust store, over `ctx.stateDir`. */
  readonly store: TrustStore;
  /**
   * How the operator reached each member over SSH — written by `pack add`, read by `pack update`,
   * dropped by `pack remove`. Operator-local convenience beside the trust store, never trust and
   * never a wire field (ADR 0016), which is why it is a second store and not a column in the first.
   */
  readonly ops: PackOpsStore;
  /** Membership changes are the most consequential writes an operator makes; `null` only in tests. */
  readonly audit: AuditLog | null;
  /** The injected transport — the enrollment POST and every `PeerClient` share it. */
  readonly fetch: PackFetch;
  readonly now: () => number;
  readonly random: RandomSource;
  /** Mints this collie's TLS identity. Defaults to the loud refusal until certificates are wired. */
  readonly mintIdentity: IdentityMinter;
  /** Reads stdin to EOF, for a token given as `-`. */
  readStdin(): Promise<string>;
  /**
   * `collie restart` — how a membership change reaches the running bridge.
   *
   * The optional `io` is where the nested verb's own output goes. Only `pack add` passes it, and
   * only because its ink surface must be the sole writer while it is mounted (`cli/render.ts`);
   * every other caller omits it and the restart writes where it always did.
   */
  restart(io?: Io): Promise<number>;
  /**
   * `collie serve` — the new lead publishes the one managed front door (ADR 0001). The optional
   * `io` is `restart`'s: `serve` can run mid-restart (`cmdStart` calls it), so it must accept the
   * same held-chatter `Io` `restart` was given rather than defaulting back to this run's own.
   */
  serve(io?: Io): Promise<number>;
  /** `collie unserve` — a peer publishes nothing (§3), so joining tears our own mapping down. */
  unserve(): number;
  /** Push a `clear` to every subscribed device for these notification slots. Best effort. */
  clearNotifications(tags: readonly string[]): Promise<void>;
  /** The terminal renderer, when this run landed on one (`cli/render.ts`). Absent ⇒ plain lines. */
  readonly ui?: Ui | null;
  /**
   * Is there a terminal to ask a question at? Absent reads as "no", so a verb that asks one must
   * still have an answer for the scripted path — the same guard `stt setup` and `chooseMux` use.
   */
  readonly interactive?: boolean;
  /**
   * The free-text ask, behind the seam `pack add` already owns (`PackAddDeps.prompt` narrows this
   * to required). `null` means nobody is there to answer.
   */
  prompt?(question: string): string | null | Promise<string | null>;
  /** This machine's own hostname — the default `--label`, so a member is named after its box. */
  hostname?(): string;
}

/**
 * The seams a member probe needs, and no more — `collie doctor` reuses {@link probeMembers} without
 * being able to mutate anything (the store, the audit log and the lifecycle verbs are absent by
 * construction, which is what makes its read-only contract structural rather than a promise).
 */
export type ProbeDeps = Pick<PackDeps, "ctx" | "fetch" | "now">;

/** The seams the staleness comparison needs. Same reason as {@link ProbeDeps}. */
export type DriftDeps = Pick<PackDeps, "ctx" | "io" | "files">;

const CONTENT_TYPE = { "content-type": "application/json" } as const;

// Fixed and generous, not `timeoutFor`'s poll-clamped ~1.5s member budget: an enrollment dial crosses
// operator-owned ingress — reverse proxies, tunnels, WAN — that a same-pack member dial never does,
// and it runs once interactively (never on a poll loop), so seconds of patience are cheap here and a
// poll-scale budget would produce false UNREACHABLEs against a lead that is merely slow to answer.
const JOIN_DIAL_TIMEOUT_MS = 15_000;

// ── Shared plumbing ──────────────────────────────────────────────────────────

/** The poll interval a one-shot verb prices its budgets against — the operator's, or the default. */
function pollFor(ctx: CliContext): number {
  const pollMs = Number.parseInt(ctx.env.COLLIE_POLL_MS?.trim() ?? "", 10);
  return Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 1500;
}

/** The pack timeout budget for a one-shot verb: the default, clamped by the poll interval as usual. */
function timeoutFor(ctx: CliContext): number {
  return packTimeoutBudget(pollFor(ctx), ctx.env);
}

/**
 * The patient budget a verb's `hello` — and its one cold data attempt — runs on (§10.4).
 *
 * A verb is a FRESH PROCESS with an empty connection pool, so every request it sends pays a cold
 * pinned-TLS handshake — which over a relay costs more than the whole poll budget. On the strict
 * budget `pack status` therefore printed `unreachable` for a healthy member categorically, no matter
 * how many times the operator ran it. Nothing on a phone waits for a verb, so it can afford to wait.
 */
function patientTimeoutFor(ctx: CliContext): number {
  return packHelloBudget(pollFor(ctx), ctx.env);
}

/**
 * A client for talking to other members, authenticated by `secret`.
 *
 * `secret` is passed in rather than read from the store because rotation needs the *superseded* value:
 * the new secret is already on disk when the distribution calls go out, and a peer that has not yet
 * been handed it would refuse a request carrying it (§8.4 — no grace window, so the lead must dial
 * with the value the peer still holds).
 */
export function clientFor(deps: ProbeDeps, data: TrustStoreData, secret: string): PeerClient {
  return new PeerClient({
    self: data.self.memberId,
    secret: () => secret,
    timeoutMs: timeoutFor(deps.ctx),
    patientTimeoutMs: patientTimeoutFor(deps.ctx),
    fetch: deps.fetch,
    now: deps.now,
    // Pin whichever member this dial is aimed at (§8.1) — EXCEPT this store's lead, which is dialled
    // with no TLS material at all.
    //
    // **Why the lead is the exception, and why the test is its ROLE.** `bridge/pack/transport.ts`'s
    // design note states the law this obeys: "A LEAD does not pin its listener at all. Its pack
    // surface rides the front door, and `tailscale serve` (or any conforming proxy, docs/deployment.md
    // Variant C) terminates TLS before the process sees the connection — no client certificate can
    // survive to it under ANY design." So the certificate on the wire in the peer→lead direction is
    // the front door's, never the lead's own, and pinning `ca: [lead.certPem]` here could not match
    // at any address the lead can publish: against the front door it is `unable to verify the first
    // certificate`, and against the lead's own (unpinned, §8.1) listener it is `unknown certificate
    // verification error`. Returning `undefined` hands the dial to the platform's ordinary
    // verification of a publicly-trusted certificate, which is what a front door is FOR.
    //
    // The second factor is not lost, it is relocated: §8.6 re-establishes it at the application
    // layer, and `sign`/`dialSign` below run on EVERY call this client makes, carrying the pack
    // secret and this member's signature. §8.1's two factors are still two.
    //
    // Keyed on the roster's LEAD ENTRY — `memberById` resolves `data.lead` first, and only that
    // entry carries `role: "lead"` — and never on the shape of the address. An address is an
    // operator-owned hint (§4); a lead reachable at a bare `host:port` is still a lead whose
    // listener pins nothing, and a peer behind the operator's own TLS proxy is still a peer whose
    // listener demands the pin. Sniffing for a scheme would get both of those backwards.
    tls: (link) => {
      const member = memberById(data, link.memberId);
      if (member === undefined) return undefined;
      if (member.role === "lead") return undefined;
      return dialTls(data, member) ?? undefined;
    },
    // EVERY CLI-ORIGINATED CALL IS SIGNED (§8.6), not only the two that require it. The verbs are the
    // peer→lead direction, where the transport cannot pin (`bridge/pack/transport.ts`); signing the
    // whole set means `pack status` and `reconnect` can probe a lead at all, and it costs one ECDSA
    // signature per one-shot command. The receiver only *requires* one on the membership routes.
    sign: (parts) => signRequest(data.self.keyPem, parts),
    // …and every one carries a DIAL ATTESTATION too (§8.6). The signature above answers "may this
    // member do this?" on the routes that ask; this one answers "which of my anchors are you?" at a
    // peer that has anchored a deputy, which refuses an unattested dial whoever it claims to be from.
    // A verb that dialled such a peer without one — `pack rotate`, `pack status` — would read the
    // whole pack as unauthorized.
    dialSign: (parts) => signDial(data.self.keyPem, parts),
  });
}

/** A member of this collie's roster by id — its lead, or one of its peers. */
function memberById(data: TrustStoreData, memberId: string): TrustedMember | undefined {
  if (data.lead !== null && data.lead.memberId === memberId) return data.lead;
  return data.peers.find((p) => p.memberId === memberId);
}

export const linkOf = (member: TrustedMember): PackLink => ({
  memberId: member.memberId,
  address: member.address,
});

/** One line naming why a member did not answer. Never contains a secret — nothing here holds one. */
export function failureLine(outcome: PeerOutcome<unknown>): string {
  if (outcome.ok) return "ok";
  if (outcome.state === "incompatible") return `incompatible — ${outcome.reason}`;
  // A refusal is an ANSWER, not a failure to reach — the far side is there and said no (§14.3).
  if (outcome.state === "refused") return `refused — ${outcome.reason}`;
  // …and so is a conflict (§18.10, §10.2's fourth state). It answered, and answered precisely: it
  // follows somebody else now. Never `unreachable` — the machine is up, and the remedy is a
  // membership decision rather than a network one.
  if (outcome.state === "conflicted") {
    const generation = outcome.warrantGeneration === null ? "" : ` (warrant generation ${outcome.warrantGeneration})`;
    return `this peer follows another lead "${outcome.leadMemberId}"${generation}`;
  }
  return `unreachable — ${outcome.reason}`;
}

/**
 * Which surface the address being derived actually names — the two answer on different ports, so the
 * caller has to say which one it is advertising rather than let one default be wrong half the time.
 *
 * - `"pack-listener"`: the `/pack/v1/*` prefix on this collie's OWN listener, `COLLIE_HOST:COLLIE_PORT`.
 *   A peer publishes no front door (§3, ADR 0013), so this is the only thing that answers on it.
 * - `"front-door"`: the one managed ingress a lead holds — `tailscale serve` on :443 in https mode
 *   (ADR 0001), which is also the URL a phone opens.
 */
export type SelfAddressKind = "pack-listener" | "front-door";

/**
 * This machine's address as another member will dial it (§8.2's negotiated column).
 *
 * The operator's `--address` wins, because reachability is theirs to own (§8.2: "whatever the operator
 * can reach" — a tailnet, a LAN, a tunnel), and it is taken VERBATIM: scheme, brackets, port and all.
 * Then, for a `front-door` address only, `COLLIE_PUBLIC_URL`. Otherwise it is this node's Tailscale
 * name, which is what `collie url` already prints. There is no further guess: an address we cannot
 * state is an error the operator fixes with a flag, not a `localhost` the far side would dial forever.
 *
 * **`COLLIE_PUBLIC_URL` is the front door's configured truth, and it is consulted here (amended
 * 2026-08-13).** It used to feed only the QR and the status banner, on the reasoning that a
 * Variant-C/E operator's lever was `--address`. The field says otherwise: a lead behind a reverse
 * proxy derives its tailnet name here, and a one-way tailnet ACL makes that name perfectly correct
 * and silently undialable *from the peer* — `collie join` hangs, and nothing names the cause. The
 * remedy was a flag the operator had to remember on every `pack invite`/`pack add`, and forgot four
 * times in five. Which ingress a machine actually publishes is per-INSTALLATION truth, so it belongs
 * in config, next to the URL the phone already opens. Only the ORIGIN is used (scheme + host + port):
 * the pack link mounts at `/pack/v1/*` off the origin, so a path is dropped with a warning, and a
 * value that does not parse as a URL warns and falls through to the derivation rather than aborting
 * the verb — a malformed banner variable must not be able to break enrollment.
 *
 * **The `pack-listener` kind never consults it**, and that is not an oversight: a peer is dialled on
 * its own listener (`COLLIE_HOST:COLLIE_PORT`) and publishes no front door at all (§3, ADR 0013). A
 * public URL is a front door by definition, so pointing a lead at one for the listener kind would
 * aim it at whatever answers that proxy — never this peer's `/pack/v1/*`. The QR and the status
 * banner are unchanged; this adds a reader, it moves nothing.
 *
 * **A derived `pack-listener` address always carries an explicit port, and that is the whole reason
 * `kind` exists.** A bare host dials :443 (`packUrl`/`enrollUrl` assume `https://`) — which is right
 * for a lead, whose pack surface rides the front door, and silently wrong for a peer, whose listener
 * is `COLLIE_PORT` and nothing else. Left portless, a hand-typed `collie join` on a default-configured
 * machine hands the lead an address it will dial forever at a port nothing listens on, and the member
 * simply stays provisional with no line naming the cause. So the peer direction appends this
 * instance's own port — the same `COLLIE_PORT`/default the bridge binds — and the front-door direction
 * keeps 443 implicit, because that is the port it is actually published on.
 *
 * Nothing here rewrites an address already stored on either side: a record minted before this
 * distinction is repaired by `collie reconnect`, which is the verb for exactly that.
 */
export function selfAddress(
  deps: PackDeps,
  override: string | undefined,
  kind: SelfAddressKind,
): string | null {
  return resolveSelfAddress(deps, override, kind)?.address ?? null;
}

/** Where a derived address came from — what a verb needs to tell the operator which lever spoke. */
export type SelfAddressSource = "flag" | "public-url" | "derived";

/** {@link selfAddress}, with the source retained so an interactive verb can name it once. */
export interface ResolvedSelfAddress {
  readonly address: string;
  readonly source: SelfAddressSource;
}

/**
 * {@link selfAddress}'s whole body — see its doc for the precedence and why it is that order.
 *
 * Warnings about `COLLIE_PUBLIC_URL` are emitted HERE, so they are printed once per resolution rather
 * than once per reader.
 */
export function resolveSelfAddress(
  deps: PackDeps,
  override: string | undefined,
  kind: SelfAddressKind,
): ResolvedSelfAddress | null {
  if (override !== undefined && override !== "") return { address: override, source: "flag" };
  if (kind === "front-door") {
    const configured = publicFrontDoor(deps);
    if (configured !== null) return { address: configured, source: "public-url" };
  }
  const name = tailnetName(deps.exec);
  if (name === null) return null;
  // http mode publishes no TLS front door at all, so both kinds are the bridge port there.
  if (kind === "front-door" && deps.ctx.serveMode === "https") {
    // Portless only on 443, which is what a bare host dials. A front door moved by
    // `COLLIE_SERVE_PORT` must carry its port, or every peer would dial :443 and find nothing.
    const address = deps.ctx.servePort === DEFAULT_SERVE_PORT ? name : `${name}:${deps.ctx.servePort}`;
    return { address, source: "derived" };
  }
  return { address: `${name}:${deps.ctx.port}`, source: "derived" };
}

/**
 * `COLLIE_PUBLIC_URL` as an origin, or `null` with the reason already on stderr.
 *
 * An `http://` origin passes through untouched: `join`'s plaintext refusal (and its `--insecure`
 * escape) already owns that risk at the one point where a secret would actually cross the wire, and
 * a second refusal here would only fail the verb earlier with a worse sentence.
 */
function publicFrontDoor(deps: PackDeps): string | null {
  const raw = deps.ctx.env.COLLIE_PUBLIC_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    deps.io.err(`warn: COLLIE_PUBLIC_URL="${raw}" is not a URL — ignoring it and using this node's tailnet name.`);
    return null;
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    deps.io.err(`warn: COLLIE_PUBLIC_URL's path ("${url.pathname}") is dropped — the pack link mounts at`);
    deps.io.err(`      /pack/v1/* off the origin, so ${url.origin} is what members are given.`);
  }
  return url.origin;
}

/**
 * The host an operator types after `collie pack join`, on the machine that is joining.
 *
 * This is NOT {@link selfAddress}'s front door, and the difference is the point. A front door is
 * `https://<name>` on :443, and a joiner that dials it enrolls through whatever terminates that TLS.
 * The pack surface a lead answers on directly is its OWN listener, `COLLIE_PORT`, and 8787 is what
 * `collie pack join <host>` assumes — so the banner prints a bare host on the default port and
 * appends `:<port>` only when this lead moved off it. `COLLIE_PUBLIC_URL` still wins, because it is
 * the operator telling Collie which ingress this machine actually publishes; its port is made
 * explicit (443 for https, 80 for http) so the joiner dials the door that is really there.
 *
 * `null` when this node has no Tailscale name and no configured URL — the caller prints a
 * placeholder, exactly as it did before.
 */
export function joinHost(deps: PackDeps): string | null {
  const configured = publicFrontDoor(deps);
  if (configured !== null) {
    const url = new URL(configured);
    const port = url.port === "" ? (url.protocol === "http:" ? 80 : DEFAULT_SERVE_PORT) : Number(url.port);
    return port === DEFAULT_PORT ? url.hostname : `${url.hostname}:${port}`;
  }
  const name = tailnetName(deps.exec);
  if (name === null) return null;
  // The SHORT MagicDNS name: `bluefin`, not `bluefin.tail1234.ts.net`. MagicDNS puts the tailnet
  // suffix in every node's search domain, so the short name resolves from any other node — and it is
  // the thing an operator can retype without reading it off a screen. If there is no suffix to
  // strip, the name is already as short as it gets.
  const short = name.split(".")[0];
  const host = short === undefined || short === "" ? name : short;
  return deps.ctx.port === DEFAULT_PORT ? host : `${host}:${deps.ctx.port}`;
}

/** The parsed flag set every pack verb shares: `--flag value` pairs plus bare positional arguments. */
export interface PackArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
  readonly bare: ReadonlySet<string>;
}

/**
 * Split argv into positionals, `--flag value` pairs and bare `--flag`s.
 *
 * `--force` is the only bare flag today; everything else takes a value. An unknown flag is left for
 * the verb to reject, so a typo is never silently ignored.
 */
export function parsePackArgs(args: readonly string[], bareFlags: readonly string[] = ["force"]): PackArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const bare = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = splitFlag(arg.slice(2));
    if (bareFlags.includes(name)) {
      bare.add(name);
      continue;
    }
    if (inline !== null) {
      flags[name] = inline;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = "";
    }
  }
  return { positional, flags, bare };
}

function splitFlag(raw: string): [string, string | null] {
  const eq = raw.indexOf("=");
  return eq < 0 ? [raw, null] : [raw.slice(0, eq), raw.slice(eq + 1)];
}

/**
 * Read a token the three ways §8.3 allows: `-` is stdin, `@<path>` is a file, anything else is the
 * literal — which WARNS, because a literal was visible in `ps` for as long as the process ran.
 */
export async function readToken(
  raw: string,
  deps: Pick<PackDeps, "files" | "io" | "readStdin">,
): Promise<string | null> {
  if (raw === "-") return (await deps.readStdin()).trim() || null;
  if (raw.startsWith("@")) {
    const text = deps.files.read(raw.slice(1));
    if (text === null) {
      deps.io.err(`error: cannot read the token file ${raw.slice(1)}`);
      return null;
    }
    return text.trim() || null;
  }
  deps.io.err(
    "warn: the token was passed as a command-line argument, which `ps -eo args` and /proc/<pid>/cmdline",
  );
  deps.io.err("      expose to every local uid. Prefer `-` (stdin) or `@<file>`. Mint a fresh token if");
  deps.io.err("      this machine is shared.");
  return raw.trim() || null;
}

/**
 * Load the trust store, creating this collie's identity if it has never had one.
 *
 * Materialisation happens **here and on no other path**: minting an invite or answering one are the
 * operator's first pack actions, and until one of them happens a solo instance has no file, no key
 * and no roster (PACK_PROTOCOL.md §11). This is the ONLY call site of the minter in the codebase,
 * which is what makes "solo mints nothing" a structural fact rather than a promise: there is no other
 * path on which a key could come into existence.
 *
 * Exported for `pack add` (cli/remote.ts), which mints its invite through the same path — and must
 * do so through THIS function rather than a second one, or "solo mints nothing" stops being
 * structural.
 */
export async function ensureStore(deps: PackDeps, label: string | undefined): Promise<TrustStoreData | null> {
  const existing = await deps.store.load();
  if (existing !== null) return existing;
  try {
    const material = await deps.mintIdentity();
    const memberId = mintMemberId(label ?? null, new Set(), deps.random);
    return await deps.store.update((current) => {
      if (current !== null) return { next: current, result: current };
      const next = createTrustStore(selfIdentity(memberId, material, deps.now()));
      return { next, result: next };
    });
  } catch (err) {
    deps.io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Restart the local service so the running bridge sees the change, and say why. */
async function applyLocally(deps: PackDeps, what: string): Promise<void> {
  deps.io.out(`  restarting the bridge so ${what} takes effect…`);
  const code = await deps.restart();
  if (code !== EXIT.OK) {
    deps.io.err("warn: the restart failed — the trust store IS updated, but the running bridge still");
    deps.io.err("      holds the previous roster. Run `collie restart` before relying on this change.");
  }
}

/**
 * Clear this machine's own herd notification slots.
 *
 * The handoff from M4/06: in peer mode the herd push path is MUTED, not deleted (`herdPushGate`), so a
 * notification already sitting on a phone can never be cleared by the machinery that raised it — the
 * muted sink drops the `clear` too. One clear at enrollment time, while the gate is still open, is the
 * only moment that can retract them. Best effort by construction: no push keys, no subscriptions, or a
 * send that fails all mean the same thing here, and none of them is a reason to fail a join.
 */
async function clearOwnHerdTags(deps: PackDeps): Promise<void> {
  const root = deriveConfigRoot(deps.ctx.socket);
  const sessions = discoverSessionSockets(
    root,
    (dir) => deps.files.list(dir),
    (p) => deps.files.exists(p),
  );
  const tags = sessions.map((s) => herdTagFor(s.socketPath === deps.ctx.socket, s.name));
  if (tags.length === 0) return;
  try {
    await deps.clearNotifications(tags);
  } catch {
    // A phone that keeps one stale notification is a smaller problem than a join that failed at the
    // very last step, after the roster on both machines already changed.
  }
}

// ── pack invite (on the lead) ────────────────────────────────────────────────

/**
 * Mint a single-use, ten-minute enrollment token and print it ONCE (§8.2 step 1).
 *
 * Only the hash is persisted, so there is no second chance to read it — losing it costs one more
 * `pack invite`, which is the correct price.
 */
export async function cmdPackInvite(deps: PackDeps, args: readonly string[]): Promise<number> {
  const { flags } = parsePackArgs(args);
  const data = await ensureStore(deps, flags.as);
  if (data === null) return EXIT.FAIL;
  if (data.lead !== null) {
    deps.io.err(`error: this collie is a peer of "${data.lead.memberId}" — invites are minted on the lead.`);
    return EXIT.STATE;
  }
  const minted = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null
      ? null
      : mintInvite(current, {
          now: deps.now(),
          label: flags.label ?? null,
          packName: flags.name,
          random: deps.random,
        }),
  );
  if (minted === null) return EXIT.FAIL;

  // The host the joiner types after `collie pack join` — this lead's, and `--address` still wins.
  const target = flags.address !== undefined && flags.address !== "" ? flags.address : joinHost(deps);
  // The operator carries `<token>.<lead-fingerprint>` (§8.2): the token still authenticates the joiner
  // to the lead, and the fingerprint — this lead's OWN certificate hash, public material — lets `join`
  // authenticate the lead back. Only the printed string gains the suffix: the wire token stays exactly
  // `minted.token` and the store still holds only `hashToken(minted.token)`, so nothing else changes.
  // `join` refuses a lead whose certificate does not hash to this fingerprint, which closes the
  // enrollment-path MITM/relay: a token that names no lead is a token `join` will not act on.
  const leadFp = data.self.fingerprint;
  deps.io.out(`${minted.token}.${leadFp}`);
  deps.io.out("");
  deps.io.out(`  single-use · expires ${new Date(minted.expiresAt).toISOString()} (10 minutes)`);
  deps.io.out("  Shown once — only its hash is stored. Run this on the machine that is joining:");
  const host = target ?? "<this-lead-address>";
  // The short form first, because it is the one a person types: `join` asks for the token at a
  // prompt when none is given, so nothing else has to be remembered. The stdin form stays right
  // underneath it — it is what a script uses, and it is still the only form that takes no keystrokes.
  deps.io.out(`    collie pack join ${host}`);
  deps.io.out(`    collie pack join ${host} -   # paste the token on stdin`);
  deps.io.out("  Passing it as an argument instead leaves it in `ps` output for every local uid.");
  await applyLocally(deps, "the freshly minted invite");
  return EXIT.OK;
}

// ── join (on the joining machine) ────────────────────────────────────────────

const JOIN_USAGE = "usage: collie pack join <lead-address> [<token>|-|@file] [--address <mine>] [--label <name>]";

/** What the operator is asked when they gave no token and there is a terminal to ask at. */
const TOKEN_PROMPT = "Paste the invite token from `collie pack invite` on the lead:";

/**
 * The invite token, however it was supplied: an argument (`-`, `@file` or a literal), or — when
 * none was given and a terminal is there — one line typed at a prompt. `null` with the reason
 * already on stderr.
 *
 * A token typed at the prompt deliberately skips {@link readToken}'s `ps` warning: it was never in
 * argv, and argv is the only thing that warning is about.
 */
async function resolveToken(deps: PackDeps, address: string, given: string | undefined): Promise<string | null> {
  if (given !== undefined) {
    const raw = await readToken(given, deps);
    if (raw === null) deps.io.err("error: the token was empty");
    return raw;
  }
  const typed =
    deps.interactive === true && deps.prompt !== undefined ? (await deps.prompt(TOKEN_PROMPT))?.trim() : null;
  if (typed !== null && typed !== undefined && typed !== "") return typed;
  // No terminal, or an empty answer: the same four lines a scripted run has always been given.
  deps.io.err(JOIN_USAGE);
  deps.io.err("error: join needs the invite token as its second argument.");
  deps.io.err("       Pass `-` and paste the token on stdin, or `@<file>` to read it from a file:");
  deps.io.err(`         collie pack join ${address} -`);
  deps.io.err("       Mint the token on the lead with `collie pack invite`; it is single-use and lasts 10 minutes.");
  return null;
}

/**
 * `--label`, or this machine's hostname.
 *
 * The label becomes the member id on both sides, and an unlabelled join used to mint `collie-8f3a2b1c`
 * — a name that identifies the machine to nobody. The box's own name is the answer everyone would
 * have typed, so it is the default; `--label` still wins, and a machine with no hostname to read
 * falls back to the random id rather than to an empty string.
 */
function joinLabel(deps: PackDeps, flag: string | undefined): string | undefined {
  if (flag !== undefined && flag !== "") return flag;
  const host = deps.hostname?.().trim();
  return host === undefined || host === "" ? undefined : host;
}

/** One enrollment POST. `res` absent means nothing answered; see {@link looksLikePlaintextListener}. */
interface EnrollAttempt {
  readonly res?: Response;
  /** Collie's words for why nothing answered — never the runtime's, once it reaches an operator. */
  readonly reason: string;
  /** Did it fail the way a TLS client fails against a listener that speaks plain HTTP? */
  readonly plaintext: boolean;
}

async function postEnrollment(deps: PackDeps, origin: URL, body: string): Promise<EnrollAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOIN_DIAL_TIMEOUT_MS);
  try {
    const res = await deps.fetch(new URL(PACK_ENROLL_PATH, origin).toString(), {
      method: "POST",
      headers: { ...CONTENT_TYPE, "x-pack-protocol": String(PACK_PROTOCOL_VERSION) },
      // The token rides the BODY, never the URL: a query string lands in access logs on every hop
      // that ever fronts a lead, and §8.3's rule is about where a credential comes to rest.
      body,
      signal: controller.signal,
    });
    return { res, reason: "", plaintext: false };
  } catch (err) {
    // A timeout is never read as a plaintext listener: the whole point of the retry is that the far
    // side answered *something* that was not TLS, and a budget that ran out answered nothing at all.
    if (controller.signal.aborted) {
      return { reason: `timed out after ${JOIN_DIAL_TIMEOUT_MS / 1000}s`, plaintext: false };
    }
    return {
      reason: err instanceof Error ? err.message : String(err),
      plaintext: err instanceof Error && looksLikePlaintextListener(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The error shapes a TLS client produces against a listener that is speaking plain HTTP.
 *
 * Probed against Bun 1.4's `fetch`, which is what actually runs here: an `https://` request to a
 * `Bun.serve` listener fails with `code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"` — the handshake
 * never produced a certificate to verify — and a listener that resets mid-handshake gives
 * `ECONNRESET`. The OpenSSL spellings (`EPROTO`, "wrong version number", "http request") are here
 * because they are what every other runtime and every proxy in front of one says for the same
 * thing, and this predicate must not become Bun-version-shaped.
 *
 * It is a HINT, never a decision: everything it gates is a question asked before anything is sent.
 * A false positive costs one prompt against a lead whose TLS is merely misconfigured; a false
 * negative costs nothing at all, because the refusal it falls back to is the one that shipped.
 */
export function looksLikePlaintextListener(err: Error): boolean {
  // SAFETY: every runtime's transport error carries its reason as `code` — Bun's, Node's and
  // OpenSSL's alike — and this reads that one field defensively: `String(… ?? "")` turns an absent
  // key, an `undefined` and a non-string alike into a value the set below simply does not hold.
  const code = String((err as Error & { code?: unknown }).code ?? "").toUpperCase();
  if (PLAINTEXT_CODES.has(code)) return true;
  return /wrong version number|packet length too long|http request|record layer failure/i.test(err.message);
}

const PLAINTEXT_CODES: ReadonlySet<string> = new Set([
  "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
  "ECONNRESET",
  "EPROTO",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
  "ERR_SSL_HTTP_REQUEST",
]);

/**
 * The one question this verb asks. `false` when nobody is there to answer it, which is what keeps a
 * scripted run on exactly the refusal it had before.
 */
async function consentToPlaintext(deps: PackDeps, plain: URL): Promise<boolean> {
  if (deps.interactive !== true || deps.prompt === undefined) return false;
  const answered = await deps.prompt(
    `${plain.host} answers over plain HTTP, not HTTPS. On a tailnet the hop is still encrypted by WireGuard. Send the token over it? [y/N]`,
  );
  return answered?.trim().toLowerCase() === "y";
}

/**
 * Refuse a plaintext hop. Over `http://` both the invite token and the pack secret cross the wire in
 * the clear — F1's fingerprint pin authenticates the lead to us, but it does nothing to stop a
 * token-thief racing the spend with its own certificate.
 */
function refusePlaintext(deps: PackDeps): void {
  deps.io.err("error: refusing to enroll over http:// — the invite token and the pack secret would cross the");
  deps.io.err("       wire in the clear. An on-path attacker who reads the token can enroll THEIR OWN certificate");
  deps.io.err("       as a member before you do (the lead admits on the token alone), then holds the pack secret");
  deps.io.err("       and a pinned link. Use an encrypted address (https:// via tailscale serve, or your own TLS");
  deps.io.err("       front door). If this hop is genuinely trusted and you accept that risk, re-run with");
  deps.io.err("       --insecure to own that assumption explicitly.");
}

/**
 * `collie pack join <lead-address> [<token>]` — §8.2, run on the peer, once.
 *
 * Distinct outcomes get distinct exit codes (spec requirement), because "it didn't work" is the one
 * answer an operator cannot act on: already in a pack is `3`, a refused token is `4`, an address that
 * did not answer is `5`.
 */
export async function cmdJoin(deps: PackDeps, args: readonly string[]): Promise<number> {
  const { positional, flags, bare } = parsePackArgs(args, ["insecure"]);
  const [address, tokenArg] = positional;
  if (address === undefined) {
    deps.io.err(JOIN_USAGE);
    deps.io.err("       Mint the token on the lead with `collie pack invite`; it is single-use and lasts 10 minutes.");
    return EXIT.USAGE;
  }

  const existing = await deps.store.load();
  if (existing !== null && existing.pack !== null) {
    const role = existing.lead === null ? `lead of ${existing.peers.length} peer(s)` : `peer of "${existing.lead.memberId}"`;
    deps.io.err(`error: already in pack "${existing.pack.name}" as ${role} (member "${existing.self.memberId}").`);
    deps.io.err("       Run `collie pack leave` here first — joining a second pack is not a thing (§3).");
    return EXIT.STATE;
  }

  const raw = await resolveToken(deps, address, tokenArg);
  if (raw === null) return EXIT.USAGE;

  // The operator-carried token is `<token>.<lead-fingerprint>` (§8.2). Split on the LAST dot: minted
  // tokens and fingerprints hold none, so this is unambiguous, and the wire `EnrollRequest.token` is
  // ONLY the part before it — the far side never sees the fingerprint. FAIL CLOSED on an old-format
  // token: a token that names no lead, or names a malformed one, is refused here rather than enrolled
  // without ever authenticating the lead. That refusal is the whole point — it cannot be skippable.
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) {
    deps.io.err("error: this invite has no lead fingerprint — mint a fresh one on an updated lead.");
    deps.io.err("       A token that names no lead cannot pin one, so Collie refuses to enroll on it:");
    deps.io.err("       run `collie pack invite` on the lead and paste the whole `<token>.<fingerprint>`.");
    return EXIT.REFUSED;
  }
  const token = raw.slice(0, dot);
  const invitedFp = normalizeFingerprint(raw.slice(dot + 1));
  if (invitedFp === null) {
    deps.io.err("error: the invite's lead fingerprint is malformed — a fingerprint is 64 hex characters.");
    deps.io.err("       The token was likely truncated or mistyped. Mint a fresh one: `collie pack invite`.");
    return EXIT.REFUSED;
  }

  const label = joinLabel(deps, flags.label);
  const data = await ensureStore(deps, label);
  if (data === null) return EXIT.FAIL;
  // Joining makes this machine a peer, and a peer is dialled on its own pack listener — never on a
  // front door, because it is about to tear its own one down (§3).
  const mine = selfAddress(deps, flags.address, "pack-listener");
  if (mine === null) {
    deps.io.err("error: cannot work out an address the lead can dial this machine at.");
    deps.io.err("       Pass one: `collie pack join <lead-address> - --address <host-the-lead-can-reach>`.");
    return EXIT.FAIL;
  }

  // The address the operator typed, resolved once: scheme and port defaults applied, and kept as a
  // URL so the plain-HTTP retry below can flip one field rather than re-parse a string.
  const typedScheme = /^https?:\/\//i.test(address);
  let origin = leadOrigin(address);
  if (origin === null) {
    deps.io.err(`error: "${address}" is not a host this can dial — give a hostname or host:port.`);
    return EXIT.USAGE;
  }
  const insecure = bare.has("insecure");

  // An EXPLICIT `http://` address is refused exactly as it always was, with no question asked. A
  // script that spells the scheme means it, and a prompt would change what that script does; the
  // consent below is only ever offered for an address that named no scheme at all.
  if (origin.protocol === "http:" && !insecure) {
    refusePlaintext(deps);
    return EXIT.REFUSED;
  }

  const body = JSON.stringify({
    protocol: PACK_PROTOCOL_VERSION,
    token,
    fingerprint: data.self.fingerprint,
    // The certificate itself, not only its hash: the lead pins by fingerprint but ENFORCES by
    // certificate (its dial's `ca` list), and it has no other way to obtain the material. The
    // lead re-derives the fingerprint from these bytes and refuses a payload where the two
    // disagree, so sending both adds a cross-check rather than a second source of truth.
    certPem: data.self.certPem,
    address: mine,
    label: label ?? null,
  });

  let attempt = await postEnrollment(deps, origin, body);
  // A lead whose pack surface is plain HTTP on the port we assumed `https://` for fails the
  // handshake, not the request — and the operator, who typed a bare host, has no way to know that
  // is what happened. So ask, once, in a terminal, and retry the same host:port over `http://` if
  // the answer is yes. Nothing has crossed the wire at this point: the question comes BEFORE the
  // token is sent, which is the whole reason the retry is a second POST and not a redirect.
  if (attempt.res === undefined && attempt.plaintext && !typedScheme) {
    const plain = new URL(origin.toString());
    plain.protocol = "http:";
    if (!insecure && !(await consentToPlaintext(deps, plain))) {
      refusePlaintext(deps);
      return EXIT.REFUSED;
    }
    origin = plain;
    attempt = await postEnrollment(deps, origin, body);
  }

  // What was actually dialled, and therefore what this machine must remember: a peer dials its lead
  // again on every poll, and a bare `bluefin` would send those dials to :443 over TLS the lead never
  // answers. The origin is stored, so the second dial goes where the first one succeeded.
  const dialed = `${origin.protocol}//${origin.host}`;
  const res = attempt.res;
  if (res === undefined) {
    deps.io.err(`error: could not reach ${address} — ${attempt.reason}`);
    deps.io.err("       The lead owns nothing about reachability: check the address, the tunnel, the port.");
    if (!typedScheme && origin.protocol === "https:") {
      deps.io.err("       No scheme was given, so https:// was assumed. If the lead really is plaintext http://, say");
      deps.io.err("       so explicitly AND pass --insecure — but the token and pack secret then cross the wire in the");
      deps.io.err("       clear (see the http:// refusal).");
    }
    return EXIT.UNREACHABLE;
  }

  if (res.status === 401) {
    deps.io.err("error: the lead refused the token — spent, expired (10 minutes), or this is not its address.");
    deps.io.err("       Mint a fresh one on the lead: `collie pack invite`.");
    return EXIT.REFUSED;
  }
  if (res.status === 409) {
    deps.io.err(`error: protocol mismatch — this build speaks ${PACK_PROTOCOL_VERSION}; update the older machine.`);
    return EXIT.REFUSED;
  }
  if (!res.ok) {
    deps.io.err(`error: the lead answered HTTP ${res.status} to the enrollment request.`);
    return EXIT.FAIL;
  }

  const parsed = parseEnrollResponse(await res.json().catch(() => null));
  if (parsed === null) {
    deps.io.err("error: the lead's enrollment response was not one this build can read.");
    return EXIT.FAIL;
  }

  // The invite named the lead's certificate fingerprint; the answer must present THAT certificate.
  // `parseEnrollResponse` already proved `leadFingerprint === fingerprintOfCert(leadCertPem)`, so this
  // one comparison is the lead authenticating itself to the joiner — it is what a self-consistent
  // response could never do on its own. A MITM or a mistyped/rebound address that captured the token
  // and answered with ITS OWN certificate is refused here, BEFORE anything is pinned or persisted
  // (§8.2). This fingerprint anchors the LEAD to the joiner — a fake lead answering with its own
  // certificate is refused here — but it does NOT protect the lead from a token-thief on a plaintext
  // hop: over http:// an on-path attacker races the spend with their own certificate, which is why
  // http:// enrollment now requires an explicit --insecure (see the guard above).
  if (invitedFp !== parsed.leadFingerprint) {
    deps.io.err("error: the lead's certificate does not match the invite — this is not the machine the");
    deps.io.err("       invite was minted on. Possible man-in-the-middle on the enrollment path, or the");
    deps.io.err("       wrong <lead-address>. Nothing was pinned or persisted. Check the address; if it is");
    deps.io.err("       right, mint a fresh invite on the lead: `collie pack invite`.");
    return EXIT.REFUSED;
  }

  const accepted = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : acceptEnrollment(current, parsed, dialed, deps.now()),
  );
  if (accepted === null) return EXIT.FAIL;

  deps.io.out(`✓ joined pack "${parsed.packName}" as "${accepted.memberId}"`);
  deps.io.out(`  lead      ${parsed.leadMemberId} at ${dialed}`);
  deps.io.out(`  pinned    ${parsed.leadFingerprint.slice(0, 16)}… (its certificate, not its name)`);
  deps.io.out("  This machine now publishes no front door and sends no notifications of its own —");
  deps.io.out("  the phone talks to the lead, which speaks for the whole pack.");
  deps.io.out("");
  // The lead persisted this enrollment through its OWN running bridge, which read its roster at boot
  // and does not re-read it (§8.2's note). This side restarts itself two lines below; the lead cannot
  // be restarted from here, so the operator is told — it is the one remaining step of the join.
  deps.io.out(`  ONE STEP LEFT, on the lead (${parsed.leadMemberId}): \`collie restart\` there.`);
  deps.io.out("  Its roster now has this machine on disk, but its running process read that roster at");
  deps.io.out("  boot — until it restarts, this machine's sessions do not appear on the phone.");

  // Clear BEFORE the restart: after it the herd push path is muted (peer mode), and a muted sink
  // drops a `clear` exactly as it drops an alert — so anything already on the phone would be stuck.
  await clearOwnHerdTags(deps);
  await applyLocally(deps, "peer mode");
  // …and only then the front door, because `restart` runs `start`, which publishes. Tearing down
  // first would race the very thing that re-publishes it (ADR 0001: one managed front door, the
  // lead's — a peer manages none).
  const unserved = deps.unserve();
  if (unserved !== EXIT.OK) {
    deps.io.err("warn: could not tear down this machine's `tailscale serve` mapping — it refused to touch a");
    deps.io.err("      mapping it cannot prove Collie owns. Check `collie status`; a peer must publish none.");
  }
  return EXIT.OK;
}

/**
 * The origin an operator-typed lead address names. `null` when it is not a bare host.
 *
 * Two defaults, and both only for an address that named no scheme: `https://`, as it always did, and
 * **port 8787** — the port a collie's own listener binds, and therefore the only thing `collie pack
 * join bluefin` can mean. A typed scheme or a typed port is taken as typed, so `host:port`,
 * `http://…` and `https://…` resolve exactly as they did before this default existed.
 *
 * The port is the reason a bare host is no longer :443. A lead's front door on :443 is a `tailscale
 * serve` mapping in front of that same listener, so it is one more thing that has to be right; the
 * listener itself is what enrollment actually needs, and it is at 8787 on every default install.
 */
export function leadOrigin(address: string): URL | null {
  const typedScheme = /^https?:\/\//i.test(address);
  let base: URL;
  try {
    base = new URL(typedScheme ? address : `https://${address}`);
  } catch {
    return null;
  }
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") return null;
  if (base.pathname !== "/" || base.host === "") return null;
  if (!typedScheme && base.port === "") base.port = String(DEFAULT_PORT);
  return base;
}

/** The enrollment URL for an operator-typed address. `null` when it is not a bare host. */
export function enrollUrl(address: string): string | null {
  const base = leadOrigin(address);
  return base === null ? null : new URL(PACK_ENROLL_PATH, base).toString();
}

// ── leave (on the peer) ──────────────────────────────────────────────────────

/**
 * `collie leave` — drop the roster entry, the pinned material and the pack secret (§8.4).
 *
 * It revokes on both sides where it can, and **tells the truth when it cannot**: a peer that leaves
 * while the lead is down still stops trusting the lead locally, and the operator is told, in the same
 * breath, that the lead still lists this machine and what to run there.
 */
export async function cmdLeave(deps: PackDeps): Promise<number> {
  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.err("error: this collie is not in a pack — nothing to leave.");
    return EXIT.STATE;
  }
  if (isLeading(data)) {
    deps.io.err(`error: this collie LEADS ${data.peers.length} peer(s); leaving would strand them.`);
    deps.io.err("       Drop them one at a time with `collie pack remove <member>`, or hand the pack over");
    deps.io.err("       with `collie promote` on the machine that should lead it.");
    return EXIT.STATE;
  }

  let revoked = false;
  if (data.lead !== null) {
    const client = clientFor(deps, data, data.pack.secret);
    const outcome = await client.json(linkOf(data.lead), "leave", undefined, {
      method: "POST",
      headers: CONTENT_TYPE,
      body: "{}",
    });
    revoked = outcome.ok;
    if (!outcome.ok) deps.io.err(`warn: could not tell the lead — ${failureLine(outcome)}`);
  }

  const left = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : leavePack(current),
  );
  if (left === null) return EXIT.FAIL;

  deps.io.out(`✓ left pack "${data.pack.name}" — the pack secret and every pin are gone from this machine.`);
  deps.io.out("  This collie's own identity survives, so re-joining needs no new certificate anywhere.");
  if (revoked) {
    deps.io.out(`  The lead removed this machine from its roster too.`);
  } else if (data.lead !== null) {
    deps.io.out(`  The lead was NOT reached: "${data.lead.memberId}" still lists this machine. Run there:`);
    deps.io.out(`    collie pack remove ${data.self.memberId}`);
    deps.io.out("  Until then it will keep dialling this address and being refused — which is harmless,");
    deps.io.out("  because the pins and the secret it would need are already gone from here.");
  }
  // BEFORE the restart, so the bridge that comes back is the one this verb just described.
  for (const line of retirePackBind(deps)) deps.io.out(line);
  await applyLocally(deps, "solo mode (own front door, own notifications)");
  return EXIT.OK;
}

/**
 * Returning a machine to solo includes returning its BIND, and this is the half that was missing.
 *
 * `pack add`'s configure leg writes `COLLIE_HOST=<the address the lead dials>` — a wide bind — and
 * nothing else. Peer mode tolerates that; solo mode does not. So the moment the documented tear-down
 * finished, the machine's service began failing every five seconds forever on
 * `COLLIE_HOST=… is not a loopback address`, while the last thing `collie leave` printed was
 * "isn't answering … yet · activating" — a word that means "wait" over a unit that will never come
 * up. Recovery meant reading the journal and hand-editing `.env` (F12).
 *
 * ── WHY THE BIND IS DROPPED, AND NOT PERMITTED ──────────────────────────────
 * The other candidate fix was for `pack add` to write `COLLIE_ALLOW_NON_LOOPBACK_BIND=1` beside the
 * wide bind it chose. That is the substitution ADR 0013 exists to refuse. A peer's off-loopback
 * listener is admitted BY CONSTRUCTION — two independent factors, pinned mutual TLS plus the pack
 * secret, checked before any handler runs — and ADR 0013 is explicit that the browser gates
 * (`Tailscale-User-Login`, `COLLIE_DEVICE_HEADER`, same-origin) are client-settable and mean nothing
 * on a wide bind. `collie leave` destroys both factors in the two lines above this one. Carrying the
 * exemption past them would leave a machine with no pack, a wide bind, its own front door and its
 * browser write gates back on — reachability standing in for authorisation, which is the one
 * substitution the whole posture is built to refuse. The exemption is the pack's; it lapses with it.
 *
 * ── WHAT IT WILL NOT TOUCH ─────────────────────────────────────────────────
 * Only a bind that CANNOT WORK. If `COLLIE_ALLOW_NON_LOOPBACK_BIND` is set, the operator has said
 * they own the bind (ADR 0013's F3 amendment: the bind is one address and it is theirs), and nothing
 * here second-guesses it. So this needs no record of who wrote the value: a non-loopback bind with no
 * allow-flag is one the solo bridge refuses to start on, whoever wrote it, and removing it destroys
 * no working configuration — it restores the default, which is loopback.
 */
function retirePackBind(deps: PackDeps): string[] {
  const host = resolveBridgeHost(deps.ctx.env);
  const refusal = nonLoopbackBindRefusal({
    host,
    allowNonLoopbackBind: envBool("COLLIE_ALLOW_NON_LOOPBACK_BIND", false, deps.ctx.env),
  });
  if (refusal === null) return [];
  const envPath = join(deps.ctx.configDir, ".env");
  const text = deps.files.read(envPath);
  const next = text === null ? null : dropEnvAssignments(text, "COLLIE_HOST");
  if (next === null) {
    // The value is real — the bridge resolves it — but it is not in the file this verb owns: a
    // systemd `Environment=`, an exported shell variable, a wrapper. Say what will happen, name the
    // variable, and hand over the two ways out. Silence here is what made this finding a blocker.
    return [
      `  ⚠ This machine binds COLLIE_HOST=${host}, which \`pack add\` needed and solo mode refuses:`,
      "    the bridge will exit at startup and systemd will restart it every five seconds, forever.",
      `    Collie could not fix it here — that value does not come from ${envPath}.`,
      "    Unset COLLIE_HOST wherever it is set (a systemd Environment=, your shell), or set",
      "    COLLIE_ALLOW_NON_LOOPBACK_BIND=1 if you mean to keep binding wide with your own control",
      "    in front of it. Then `collie restart`.",
    ];
  }
  deps.files.write(envPath, next, 0o600);
  // …and out of THIS process's view of the environment, which is the half F22 was missing. The
  // restart on the next line prints the health banner, and that banner resolves the bind it probes
  // from `ctx.env` — the env as this process read it at start-up, still carrying the value just
  // deleted from disk. So the tear-down ended on `⚠ Collie isn't answering on <the bind it had just
  // removed> yet` about a machine that was healthy on loopback: the probe dialled an address the
  // machine no longer binds, and blamed the machine. `leave` is the one verb that knowingly changes
  // COLLIE_HOST underneath itself, so it is the one verb that must re-seat it here.
  delete deps.ctx.env.COLLIE_HOST;
  return [
    `  COLLIE_HOST=${host} removed from ${envPath} — it was the address the LEAD dialled, and a`,
    "  wide bind is admitted only by the pack's two factors (ADR 0013), which this machine no longer",
    "  has. Solo refuses to start on it, so leaving it would have crash-looped the service.",
    "  This collie is back on loopback, where a solo collie belongs; put your own ingress in front",
    "  of it, or set COLLIE_ALLOW_NON_LOOPBACK_BIND=1 if you mean to bind wide with a control there.",
  ];
}

// ── pack status ──────────────────────────────────────────────────────────────

/**
 * The diagnostic surface (spec requirement): mode, members, reachability, secret pickup, version skew
 * and the reason for a refusal.
 *
 * **This is the one place the refusal causes are distinguished**, and it is legitimate here for the
 * reason §8.1 gives for hiding them on the wire: this is the operator, on their own machine, reading
 * their own 0600 store. What is knowable locally is stated locally — an `unenrolled` tombstone, a
 * member a generation behind — and what only the far side knows stays as its verbatim reason string.
 */
export async function cmdPackStatus(deps: PackDeps, args: readonly string[]): Promise<number> {
  const { bare } = parsePackArgs(args, ["force", "no-probe"]);
  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.out("mode: solo — this collie is not in a pack (no trust store, or an empty one).");
    deps.io.out("  `collie pack invite` here makes it a lead; `collie join …` makes it a peer.");
    return EXIT.OK;
  }

  const { mode, conflict } = deriveMode({
    peers: data.peers.filter((p) => p.status === "enrolled"),
    lead: data.lead !== null && data.lead.status === "enrolled" ? data.lead : null,
  });
  deps.io.out(`pack   ${data.pack.name}  (${data.pack.packId})`);
  deps.io.out(`mode   ${mode}`);
  deps.io.out(`self   ${data.self.memberId}  ${data.self.fingerprint.slice(0, 16)}…`);
  // What interface this collie's own pack listener answers on — COLLIE_HOST, resolved the same way
  // the bridge resolves it (default loopback). Shown so an operator SEES the bind rather than infers
  // it; the bind never gates (pinned mTLS + the pack secret do, §3), it only bounds who can attempt.
  const bind = deps.ctx.env.COLLIE_HOST ?? "127.0.0.1";
  const bindShown = bind.trim() === "" ? "0.0.0.0/:: (COLLIE_HOST empty)" : bind;
  const bindNote = bindIsWildcard(bind) ? " — ALL interfaces, gated only by pinned mTLS + the pack secret" : "";
  deps.io.out(`bind   ${bindShown}${bindNote}`);
  deps.io.out(`secret generation ${data.pack.secretGeneration}, rotated ${new Date(data.pack.rotatedAt).toISOString()}`);
  if (conflict !== null) deps.io.out(`⚠ ${conflict}`);
  // A live handover approval is state an operator must be able to see they left armed (§14.1) — in
  // the same spirit as §8.4's per-member secret column. Expired reads as absent, and a peer shows
  // nothing because no approval can exist there: it is consent to demote *this* machine.
  const approval = data.lead === null ? liveHandover(data, deps.now()) : null;
  if (approval !== null) {
    const minutes = Math.max(1, Math.ceil((approval.expiresAt - deps.now()) / 60_000));
    deps.io.out(`handover approved: ${approval.memberId} — expires in ${minutes}m`);
  }
  // The deputy, from whichever side this machine is on (RFC §10). The lead prints its own
  // designation; a peer prints the warrant it holds and whether its listener is actually built with
  // it — two different facts, and only one of them is knowable on each machine.
  const marker = parseMarker(deps.files.read(packRuntimePath(deps.ctx.stateDir)));
  // …but first, whether this machine is still the lead it thinks it is. A machine rejoining a pack
  // by itself must be a thing the operator READS about, not one they discover (RFC §8.2).
  for (const l of deposedLines(marker)) deps.io.out(l.text);
  const sideLines =
    data.lead === null
      ? [...leadDeputyLines(data, deps.now()), ...pairingCollisionLines(marker, deps.now())]
      : [
          ...leadContactLines(data, marker, deps.ctx.env, deps.now()),
          ...peerWarrantLines(data, marker, deps.now()),
          // Only the named deputy prints anything here, and only about the door THIS machine binds.
          ...standbyDoorLines(data, marker, syncedDevicesOnDisk(deps), deps.ctx.env, deps.now()),
        ];
  for (const l of sideLines) deps.io.out(l.text);
  reportDrift(deps, data);

  const members = data.lead === null ? data.peers : [data.lead, ...data.peers];
  if (members.length === 0) {
    deps.io.out("members: none yet — mint an invite and run `collie join` on the other machine.");
    return EXIT.OK;
  }

  // Both questions, always — a member that answers `hello` on the patient budget and then starves the
  // phone on the strict one is the exact failure this surface used to render as `reachable`.
  const reaches = bare.has("no-probe") ? new Map<string, MemberReach>() : await probeMemberReach(deps, data, members);
  const clamped = packTimeoutClampWarning(pollFor(deps.ctx), deps.ctx.env);
  if (clamped !== null) deps.io.out(clamped);
  // This build's own version, resolved once for the whole roster by the same rule `collie version`
  // uses (`bridge/version.ts`) — the bridge answers `hello` with that exact string, so the two sides
  // of every comparison below are the same kind of thing.
  const ours = collieVersionBare(deps.ctx.root, (p) => deps.files.read(p));

  // ── The roster, in one voice ───────────────────────────────────────────────
  // Every line below is emitted through `emit`, which either prints it (the plain path, byte for
  // byte what it always was) or banks it with a tone for `cli/ui/` to colour. The lines are FORMED
  // once, here, rather than modelled and re-derived: this surface is deliberately wordy — a
  // provisional member gets three lines of explanation, a bare 401 gets four — and a second
  // formatter would be a second place for that prose to drift. Colour is what the terminal adds.
  const banked: TonedLine[] = [];
  const emit = (text: string, tone: Tone = "plain"): void => {
    if (deps.ui != null) banked.push({ text, tone });
    else deps.io.out(text);
  };

  // The one machine that may take over, when it is the one not answering (RFC §5). Emitted above the
  // roster rather than beside that member's row: it is a fact about the PACK's readiness, and it is
  // the line the operator has to act on while the lead is still healthy enough to sign a new warrant.
  // Suppressed under `--no-probe`, where nothing answered because nothing was asked: a warning
  // derived from an unasked question is the fastest way to teach an operator to ignore warnings.
  if (data.lead === null && !bare.has("no-probe")) {
    for (const l of deputyUnreachableLines(data, (id) => reaches.get(id)?.hello.ok === true)) {
      emit(l.text, l.tone);
    }
  }
  // Read once for the whole roster: the anchor column is per member, and one file answers for all.
  const opsRecords = data.lead === null ? (await deps.ops.load()).data : null;

  emit("");
  emit("members:", "dim");
  for (const m of members) {
    const behind = m.status === "enrolled" && m.secretGeneration !== data.pack.secretGeneration;
    emit(`  ${m.memberId}  (${m.role})  ${m.address}`, "plain");
    emit(`    pinned  ${m.fingerprint.slice(0, 16)}…  enrolled ${new Date(m.enrolledAt).toISOString()}`, "dim");
    emit(
      `    secret  generation ${m.secretGeneration}` +
        (behind ? " — HAS NOT picked up the current secret" : " — current"),
      behind ? "warn" : "dim",
    );
    // §9's unfinished business, above the link line rather than under it: a member still owed the
    // proof is usually the unreachable one, and the row must not be conditional on it answering.
    if (data.lead === null) for (const l of memberRePinLines(m)) emit(l.text, l.tone);
    if (m.status === "unenrolled") {
      emit("    status  unenrolled — dropped by a rotation it was offline for (§8.4).", "warn");
      emit(`            Recovery is deliberate: \`collie pack invite\` here, \`collie join\` there.`, "dim");
      continue;
    }
    const reach = reaches.get(m.memberId);
    const outcome = reach?.hello;
    // A member pinned but never once contacted (strictly `contactedAt === null`) is a possible
    // half-finished join. An ABSENT field is `undefined` — a member from before this field existed —
    // and must never read as provisional. A number is a real contact time. Suppressed when this very
    // probe succeeded: a member reachable right now is not half-finished (it is stamped just below).
    if (m.contactedAt === null && outcome?.ok !== true) {
      emit("    status  provisional — enrolled but never once reachable; a half-finished join looks exactly", "warn");
      emit(`            like this (§8.2). If you did not complete a join for "${m.memberId}", clear it:`, "dim");
      emit(`            \`collie pack remove ${m.memberId}\`.`, "dim");
    }
    if (outcome === undefined) {
      emit("    link    not probed (--no-probe)", "dim");
      continue;
    }
    if (outcome.ok) {
      emit(`    link    reachable · answered at ${new Date(outcome.receivedAt).toISOString()}`, "good");
      // The second question. `hello` says the machine is there; this says the phone can actually be
      // fed from it, on the strict per-poll budget that every real read runs under.
      for (const line of dataLines(reach)) emit(line.text, line.tone);
      for (const line of versionLines(outcome.value.version, ours, m.memberId)) emit(line, "dim");
      // The two phases of RFC §5, for this member: what it says it holds, and whether its listener
      // came up holding it (§18.17). Lead-side only — a peer has no roster to report anchoring for.
      if (data.lead === null) {
        const record = opsRecords?.members[m.memberId] ?? null;
        const active = outcome.value.warrantActiveGeneration;
        for (const l of memberWarrantLines(data, outcome.value.warrantGeneration, record, m.memberId, active)) {
          emit(l.text, l.tone);
        }
        await convergeAnchor(deps, data, record, m.memberId, active);
      }
      // First successful contact clears the provisional marker: one-time and self-healing. The
      // bridge's own sweep could also stamp this later; today `pack status` is the clearer.
      if (m.contactedAt === null) {
        const at = outcome.receivedAt;
        const stamp = (x: TrustedMember): TrustedMember => (x.memberId === m.memberId ? { ...x, contactedAt: at } : x);
        await commitPackChange(deps.store, deps.audit, (current) =>
          current === null
            ? null
            : {
                next: {
                  ...current,
                  lead: current.lead === null ? null : stamp(current.lead),
                  peers: current.peers.map(stamp),
                },
                result: null,
                audit: { action: "pack.contacted", detail: { member: m.memberId, at } },
              },
        );
      }
      continue;
    }
    if (outcome.state === "incompatible") {
      emit(`    link    INCOMPATIBLE · ${outcome.reason}`, "bad");
      emit(
        `            Not retried on the poll cadence. If this machine is the newer one:` +
          ` \`collie pack update ${m.memberId}\`.`,
        "dim",
      );
      continue;
    }
    emit(`    link    unreachable · ${outcome.reason}`, "bad");
    if (outcome.reason.includes("unauthorized")) {
      emit("            A bare 401 is deliberately one answer for two causes (§8.1): an unpinned", "dim");
      emit("            certificate or a secret this member no longer holds. The local column above", "dim");
      emit("            says which is likelier — a member a generation behind is the secret.", "dim");
    }
    // …and the one cause the address itself gives away. Below the reason, not instead of it: the
    // scheme is a strong suspicion about an unreachable member, never a diagnosis of the failure.
    for (const l of schemedAddressLines(m.memberId, m.address, m.role)) emit(l.text, l.tone);
    for (const l of unreachableLeadLines(m)) emit(l.text, l.tone);
  }
  if (deps.ui != null) await deps.ui.packMembers(banked);
  return EXIT.OK;
}

/**
 * The registry this machine's lead has synced here (RFC §6.5), off disk.
 *
 * Absent, unreadable or malformed all read as **none**, which is exactly how the door itself reads
 * them — and "none" is a refusal to arm rather than an ungated one, so the closed reading is also the
 * honest one. Never `paired-devices.json`: these are the lead's device hashes and merging them into
 * this machine's own registry would arm its own write gate (`bridge/pack/standby-devices.ts`).
 */
function syncedDevicesOnDisk(deps: PackDeps): StandbyDevices | null {
  const raw = deps.files.read(standbyDevicesPath(deps.ctx.stateDir));
  return raw === null ? null : parseStandbyDevices(raw);
}

/**
 * The one thing `pack status` knows that the store alone does not: **whether the running bridge is
 * serving this roster**.
 *
 * A membership change can land on a bridge nobody restarted — the first `join` writes into the LEAD's
 * store through the lead's own enrollment endpoint, and a promotion demotes the old lead the same way
 * — and the trust store is read once per process, at boot, on purpose (§8.3, §3). The bridge leaves
 * the roster it wired in `pack-runtime.json`; this compares the two and names the restart.
 *
 * Silent when there is no marker: no bridge has booted since this store existed, so there is no
 * running process for the store to be ahead of, and a `pack status` run before the first `start`
 * must not invent a warning.
 */
export function reportDrift(deps: DriftDeps, data: TrustStoreData): void {
  const marker = parseMarker(deps.files.read(packRuntimePath(deps.ctx.stateDir)));
  const drift = rosterDrift(marker, data);
  if (drift === null || marker === null) return;
  deps.io.out("");
  deps.io.out("⚠ enrolled but INACTIVE — the bridge running here still holds the roster it read at boot.");
  if (drift.gained.length > 0) deps.io.out(`    not yet active:  ${drift.gained.join(", ")}`);
  if (drift.lost.length > 0) deps.io.out(`    still wired for: ${drift.lost.join(", ")} (no longer members)`);
  if (drift.modeChanged !== null) {
    deps.io.out(
      `    this machine is a ${drift.modeChanged} on disk and a ${marker.mode} in memory — its listener` +
        ` and its front door are still the ${marker.mode}'s.`,
    );
  }
  deps.io.out("  Run `collie restart` HERE to activate it. Nothing is lost meanwhile: the store is correct,");
  deps.io.out("  it is the process that is behind, and every membership verb restarts on its own machine.");
}

/**
 * The first Collie version that reports its own version over `hello` (PACK_PROTOCOL.md §5, amended
 * 2026-08-12). A member that answers without the field is older than this and is rendered as such —
 * honestly, and never as `unknown`-shaped noise (§7.1).
 *
 * It names the version this amendment SHIPS in, which is why it is a literal and not read from the
 * manifest: it is a fact about the protocol's history, fixed forever once released, while the
 * manifest moves with every release.
 */
export const VERSION_REPORTED_SINCE = "1.0.0-alpha.12";

/**
 * How a member's reported version renders (§7.1). Skew is an **observation**: it refuses nothing,
 * degrades nothing and is never the `incompatible` state — that one stays reserved for §7's protocol
 * mismatch, which is a wire contract rather than a build number.
 *
 * Same version ⇒ one quiet line. Different ⇒ a `warn:` naming BOTH versions and the remedy. Absent
 * ⇒ pre-amendment, stated plainly: the member is behind, not broken, and cannot say so itself.
 */
function versionLines(reported: string | null, ours: string, memberId: string): string[] {
  if (reported === null) return [`    version pre-${VERSION_REPORTED_SINCE} (not reported)`];
  if (reported === ours) return [`    version ${reported}`];
  // `unknown` is this checkout answering "no build stamp and no manifest" — it is not a version, so
  // there is no older machine to name. Report theirs and stay quiet rather than warn about a skew
  // whose other half we cannot state.
  if (ours === "unknown") return [`    version ${reported}`];
  return [
    `    version ${reported} — warn: this machine runs ${ours}`,
    `            Build skew refuses nothing (§7.1) — the link keeps working. Level it from here:`,
    `            \`collie pack update ${memberId}\` (over your own ssh, ADR 0016).`,
  ];
}

/**
 * Bring `pack-ops.json`'s anchor record up to what the member itself just reported (§18.17).
 *
 * The record is this operator's own lower bound — it moves only when `pack deputy`'s restart leg
 * completes here — so a machine restarted any other way stays recorded as un-armed forever, and the
 * OFFLINE view (`pack status --no-probe`, and every member that is not answering right now) keeps
 * printing `anchor INACTIVE` about a pack that is armed. A probe that got the answer writes it down,
 * so the two views converge instead of disagreeing until the next `pack deputy`.
 *
 * **Only ever a refresh, never a creation.** A member with no record is one this machine has never
 * SSH'd to (ADR 0016), and an anchor generation with no ssh route beside it would be a record
 * inventing a field the operator never supplied. It is also silent on failure for the reason
 * `PackOpsStore.record` returns a boolean at all: a convenience file is never worth failing a
 * read-only status on, and the next probe will try again.
 */
async function convergeAnchor(
  deps: PackDeps,
  data: TrustStoreData,
  record: OpsRecord | null,
  memberId: string,
  active: number | null,
): Promise<void> {
  if (record === null || active === null) return;
  const issued = currentWarrant(data)?.warrant ?? null;
  if (issued === null || issued.deputyMemberId === null || active < issued.generation) return;
  if ((record.anchoredGeneration ?? 0) >= active) return;
  await deps.ops.record(memberId, { ...record, anchoredGeneration: active, anchoredAt: deps.now() });
}

/**
 * How the data half of a {@link MemberReach} renders, under a member that answered `hello`.
 *
 * A failure here is the interesting line on this whole surface: the machine IS there — it just
 * answered — so the remedy is a budget, not a `reconnect`. It names both knobs, because raising one
 * without the other is silently clamped ({@link packTimeoutClampWarning}).
 *
 * **Silent when no data request was sent at all** — `--no-probe`, a `hello` that never answered, or a
 * member that is this store's LEAD, which is asked one question and no more ({@link MemberReach.data}).
 * The lead's row therefore rests on `link` alone, which is the whole of what a peer can know.
 */
function dataLines(reach: MemberReach | undefined): TonedLine[] {
  const data = reach?.data;
  if (data === undefined || data === null) return [];
  if (data.ok) return [{ text: `    data    served a snapshot in ${reach?.dataMs ?? 0}ms`, tone: "good" }];
  return [
    { text: `    data    STARVED · answered \`hello\`, but ${failureLine(data)}`, tone: "bad" },
    {
      text: "            The machine is there; its data is not arriving inside the per-poll budget.",
      tone: "dim",
    },
    {
      text: `            Raise BOTH: \`COLLIE_PACK_TIMEOUT_MS\` and \`COLLIE_POLL_MS\` (the first is clamped to 0.8 of the second).`,
      tone: "dim",
    },
  ];
}

/**
 * `hello` against every member, concurrently — one budget for the sweep, not N (§10.1).
 *
 * Typed on {@link HelloResult} rather than `unknown`: the reported version is the point of the probe
 * for `pack status` (§7.1), and erasing it here would leave the renderer casting a body the client
 * has already parsed.
 */
export function probeMembers(
  deps: ProbeDeps,
  data: TrustStoreData,
  members: readonly TrustedMember[],
): Promise<Map<string, PeerOutcome<HelloResult>>> {
  const secret = data.pack?.secret ?? "";
  const client = clientFor(deps, data, secret);
  return sweepPeers<PeerOutcome<HelloResult>>(
    members.filter((m) => m.status === "enrolled").map(linkOf),
    (link) => client.hello(link),
  );
}

/** What one member answered to BOTH questions a link has to pass — see {@link probeMemberReach}. */
export interface MemberReach {
  /** The verdict probe, on the patient budget. Exactly what {@link probeMembers} returns. */
  readonly hello: PeerOutcome<HelloResult>;
  /**
   * One real data request — `GET /pack/v1/snapshot`, a read — under the budget rules the bridge's own
   * poll uses. `null` when the question was not asked, which is two cases and only two.
   *
   * **`hello` never answered.** A member that is not there has already failed, and asking it a second
   * question teaches nothing while doubling the wait.
   *
   * **The member is this store's LEAD.** A peer never polls its lead for a snapshot — the flow runs
   * the other way — and the route is not on the closed peer → lead set at all
   * (`bridge/pack/router.ts`'s `SIGNABLE_PATHS`, RFC §8.6: `leave`, `lead`, `hello` and the two
   * warrant deliveries; *"the proxy surface is not on this list and must not be"*). So the lead
   * ANSWERS a snapshot request with §8.1's bare 401, which is a correct refusal and not a fact about
   * the link. Asking it produced a red `STARVED` line, on a healthy pack, under a remedy — raise two
   * budgets — that cannot move an authorization refusal (F21).
   */
  readonly data: PeerOutcome<JsonValue> | null;
  /** How long the data request took, by this collie's clock, or `null` when none was sent. */
  readonly dataMs: number | null;
}

/**
 * `hello` **and one real data request** against every member — the probe every reachability finding
 * is built from.
 *
 * `hello` alone was a lie by omission. It runs on the patient budget (§10.4) while every data request
 * runs on the strict clamped one, so a link whose handshake outprices the poll answered the probe and
 * starved the phone: `pack status` printed `reachable`, `doctor` printed `member-reach ✓`, and every
 * pane read 503'd. The two questions are budgeted differently, so both have to be ASKED.
 *
 * One client for both, in that order, deliberately: the data request then rides the connection `hello`
 * just warmed, which is precisely the bridge's steady state after its own patient probe. What this
 * reports is therefore what the phone gets — not a cold-start number no poll ever sees.
 */
export async function probeMemberReach(
  deps: ProbeDeps,
  data: TrustStoreData,
  members: readonly TrustedMember[],
): Promise<Map<string, MemberReach>> {
  const client = clientFor(deps, data, data.pack?.secret ?? "");
  const enrolled = members.filter((m) => m.status === "enrolled");
  // The role travels beside the link because a `PackLink` is address material only (§4) — and the
  // role is what decides whether the second question exists to be asked. See {@link MemberReach.data}.
  const roles = new Map(enrolled.map((m) => [m.memberId, m.role]));
  return sweepPeers<MemberReach>(enrolled.map(linkOf), async (link) => {
    const hello = await client.hello(link);
    if (!hello.ok) return { hello, data: null, dataMs: null };
    // A peer's one roster entry is its LEAD, and `snapshot` is not on the peer → lead route set the
    // lead admits (§8.6) — so the only answer this request can ever get is a refusal. Not asking is
    // the fix; classifying the refusal more kindly would still be one wasted round trip per poll.
    if (roles.get(link.memberId) === "lead") return { hello, data: null, dataMs: null };
    const startedAt = deps.now();
    const snapshot = await client.snapshot(link);
    return { hello, data: snapshot, dataMs: deps.now() - startedAt };
  });
}

// ── pack rotate (on the lead) ────────────────────────────────────────────────

/**
 * Reissue the pack secret and distribute it (§8.4).
 *
 * **Order is the contract.** The rotation lands locally first, so there is never an instant where the
 * lead has handed out a value it does not itself hold; distribution then dials with the SUPERSEDED
 * secret, because a peer that has not been told yet still checks the old one and there is no grace
 * window to lean on. Between those two steps the lead's ordinary poll of an undelivered peer fails —
 * one interval of `stale`, which is the price of not keeping a leaked value alive.
 */
export async function cmdPackRotate(deps: PackDeps): Promise<number> {
  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.err("error: this collie is not in a pack.");
    return EXIT.STATE;
  }
  if (data.lead !== null) {
    deps.io.err(`error: rotation runs on the lead; this collie is a peer of "${data.lead.memberId}".`);
    return EXIT.STATE;
  }
  const previous = data.pack.secret;

  const rotated = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : rotatePackSecret(current, deps.now(), deps.random),
  );
  if (rotated === null) return EXIT.FAIL;
  const next = (await deps.store.load())?.pack;
  if (next === null || next === undefined) return EXIT.FAIL;
  deps.io.out(`rotating to generation ${rotated.secretGeneration} — the previous secret is already dead here.`);
  deps.io.out("  No grace window: any peer offline right now misses this pickup and is dropped to an `unenrolled` tombstone that must re-join.");

  const client = clientFor(deps, data, previous);
  const targets = data.peers.filter((p) => p.status === "enrolled");
  const outcomes = await sweepPeers(targets.map(linkOf), (link) =>
    client.json(link, "secret", undefined, {
      method: "POST",
      headers: CONTENT_TYPE,
      // The secret rides the body of an admitted, pinned link — the only channel it ever travels on.
      body: JSON.stringify({ secret: next.secret, generation: next.secretGeneration }),
    }),
  );

  for (const peer of targets) {
    const outcome = outcomes.get(peer.memberId);
    if (outcome?.ok === true) {
      await commitPackChange(deps.store, deps.audit, (current) =>
        current === null ? null : markSecretDelivered(current, peer.memberId),
      );
      deps.io.out(`  ✓ ${peer.memberId} picked up generation ${next.secretGeneration}`);
    } else {
      deps.io.out(`  ✗ ${peer.memberId} — ${outcome === undefined ? "not dialled" : failureLine(outcome)}`);
    }
  }

  const dropped = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : dropMembersBehind(current),
  );
  if (dropped !== null && dropped.dropped.length > 0) {
    deps.io.out("");
    deps.io.out(`dropped to unenrolled: ${dropped.dropped.join(", ")}`);
    deps.io.out("  They were offline for the rotation, so they hold a secret that is no longer accepted.");
    deps.io.out("  Recovery is deliberate: `collie pack invite` here, then `collie join` on each of them.");
  }
  await applyLocally(deps, "the new secret");
  return EXIT.OK;
}

// ── pack remove (on the lead) ────────────────────────────────────────────────

/** `collie pack remove <member>` — unpin and forget (§8.4). Local, and deliberately not a request. */
export async function cmdPackRemove(deps: PackDeps, args: readonly string[]): Promise<number> {
  const { positional } = parsePackArgs(args);
  const memberId = positional[0];
  if (memberId === undefined) {
    deps.io.err("usage: collie pack remove <member-id>");
    return EXIT.USAGE;
  }
  // Read before the roster changes, so the line printed below is composed from the same run's facts.
  const record = await deps.ops.get(memberId);
  const removed = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : removeMember(current, memberId),
  );
  if (removed === null) {
    deps.io.err(`error: no member "${memberId}" in this roster — \`collie pack status\` lists them.`);
    return EXIT.STATE;
  }
  deps.io.out(`✓ removed "${memberId}" — its pin is gone, so its certificate is now simply not a member.`);
  deps.io.out("  Nothing was sent to it: revocation is local by design, and the removed machine keeps its");
  deps.io.out("  own copy of the pack until its operator runs `collie leave` there. Either side alone ends");
  deps.io.out("  the link (§8.4) — this side is now ended.");
  for (const line of leaveTheOtherSideLines(deps, record)) deps.io.out(line);
  await applyLocally(deps, "the shortened roster");
  return EXIT.OK;
}

/**
 * The half of `pack remove` that helps: the command the operator now has to run on the OTHER side.
 *
 * `pack remove` is correct and says so plainly — the removed machine keeps its copy of the pack until
 * someone runs `collie leave` there. Meanwhile that machine sits in the worst state Collie has: still
 * in peer mode, so it publishes no front door and answers no phone, and no longer pinned here, so
 * this lead cannot reach it either. Invisible from both ends.
 *
 * **And this verb used to delete the one thing that finishes the job.** `pack-ops.json`'s row for the
 * member is `{sshHost, path, port}` — exactly the connection `pack add` used, and exactly what the
 * sentence above needs — and it was forgotten in the same breath as printing that sentence (F16).
 *
 * **So the row is KEPT, and this says where it is.** The comment that used to justify dropping it
 * feared a non-member lingering in `pack update`'s target list; that fear does not survive reading
 * the code — `pack update` builds its targets from the ROSTER and only then looks a member up here
 * (`cli/pack-update.ts`), so a row for a machine that is not a member can never be dialled by it.
 * Nothing here is trust and nothing here is a wire field, which is the whole of ADR 0016's rule; a
 * re-add overwrites the row, and deleting the file forgets it. That is a cheaper mistake than
 * throwing away an ssh destination the operator typed once and now needs.
 */
function leaveTheOtherSideLines(deps: PackDeps, record: OpsRecord | null): string[] {
  const where = packOpsPath(deps.ctx.stateDir);
  if (record === null) {
    return [
      `  It is still in peer mode over there, so it answers no phone — and this lead no longer has a`,
      `  pin for it. Finish the tear-down on that machine: \`collie leave\` there.`,
      `  (This lead has no record of how it was reached over ssh — nothing in ${where} named it.)`,
    ];
  }
  const binary = record.path === null ? "collie" : `${record.path}/bin/collie`;
  return [
    "  It is still in peer mode over there, so it answers no phone — and this lead no longer has a",
    "  pin for it. Finish the tear-down on that machine:",
    `    ssh ${record.sshHost} ${binary} leave`,
    `  That line is rebuilt from ${where}, which this verb KEEPS: it is how \`pack add\` reached the`,
    "  machine, it is not trust and never a wire field (ADR 0016), and `pack update` targets the",
    "  roster — so a row for a machine that is no longer a member can never be dialled by it.",
  ];
}

// ── pack set-address (on the lead) ───────────────────────────────────────────

/**
 * Why this address is not one a pack link may be dialled at — one line, or `null` when it is fine.
 *
 * A pack address is **bare `host:port`**, and the two refusals below are the two ways a real roster
 * row has gone wrong:
 *
 *  - **A scheme.** The pack builds its own request from the address (`packUrl`) and dials pinned
 *    mutual TLS itself (§8.1), so a `https://…` value is dialled as a *hostname* containing slashes
 *    and never resolves. Where such a row comes from is worth naming: a takeover ADOPTS the deposed
 *    lead's roster, and that row holds the address the pack knew the old lead by — its FRONT DOOR
 *    URL. A peer publishes no front door (ADR 0013), so after the crown moves that value names a
 *    door that no longer exists, in a form that could not be dialled even if it did.
 *  - **No port.** A portless address dials :443, which is right for a front door and silently wrong
 *    for a peer's listener — the member simply stays unreachable with nothing naming the cause
 *    (see {@link selfAddress}'s `pack-listener` note, which is the same trap on the minting side).
 */
export function packAddressRefusal(address: string): string | null {
  if (address.trim() !== address || address === "") return "it is empty or padded with whitespace";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
    return "an address with a scheme is a front door's, not a pack listener's — the pack dials pinned TLS itself, so it wants a bare host:port";
  }
  if (address.includes("/")) return "a pack address is a host and a port, never a path";
  // `[::1]:8787` as well as `host:8787` — the port is the last colon-separated field either way.
  const port = /:(\d+)$/.exec(address);
  if (port === null) {
    return "there is no port — a peer answers on its own COLLIE_PORT, and a portless address dials :443";
  }
  const n = Number(port[1]);
  if (n < 1 || n > 65535) return `port ${n} is not a port`;
  if (address.slice(0, address.length - port[0].length) === "") return "there is no host before the port";
  return null;
}

/**
 * The remedy `pack status` offers a peer whose LEAD did not answer — the other half of
 * {@link schemedAddressLines}, which is deliberately silent on this row.
 *
 * There is exactly one verb here, and it is not `pack set-address`. A member's address is corrected
 * on the machine that DIALS it, so a peer re-points its own lead with `collie reconnect <address>`,
 * run here ({@link cmdReconnect}); `set-address` is the lead's verb for a peer's row and refuses on
 * this machine ({@link cmdPackSetAddress}). Naming the wrong one sent an operator to a command that
 * refuses them, which is the whole of F11.
 *
 * Address-shaped remedies only. The lead is one machine behind one front door, so the two ways this
 * row goes quiet are "the door is down" and "the door moved" — and only the second is Collie's to
 * repair. The pin is never mentioned: it is unchanged by either, and `reconnect` does not touch it.
 */
function unreachableLeadLines(m: Pick<TrustedMember, "role" | "address">): TonedLine[] {
  if (m.role !== "lead") return [];
  return [
    { text: "            This is this machine's LEAD, reached at its front door — check that the door", tone: "dim" },
    { text: `            is up over there (\`collie status\` on the lead). If it MOVED, re-point this`, tone: "dim" },
    { text: "            machine at the new one HERE: `collie reconnect <address>` (the pin is kept).", tone: "dim" },
  ];
}

/**
 * The hint `pack status` appends to an unreachable member whose stored address carries a scheme.
 *
 * Render-only, and deliberately conditional on THREE facts. Two are about the address: a scheme'd
 * address that is answering is somebody's working reverse-proxy front door, and telling them to
 * change it would be wrong. The third is about the ROLE, and it is the one this hint got wrong.
 *
 * **Never for the LEAD entry.** A lead's address is its front door (§4, ADR 0001), so a scheme
 * there is not a symptom — it is the correct value, and it is what `pack add` and `join` write.
 * The remedy this hint offers is wrong twice over for that row: the premise is backwards, and an
 * operator who follows it to its conclusion strips the scheme and breaks the entry. A peer that
 * cannot reach its lead is not diagnosed by the shape of the address at all.
 *
 * So this hint belongs to exactly one row: a PEER, printed by the lead that dials it, where the
 * pack really does want a bare `host:port` for its own pinned dial ({@link packAddressRefusal}).
 * The verb named there is the lead's, `pack set-address`, because the lead is the machine that
 * dials that member. On the other side of the link the verb is `collie reconnect <address>`, run
 * on the machine being re-pointed — which is what {@link cmdPackSetAddress} says when a peer
 * reaches for `set-address` by mistake.
 */
export function schemedAddressLines(memberId: string, address: string, role: TrustedMember["role"]): TonedLine[] {
  if (role === "lead") return [];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) return [];
  return [
    { text: "            an address with a scheme is a front door's, not a pack listener's —", tone: "dim" },
    { text: `            \`collie pack set-address ${memberId} <host:port>\``, tone: "dim" },
  ];
}

/**
 * `collie pack set-address <member> <host:port>` — correct where this lead dials a member.
 *
 * The verb exists because a takeover leaves a row nobody minted: the new lead adopts the roster it
 * was handed, including the deposed lead's own entry, and that entry holds a front-door URL
 * ({@link packAddressRefusal} says why that cannot be dialled). Before this verb the only repair was
 * hand-editing `pack-trust.json`.
 *
 * **It is not `collie reconnect`, and neither replaces the other.** `reconnect` is the "it moved —
 * re-point me and probe it" verb, and it takes whatever it is given; this one is the lead's
 * *correction* of a member's address and refuses a value the pack could not dial. A wrong address is
 * a hint, never an identity (§4) — the pin is untouched either way, so the cost of a bad one is
 * exactly one more run of this verb.
 */
export async function cmdPackSetAddress(deps: PackDeps, args: readonly string[]): Promise<number> {
  const { positional } = parsePackArgs(args);
  const [memberId, address] = positional;
  if (memberId === undefined || address === undefined) {
    deps.io.err("usage: collie pack set-address <member-id> <host:port>");
    return EXIT.USAGE;
  }
  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.err("error: this collie is not in a pack — there is no roster to correct.");
    return EXIT.STATE;
  }
  if (data.lead !== null) {
    deps.io.err(`error: this collie is a peer of "${data.lead.memberId}" — a member's address is corrected on`);
    deps.io.err("       the lead, which is the machine that dials it. To re-point THIS machine at its own");
    deps.io.err("       lead, run `collie reconnect <address>` here.");
    return EXIT.STATE;
  }
  if (memberId === data.self.memberId) {
    deps.io.err(`error: "${memberId}" is this machine. A member's address is where OTHERS dial it, so it is`);
    deps.io.err("       set on the machine doing the dialling — there is nothing here to correct.");
    return EXIT.STATE;
  }
  const member = data.peers.find((p) => p.memberId === memberId);
  if (member === undefined) {
    deps.io.err(`error: no member "${memberId}" in this roster — \`collie pack status\` lists them.`);
    return EXIT.STATE;
  }
  const refusal = packAddressRefusal(address);
  if (refusal !== null) {
    deps.io.err(`error: "${address}" is not a pack address — ${refusal}.`);
    deps.io.err("       usage: collie pack set-address <member-id> <host:port>");
    return EXIT.USAGE;
  }
  if (member.address === address) {
    deps.io.out(`"${memberId}" is already at ${address} — nothing to change.`);
    return EXIT.OK;
  }

  const moved = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : updateMemberAddress(current, memberId, address),
  );
  if (moved === null) {
    deps.io.err(`error: no member "${memberId}" to move — the roster changed under this verb.`);
    return EXIT.STATE;
  }
  deps.io.out(`✓ "${memberId}" — its pinned certificate is unchanged.`);
  deps.io.out(`    from  ${moved.from === "" ? "(none)" : moved.from}`);
  deps.io.out(`    to    ${address}`);
  await applyLocally(deps, "the new address");
  deps.io.out("  `collie pack status` dials it there.");
  return EXIT.OK;
}

// ── pack approve-promote (on the lead) ───────────────────────────────────────

/**
 * `collie pack approve-promote <member-id>` — the operator's consent, on the machine being taken
 * from, for ONE named member to take the crown (§14.1, ADR 0014).
 *
 * Promotion is a **confirm on the receiver**, not a command from the claimant: a §8.6 signature
 * proves which member is speaking, never that an operator willed it. So the crown moves in two steps
 * on two machines, and this is the first. Touching both machines is the design — consent run here is
 * what proves the operator controls the machine that is about to lose its terminals, its roster and
 * its front door.
 *
 * **It restarts the bridge, and that is load-bearing rather than incidental.** The trust store is
 * read at most once per process, so an approval this verb writes to disk would be invisible to the
 * already-running bridge and the promotion would refuse forever. The restart happens at approve-time,
 * before the operator walks to the peer, so the `promote` itself meets a process that already holds
 * the consent. Same for `--cancel`: the bridge must *forget* it, which is the same mechanism.
 */
export async function cmdPackApprovePromote(deps: PackDeps, args: readonly string[]): Promise<number> {
  // `cancel` is a BARE flag. Anything else and `--cancel` would swallow the following token as its
  // value — which, on a verb whose one argument is a member id, silently approves nobody.
  const { positional, bare } = parsePackArgs(args, ["force", "cancel"]);
  const cancelling = bare.has("cancel");
  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.err("error: this collie is not in a pack — there is no handover to approve.");
    return EXIT.STATE;
  }
  if (data.lead !== null) {
    deps.io.err(`error: this collie is a peer of "${data.lead.memberId}" — a handover is approved on the lead,`);
    deps.io.err("       which is the machine that would be demoted by it.");
    return EXIT.STATE;
  }

  if (cancelling) {
    const cancelled = await commitPackChange(deps.store, deps.audit, (current) =>
      current === null ? null : cancelPromotion(current, deps.now()),
    );
    if (cancelled === null) {
      // Not an error: the operator asked for "no live approval" and that is the state. An expired one
      // reads as absent here for the same reason it does on the demotion path.
      deps.io.out("nothing was armed — this lead has no live handover approval to cancel.");
      return EXIT.OK;
    }
    deps.io.out(`✓ cancelled the handover approval for "${cancelled.memberId}" — nobody may take over now.`);
    deps.io.out("  Nothing was sent anywhere: the approval was local consent on this machine.");
    await applyLocally(deps, "the withdrawal");
    return EXIT.OK;
  }

  const memberId = positional[0];
  if (memberId === undefined) {
    deps.io.err("usage: collie pack approve-promote <member-id>   # consent, on the lead, for 10 minutes");
    deps.io.err("       collie pack approve-promote --cancel      # clear a live approval");
    return EXIT.USAGE;
  }

  const approved = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : approvePromotion(current, memberId, deps.now()),
  );
  if (approved === null) {
    // An approval naming nobody this lead pins is a typo, not a consent (§14.1).
    deps.io.err(`error: no enrolled member "${memberId}" in this roster — \`collie pack status\` lists them.`);
    return EXIT.STATE;
  }

  deps.io.out(`✓ approved "${approved.memberId}" to take over as lead — single-use, ten minutes.`);
  deps.io.out(`  expires ${new Date(approved.expiresAt).toISOString()}`);
  deps.io.out(`  Now run \`collie promote\` on "${approved.memberId}" within 10 minutes. Until it does, nothing`);
  deps.io.out("  has changed here: this is consent, not a handover.");
  deps.io.out("  Nothing was sent to it and no secret is involved — the claim is already signed against a");
  deps.io.out(`  pinned certificate, so consent only has to name who may take over.`);
  deps.io.out("  Changed your mind? `collie pack approve-promote --cancel`.");
  await applyLocally(deps, "the approval");
  return EXIT.OK;
}

// ── promote (on the peer becoming lead) ──────────────────────────────────────

/**
 * `collie promote` — §14, run on the peer that is to become lead.
 *
 * **Refuses if the current lead is unreachable, unless `--force`.** A clean handover has to reach the
 * old lead to demote it and take its roster; promoting without that leaves two machines believing they
 * lead, which is two front doors and two rosters. `--force` is the operator saying they know the old
 * lead is gone.
 */
export async function cmdPromote(deps: PackDeps, args: readonly string[]): Promise<number> {
  const { flags, bare } = parsePackArgs(args);
  const force = bare.has("force");
  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.err("error: this collie is not in a pack — there is no crown to take.");
    return EXIT.STATE;
  }
  if (data.lead === null) {
    deps.io.err("error: this collie is already the lead of this pack.");
    return EXIT.STATE;
  }
  // This machine is taking the crown, so what it advertises — to the pack AND to the phone below —
  // is the front door it publishes at the end of this verb.
  const mine = selfAddress(deps, flags.address, "front-door");
  if (mine === null) {
    deps.io.err("error: cannot work out the address the pack should dial this machine at.");
    deps.io.err("       Pass one: `collie promote --address <host-the-others-can-reach>`.");
    return EXIT.FAIL;
  }

  const claim: RosterEntry = {
    memberId: data.self.memberId,
    fingerprint: data.self.fingerprint,
    // The certificate travels with the claim so a recipient that has never pinned this member can.
    // It authenticates nothing by itself — §8.6's signature over the request does that (§14).
    certPem: data.self.certPem,
    address: mine,
  };
  const client = clientFor(deps, data, data.pack.secret);
  const handover = await client.json(linkOf(data.lead), "lead", undefined, {
    method: "POST",
    headers: CONTENT_TYPE,
    body: JSON.stringify({ lead: claim }),
  });

  // THE LEAD SAID NO — §14.3, and it is not a reachability problem. Checked before `--force`,
  // because a refusal is proof the old lead is *there*: forcing past a reachable lead is what §14
  // refuses outright, and `--force` is only ever for a machine the operator knows is gone. The
  // lead's own sentence is printed verbatim (it names the verb to run and the window), and the
  // `--force` suggestion is deliberately absent — aiming an operator at the destructive remedy for a
  // missing consent is the exact failure this outcome exists to end.
  let roster: RosterEntry[] = [];
  if (!handover.ok && handover.state === "refused") {
    deps.io.err(`error: ${handover.reason}`);
    return EXIT.REFUSED;
  }
  if (handover.ok) {
    // SAFETY: `value` is the old lead's HTTP body after `res.json()` — a JsonValue by construction,
    // and an object or null is the only shape §14.3 defines. `parseRoster` re-checks every field of
    // `roster` below, so a body that disagrees yields an empty roster rather than a trusted one.
    const body = handover.value as JsonObject | null;
    roster = parseRoster(body?.roster) ?? [];
    // The demoted lead is a member of this pack like any other, and it just told us its own pin is
    // still good — so it goes into the new roster rather than being dropped for having been the lead.
    roster = [rosterEntryOf(data.lead), ...roster.filter((r) => r.memberId !== data.lead?.memberId)];
    deps.io.out(`✓ "${data.lead.memberId}" stepped down and handed over ${roster.length - 1} other member(s).`);
  } else if (!force) {
    deps.io.err(`error: the current lead "${data.lead.memberId}" did not answer — ${failureLine(handover)}`);
    deps.io.err("       Promoting anyway would leave two leads, two front doors and two rosters. If that");
    deps.io.err("       machine is really gone, re-run with --force; it must then be `collie leave`-d or");
    deps.io.err("       re-`join`-ed before it is ever powered back on into this pack.");
    return handover.state === "incompatible" ? EXIT.REFUSED : EXIT.UNREACHABLE;
  } else {
    deps.io.err(`warn: --force — "${data.lead.memberId}" was not demoted and may still believe it leads.`);
    deps.io.err("      Every other member must re-join this machine with a fresh token; nothing was taken");
    deps.io.err("      over from the old roster, because the only copy of it was on that machine.");
  }

  const promoted = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : promoteSelf(current, roster, deps.now()),
  );
  if (promoted === null) return EXIT.FAIL;

  // NOBODY ELSE IS SWEPT — §14.4/§14.5 (2026-08-12). A peer pins its CURRENT lead's certificate as
  // the sole anchor of its listener (`peerListenerTls`, bridge/pack/transport.ts), so a dial from a
  // lead it does not yet pin is refused at the TLS handshake before any route runs — reachable or
  // not, forced or not. The sweep that used to stand here could never land; a column of ✗ lines read
  // as a partial failure where the truth is uniform. Every remaining member re-joins instead, which
  // is the numbered step below.
  const others = roster.filter((r) => r.memberId !== data.lead?.memberId);

  await applyLocally(deps, "lead mode");
  const served = await deps.serve();
  if (served !== EXIT.OK) {
    deps.io.err("warn: the front door did not come up here. The pack has a lead with no published URL —");
    deps.io.err("      fix it with `collie serve` before re-pointing the phone.");
  }

  deps.io.out("");
  deps.io.out("── the crown moved; these do not ──────────────────────────────");
  deps.io.out("  The pack identity, the pack secret and every pinned certificate are REUSED — this was a");
  deps.io.out("  role change, not a re-enrollment. What stays on the old lead, permanently:");
  deps.io.out("    · push subscriptions   — the phone must re-subscribe here (Settings → notifications)");
  deps.io.out("    · the audit log        — host-local by rule; the old lead keeps its own history");
  deps.io.out("    · outstanding notification tags and activity ledgers");
  deps.io.out("  Nothing migrates. The phone re-onboards against this machine.");
  deps.io.out("");
  deps.io.out("  1. Re-point your phone — the front-door URL is bound to a node, and nothing rewrites a");
  deps.io.out(`     bookmark. This machine: ${mine}`);
  deps.io.out(`  2. On "${data.lead.memberId}": set \`COLLIE_HOST=<an address this machine can dial>\` in its .env, then`);
  deps.io.out("     `collie restart`, then `collie unserve` — in that order. A lead behind a front door typically");
  deps.io.out("     binds loopback; as a peer it must be dialable directly (§3), and only a restart moves the bind.");
  deps.io.out("     It adopted the demotion on disk when it answered, but its PROCESS is still the lead it booted");
  deps.io.out("     as: lead-mode listener, pinning nothing, until the restart. And only that machine can drop the");
  deps.io.out("     front door (Collie removes only a mapping its own record matches); `restart` re-publishes on");
  deps.io.out("     the way up, which is why `unserve` comes after it.");
  deps.io.out(`  3. Here: \`collie reconnect ${data.lead.memberId} <host:port>\` — the roster records that machine at its`);
  deps.io.out("     FRONT DOOR, which step 2 just retired. Until you re-point it, `collie pack status` and `collie");
  deps.io.out("     doctor` here show it unreachable, and `doctor` there names the bind.");
  if (others.length > 0) {
    deps.io.out(`  4. Every other member — ${others.map((r) => r.memberId).join(", ")} — must \`collie join\` this machine with a`);
    deps.io.out("     fresh token: each still pins the old lead's certificate at its own handshake, so nothing here");
    deps.io.out("     can reach it. The same rule rotation uses (§8.4), for the same reason.");
  }
  return EXIT.OK;
}

// ── reconnect ────────────────────────────────────────────────────────────────

/**
 * `collie reconnect [<member>] <address>` — a member moved (§4: the address is a hint, the pinned
 * fingerprint is the identity), so re-point at it **without re-enrolling anything**.
 *
 * One argument on a peer means its lead; two anywhere means that member. The pin is not touched, which
 * is the whole point: a laptop that changed networks did not change certificate, and re-pinning here
 * would hand DHCP a trust decision.
 */
export async function cmdReconnect(deps: PackDeps, args: readonly string[]): Promise<number> {
  const { positional } = parsePackArgs(args);
  const data = await deps.store.load();
  if (data === null || data.pack === null) {
    deps.io.err("error: this collie is not in a pack.");
    return EXIT.STATE;
  }
  const [first, second] = positional;
  if (first === undefined) {
    deps.io.err("usage: collie reconnect <address>            # on a peer: the lead moved");
    deps.io.err("       collie reconnect <member> <address>   # on a lead: that peer moved");
    return EXIT.USAGE;
  }
  const target = second === undefined ? data.lead?.memberId : first;
  const address = second ?? first;
  if (target === undefined) {
    deps.io.err("error: this collie has no lead — name the member: `collie reconnect <member> <address>`.");
    return EXIT.STATE;
  }

  const moved = await commitPackChange(deps.store, deps.audit, (current) =>
    current === null ? null : updateMemberAddress(current, target, address),
  );
  if (moved === null) {
    deps.io.err(`error: no member "${target}" to move, or it is already at ${address}.`);
    return EXIT.STATE;
  }
  deps.io.out(`✓ "${target}" moved from ${moved.from} to ${address} — its pinned certificate is unchanged.`);

  const client = clientFor(deps, data, data.pack.secret);
  const link = { memberId: target, address };
  const outcome = await client.hello(link);
  deps.io.out(outcome.ok ? "  it answered there." : `  it did not answer there yet — ${failureLine(outcome)}`);
  if (outcome.ok) {
    // The same second question `pack status` asks, for the same reason: an address that answers the
    // patient probe and then starves the strict one is a moved member that is still not usable. The
    // exit code stays the `hello` verdict — the move itself succeeded, and a budget problem is not a
    // reason to tell a script the address is wrong.
    const startedAt = deps.now();
    const served = await client.snapshot(link);
    const took = deps.now() - startedAt;
    deps.io.out(served.ok ? `  it served a snapshot in ${took}ms.` : `  but it served no data — ${failureLine(served)}`);
  }
  await applyLocally(deps, "the new address");
  return outcome.ok ? EXIT.OK : EXIT.UNREACHABLE;
}

// ── `collie pack <sub>` dispatch ─────────────────────────────────────────────

/** The `pack` sub-verbs, in the order the help prints them. */
export const PACK_SUBCOMMANDS = [
  "invite",
  // `join` and `leave` are the CANONICAL spellings — every other pack verb lives under `pack`, and
  // these two were the exception for no reason anyone could state. The top-level `collie join` /
  // `collie leave` stay as aliases onto these same functions (`cli/program.ts`), so a 1.0.0 script
  // keeps working; the aliases are what changed status, not the behaviour.
  "join",
  "leave",
  "add",
  "update",
  "status",
  "rotate",
  "remove",
  "set-address",
  "deputy",
  "approve-promote",
] as const;

export function packUsage(): string {
  return `usage: collie pack {${PACK_SUBCOMMANDS.join("|")}}`;
}

/**
 * The spellings that ASK for the block below rather than mistype a subcommand.
 *
 * `--help`/`-h` reach here as arguments, not as options: the parent verb turns commander's own help
 * off so every flag grammar stays in the verb (`cli/program.ts`), which used to make `collie pack
 * --help` — the most ordinary thing anyone types — answer `error: unknown pack subcommand`. They
 * print exactly what `collie pack` and `collie pack help` print, and share their exit code: this is a
 * spelling, not a second surface.
 */
const PACK_HELP_SPELLINGS: ReadonlySet<string> = new Set(["help", "--help", "-h"]);

export async function cmdPack(deps: PackAddDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "invite":
      return cmdPackInvite(deps, rest);
    case "join":
      return cmdJoin(deps, rest);
    case "leave":
      return cmdLeave(deps);
    // Imported at CALL time, not at module load: `cli/remote.ts` imports this module's `ensureStore`,
    // `selfAddress` and `probeMembers`, so a static import here would close a cycle. Everything else
    // in the switch is local, and `pack add` is the one verb that reaches another machine.
    case "add": {
      const { cmdPackAdd } = await import("./remote.ts");
      return cmdPackAdd(deps, rest);
    }
    // Same reason `add` is imported at call time: `cli/pack-update.ts` reaches back into this module
    // for `parsePackArgs` and `probeMembers`, and a static import here would close a cycle.
    case "update": {
      const { cmdPackUpdate } = await import("./pack-update.ts");
      return cmdPackUpdate(deps, rest);
    }
    // Same reason `add` and `update` are imported at call time: `cli/pack-deputy.ts` reaches back into
    // this module for `parsePackArgs`, `clientFor` and `linkOf`, and a static import here would close
    // a cycle.
    case "deputy": {
      const { cmdPackDeputy } = await import("./pack-deputy.ts");
      return cmdPackDeputy(deps, rest);
    }
    case "status":
      return cmdPackStatus(deps, rest);
    case "rotate":
      return cmdPackRotate(deps);
    case "remove":
      return cmdPackRemove(deps, rest);
    case "set-address":
      return cmdPackSetAddress(deps, rest);
    case "approve-promote":
      return cmdPackApprovePromote(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && !PACK_HELP_SPELLINGS.has(sub)) {
        deps.io.err(`error: unknown pack subcommand \`${sub}\``);
      }
      deps.io.err(packUsage());
      deps.io.err("  invite   mint a single-use, 10-minute enrollment token (on the lead)");
      deps.io.err("  join     join a pack: `pack join <lead-address>` (on the joining machine)");
      deps.io.err("  leave    leave the pack — drops the pack secret and every pin on this machine");
      deps.io.err("  add      install and enroll a peer over SSH: `pack add <ssh-host>` (on the lead)");
      deps.io.err("  update   level peers to this lead's build over SSH: `pack update <member>… | --all`");
      deps.io.err("  status   mode, members, reachability, secret pickup and why a link is refused");
      deps.io.err("  rotate   reissue the pack secret and hand it to every reachable peer");
      deps.io.err("  remove   unpin and forget a member (on the lead)");
      deps.io.err("  set-address  correct where this lead dials a member: `pack set-address <member> <host:port>`");
      deps.io.err("  deputy   name the ONE peer that may take over, and arm it: `pack deputy <member>`");
      deps.io.err("           (on the lead); `--revoke` names nobody");
      deps.io.err("  approve-promote  consent, on the lead, for one member to take over (10 minutes,");
      deps.io.err("                   single-use); `--cancel` clears it");
      return EXIT.USAGE;
  }
}

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * The real seams. Kept here rather than in `cli/main.ts` so the dispatcher stays a table: everything
 * a pack verb touches — the store, the transport, the clock, entropy, the identity minter — is named
 * in one place, and `cli/pack.test.ts` replaces exactly this object.
 */
export function packDeps(
  base: {
    ctx: CliContext;
    io: Io;
    ui?: Ui | null;
    exec: Exec;
    files: Files;
    restart: (io?: Io) => Promise<number>;
    serve: (io?: Io) => Promise<number>;
    unserve: () => number;
  },
  audit: AuditLog | null,
): PackDeps {
  return {
    ...base,
    store: new TrustStore(base.ctx.stateDir),
    ops: new PackOpsStore(base.ctx.stateDir),
    audit,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    random: randomToken,
    // Built per call, NOT eagerly: `tailnetName` shells out to `tailscale`, and `packDeps` is
    // constructed for every pack verb — including the ones that never mint. An eager build would
    // make `collie pack status` run a tailnet lookup it has no use for.
    //
    // The CN and SANs are legibility, not trust: a pin is a fingerprint and the dialling side
    // overrides the name check (`bridge/pack/transport.ts`), so a member that roams stays the same
    // member. They are filled in anyway so `openssl x509 -text` on this file says something true.
    mintIdentity: () =>
      identityMinter({
        commonName: `collie-${hostname()}`,
        sans: [tailnetName(base.exec) ?? "", hostname(), "localhost", "127.0.0.1"],
      })(),
    readStdin: () => new Response(Bun.stdin.stream()).text(),
    // Bun's built-ins behind a tty check, exactly as `pack add` and `stt setup` guard theirs: a
    // question nobody can answer must refuse legibly rather than read EOF as an answer. `packAddDeps`
    // layers the identical pair on top for the verbs that take a `[y/N]`.
    interactive: process.stdin.isTTY === true,
    prompt: (question) => (process.stdin.isTTY === true ? prompt(question) : null),
    hostname: () => hostname(),
    clearNotifications: (tags) => clearViaPush(base.ctx, tags),
  };
}

/** Send one `clear` per notification slot through the bridge's own `Push`. Silent when push is off. */
async function clearViaPush(ctx: CliContext, tags: readonly string[]): Promise<void> {
  for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined) process.env[k] = v;
  const { loadConfig } = await import("../bridge/config.ts");
  const { Push } = await import("../bridge/push.ts");
  const push = new Push(loadConfig());
  await push.init();
  if (!push.enabled) return;
  for (const tag of tags) await push.send({ type: "clear", tag });
}

/** The audit log a pack verb writes through — the same file, same mode, the bridge appends to. */
export async function packAudit(ctx: CliContext): Promise<AuditLog> {
  const { AuditLog: Log, fileAuditAppender } = await import("../bridge/audit.ts");
  return new Log(fileAuditAppender(join(ctx.stateDir, "audit.log")));
}
