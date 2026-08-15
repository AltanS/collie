import { join } from "node:path";

import { fsTrustStoreIo, type TrustStoreIo } from "./trust-store.ts";

// The ops store: how the operator reached a member ONCE, so they need not retype it.
//
// ── THIS IS NOT TRUST, AND IT IS NOT A WIRE FIELD (ADR 0016) ─────────────────
// Every value here is something the operator typed on their own command line — an ssh host, a remote
// checkout path, a port. It is convenience, kept beside the trust store rather than inside it: the
// trust store's fields are whitelisted by `TRUST_STORE_VERSION` and every one of them is material a
// pin or a secret depends on, so an ssh hostname in there would be a routing hint with a trust file's
// authority. Nothing in this file ever crosses the pack link, in either direction — a peer neither
// sends nor learns how its operator dials it (PACK_PROTOCOL.md §11's spirit, ADR 0016's rule).
//
// It is written by `pack add` (on a run that finished), refreshed by `pack update` when the operator
// overrides one of its fields, and deleted by `pack remove`. A member with no record here is not
// broken — it is a member this machine has never SSH'd to, and `pack update` says exactly that.
//
// At rest it reuses the trust store's discipline verbatim ({@link fsTrustStoreIo}): 0600 in a 0700
// directory, temp-file-then-rename. It holds no secret, but it names hosts an operator can reach, and
// there is no reason for that to be more readable than the roster it sits next to.

/** The ops store's filename under `stateDir`. Also the literal the solo baseline scans for. */
export const PACK_OPS_FILENAME = "pack-ops.json";

/** Absolute path of the ops store for a given state dir. The only place this path is composed. */
export function packOpsPath(stateDir: string): string {
  return join(stateDir, PACK_OPS_FILENAME);
}

/** On-disk schema version. An unknown one is refused, never guessed at. */
export const PACK_OPS_VERSION = 1;

/** How this machine last reached one member over SSH. Every field is operator-supplied or observed. */
export interface OpsRecord {
  /** The ssh destination as the operator typed it — `host`, `user@host`, an `~/.ssh/config` alias. */
  readonly sshHost: string;
  /** The remote checkout, as the far machine reported it. `null` = it was never observed. */
  readonly path: string | null;
  /** The port that machine's collie is configured to bind. */
  readonly port: number;
  readonly recordedAt: number;
}

/** The whole file: member id → how to reach it. */
export interface PackOpsData {
  readonly version: number;
  readonly members: Readonly<Record<string, OpsRecord>>;
}

/** An empty store, for a machine that has never run `pack add`. */
export function emptyPackOps(): PackOpsData {
  return { version: PACK_OPS_VERSION, members: {} };
}

function isRecord(value: unknown): value is OpsRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.sshHost === "string" &&
    r.sshHost !== "" &&
    (r.path === null || typeof r.path === "string") &&
    typeof r.port === "number" &&
    typeof r.recordedAt === "number"
  );
}

/**
 * Parse an ops store. `null` for anything this reader does not understand.
 *
 * **Fails closed like the trust store, for a smaller reason.** Nothing here is a pin, so a hole costs
 * an operator one flag rather than an unenforced trust decision — but a half-read file would still
 * have `pack update` SSH to a host it derived from bytes it could not fully read, and that is a
 * command run on someone's machine. Refuse; the caller reports it and the file is left untouched.
 */
export function parsePackOps(raw: string): PackOpsData | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (d.version !== PACK_OPS_VERSION) return null;
  if (d.members === null || typeof d.members !== "object") return null;
  const members: Record<string, OpsRecord> = {};
  for (const [memberId, record] of Object.entries(d.members as Record<string, unknown>)) {
    if (!isRecord(record)) return null;
    members[memberId] = {
      sshHost: record.sshHost,
      path: record.path,
      port: record.port,
      recordedAt: record.recordedAt,
    };
  }
  return { version: PACK_OPS_VERSION, members };
}

/** Serialise for disk. Stable, pretty-printed, newline-terminated — a diffable operator file. */
export function serializePackOps(data: PackOpsData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** What a read found. `unreadable` is distinguished from absent so a verb can say which it is. */
export interface PackOpsRead {
  readonly data: PackOpsData | null;
  /** The file exists and is not one this build can read. Nothing was rewritten. */
  readonly unreadable: boolean;
}

/**
 * The ops store as a process holds it: read once, written whole.
 *
 * Deliberately NOT a `TrustStore` subclass and deliberately not merged into it — the two files have
 * different lifetimes, different sensitivity and different owners (ADR 0016). What they share is the
 * `TrustStoreIo` seam, which is what keeps this module unit-testable without a disk.
 */
export class PackOpsStore {
  private cached: PackOpsRead | null = null;
  private readonly path: string;

  constructor(
    stateDir: string,
    private readonly io: TrustStoreIo = fsTrustStoreIo(stateDir),
  ) {
    this.path = packOpsPath(stateDir);
  }

  /** The file's contents, or `null` when this machine has never recorded a member. */
  async load(): Promise<PackOpsRead> {
    if (this.cached !== null) return this.cached;
    const raw = await this.io.read(this.path);
    const parsed = raw === null ? null : parsePackOps(raw);
    this.cached = { data: parsed, unreadable: raw !== null && parsed === null };
    return this.cached;
  }

  /** One member's record, or `null` when there is none (or the file could not be read). */
  async get(memberId: string): Promise<OpsRecord | null> {
    const { data } = await this.load();
    return data?.members[memberId] ?? null;
  }

  /**
   * Record (or refresh) how a member was reached. `false` means the existing file could not be read
   * and was therefore NOT overwritten — a convenience file is never worth destroying an operator's.
   */
  async record(memberId: string, record: OpsRecord): Promise<boolean> {
    const { data, unreadable } = await this.load();
    if (unreadable) return false;
    const next: PackOpsData = {
      version: PACK_OPS_VERSION,
      members: { ...(data?.members ?? {}), [memberId]: record },
    };
    await this.write(next);
    return true;
  }

  /** Forget a member. Silent when there is nothing to forget — `pack remove` must not fail on it. */
  async forget(memberId: string): Promise<boolean> {
    const { data, unreadable } = await this.load();
    if (unreadable || data === null || data.members[memberId] === undefined) return false;
    const members = { ...data.members };
    delete members[memberId];
    await this.write({ version: PACK_OPS_VERSION, members });
    return true;
  }

  private async write(next: PackOpsData): Promise<void> {
    await this.io.write(this.path, serializePackOps(next));
    this.cached = { data: next, unreadable: false };
  }
}
