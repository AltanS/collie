import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

import { CREW_OPS_FILENAME } from "./ops-store.ts";
import { CREW_RUNTIME_FILENAME } from "./staleness.ts";
import { TRUST_STORE_FILENAME } from "./trust-store.ts";

// REMOVE_IN_1_9_0 — the whole module.
//
// 1.7.0 wrote `pack-trust.json`, `pack-ops.json` and `pack-runtime.json`; 1.8.0 writes the same three
// files under `crew-` (M27, ADR 0039). This is the one-time move between the two, run on the first
// start of 1.8.0 and a no-op on every start after it.
//
// ── WHY A RENAME AND NOT A COPY ──────────────────────────────────────────────
// A copy leaves two trust stores on disk, and a second trust store is a second roster: whichever one
// a later build opens first decides which pins are enforced. That is the failure this rename exists
// to avoid, so no `.bak` is kept. The rollback is the one the update flow already provides — the
// previous checkout is still there, and a 1.7.0 binary started against a migrated state directory
// reads no trust store at all and stays solo rather than enforcing a stale roster.
//
// ── WHY THE NEW FILE WINS ────────────────────────────────────────────────────
// If both names exist, the operator has run 1.8.0 already and then put a 1.7.0 file back beside it
// (a restored backup, a hand copy). Renaming over the live file would drop what 1.8.0 wrote, so the
// old file is left exactly where it is and the collision is said out loud once.

/** One file's move: the 1.7.0 name, and the name 1.8.0 reads and writes. */
export interface CrewStateFileMove {
  readonly legacy: string;
  readonly current: string;
}

/**
 * The three files, in the order they are checked. Each `current` is read from the module that owns
 * it rather than typed a second time here.
 *
 * A FUNCTION, not a `const`: `trust-store.ts` calls this module from `fsTrustStoreIo`, so the two
 * import each other, and a module-level literal would read a name that is still `undefined` on one
 * of the two evaluation orders. Called at start, once, so the array costs nothing.
 */
export function crewStateFileMoves(): readonly CrewStateFileMove[] {
  return [
    { legacy: "pack-trust.json", current: TRUST_STORE_FILENAME },
    { legacy: "pack-ops.json", current: CREW_OPS_FILENAME },
    { legacy: "pack-runtime.json", current: CREW_RUNTIME_FILENAME },
  ];
}

/** The two filesystem operations the move needs, injected so the decision is testable without a disk. */
export interface CrewStateFileIo {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
}

/** The real filesystem. Synchronous on purpose: this runs before anything else opens a state file. */
export const fsCrewStateFileIo: CrewStateFileIo = {
  exists: (path) => existsSync(path),
  rename: (from, to) => renameSync(from, to),
};

/** State directories this process has already moved. The move is once per process, not per caller. */
const moved = new Set<string>();

/**
 * {@link migrateCrewStateFiles}, at most once per state directory per process.
 *
 * WHO CALLS THIS, AND WHY IT IS NOT LOWER DOWN. The callers are the bridge's boot and the three CLI
 * deps builders that construct a real store (`crewDeps`, `doctorDeps`, `updateCheckDeps`) — the
 * places that are ABOUT to open the directory and that only a real verb reaches. It sat inside
 * `fsTrustStoreIo` first, and the test suite moved an operator's live files through it; then at the
 * CLI's process entry, and `env -i collie version` moved them for a verb that opens nothing. A
 * one-time filesystem move belongs where the intent to use the directory is, and nowhere earlier.
 */
export function migrateCrewStateOnce(stateDir: string, warn: (line: string) => void): void {
  if (moved.has(stateDir)) return;
  moved.add(stateDir);
  for (const line of migrateCrewStateFiles(stateDir)) warn(line);
}

/**
 * Move each 1.7.0 state file to its crew name, and return the lines the caller should print.
 *
 * Idempotent, and cheap on the ordinary start: three `exists()` calls on names that are not there.
 * Nothing is read, parsed or written — the inner keys (`pack` → `crew`, `packId` → `crewId`) are the
 * parser's business (`parseTrustStore`), which reads either spelling and writes back the new one.
 *
 * A rename that fails is not fatal here: the message says what could not be moved and the caller
 * carries on, exactly as an unreadable trust store leaves this collie solo rather than stopping it.
 */
export function migrateCrewStateFiles(
  stateDir: string,
  io: CrewStateFileIo = fsCrewStateFileIo,
): string[] {
  const lines: string[] = [];
  for (const move of crewStateFileMoves()) {
    const legacy = join(stateDir, move.legacy);
    if (!io.exists(legacy)) continue;
    const current = join(stateDir, move.current);
    if (io.exists(current)) {
      lines.push(
        `[crew] both ${move.current} and ${move.legacy} exist in ${stateDir}. ${move.current} is the one ` +
          `being read; ${move.legacy} is from 1.7.0 and is being left alone. Delete it once you are sure.`,
      );
      continue;
    }
    try {
      io.rename(legacy, current);
      lines.push(`[crew] renamed ${move.legacy} to ${move.current} in ${stateDir} (1.7.0 name, gone in 1.9.0).`);
    } catch (err) {
      lines.push(
        `[crew] could not rename ${move.legacy} to ${move.current} in ${stateDir}: ` +
          `${err instanceof Error ? err.message : String(err)}. Move it by hand.`,
      );
    }
  }
  return lines;
}
