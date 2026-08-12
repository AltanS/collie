import { hostname } from "node:os";
import { join } from "node:path";

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
import { signRequest } from "../bridge/pack/signing.ts";
import { dialTls } from "../bridge/pack/transport.ts";
import { deriveMode } from "../bridge/pack/mode.ts";
import {
  packTimeoutBudget,
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
import { packRuntimePath, parseMarker, rosterDrift } from "../bridge/pack/staleness.ts";
import { TrustStore, type TrustedMember, type TrustStoreData } from "../bridge/pack/trust-store.ts";
import { deriveConfigRoot, discoverSessionSockets, herdTagFor } from "../bridge/sessions.ts";
import { collieVersionBare, type CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
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
  /** `collie restart` — how a membership change reaches the running bridge. */
  restart(): Promise<number>;
  /** `collie serve` — the new lead publishes the one managed front door (ADR 0001). */
  serve(): Promise<number>;
  /** `collie unserve` — a peer publishes nothing (§3), so joining tears our own mapping down. */
  unserve(): number;
  /** Push a `clear` to every subscribed device for these notification slots. Best effort. */
  clearNotifications(tags: readonly string[]): Promise<void>;
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

// ── Shared plumbing ──────────────────────────────────────────────────────────

/** The pack timeout budget for a one-shot verb: the default, clamped by the poll interval as usual. */
function timeoutFor(ctx: CliContext): number {
  const pollMs = Number.parseInt(ctx.env.COLLIE_POLL_MS?.trim() ?? "", 10);
  return packTimeoutBudget(Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 1500, ctx.env);
}

/**
 * A client for talking to other members, authenticated by `secret`.
 *
 * `secret` is passed in rather than read from the store because rotation needs the *superseded* value:
 * the new secret is already on disk when the distribution calls go out, and a peer that has not yet
 * been handed it would refuse a request carrying it (§8.4 — no grace window, so the lead must dial
 * with the value the peer still holds).
 */
function clientFor(deps: ProbeDeps, data: TrustStoreData, secret: string): PeerClient {
  return new PeerClient({
    self: data.self.memberId,
    secret: () => secret,
    timeoutMs: timeoutFor(deps.ctx),
    fetch: deps.fetch,
    now: deps.now,
    // Pin whichever member this dial is aimed at (§8.1). A verb only ever dials a member already in
    // this store, so the lookup is total in practice and a miss is a member we must not dial pinless.
    tls: (link) => {
      const member = memberById(data, link.memberId);
      return member === undefined ? undefined : (dialTls(data, member) ?? undefined);
    },
    // EVERY CLI-ORIGINATED CALL IS SIGNED (§8.6), not only the two that require it. The verbs are the
    // peer→lead direction, where the transport cannot pin (`bridge/pack/transport.ts`); signing the
    // whole set means `pack status` and `reconnect` can probe a lead at all, and it costs one ECDSA
    // signature per one-shot command. The receiver only *requires* one on the membership routes.
    sign: (parts) => signRequest(data.self.keyPem, parts),
  });
}

/** A member of this collie's roster by id — its lead, or one of its peers. */
function memberById(data: TrustStoreData, memberId: string): TrustedMember | undefined {
  if (data.lead !== null && data.lead.memberId === memberId) return data.lead;
  return data.peers.find((p) => p.memberId === memberId);
}

const linkOf = (member: TrustedMember): PackLink => ({
  memberId: member.memberId,
  address: member.address,
});

/** One line naming why a member did not answer. Never contains a secret — nothing here holds one. */
export function failureLine(outcome: PeerOutcome<unknown>): string {
  if (outcome.ok) return "ok";
  if (outcome.state === "incompatible") return `incompatible — ${outcome.reason}`;
  // A refusal is an ANSWER, not a failure to reach — the far side is there and said no (§14.3).
  if (outcome.state === "refused") return `refused — ${outcome.reason}`;
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
 * Otherwise it is this node's Tailscale name, which is what `collie url` already prints. There is no
 * third guess: an address we cannot state is an error the operator fixes with a flag, not a
 * `localhost` the far side would dial forever.
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
  if (override !== undefined && override !== "") return override;
  const name = tailnetName(deps.exec);
  if (name === null) return null;
  // http mode publishes no TLS front door at all, so both kinds are the bridge port there.
  if (kind === "front-door" && deps.ctx.serveMode === "https") return name;
  return `${name}:${deps.ctx.port}`;
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

  // The lead's own address, for the joiner to dial: its front door, not its bridge port.
  const address = selfAddress(deps, flags.address, "front-door");
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
  deps.io.out(
    `    collie join ${address ?? "<this-lead-address>"} -    # then paste the whole token on stdin`,
  );
  deps.io.out("  Passing it as an argument instead leaves it in `ps` output for every local uid.");
  await applyLocally(deps, "the bridge can answer this invite");
  return EXIT.OK;
}

// ── join (on the joining machine) ────────────────────────────────────────────

/**
 * `collie join <lead-address> <token>` — §8.2, run on the peer, once.
 *
 * Distinct outcomes get distinct exit codes (spec requirement), because "it didn't work" is the one
 * answer an operator cannot act on: already in a pack is `3`, a refused token is `4`, an address that
 * did not answer is `5`.
 */
export async function cmdJoin(deps: PackDeps, args: readonly string[]): Promise<number> {
  const { positional, flags, bare } = parsePackArgs(args, ["insecure"]);
  const [address, rawToken] = positional;
  if (address === undefined || rawToken === undefined) {
    deps.io.err("usage: collie join <lead-address> <token|-|@file> [--address <mine>] [--label <name>]");
    return EXIT.USAGE;
  }

  const existing = await deps.store.load();
  if (existing !== null && existing.pack !== null) {
    const role = existing.lead === null ? `lead of ${existing.peers.length} peer(s)` : `peer of "${existing.lead.memberId}"`;
    deps.io.err(`error: already in pack "${existing.pack.name}" as ${role} (member "${existing.self.memberId}").`);
    deps.io.err("       Run `collie leave` here first — joining a second pack is not a thing (§3).");
    return EXIT.STATE;
  }

  const raw = await readToken(rawToken, deps);
  if (raw === null) {
    deps.io.err("error: the token was empty");
    return EXIT.USAGE;
  }

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

  const data = await ensureStore(deps, flags.label);
  if (data === null) return EXIT.FAIL;
  // Joining makes this machine a peer, and a peer is dialled on its own pack listener — never on a
  // front door, because it is about to tear its own one down (§3).
  const mine = selfAddress(deps, flags.address, "pack-listener");
  if (mine === null) {
    deps.io.err("error: cannot work out an address the lead can dial this machine at.");
    deps.io.err("       Pass one: `collie join <lead-address> - --address <host-the-lead-can-reach>`.");
    return EXIT.FAIL;
  }

  const url = enrollUrl(address);
  if (url === null) {
    deps.io.err(`error: "${address}" is not a host this can dial — give a hostname or host:port.`);
    return EXIT.USAGE;
  }

  // Refuse a plaintext hop unless the operator owns the risk explicitly. Over http:// both the invite
  // token and the pack secret cross the wire in the clear — F1's fingerprint pin authenticates the
  // lead to us, but it does nothing to stop a token-thief racing the spend with its own certificate.
  if (new URL(url).protocol === "http:" && !bare.has("insecure")) {
    deps.io.err("error: refusing to enroll over http:// — the invite token and the pack secret would cross the");
    deps.io.err("       wire in the clear. An on-path attacker who reads the token can enroll THEIR OWN certificate");
    deps.io.err("       as a member before you do (the lead admits on the token alone), then holds the pack secret");
    deps.io.err("       and a pinned link. Use an encrypted address (https:// via tailscale serve, or your own TLS");
    deps.io.err("       front door). If this hop is genuinely trusted and you accept that risk, re-run with");
    deps.io.err("       --insecure to own that assumption explicitly.");
    return EXIT.REFUSED;
  }

  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { ...CONTENT_TYPE, "x-pack-protocol": String(PACK_PROTOCOL_VERSION) },
      // The token rides the BODY, never the URL: a query string lands in access logs on every hop
      // that ever fronts a lead, and §8.3's rule is about where a credential comes to rest.
      body: JSON.stringify({
        protocol: PACK_PROTOCOL_VERSION,
        token,
        fingerprint: data.self.fingerprint,
        // The certificate itself, not only its hash: the lead pins by fingerprint but ENFORCES by
        // certificate (its dial's `ca` list), and it has no other way to obtain the material. The
        // lead re-derives the fingerprint from these bytes and refuses a payload where the two
        // disagree, so sending both adds a cross-check rather than a second source of truth.
        certPem: data.self.certPem,
        address: mine,
        label: flags.label ?? null,
      }),
    });
  } catch (err) {
    deps.io.err(`error: could not reach ${address} — ${err instanceof Error ? err.message : String(err)}`);
    deps.io.err("       The lead owns nothing about reachability: check the address, the tunnel, the port.");
    if (!/^https?:\/\//i.test(address)) {
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
    current === null ? null : acceptEnrollment(current, parsed, address, deps.now()),
  );
  if (accepted === null) return EXIT.FAIL;

  deps.io.out(`✓ joined pack "${parsed.packName}" as "${accepted.memberId}"`);
  deps.io.out(`  lead      ${parsed.leadMemberId} at ${address}`);
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

/** The enrollment URL for an operator-typed address. `null` when it is not a bare host. */
export function enrollUrl(address: string): string | null {
  const withScheme = /^https?:\/\//i.test(address) ? address : `https://${address}`;
  let base: URL;
  try {
    base = new URL(withScheme);
  } catch {
    return null;
  }
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") return null;
  if (base.pathname !== "/" || base.host === "") return null;
  return new URL(PACK_ENROLL_PATH, base).toString();
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
  await applyLocally(deps, "solo mode (own front door, own notifications)");
  return EXIT.OK;
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
  reportDrift(deps, data);

  const members = data.lead === null ? data.peers : [data.lead, ...data.peers];
  if (members.length === 0) {
    deps.io.out("members: none yet — mint an invite and run `collie join` on the other machine.");
    return EXIT.OK;
  }

  const probes = bare.has("no-probe")
    ? new Map<string, PeerOutcome<HelloResult>>()
    : await probeMembers(deps, data, members);
  // This build's own version, resolved once for the whole roster by the same rule `collie version`
  // uses (`bridge/version.ts`) — the bridge answers `hello` with that exact string, so the two sides
  // of every comparison below are the same kind of thing.
  const ours = collieVersionBare(deps.ctx.root, (p) => deps.files.read(p));

  deps.io.out("");
  deps.io.out("members:");
  for (const m of members) {
    const behind = m.status === "enrolled" && m.secretGeneration !== data.pack.secretGeneration;
    deps.io.out(`  ${m.memberId}  (${m.role})  ${m.address}`);
    deps.io.out(`    pinned  ${m.fingerprint.slice(0, 16)}…  enrolled ${new Date(m.enrolledAt).toISOString()}`);
    deps.io.out(
      `    secret  generation ${m.secretGeneration}` +
        (behind ? " — HAS NOT picked up the current secret" : " — current"),
    );
    if (m.status === "unenrolled") {
      deps.io.out("    status  unenrolled — dropped by a rotation it was offline for (§8.4).");
      deps.io.out(`            Recovery is deliberate: \`collie pack invite\` here, \`collie join\` there.`);
      continue;
    }
    const outcome = probes.get(m.memberId);
    // A member pinned but never once contacted (strictly `contactedAt === null`) is a possible
    // half-finished join. An ABSENT field is `undefined` — a member from before this field existed —
    // and must never read as provisional. A number is a real contact time. Suppressed when this very
    // probe succeeded: a member reachable right now is not half-finished (it is stamped just below).
    if (m.contactedAt === null && outcome?.ok !== true) {
      deps.io.out("    status  provisional — enrolled but never once reachable; a half-finished join looks exactly");
      deps.io.out(`            like this (§8.2). If you did not complete a join for "${m.memberId}", clear it:`);
      deps.io.out(`            \`collie pack remove ${m.memberId}\`.`);
    }
    if (outcome === undefined) {
      deps.io.out("    link    not probed (--no-probe)");
      continue;
    }
    if (outcome.ok) {
      deps.io.out(`    link    reachable · answered at ${new Date(outcome.receivedAt).toISOString()}`);
      for (const line of versionLines(outcome.value.version, ours)) deps.io.out(line);
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
      deps.io.out(`    link    INCOMPATIBLE · ${outcome.reason}`);
      deps.io.out("            Version skew is not retried on the poll cadence — update the older machine.");
      continue;
    }
    deps.io.out(`    link    unreachable · ${outcome.reason}`);
    if (outcome.reason.includes("unauthorized")) {
      deps.io.out("            A bare 401 is deliberately one answer for two causes (§8.1): an unpinned");
      deps.io.out("            certificate or a secret this member no longer holds. The local column above");
      deps.io.out("            says which is likelier — a member a generation behind is the secret.");
    }
  }
  return EXIT.OK;
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
function versionLines(reported: string | null, ours: string): string[] {
  if (reported === null) return [`    version pre-${VERSION_REPORTED_SINCE} (not reported)`];
  if (reported === ours) return [`    version ${reported}`];
  // `unknown` is this checkout answering "no build stamp and no manifest" — it is not a version, so
  // there is no older machine to name. Report theirs and stay quiet rather than warn about a skew
  // whose other half we cannot state.
  if (ours === "unknown") return [`    version ${reported}`];
  return [
    `    version ${reported} — warn: this machine runs ${ours}`,
    "            Build skew refuses nothing (§7.1) — the link keeps working. Update the older machine.",
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
  await applyLocally(deps, "the shortened roster");
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
    await applyLocally(deps, "the running bridge forgets the approval");
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
  await applyLocally(deps, "the running bridge holds the approval");
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
    const body = handover.value as Record<string, unknown> | null;
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

  // Tell everyone else. The old lead already knows — it demoted itself in the call above.
  const others = roster.filter((r) => r.memberId !== data.lead?.memberId);
  const told = await sweepPeers(
    others.map((r) => ({ memberId: r.memberId, address: r.address })),
    (link) =>
      client.json(link, "lead", undefined, {
        method: "POST",
        headers: CONTENT_TYPE,
        body: JSON.stringify({ lead: claim }),
      }),
  );
  const stranded: string[] = [];
  for (const peer of others) {
    const outcome = told.get(peer.memberId);
    if (outcome?.ok === true) {
      deps.io.out(`  ✓ ${peer.memberId} now dials this machine`);
    } else {
      stranded.push(peer.memberId);
      deps.io.out(`  ✗ ${peer.memberId} — ${outcome === undefined ? "not dialled" : failureLine(outcome)}`);
    }
  }

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
  deps.io.out(`  2. On "${data.lead.memberId}": \`collie restart\`, then \`collie unserve\` — in that order.`);
  deps.io.out("     It adopted the demotion on disk when it answered, but its PROCESS is still the lead it");
  deps.io.out("     booted as: lead-mode listener, pinning nothing, until the restart. And only that machine");
  deps.io.out("     can drop the front door (Collie removes only a mapping its own record matches); `restart`");
  deps.io.out("     re-publishes on the way up, which is why `unserve` comes after it.");
  if (stranded.length > 0) {
    deps.io.out(`  3. Unreachable during promotion: ${stranded.join(", ")} — each must \`collie join\` this`);
    deps.io.out("     machine with a fresh token. The same rule rotation uses, for the same reason.");
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
  const outcome = await client.hello({ memberId: target, address });
  deps.io.out(outcome.ok ? "  it answered there." : `  it did not answer there yet — ${failureLine(outcome)}`);
  await applyLocally(deps, "the new address");
  return outcome.ok ? EXIT.OK : EXIT.UNREACHABLE;
}

// ── `collie pack <sub>` dispatch ─────────────────────────────────────────────

/** The `pack` sub-verbs, in the order the help prints them. */
export const PACK_SUBCOMMANDS = ["invite", "add", "status", "rotate", "remove", "approve-promote"] as const;

export function packUsage(): string {
  return `usage: collie pack {${PACK_SUBCOMMANDS.join("|")}}`;
}

export async function cmdPack(deps: PackAddDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "invite":
      return cmdPackInvite(deps, rest);
    // Imported at CALL time, not at module load: `cli/remote.ts` imports this module's `ensureStore`,
    // `selfAddress` and `probeMembers`, so a static import here would close a cycle. Everything else
    // in the switch is local, and `pack add` is the one verb that reaches another machine.
    case "add": {
      const { cmdPackAdd } = await import("./remote.ts");
      return cmdPackAdd(deps, rest);
    }
    case "status":
      return cmdPackStatus(deps, rest);
    case "rotate":
      return cmdPackRotate(deps);
    case "remove":
      return cmdPackRemove(deps, rest);
    case "approve-promote":
      return cmdPackApprovePromote(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown pack subcommand \`${sub}\``);
      }
      deps.io.err(packUsage());
      deps.io.err("  invite   mint a single-use, 10-minute enrollment token (on the lead)");
      deps.io.err("  add      install and enroll a peer over SSH: `pack add <ssh-host>` (on the lead)");
      deps.io.err("  status   mode, members, reachability, secret pickup and why a link is refused");
      deps.io.err("  rotate   reissue the pack secret and hand it to every reachable peer");
      deps.io.err("  remove   unpin and forget a member (on the lead)");
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
    exec: Exec;
    files: Files;
    restart: () => Promise<number>;
    serve: () => Promise<number>;
    unserve: () => number;
  },
  audit: AuditLog | null,
): PackDeps {
  return {
    ...base,
    store: new TrustStore(base.ctx.stateDir),
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
