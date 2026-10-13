// Request ids that survive a restart (WIRE.md 7.6 and 8.9): the SDK core's ReceiptStore on the Durable Object's
// SQLite. A row holds the digest of what the request asked for and the reply it got, never the payload. Only
// successes are written.
//
// The newest 1000 per pane are kept (the starters count as one group). Older ones are dropped in the same
// transaction that writes the new one: the reply goes, and the id stays as its digest only, so a repeat of it is
// refused (an unknown outcome, never a second run). At most 10,000 dropped ids are kept per pane; past that the
// oldest go too, and the act's own check (a closed ask, a turn that moved) is what is left.
import { type DroppedReceipt, RECEIPTS_PER_GROUP, type ReceiptRecord, type ReceiptStore } from "../../durable-member/sdk/core/index.ts";

export const RECEIPTS_KEPT = RECEIPTS_PER_GROUP;
export const DROPPED_KEPT = RECEIPTS_PER_GROUP * 10;

type Row = {
  digest: string;
  reply: string;
  dropped: number;
};

export class SqliteReceiptStore implements ReceiptStore {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    const sql = storage.sql;
    this.sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS collie_receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, reply TEXT NOT NULL, at INTEGER NOT NULL)");
    // A table from before the per-pane cap has neither column. Every row in it reads as one group, kept.
    const columns = new Set(sql.exec<{ name: string }>("PRAGMA table_info(collie_receipts)").toArray().map((c) => c.name));
    if (!columns.has("grp")) sql.exec("ALTER TABLE collie_receipts ADD COLUMN grp TEXT NOT NULL DEFAULT ''");
    if (!columns.has("dropped")) sql.exec("ALTER TABLE collie_receipts ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0");
    sql.exec("CREATE INDEX IF NOT EXISTS collie_receipts_grp ON collie_receipts (grp, dropped, at)");
  }

  get(requestId: string): ReceiptRecord | DroppedReceipt | undefined {
    const row = this.sql.exec<Row>("SELECT digest, reply, dropped FROM collie_receipts WHERE request_id = ?", requestId).toArray()[0];
    if (row === undefined) return undefined;
    return row.dropped === 1 ? { dropped: true, digest: row.digest } : { digest: row.digest, reply: JSON.parse(row.reply) as object };
  }

  put(requestId: string, record: ReceiptRecord, group: string): void {
    this.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT OR REPLACE INTO collie_receipts (request_id, digest, reply, at, grp, dropped) VALUES (?, ?, ?, ?, ?, 0)",
        requestId,
        record.digest,
        JSON.stringify(record.reply),
        Date.now(),
        group,
      );
      // Past the newest 1000 of this group: drop the reply, keep the id and its digest.
      this.sql.exec(
        `UPDATE collie_receipts SET dropped = 1, reply = '' WHERE grp = ?1 AND dropped = 0 AND request_id NOT IN
           (SELECT request_id FROM collie_receipts WHERE grp = ?1 AND dropped = 0 ORDER BY at DESC, rowid DESC LIMIT ?2)`,
        group,
        RECEIPTS_KEPT,
      );
      this.sql.exec(
        `DELETE FROM collie_receipts WHERE grp = ?1 AND dropped = 1 AND request_id NOT IN
           (SELECT request_id FROM collie_receipts WHERE grp = ?1 AND dropped = 1 ORDER BY at DESC, rowid DESC LIMIT ?2)`,
        group,
        DROPPED_KEPT,
      );
    });
  }
}
