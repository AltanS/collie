import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hashesEqual } from "./pairing.ts";

// ── THE HOST'S OWN READ CREDENTIAL, FOR THE CLI THAT RUNS BESIDE THE BRIDGE ────────────────────
//
// Reads need the pairing token (ADR 0086), and the CLI holds none: `collie doctor` reads its own
// bridge's `/api/snapshot`, and `collie crew update` reads `/api/update/check`. Both went to 403.
//
// So at start the bridge mints a fresh 256-bit secret, writes it to `<stateDir>/local-secret` owner-only
// (0600 in the 0700 state folder; on Windows the state folder's access list, which start-up already
// holds to the owner, `bridge/owner-only.ts`), and keeps only its SHA-256. A CLI run against that state
// folder reads the file and sends `Authorization: Bearer <secret>`.
//
// WHAT IT OPENS, AND WHY THAT IS ALL:
//   - Reads only. `guard` asks for it at the `"read"` level and at no other, so it never types into a
//     terminal, never opens the Files view (`device-read`), never revokes a device.
//   - From this host, through nothing: a request carrying a proxy's header (`X-Forwarded-For`,
//     `Forwarded`, `X-Real-IP` and the like) is refused, and the TCP peer must be loopback. Only when
//     the bridge binds one concrete non-loopback address (a crew peer on its tailnet address, where
//     the CLI dials that address) does one of this host's own interface addresses count too
//     (`browserPairingGate` in server.ts says why, and why no other machine passes). A plain TCP relay
//     on this host (socat, `ssh -L`) still passes, as it always passed the loopback rule, so the peer
//     rule is not the boundary; the file's owner-only mode is. Whoever can read the file can already
//     read the state folder, which holds the pairing registry and the crew secret.
//   - Rotated on every start, deleted on a clean stop. A stale file from a crash names a secret no
//     running bridge holds.
//
// A missing file (the bridge is down, or older than this) means the CLI sends nothing, exactly as before.

/** The file under the state dir. Listed with the state folder's secrets in bridge/acl-policy.ts. */
export const LOCAL_SECRET_FILENAME = "local-secret";

/** The device label a request carrying the local credential is attributed to. */
export const LOCAL_LABEL = "local";

/** 256 bits as base64url, no padding: exactly this many characters. */
const SECRET_LENGTH = 43;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Where the file lives for a state dir. */
export function localSecretPath(stateDir: string): string {
  return join(stateDir, LOCAL_SECRET_FILENAME);
}

/** A fresh secret: 256 random bits, base64url. `random` is injected so a test can pin it. */
export function mintLocalSecret(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

/** Whether a string is a well-formed secret. Anything else is never sent and never matched. */
export function isWellFormedLocalSecret(value: string): boolean {
  return value.length === SECRET_LENGTH && SECRET_PATTERN.test(value);
}

/** The bridge's side: holds the hash, never the secret, and answers one question. */
export interface LocalCredential {
  /** Whether `token` is this bridge's current local secret. Constant time over the hash. */
  matches(token: string | null): boolean;
}

/** The matcher for one secret. Only its SHA-256 is kept. */
export function localCredentialOf(secret: string): LocalCredential {
  const hash = createHash("sha256").update(secret, "utf8").digest("hex");
  return {
    matches(token) {
      if (token === null || !isWellFormedLocalSecret(token)) return false;
      return hashesEqual(hash, createHash("sha256").update(token, "utf8").digest("hex"));
    },
  };
}

/**
 * Write the secret owner-only and atomically: a 0600 temp file in the 0700 state folder, renamed over
 * the target, so a CLI never reads half a secret. A file left by an earlier run is replaced.
 */
export async function writeLocalSecret(stateDir: string, secret: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = localSecretPath(stateDir);
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, `${secret}\n`, { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Delete the file on a clean stop, but only while it still holds THIS process's secret: a restart that
 * overlapped (the new bridge wrote its own before the old one finished stopping) keeps the new file.
 */
export async function removeLocalSecret(stateDir: string, secret: string): Promise<void> {
  const path = localSecretPath(stateDir);
  try {
    if ((await readFile(path, "utf8")).trim() !== secret) return;
    await unlink(path);
  } catch {
    /* already gone, or unreadable: nothing of ours to remove */
  }
}

/**
 * The CLI's side: the secret in `<stateDir>/local-secret`, or null when there is none or it is not
 * secret-shaped. `read` is the CLI's own file seam (`Files.read`), so a test reads no real disk.
 */
export function readLocalSecret(stateDir: string, read: (path: string) => string | null): string | null {
  const raw = read(localSecretPath(stateDir));
  if (raw === null) return null;
  const secret = raw.trim();
  return isWellFormedLocalSecret(secret) ? secret : null;
}

/** The `Authorization` header for a CLI read, or nothing when no secret is on disk. */
export function localAuthHeader(secret: string | null): Record<string, string> {
  return secret === null ? {} : { authorization: `Bearer ${secret}` };
}
