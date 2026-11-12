// Pane instances (added 2026-10-18). A multiplexer reuses a pane id once the pane closes: Herdr's
// `w1:p1`, zellij's `terminal_1`, tmux's `%7`. An address `<member>/<pane>` alone cannot tell the pane
// a sender meant from a new session that took its id since. So the bridge gives every pane it sees a
// token, four characters of [a-z0-9] from a CSPRNG, minted the first time it sees that session and
// pane id, and an address may carry it: `<member>/<pane>#<token>` (address.ts).
//
//   <stateDir>/walky/instances.json
//   { "v": 1, "panes": [ { "session": "...", "paneId": "...", "token": "k3f9", "since": <ms>, "lastSeen": <ms> } ] }
//
// A pane not seen for more than 30 seconds ({@link INSTANCE_GRACE_MS}) is dropped, and its listeners
// hear it: the log then unlinks the pane's inbox. The grace rides out a snapshot that missed a pane.
//
// THE GRACE IS FOR A MISSED SNAPSHOT ONLY (review 12 M1). With a `look` at the panes (index.ts), a pane
// missing from a session whose snapshot was read is closed, and goes at once; and a pane whose
// GENERATION changed (its agent, or the agent session it named: `<agent>:<session or ->`, the Send
// Protocol's generation) is a new instance under the same id, so it gets a new token and the old one's
// listeners hear it go. Else a session that took a closed pane's id inside the grace would inherit the
// old token, and with it a trick's bound rows and taps, the inbox and the off flag. An agent that names
// its session later (`claude:-` to `claude:<id>`) is the same instance. On load the same rule holds against the clock: a bridge restart inside 30 seconds keeps the
// tokens, a reboot or a long outage mints new ones. The folder is 0700 and the file 0600, as the log's.
// A file that does not parse reads as empty: every pane then gets a new token, which is the safe side.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { INSTANCE_TOKEN } from "./address.ts";

/** How long a pane may be out of sight before its token goes. */
export const INSTANCE_GRACE_MS = 30_000;
/** How often the bridge looks at its panes when no message asks, and the most the file's clock may lag. */
export const INSTANCE_TICK_MS = 10_000;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Mint one token: four characters of [a-z0-9], uniform (a byte at or above 252 is skipped). */
export function mintInstanceToken(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  let out = "";
  while (out.length < 4) {
    for (const byte of random(8)) {
      if (byte >= 252) continue;
      out += ALPHABET[byte % 36];
      if (out.length === 4) break;
    }
  }
  return out;
}

/** One pane, as the registry keys it. */
export interface PaneKey {
  readonly session: string;
  readonly paneId: string;
}

export interface InstanceEntry extends PaneKey {
  readonly token: string;
  /** The pane's generation when last looked at, with a `look`: `<agent>:<agent session or ->`. */
  readonly generation?: string;
  /** When the token was minted. */
  readonly since: number;
  /** When the pane was last seen. */
  readonly lastSeen: number;
}

/** What one look at a pane did: its token, whether it was minted just now, and the entry it replaced. */
interface Touched {
  readonly token: string;
  readonly minted: boolean;
  readonly replaced?: InstanceEntry;
}

/**
 * How the registry looks at a pane (review 12 M1). `generation`: `<agent>:<agent session or ->`, null for a
 * pane it cannot see. `read`: the session's last snapshot was read, so a pane missing from it is closed.
 */
export interface InstanceLook {
  generation(session: string, paneId: string): string | null;
  read(session: string): boolean;
}

/** A generation's agent and session: `<agent>:<session or ->`. */
function cut(generation: string): [string, string] {
  // An agent name holds no colon; a session id may.
  const colon = generation.indexOf(":");
  return colon < 0 ? [generation, "-"] : [generation.slice(0, colon), generation.slice(colon + 1)];
}

/**
 * Whether two generations of one pane id are the same instance: the same agent, and no two different
 * sessions it named. A side not known, or a session not named yet (`-`), changes nothing.
 */
export function sameGeneration(held: string | undefined, now: string | null): boolean {
  if (held === undefined || now === null) return true;
  const [agentHeld, sessionHeld] = cut(held);
  const [agentNow, sessionNow] = cut(now);
  if (agentHeld !== agentNow) return false;
  return sessionHeld === "-" || sessionNow === "-" || sessionHeld === sessionNow;
}

export type InstanceDropListener = (session: string, paneId: string, token: string) => void;

function keyOf(session: string, paneId: string): string {
  return `${session}\u0000${paneId}`;
}

export class WalkyInstances {
  private readonly path: string | null;
  private readonly entries = new Map<string, InstanceEntry>();
  private readonly listeners: InstanceDropListener[] = [];
  /** What the load dropped: told to each listener as it registers, so a stale inbox goes too. */
  private readonly droppedOnLoad: InstanceEntry[] = [];
  private writtenAt = -Infinity;

  /** `dir` null keeps the tokens in memory only (a test). Without `look`, only the grace ends a token. */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
    private readonly random?: (n: number) => Uint8Array,
    private readonly look?: InstanceLook,
  ) {
    this.path = dir === null ? null : join(dir, "instances.json");
    this.load();
  }

  private load(): void {
    if (this.path === null || !existsSync(this.path)) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    const row = parseJsonObject(raw);
    if (row?.v !== 1 || !Array.isArray(row.panes)) return;
    const floor = this.now() - INSTANCE_GRACE_MS;
    for (const value of row.panes) {
      const entry = asJsonObject(value);
      const session = asJsonString(entry?.session);
      const paneId = asJsonString(entry?.paneId);
      const token = asJsonString(entry?.token);
      const since = asJsonNumber(entry?.since);
      const lastSeen = asJsonNumber(entry?.lastSeen);
      const generation = asJsonString(entry?.generation);
      if (session === undefined || paneId === undefined || token === undefined || since === undefined || lastSeen === undefined) continue;
      if (!INSTANCE_TOKEN.test(token)) continue;
      const held: InstanceEntry = generation === undefined ? { session, paneId, token, since, lastSeen } : { session, paneId, token, since, lastSeen, generation };
      if (lastSeen < floor) this.droppedOnLoad.push(held);
      else this.entries.set(keyOf(session, paneId), held);
    }
    if (this.droppedOnLoad.length > 0) this.write();
  }

  /** Call `listener` for every token that goes, the ones the load dropped included. */
  onDrop(listener: InstanceDropListener): void {
    this.listeners.push(listener);
    for (const entry of this.droppedOnLoad) listener(entry.session, entry.paneId, entry.token);
  }

  /** A token no other pane with this id holds, so a token always tells two sessions' panes apart. */
  private mint(paneId: string): string {
    const taken = new Set([...this.entries.values()].filter((entry) => entry.paneId === paneId).map((entry) => entry.token));
    for (;;) {
      const token = mintInstanceToken(this.random);
      if (!taken.has(token)) return token;
    }
  }

  /**
   * The pane's token, minted when it is new or its generation changed (the old entry is `replaced`), its
   * `lastSeen` set to `at`; `minted` says which.
   */
  private touch(pane: PaneKey, at: number): Touched {
    const key = keyOf(pane.session, pane.paneId);
    const held = this.entries.get(key);
    const generation = this.look?.generation(pane.session, pane.paneId) ?? null;
    if (held !== undefined && sameGeneration(held.generation, generation)) {
      // A generation learned (a session named) is kept; one not seen now keeps the last.
      const known = generation !== null && !generation.endsWith(":-") ? generation : (held.generation ?? generation ?? undefined);
      this.entries.set(key, known === undefined ? { ...held, lastSeen: Math.max(held.lastSeen, at) } : { ...held, lastSeen: Math.max(held.lastSeen, at), generation: known });
      return { token: held.token, minted: false };
    }
    // The new token differs from the replaced one too: `mint` runs while the old entry is still held.
    const token = this.mint(pane.paneId);
    const fresh: InstanceEntry = { session: pane.session, paneId: pane.paneId, token, since: at, lastSeen: at };
    this.entries.set(key, generation === null ? fresh : { ...fresh, generation });
    return held === undefined ? { token, minted: true } : { token, minted: true, replaced: held };
  }

  private tell(gone: readonly InstanceEntry[]): void {
    for (const entry of gone) for (const listener of this.listeners) listener(entry.session, entry.paneId, entry.token);
  }

  /**
   * Every pane the bridge sees now: a token for a new one, `lastSeen` for the rest, and every pane
   * not seen for more than {@link INSTANCE_GRACE_MS} dropped (its listeners hear it).
   */
  observe(panes: readonly PaneKey[], at: number = this.now()): void {
    let changed = false;
    const present = new Set<string>();
    const dropped: InstanceEntry[] = [];
    for (const pane of panes) {
      present.add(keyOf(pane.session, pane.paneId));
      const touched = this.touch(pane, at);
      if (touched.minted) changed = true;
      if (touched.replaced !== undefined) dropped.push(touched.replaced);
    }
    for (const [key, entry] of this.entries) {
      if (present.has(key)) continue;
      // Missing from a session whose snapshot was read: closed now. Else out of sight, for the grace.
      const closed = this.look?.read(entry.session) === true;
      if (!closed && at - entry.lastSeen <= INSTANCE_GRACE_MS) continue;
      this.entries.delete(key);
      dropped.push(entry);
    }
    if (dropped.length > 0) changed = true;
    this.persist(changed, at);
    this.tell(dropped);
  }

  /** {@link observe}, then every pane with its token, in the order given. */
  stamp<T extends PaneKey>(panes: readonly T[], at: number = this.now()): (T & { readonly instance: string })[] {
    this.observe(panes, at);
    return panes.map((pane) => ({ ...pane, instance: this.entries.get(keyOf(pane.session, pane.paneId))!.token }));
  }

  /**
   * One pane's token, minted when it is new, for a reader that sees one pane at a time (the snapshot).
   * It drops no other pane: only {@link observe} sees every pane, and only it may call one gone. A pane
   * whose generation changed is replaced here too, and the old token's listeners hear it.
   */
  tokenOf(session: string, paneId: string, at: number = this.now()): string {
    const { token, minted, replaced } = this.touch({ session, paneId }, at);
    this.persist(minted, at);
    if (replaced !== undefined) this.tell([replaced]);
    return token;
  }

  /** The token a pane holds now, or null. Mints nothing. */
  peek(session: string, paneId: string): string | null {
    return this.entries.get(keyOf(session, paneId))?.token ?? null;
  }

  /** Every entry, for a test and a status line. */
  all(): InstanceEntry[] {
    return [...this.entries.values()];
  }

  /** Written when a token came or went, and else at most every {@link INSTANCE_TICK_MS}, so `lastSeen` on disk lags at most that. */
  private persist(changed: boolean, at: number): void {
    if (!changed && at - this.writtenAt < INSTANCE_TICK_MS) return;
    this.writtenAt = at;
    this.write();
  }

  private write(): void {
    if (this.path === null || this.dir === null) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, panes: [...this.entries.values()] })}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // The tokens still hold in memory; a restart then mints new ones, which is the safe side.
    }
  }
}
