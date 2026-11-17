// THE RUN TOKENS OF THE LOCAL API (M105 spec 05, decisions 1 to 3). A run of a trick whose approved manifest
// declares `access` (`see` or `read`) gets one random token while the local API stands. The token rides in the
// run's facts on stdin as `api.token` and nowhere else: never in the environment, on a command line, on disk,
// in a log line or in an answer. The local API socket (bridge/api/socket.ts) answers a connection only after
// its `hello` names a live token, and then at the token's level.
//
// THE TABLE. Token to (trick id, level, run). The table keeps the SHA-256 of each token, never the token: a
// lookup goes by the hash's hex, and the stored hash is then compared with the asked one by
// `timingSafeEqual` over two 32-byte buffers, so the compare takes the same time for every token of a length.
// A token of another length or alphabet is refused before any hash.
//
// THE LIFE. A token dies when its run ends (`end`, every outcome: exit, failure, timeout, kill, a throw),
// when its trick is switched off or removed (`endTrick`), when tricks are switched off as a whole and at
// bridge stop (`clear`). At most one live token per run: a second `mint` for the same run ends the first.
// service.ts holds the calls; run-tokens.test.ts and service.test.ts pin each death.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { TrickAccess } from "../../web/src/lib/tricks/schema.ts";

/** The bytes of randomness in one token: 32, written as 43 base64url characters. */
export const RUN_TOKEN_BYTES = 32;
/** The text of a token: exactly 43 base64url characters (32 bytes, no padding). */
const RUN_TOKEN_TEXT = /^[A-Za-z0-9_-]{43}$/u;

/** What a live token stands for. */
export interface RunTokenHolder {
  readonly trickId: string;
  readonly level: TrickAccess;
}

interface Entry extends RunTokenHolder {
  readonly hash: Buffer;
  readonly runId: string;
}

function hashOf(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Whether `token` reads as a run token: 43 base64url characters. */
function isRunTokenText(token: string): boolean {
  return RUN_TOKEN_TEXT.test(token);
}

export class RunTokens {
  /** Live entries by the hex of their token's hash. */
  private readonly byHash = new Map<string, Entry>();
  /** The hash hex of each run's live token. */
  private readonly byRun = new Map<string, string>();

  /** A new token for one run of one trick, at the level its approved manifest declares. Ends the run's earlier token. */
  mint(trickId: string, level: TrickAccess, runId: string): string {
    this.end(runId);
    const token = randomBytes(RUN_TOKEN_BYTES).toString("base64url");
    const hash = hashOf(token);
    const key = hash.toString("hex");
    this.byHash.set(key, { trickId, level, runId, hash });
    this.byRun.set(runId, key);
    return token;
  }

  /** The trick and level of a live token, or null for a token that is unknown, dead or of another shape. */
  resolve(token: string): RunTokenHolder | null {
    if (!isRunTokenText(token)) return null;
    const hash = hashOf(token);
    const entry = this.byHash.get(hash.toString("hex"));
    if (entry === undefined || entry.hash.length !== hash.length || !timingSafeEqual(entry.hash, hash)) return null;
    return { trickId: entry.trickId, level: entry.level };
  }

  /** The run ended: its token dies. */
  end(runId: string): void {
    const key = this.byRun.get(runId);
    if (key === undefined) return;
    this.byRun.delete(runId);
    this.byHash.delete(key);
  }

  /** The trick was switched off or removed: every token of its runs dies. */
  endTrick(trickId: string): void {
    for (const entry of this.byHash.values()) {
      if (entry.trickId === trickId) this.end(entry.runId);
    }
  }

  /** Tricks went off as a whole, or the bridge stops: every token dies. */
  clear(): void {
    this.byHash.clear();
    this.byRun.clear();
  }

  /** How many tokens are live: for a test. */
  size(): number {
    return this.byHash.size;
  }
}
