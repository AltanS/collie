// A session turned its walky talky off (M89). One row per pane instance, on the machine that owns the
// pane: while a row holds, no agent message is typed into that pane, put in its inbox or sent from it.
// The operator's messages never read this (deliver.ts `place`).
//
//   <stateDir>/walky/off.json
//   { "v": 1, "panes": [ { "session": "...", "paneId": "...", "token": "k3f9", "since": <ms>, "by": "session" } ] }
//
// The row is keyed on the pane instance, the address token (instances.ts), because that is the one thing
// a sender can name: the flag survives a bridge restart and an agent restart in the same open pane, and it
// ends when the pane closes (`drop`, from `WalkyInstances.onDrop`). A row whose token no longer matches
// the pane reads as on. The file is absent until the first `off`. A file that does not parse reads as
// nobody off and stays as it is until the next write. The folder is 0700 and the file 0600, as the log's.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { INSTANCE_TOKEN } from "./address.ts";

/** Who set the flag: the session with the CLI verb in its own pane, or the operator from the phone. */
export type WalkyOffBy = "session" | "operator";

/** One pane instance, as the store keys it. */
export interface WalkyOffPane {
  readonly session: string;
  readonly paneId: string;
  readonly instance: string;
}

export interface WalkyOffRow {
  readonly session: string;
  readonly paneId: string;
  readonly token: string;
  readonly since: number;
  readonly by: WalkyOffBy;
}

function keyOf(session: string, paneId: string): string {
  return `${session}\u0000${paneId}`;
}

export class WalkyOff {
  private readonly path: string | null;
  private readonly rows = new Map<string, WalkyOffRow>();

  /** `dir` null keeps the flags in memory only (a test). */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.path = dir === null ? null : join(dir, "off.json");
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
    const held = parseJsonObject(raw);
    if (held?.v !== 1 || !Array.isArray(held.panes)) return;
    for (const value of held.panes) {
      const row = asJsonObject(value);
      const session = asJsonString(row?.session);
      const paneId = asJsonString(row?.paneId);
      const token = asJsonString(row?.token);
      const since = asJsonNumber(row?.since);
      const by = asJsonString(row?.by);
      if (session === undefined || paneId === undefined || token === undefined || since === undefined) continue;
      if (!INSTANCE_TOKEN.test(token) || (by !== "session" && by !== "operator")) continue;
      this.rows.set(keyOf(session, paneId), { session, paneId, token, since, by });
    }
  }

  /** Whether this pane instance is off. Another token at the same pane id is another session: on. */
  isOff(pane: WalkyOffPane): boolean {
    return this.rows.get(keyOf(pane.session, pane.paneId))?.token === pane.instance;
  }

  /** Set the flag. Idempotent, and the last write wins. Answers the new value. */
  set(pane: WalkyOffPane, off: boolean, by: WalkyOffBy): boolean {
    const key = keyOf(pane.session, pane.paneId);
    const held = this.rows.get(key);
    if (!off) {
      if (held === undefined) return false;
      this.rows.delete(key);
      this.write();
      return false;
    }
    if (held?.token === pane.instance && held.by === by) return true;
    const since = held?.token === pane.instance ? held.since : this.now();
    this.rows.set(key, { session: pane.session, paneId: pane.paneId, token: pane.instance, since, by });
    this.write();
    return true;
  }

  /** The pane instance is gone: its flag goes with it. A newer token at the same pane id stays. */
  drop(session: string, paneId: string, token: string): void {
    const key = keyOf(session, paneId);
    if (this.rows.get(key)?.token !== token) return;
    this.rows.delete(key);
    this.write();
  }

  /** Every row, for a test and a status line. */
  all(): WalkyOffRow[] {
    return [...this.rows.values()];
  }

  private write(): void {
    if (this.path === null || this.dir === null) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, panes: [...this.rows.values()] })}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // The flags still hold in memory; a restart then reads the last file, and a session turns off again.
    }
  }
}
