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
// hear it: the log then unlinks the pane's inbox. The grace rides out a snapshot that briefly missed a
// pane. On load the same rule holds against the clock: a bridge restart inside 30 seconds keeps the
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
  /** When the token was minted. */
  readonly since: number;
  /** When the pane was last seen. */
  readonly lastSeen: number;
}

/** What one look at a pane did: its token, and whether it was minted just now. */
interface Touched {
  readonly token: string;
  readonly minted: boolean;
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

  /** `dir` null keeps the tokens in memory only (a test). */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
    private readonly random?: (n: number) => Uint8Array,
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
      if (session === undefined || paneId === undefined || token === undefined || since === undefined || lastSeen === undefined) continue;
      if (!INSTANCE_TOKEN.test(token)) continue;
      const held: InstanceEntry = { session, paneId, token, since, lastSeen };
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

  /** The pane's token, minted when it is new, its `lastSeen` set to `at`; `minted` says which. */
  private touch(pane: PaneKey, at: number): Touched {
    const key = keyOf(pane.session, pane.paneId);
    const held = this.entries.get(key);
    if (held !== undefined) {
      this.entries.set(key, { ...held, lastSeen: Math.max(held.lastSeen, at) });
      return { token: held.token, minted: false };
    }
    const token = this.mint(pane.paneId);
    this.entries.set(key, { session: pane.session, paneId: pane.paneId, token, since: at, lastSeen: at });
    return { token, minted: true };
  }

  /**
   * Every pane the bridge sees now: a token for a new one, `lastSeen` for the rest, and every pane
   * not seen for more than {@link INSTANCE_GRACE_MS} dropped (its listeners hear it).
   */
  observe(panes: readonly PaneKey[], at: number = this.now()): void {
    let changed = false;
    const present = new Set<string>();
    for (const pane of panes) {
      present.add(keyOf(pane.session, pane.paneId));
      if (this.touch(pane, at).minted) changed = true;
    }
    const dropped: InstanceEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (present.has(key) || at - entry.lastSeen <= INSTANCE_GRACE_MS) continue;
      this.entries.delete(key);
      dropped.push(entry);
    }
    if (dropped.length > 0) changed = true;
    this.persist(changed, at);
    for (const entry of dropped) for (const listener of this.listeners) listener(entry.session, entry.paneId, entry.token);
  }

  /** {@link observe}, then every pane with its token, in the order given. */
  stamp<T extends PaneKey>(panes: readonly T[], at: number = this.now()): (T & { readonly instance: string })[] {
    this.observe(panes, at);
    return panes.map((pane) => ({ ...pane, instance: this.entries.get(keyOf(pane.session, pane.paneId))!.token }));
  }

  /**
   * One pane's token, minted when it is new, for a reader that sees one pane at a time (the snapshot).
   * It drops nothing: only {@link observe} sees every pane, and only it may call one gone.
   */
  tokenOf(session: string, paneId: string, at: number = this.now()): string {
    const { token, minted } = this.touch({ session, paneId }, at);
    this.persist(minted, at);
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
