import { homedir } from "node:os";

import type { ApiErrorBody } from "./error-codes.ts";
import { apiError } from "./error-codes.ts";
import type { JsonValue } from "./json.ts";
import type { WorktreeFolderSettingResponse } from "./types.ts";
import { isStorableFolder, type WorktreeFolderSettingSurface } from "./worktree-folder-setting.ts";
import {
  checkedParentDir,
  diskFolderFs,
  herdrWorktreeDir,
  readHerdrConfig,
  type FolderFs,
  type FolderRefusal,
  type HerdrConfigRead,
} from "./worktree-folder.ts";

// The two halves of the "Worktree folder" setting's routes, as plain answers (ADR 0093, note of
// 2026-11-13). `GET /api/worktree/folder` reads, `POST /api/worktree/folder/set` writes; the gates, the
// `?host=` forward and the audit line are server.ts's (`serveWorktreeFolderRoute`).

/** What the two halves read beyond the store. Every field defaults for a test. */
export interface WorktreeFolderDeps {
  home?: string;
  fs?: FolderFs;
  readHerdrConfig?: HerdrConfigRead;
}

/** The refusal's answer body: the catalogued sentence for the code, naming the folder. */
function refusalBody(code: FolderRefusal, dir: string): ApiErrorBody {
  return apiError(code, { path: dir });
}

/**
 * What the setting is now: the stored string, whether it passes the rule right now, and the folder
 * the default falls back to when it is unset. The rule runs here on every read, never from a cache,
 * so a folder that became a link shows its problem the next time Settings opens.
 */
export async function worktreeFolderAnswer(
  setting: WorktreeFolderSettingSurface,
  deps: WorktreeFolderDeps = {},
): Promise<WorktreeFolderSettingResponse> {
  const home = deps.home ?? homedir();
  const fallback = herdrWorktreeDir(await (deps.readHerdrConfig ?? readHerdrConfig)(), home);
  const dir = setting.get();
  if (dir === undefined) return { ok: true, dir: null, fallback };
  const checked = await checkedParentDir(dir, home, deps.fs ?? diskFolderFs);
  if (checked.ok) return { ok: true, dir, path: checked.path, fallback };
  return { ok: true, dir, problem: refusalBody(checked.code, dir), fallback };
}

/** The setting's write: `{ dir: string | null }`. `null` clears it. `undefined` when the body is not that. */
export function parseWorktreeFolderBody(raw: JsonValue | undefined): { dir: string | null } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  if (raw.dir === null) return { dir: null };
  return isStorableFolder(raw.dir) ? { dir: raw.dir.trim() } : undefined;
}

/**
 * Save or clear the setting. A folder that fails the rule (rules 1 to 5 of ADR 0093) is refused and
 * nothing is stored. A write that fails on disk leaves the old value, and `saved` is false. Answers the
 * same body as the read.
 */
export async function saveWorktreeFolder(
  setting: WorktreeFolderSettingSurface,
  body: { dir: string | null },
  deps: WorktreeFolderDeps = {},
): Promise<{ saved: boolean; answer: WorktreeFolderSettingResponse | { ok: false } & ApiErrorBody }> {
  if (body.dir !== null) {
    const checked = await checkedParentDir(body.dir, deps.home, deps.fs ?? diskFolderFs);
    if (!checked.ok) return { saved: false, answer: { ok: false, ...refusalBody(checked.code, body.dir) } };
  }
  const saved = await setting.set(body.dir);
  return { saved, answer: await worktreeFolderAnswer(setting, deps) };
}
