import { lstat, mkdir, readdir, readlink, realpath, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { AccountShare } from "./account-adapters.ts";

// ── The links of a `shared` account (M101 README decisions 3 and 4, ADR 0141) ──────────────────
//
// A shared account is a new folder that links the default folder's setup and history, so only the
// login and the agent's per-account state are its own. The rules, each one a refusal to guess:
//
//   • A link is made only where the account folder has NOTHING at that name.
//   • A real file or folder there is never replaced; a link there that points elsewhere is never
//     re-pointed. Both are reported as "unlinked" and left for the person.
//   • Every link points at the REAL entry (the real path of the default's entry), so a chain is at most
//     one level. A link that would make a chain of two is not made either: it is reported.
//   • Nothing is ever unlinked, renamed or deleted.
//   • A linkable FOLDER the default lacks is created there, empty, 0700, and then linked. A linkable
//     FILE the default lacks is skipped: there is nothing to share yet.
//
// The pass is idempotent and also runs before each start with the account, so an entry that appeared
// in the default later gets its link. The planner is pure; the executor takes an injected disk, so the
// tests run on a temp folder.

/** What a name in the DEFAULT folder resolves to, following links. `real` is its real path. */
export type DefaultEntry = { kind: "missing" } | { kind: "dir" | "file"; real: string } | { kind: "other" };

/** What sits at a name in the ACCOUNT folder, without following a link. */
export type AccountEntry = { kind: "missing" } | { kind: "link"; target: string } | { kind: "dir" | "file" | "other" };

export type LinkAction = { op: "mkdir"; path: string } | { op: "link"; at: string; target: string; name: string };

export interface LinkPlan {
  actions: LinkAction[];
  /** Names that should be links and are not, and that this pass will not change. */
  unlinked: string[];
}

export interface PlanInput {
  /** The default folder's real path. */
  defaultReal: string;
  accountDir: string;
  share: AccountShare;
  defaults: Readonly<Record<string, DefaultEntry>>;
  account: Readonly<Record<string, AccountEntry>>;
}

/** The pass, as a list of actions. Pure. */
export function planLinks(input: PlanInput): LinkPlan {
  const actions: LinkAction[] = [];
  const unlinked: string[] = [];
  const consider = (name: string, folder: boolean): void => {
    const def = input.defaults[name] ?? { kind: "missing" };
    const here = input.account[name] ?? { kind: "missing" };
    let target: string;
    let makeDefault = false;
    if (def.kind === "missing") {
      if (!folder) return;
      target = join(input.defaultReal, name);
      makeDefault = true;
    } else if (def.kind === (folder ? "dir" : "file")) {
      target = def.real;
    } else {
      unlinked.push(name);
      return;
    }
    if (here.kind === "link") {
      if (here.target !== target) {
        unlinked.push(name);
        return;
      }
      // The right link to a folder the default lost: make the folder again, never the link.
      if (makeDefault) actions.push({ op: "mkdir", path: target });
      return;
    }
    if (here.kind !== "missing") {
      unlinked.push(name);
      return;
    }
    if (makeDefault) actions.push({ op: "mkdir", path: target });
    actions.push({ op: "link", at: join(input.accountDir, name), target, name });
  };
  for (const name of input.share.dirs) consider(name, true);
  for (const name of input.share.files) consider(name, false);
  return { actions, unlinked };
}

/** The disk the executor and the folder preparation use. */
export interface LinkDisk {
  /** What sits at `path` without following a link. */
  kindOf(path: string): Promise<"missing" | "dir" | "file" | "link" | "other">;
  /** What `path` resolves to, following links. */
  resolvedKind(path: string): Promise<"missing" | "dir" | "file" | "other">;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string | null>;
  /** One folder, owner-only. Fails when anything is there. */
  mkdir(path: string): Promise<void>;
  /** `mkdir -p`, owner-only. */
  mkdirp(path: string): Promise<void>;
  symlink(target: string, at: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

/** The real disk. */
export const realLinkDisk: LinkDisk = {
  async kindOf(path) {
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) return "link";
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    } catch {
      return "missing";
    }
  },
  async resolvedKind(path) {
    try {
      const st = await stat(path);
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    } catch (err) {
      // A dangling link is something, not nothing: it is never treated as a free name.
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        try {
          await lstat(path);
          return "other";
        } catch {
          return "missing";
        }
      }
      return "other";
    }
  },
  readlink: (path) => readlink(path),
  realpath: (path) => realpath(path).catch(() => null),
  mkdir: async (path) => {
    await mkdir(path, { mode: 0o700 });
  },
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  symlink: (target, at) => symlink(target, at),
  readdir: (path) => readdir(path),
};

/** What one pass did: the names linked now, and the names that should be links and are not. */
export interface LinkOutcome {
  linked: string[];
  unlinked: string[];
}

/** Read both folders for the names `share` lists. */
async function readEntries(disk: LinkDisk, defaultDir: string, accountDir: string, share: AccountShare): Promise<Pick<PlanInput, "defaults" | "account">> {
  const defaults: Record<string, DefaultEntry> = {};
  const account: Record<string, AccountEntry> = {};
  for (const name of [...share.dirs, ...share.files]) {
    const at = join(defaultDir, name);
    const kind = await disk.resolvedKind(at);
    if (kind === "dir" || kind === "file") {
      const real = await disk.realpath(at);
      defaults[name] = real === null ? { kind: "other" } : { kind, real };
    } else {
      defaults[name] = { kind };
    }
    const here = join(accountDir, name);
    const own = await disk.kindOf(here);
    if (own === "link") {
      const raw = await disk.readlink(here).catch(() => null);
      account[name] = raw === null ? { kind: "other" } : { kind: "link", target: isAbsolute(raw) ? raw : resolve(dirname(here), raw) };
    } else {
      account[name] = { kind: own };
    }
  }
  return { defaults, account };
}

/** The plan for the folders as they are now, with no change made. For the page's `unlinked`. */
export async function inspectLinks(disk: LinkDisk, defaultDir: string, accountDir: string, share: AccountShare): Promise<LinkPlan> {
  const defaultReal = (await disk.realpath(defaultDir)) ?? defaultDir;
  return planLinks({ defaultReal, accountDir, share, ...(await readEntries(disk, defaultDir, accountDir, share)) });
}

/**
 * Run the pass. A failed action does not stop the others: its name joins `unlinked`. The default
 * folder itself is made (0700) when it does not exist yet, as the agent would make it.
 */
export async function runLinkPass(disk: LinkDisk, defaultDir: string, accountDir: string, share: AccountShare): Promise<LinkOutcome> {
  if ((await disk.kindOf(defaultDir)) === "missing") await disk.mkdirp(defaultDir);
  const plan = await inspectLinks(disk, defaultDir, accountDir, share);
  const linked: string[] = [];
  const unlinked = [...plan.unlinked];
  const failedDirs = new Set<string>();
  for (const action of plan.actions) {
    if (action.op === "mkdir") {
      try {
        await disk.mkdir(action.path);
      } catch {
        // Made by someone else in between is fine; anything else shows on the link below.
        if ((await disk.resolvedKind(action.path)) !== "dir") failedDirs.add(action.path);
      }
      continue;
    }
    if (failedDirs.has(action.target)) {
      unlinked.push(action.name);
      continue;
    }
    try {
      await disk.symlink(action.target, action.at);
      linked.push(action.name);
    } catch {
      unlinked.push(action.name);
    }
  }
  return { linked, unlinked };
}

export type PrepareOutcome = { ok: true } | { ok: false; problem: "not empty" | "not a folder" | "could not be made"; detail?: string };

/**
 * Make or accept the folder of a NEW shared account: it must not exist (then it is made, 0700), or be
 * an empty folder, or be a folder an earlier shared create made (one of its shared names already links
 * to the right place). Anything else is refused and nothing is written.
 */
export async function prepareSharedFolder(disk: LinkDisk, defaultDir: string, accountDir: string, share: AccountShare): Promise<PrepareOutcome> {
  const kind = await disk.kindOf(accountDir);
  if (kind === "missing") {
    try {
      await disk.mkdir(accountDir);
      return { ok: true };
    } catch (err) {
      return { ok: false, problem: "could not be made", detail: err instanceof Error ? err.message : String(err) };
    }
  }
  if (kind !== "dir") return { ok: false, problem: "not a folder" };
  const names = await disk.readdir(accountDir);
  if (names.length === 0) return { ok: true };
  const defaultReal = (await disk.realpath(defaultDir)) ?? defaultDir;
  const { defaults, account } = await readEntries(disk, defaultDir, accountDir, share);
  for (const name of [...share.dirs, ...share.files]) {
    const here = account[name];
    const def = defaults[name];
    if (here?.kind !== "link") continue;
    const target = def !== undefined && (def.kind === "dir" || def.kind === "file") ? def.real : join(defaultReal, name);
    if (here.target === target) return { ok: true };
  }
  return { ok: false, problem: "not empty" };
}
