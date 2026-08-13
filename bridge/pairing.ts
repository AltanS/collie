import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── DEVICE PAIRING: A CREDENTIAL THE DEVICE HOLDS, NOT A NAME THE NETWORK ASSERTS ─────────────
//
// The pre-existing write gate (COLLIE_DEVICE_HEADER + COLLIE_DEVICE_ALLOWLIST, bridge/server.ts
// `deviceAuth`) trusts a header a proxy injects: the device is whoever the tailnet says it is. That
// is only as good as the proxy's sanitisation and the identity provider's naming, and it cannot be
// revoked from the phone that lost the device. This module adds the other kind of proof — a bearer
// credential the device itself holds — on the same reasoning the pack link already runs on: network
// position is not identity (ADR 0013).
//
// The two gates are INDEPENDENT and compose by AND. Configuring one says nothing about the other,
// and the header gate's behaviour here is unchanged in every case.
//
// ── ENROLMENT ────────────────────────────────────────────────────────────────────────────────
// `bin/collie pair` mints a one-time code, writes its HASH (never the code) to
// `<stateDir>/pairing-pending.json`, and prints the code to the operator's terminal. The phone posts
// `{code,label}` to `/api/pair`, which mints a 256-bit token, stores only its SHA-256 in
// `<stateDir>/paired-devices.json`, and returns the token exactly once. The bridge re-reads both
// files at request time, so a pairing minted by the CLI needs no `systemctl restart`.
//
// ── WHY EVERY SIDE EFFECT IS INJECTED ────────────────────────────────────────────────────────
// The whole of this module is reachable from `bun test` (CLAUDE.md: Bun.serve/Bun.connect code is
// not). Nothing below opens a file itself — {@link PairingIo} is the only door out, and
// {@link filePairingIo} is the one implementation that touches a disk.

/** File under the state dir holding the pending (unclaimed) pairing code. */
export const PENDING_FILENAME = "pairing-pending.json";
/** File under the state dir holding the paired-device registry. */
export const DEVICES_FILENAME = "paired-devices.json";

/** How long a minted code stays claimable. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong-code attempts before the pending pairing is destroyed. */
export const CODE_ATTEMPTS = 5;
/** Codes are this many characters. */
export const CODE_LENGTH = 8;
/**
 * The code alphabet, with every glyph pair a human mistypes removed: no `0`/`O`, no `1`/`I`/`L`,
 * no `U`/`V`. The operator reads this off a terminal and types it on a phone keyboard.
 */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";

/** At most one `lastSeenAt` write per device per this interval — a poll every 1.5s must not be a write. */
export const SEEN_THROTTLE_MS = 60_000;

/** A minted, not-yet-claimed pairing code. Only its hash is ever persisted. */
export interface PendingPairing {
  /** SHA-256 (hex) of the normalised code. */
  codeHash: string;
  /** Epoch ms after which the code is dead. */
  expiresAt: number;
  /** Wrong guesses left before the pending pairing is destroyed. */
  attemptsLeft: number;
}

/** One paired device. The token itself was shown once, at claim time, and is not recoverable. */
export interface PairedDevice {
  /** Operator-facing name, unique across the registry. */
  label: string;
  /** SHA-256 (hex) of the bearer token. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

/** The on-disk registry shape. An object (not a bare array) so it can gain keys without a migration. */
export interface PairedRegistry {
  devices: PairedDevice[];
}

/** A paired device as the API reports it — the hash never leaves the bridge. */
export interface PairedDeviceWire {
  label: string;
  createdAt: number;
  lastSeenAt: number;
  /** True for the device making this request (so the UI can say "this device"). */
  current: boolean;
}

export const EMPTY_REGISTRY: PairedRegistry = { devices: [] };

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 as lowercase hex. Used for both codes and tokens — never store either in the clear. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking where they diverge. Both are SHA-256 output, so they are
 * always the same length here; a length mismatch (a corrupted file) is a plain `false` rather than a
 * throw from `timingSafeEqual`.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Uppercase and strip everything that isn't in the alphabet, so the operator may type the code with
 * spaces, dashes or in lower case. Deliberately NOT a spelling-correction pass (`O`→`0`): the
 * alphabet has no confusable pairs left, so anything outside it is a typo the attempt counter should
 * see, not a character to guess at.
 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(new RegExp(`[^${CODE_ALPHABET}]`, "g"), "");
}

/** Mint a fresh code. `random` is injected so the generator is testable and deterministic. */
export function generateCode(random: (n: number) => Buffer = randomBytes): string {
  // Rejection-free and unbiased enough: one byte per character, modulo an alphabet that divides
  // 256 unevenly, biases the first few glyphs by <1.5% — which changes nothing for a code that
  // lives 10 minutes behind a 5-attempt counter. Drawn a byte at a time so a short read is loud.
  const bytes = random(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/** Mint a 256-bit bearer token, base64url. This is the only time the token exists in the clear. */
export function generateToken(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

/** A fresh pending pairing for `code`, expiring `ttlMs` from `now`. */
export function newPending(code: string, now: number, ttlMs = CODE_TTL_MS): PendingPairing {
  return { codeHash: sha256Hex(normalizeCode(code)), expiresAt: now + ttlMs, attemptsLeft: CODE_ATTEMPTS };
}

/** Coerce an untrusted parsed value into a {@link PendingPairing}, or null if it isn't one. */
export function coercePending(raw: unknown): PendingPairing | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.codeHash !== "string" || o.codeHash === "") return null;
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) return null;
  if (typeof o.attemptsLeft !== "number" || !Number.isFinite(o.attemptsLeft)) return null;
  return { codeHash: o.codeHash, expiresAt: o.expiresAt, attemptsLeft: Math.floor(o.attemptsLeft) };
}

/**
 * Coerce an untrusted parsed value into a registry, dropping any entry that isn't a complete device.
 * A half-written or hand-edited file therefore degrades to "fewer paired devices", never to a device
 * with an empty `tokenHash` — which would otherwise authorise a caller whose token hashes to "".
 */
export function coerceRegistry(raw: unknown): PairedRegistry {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.devices) ? o.devices : [];
  const devices: PairedDevice[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const d = entry as Record<string, unknown>;
    if (typeof d.label !== "string" || d.label.trim() === "") continue;
    if (typeof d.tokenHash !== "string" || d.tokenHash.length !== 64) continue;
    if (devices.some((x) => x.label === d.label)) continue;
    devices.push({
      label: d.label,
      tokenHash: d.tokenHash,
      createdAt: typeof d.createdAt === "number" ? d.createdAt : 0,
      lastSeenAt: typeof d.lastSeenAt === "number" ? d.lastSeenAt : 0,
    });
  }
  return { devices };
}

/**
 * Validate and bound a client-supplied label. Returns null when it is unusable — the same answer for
 * "empty" and "1 KB of newlines", because the label is echoed into the audit log and the UI.
 */
export function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (label === "" || label.length > 48) return null;
  return label;
}

/** Why a claim failed. `expired`/`exhausted` mean the pending pairing is now gone. */
export type ClaimFailure = "no-pending" | "expired" | "exhausted" | "bad-code" | "duplicate-label";

export type ClaimVerdict =
  | { ok: true }
  /** `pending` is the state to persist, or null when the pending pairing must be deleted. */
  | { ok: false; reason: ClaimFailure; pending: PendingPairing | null };

/**
 * The whole of the code check, as one pure decision: is this claim good, and what should the pending
 * file look like afterwards. The caller persists the verdict; nothing here touches a disk.
 *
 * An expired code is destroyed rather than left to be guessed at leisure, and the last wrong attempt
 * destroys it too — so a code is at most 5 guesses out of 29^8 (~5e11), for 10 minutes.
 */
export function checkClaim(
  pending: PendingPairing | null,
  code: string,
  now: number,
): ClaimVerdict {
  if (!pending) return { ok: false, reason: "no-pending", pending: null };
  if (now >= pending.expiresAt) return { ok: false, reason: "expired", pending: null };
  if (pending.attemptsLeft <= 0) return { ok: false, reason: "exhausted", pending: null };
  if (hashesEqual(pending.codeHash, sha256Hex(normalizeCode(code)))) return { ok: true };
  const attemptsLeft = pending.attemptsLeft - 1;
  if (attemptsLeft <= 0) return { ok: false, reason: "exhausted", pending: null };
  return { ok: false, reason: "bad-code", pending: { ...pending, attemptsLeft } };
}

/** The device whose token hash matches, or null. Every entry is compared, in constant time each. */
export function findByToken(registry: PairedRegistry, token: string | null): PairedDevice | null {
  if (token === null || token === "") return null;
  const hash = sha256Hex(token);
  // Not short-circuited on the first match: `find` would return early, but the loop still visits
  // every entry before that one, so the timing signal is "how far down the list you are" — which is
  // not a secret (labels are readable) and is unrelated to the token bytes.
  let found: PairedDevice | null = null;
  for (const d of registry.devices) {
    if (hashesEqual(d.tokenHash, hash)) found = d;
  }
  return found;
}

/** Add a device, or null when the label is already taken (labels are the revoke handle). */
export function addDevice(
  registry: PairedRegistry,
  device: { label: string; tokenHash: string; now: number },
): PairedRegistry | null {
  if (registry.devices.some((d) => d.label === device.label)) return null;
  return {
    devices: [
      ...registry.devices,
      { label: device.label, tokenHash: device.tokenHash, createdAt: device.now, lastSeenAt: device.now },
    ],
  };
}

/** Drop a device by label. Returns null when there was no such device (so a caller can 404). */
export function removeDevice(registry: PairedRegistry, label: string): PairedRegistry | null {
  if (!registry.devices.some((d) => d.label === label)) return null;
  return { devices: registry.devices.filter((d) => d.label !== label) };
}

/**
 * Stamp `lastSeenAt`, or null when the previous stamp is recent enough that a write would be noise.
 * The throttle is the whole reason this is a function: `resolve()` runs on every request.
 */
export function touchDevice(
  registry: PairedRegistry,
  label: string,
  now: number,
  throttleMs = SEEN_THROTTLE_MS,
): PairedRegistry | null {
  const device = registry.devices.find((d) => d.label === label);
  if (!device) return null;
  if (now - device.lastSeenAt < throttleMs) return null;
  return { devices: registry.devices.map((d) => (d.label === label ? { ...d, lastSeenAt: now } : d)) };
}

/** The wire shape of the registry, for `GET /api/devices`. */
export function toDeviceWire(registry: PairedRegistry, current: string | null): PairedDeviceWire[] {
  return registry.devices.map((d) => ({
    label: d.label,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    current: d.label === current,
  }));
}

/**
 * The `Authorization: Bearer <token>` value, or null. Case-insensitive on the scheme (RFC 7235) and
 * tolerant of extra spacing, because a proxy may rewrite whitespace.
 */
export function bearerToken(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(raw.trim());
  return match ? match[1]! : null;
}

// ── The store ────────────────────────────────────────────────────────────────────────────────

/**
 * Every disk touch this module makes. Async everywhere except {@link PairingIo.readRegistrySync},
 * which exists because the write gate (`guard()` in bridge/server.ts) is synchronous and must see a
 * revocation made by `bin/collie devices revoke` in another process without a restart.
 */
export interface PairingIo {
  readPending(): Promise<unknown | null>;
  writePending(pending: PendingPairing): Promise<void>;
  deletePending(): Promise<void>;
  readRegistry(): Promise<unknown | null>;
  writeRegistry(registry: PairedRegistry): Promise<void>;
  /** The registry as of now, read synchronously. Null ⇒ no registry file. */
  readRegistrySync(): unknown | null;
}

/**
 * The real, owner-only implementation over `<stateDir>`.
 *
 * `readRegistrySync` stats before it reads and serves a cached parse when nothing changed, so the
 * per-request cost of the gate is one `stat` — not a parse — while a CLI revocation still lands on
 * the very next request.
 */
export function filePairingIo(stateDir: string): PairingIo {
  const pendingPath = join(stateDir, PENDING_FILENAME);
  const registryPath = join(stateDir, DEVICES_FILENAME);
  let cache: { key: string; value: unknown } | null = null;

  const writeAtomic = async (path: string, text: string): Promise<void> => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  };

  const readJson = async (path: string): Promise<unknown | null> => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  };

  return {
    readPending: () => readJson(pendingPath),
    writePending: (pending) => writeAtomic(pendingPath, JSON.stringify(pending, null, 2)),
    async deletePending() {
      try {
        await unlink(pendingPath);
      } catch {
        /* already gone — deleting a spent pairing is idempotent */
      }
    },
    readRegistry: () => readJson(registryPath),
    async writeRegistry(registry) {
      await writeAtomic(registryPath, JSON.stringify(registry, null, 2));
      cache = null;
    },
    readRegistrySync() {
      let key: string;
      try {
        const st = statSync(registryPath);
        key = `${st.mtimeMs}:${st.size}`;
      } catch {
        cache = null;
        return null;
      }
      if (cache?.key === key) return cache.value;
      try {
        const value: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
        cache = { key, value };
        return value;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The bridge's view of pairing: a synchronous gate for the request path, plus the async enrolment
 * and revocation operations.
 *
 * "Enforced" is not a setting — it is `the registry is non-empty`. Pairing nobody keeps Collie
 * exactly as it was; pairing one device turns the requirement on for every device, which is the only
 * ordering that can't lock the operator out of their own bridge halfway through.
 */
export class PairingStore {
  constructor(
    private readonly io: PairingIo,
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Buffer = randomBytes,
  ) {}

  /** The registry as of this instant, straight off disk (cached on mtime). */
  registry(): PairedRegistry {
    return coerceRegistry(this.io.readRegistrySync());
  }

  /** Whether a bearer token is required for writes — i.e. whether anything is paired at all. */
  enforced(): boolean {
    return this.registry().devices.length > 0;
  }

  /**
   * The device this request's bearer token belongs to, or null. Also stamps `lastSeenAt`, throttled
   * and fire-and-forget: a failed stamp must never fail the request it was decorating.
   */
  resolve(token: string | null): PairedDevice | null {
    const registry = this.registry();
    const device = findByToken(registry, token);
    if (!device) return null;
    const touched = touchDevice(registry, device.label, this.now());
    if (touched) {
      void this.io.writeRegistry(touched).catch((err: unknown) => {
        console.warn(`[pairing] could not stamp lastSeenAt: ${(err as Error).message}`);
      });
    }
    return device;
  }

  /**
   * Claim the pending code and enrol `label`. On success the token is returned ONCE — it is not
   * stored, recoverable or re-derivable — and the pending pairing is destroyed, so a code is
   * single-use even within its TTL.
   */
  async claim(code: string, label: string): Promise<{ ok: true; token: string } | { ok: false; reason: ClaimFailure }> {
    const pending = coercePending(await this.io.readPending());
    const verdict = checkClaim(pending, code, this.now());
    if (!verdict.ok) {
      if (verdict.pending === null) await this.io.deletePending();
      else await this.io.writePending(verdict.pending);
      return { ok: false, reason: verdict.reason };
    }
    const token = generateToken(this.random);
    const next = addDevice(coerceRegistry(await this.io.readRegistry()), {
      label,
      tokenHash: sha256Hex(token),
      now: this.now(),
    });
    // A duplicate label leaves the pending pairing alive: the operator retries with another name
    // rather than re-running `collie pair`.
    if (!next) return { ok: false, reason: "duplicate-label" };
    await this.io.writeRegistry(next);
    await this.io.deletePending();
    return { ok: true, token };
  }

  /** Drop a device. False ⇒ no such label. */
  async revoke(label: string): Promise<boolean> {
    const next = removeDevice(coerceRegistry(await this.io.readRegistry()), label);
    if (!next) return false;
    await this.io.writeRegistry(next);
    return true;
  }
}
