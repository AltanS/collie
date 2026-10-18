// The result of `collie skill sync`, its printed lines, and the switch that turns the update's sync off.
//
// A separate module with NO imports, on purpose. `cli/update.ts` reads the `--json` result back, and
// update sits on the path to `collie build`, which runs before `bun install` and so may import only
// builtins and repo files (`cli/main.test.ts`). `cli/skill-install.ts` embeds the docs, and the
// update has no business loading them.

export interface SyncChange {
  readonly harness: string;
  readonly path: string;
  readonly action: "installed" | "updated";
}

export interface SyncRefusal {
  readonly harness: string;
  readonly path: string;
  readonly reason: string;
}

export interface SyncSkip {
  readonly harness: string;
  readonly path: string;
  readonly reason: "not on this machine" | "uninstalled";
}

export interface SyncResult {
  readonly changed: SyncChange[];
  readonly refused: SyncRefusal[];
  readonly skipped: SyncSkip[];
}

/**
 * `skill sync --json` read back by `collie update`, or null when the output is not that shape: a build
 * before the verb prints the general brief for `collie skill sync`, and that must read as "no sync".
 */
export function parseSyncResult(stdout: string): SyncResult | null {
  let doc: Partial<SyncResult> | null;
  try {
    // SAFETY: `JSON.parse` answers a JSON value. The three lists are checked to be arrays below, and
    // every field of their entries is only ever printed: none becomes a path, a command or a write.
    doc = JSON.parse(stdout.trim()) as Partial<SyncResult> | null;
  } catch {
    return null;
  }
  if (doc === null || !Array.isArray(doc.changed) || !Array.isArray(doc.refused) || !Array.isArray(doc.skipped)) return null;
  return { changed: doc.changed, refused: doc.refused, skipped: doc.skipped };
}

/** The lines `sync` prints: one per change, one per refusal, none for a skip. `collie update` prints the same. */
export function syncLines(result: SyncResult, dryRun = false): string[] {
  const verb = (action: SyncChange["action"]): string =>
    dryRun ? (action === "installed" ? "would install" : "would update") : action;
  return [
    ...result.changed.map((c) => `${verb(c.action)} ${c.harness} ${c.path}`),
    ...result.refused.map((r) => `refused ${r.harness} ${r.path}: ${r.reason}`),
  ];
}

/**
 * `COLLIE_SKILL_SYNC`: on unless it says off. The words are `envBool`'s (`bridge/config.ts`), read
 * here without importing that module into the update's graph. An unknown word keeps the default.
 */
export function skillSyncEnabled(raw: string | undefined): boolean {
  return !["off", "0", "false", "no"].includes((raw ?? "").trim().toLowerCase());
}
