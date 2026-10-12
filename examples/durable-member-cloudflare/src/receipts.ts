// Request ids that survive a restart (WIRE.md 7.6 and 8.9): the SDK core's ReceiptStore on the Durable Object's
// SQLite. A row holds the digest of what the request asked for and the reply it got, never the payload. Only
// successes are written. The newest 1000 are kept.
import type { ReceiptRecord, ReceiptStore } from "../../durable-member/sdk/core/index.ts";

export const RECEIPTS_KEPT = 1000;

export class SqliteReceiptStore implements ReceiptStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS collie_receipts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, reply TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  get(requestId: string): ReceiptRecord | undefined {
    const row = this.sql.exec<{ digest: string; reply: string }>("SELECT digest, reply FROM collie_receipts WHERE request_id = ?", requestId).toArray()[0];
    return row ? { digest: row.digest, reply: JSON.parse(row.reply) as object } : undefined;
  }

  put(requestId: string, record: ReceiptRecord): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO collie_receipts (request_id, digest, reply, at) VALUES (?, ?, ?, ?)",
      requestId,
      record.digest,
      JSON.stringify(record.reply),
      Date.now(),
    );
    this.sql.exec(
      "DELETE FROM collie_receipts WHERE request_id NOT IN (SELECT request_id FROM collie_receipts ORDER BY at DESC, rowid DESC LIMIT ?)",
      RECEIPTS_KEPT,
    );
  }
}
