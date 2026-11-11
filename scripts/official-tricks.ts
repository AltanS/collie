#!/usr/bin/env bun
// THE FROM COLLIE LIST, KEPT IN STEP WITH THE TRICKS REPOSITORY (bridge/tricks/official.ts).
//
//   bun scripts/official-tricks.ts --repo-dir <checkout> --commit <40 hex> [--check] [--file <list.json>]
//
// For each entry of the list, it fetches `<commit>` from the local checkout of the tricks repository with
// the bridge's own hardened fetch (bridge/tricks/fetch.ts, through `fetchOfficial`), reads the entry's
// folder by the same rules an add uses, writes its files into a temp folder and takes their code hash with
// the REAL hash function (bridge/tricks/code-hash.ts `trickCodeHash`). So the hash in the list is the one a
// person's bridge computes before it installs the trick, and the one its switch then approves.
//
// Then it writes the list back with that commit and those hashes, and with each manifest's `name` and
// `contract`. An entry's `description` is the manifest's when it has one, else the list's own line stays.
// The entries, their ids, repositories and folders are the list's: the script adds and removes none.
// When an entry moves to another commit, its old commit and hash go first into `previous` (at most
// `OFFICIAL_PREVIOUS_MAX`, newest first, the oldest dropped): a folder a person added from an earlier
// release is still from the list, so its row offers Update and its hash is one Collie wrote.
//
// `--check` writes nothing and exits 1 when the list differs from what it would write (a stale commit, a
// stale hash, a renamed trick), printing each difference. `--file` names another list (the tests' temp
// copy); the default is bridge/tricks/official.json.
//
// The fetch holds the bridge's own byte cap (`OFFICIAL_FETCH_BYTES_MAX`), so a list never names a commit the
// bridge would refuse as too large. The checkout is read through git only (`file://`), never its working tree: an edit not committed never
// reaches a hash. Nothing here reaches the network.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { candidateHash, fetchOfficial, OFFICIAL_FETCH_BYTES_MAX } from "../bridge/tricks/official-install.ts";
import { OFFICIAL_PREVIOUS_MAX, parseOfficialList, renderOfficialList, type OfficialEntry, type OfficialVersion } from "../bridge/tricks/official.ts";
import { parseJson } from "../web/src/lib/json.ts";

/** The list in this repository. */
export const LIST_FILE = join(import.meta.dir, "..", "bridge", "tricks", "official.json");

export interface OfficialRunOptions {
  repoDir: string;
  commit: string;
  check: boolean;
  file: string;
  env?: Record<string, string | undefined>;
}

export interface OfficialRun {
  /** 0 when the list is written or in step, 1 when `--check` found it stale or a trick could not be read, 2 for usage. */
  code: number;
  lines: string[];
}

/** One entry as the checkout has it at `commit`. */
async function refreshed(entry: OfficialEntry, opts: OfficialRunOptions): Promise<OfficialEntry> {
  const tmp = await mkdtemp(join(tmpdir(), "collie-official-"));
  try {
    const source = { ...entry, repo: `file://${resolve(opts.repoDir)}`, commit: opts.commit };
    const candidate = await fetchOfficial(source, join(tmp, ""), { env: opts.env ?? process.env, allowFile: true, maxBytes: OFFICIAL_FETCH_BYTES_MAX });
    const hash = await candidateHash(candidate, join(tmp, "stage"));
    const description = candidate.manifest.description ?? entry.description;
    return { ...entry, name: candidate.manifest.name, description, commit: opts.commit, hash, contract: candidate.manifest.contract, previous: rolled(entry, opts.commit) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** An entry's earlier versions once it moves to `commit`: the old current one first, `commit` itself never, capped. */
export function rolled(entry: Pick<OfficialEntry, "commit" | "hash" | "previous">, commit: string): OfficialVersion[] {
  const older = entry.commit === commit ? entry.previous : [{ commit: entry.commit, hash: entry.hash }, ...entry.previous];
  return older.filter((v, i) => v.commit !== commit && older.findIndex((w) => w.commit === v.commit) === i).slice(0, OFFICIAL_PREVIOUS_MAX);
}

/** The differences of two entries of one id, one line each. */
function differences(was: OfficialEntry, now: OfficialEntry): string[] {
  const keys = ["name", "description", "commit", "hash", "contract"] as const;
  const lines = keys.filter((key) => was[key] !== now[key]).map((key) => `${was.id}: ${key} is ${JSON.stringify(was[key])}, the checkout says ${JSON.stringify(now[key])}`);
  if (JSON.stringify(was.previous) !== JSON.stringify(now.previous)) lines.push(`${was.id}: previous would be ${String(now.previous.length)} versions, newest ${now.previous[0]?.commit.slice(0, 12) ?? "none"}`);
  return lines;
}

/** Read the list, refresh every entry from the checkout, then write it or check it. */
export async function runOfficial(opts: OfficialRunOptions): Promise<OfficialRun> {
  if (!/^[0-9a-f]{40}$/u.test(opts.commit)) return { code: 2, lines: ["error: --commit takes a full commit id, 40 hex digits"] };
  const text = await readFile(opts.file, "utf8").catch(() => null);
  if (text === null) return { code: 2, lines: [`error: cannot read ${opts.file}`] };
  const list = parseOfficialList(parseJson(text));
  if (!list.ok) return { code: 1, lines: [`error: the list is refused: ${list.reason}`] };
  const next: OfficialEntry[] = [];
  const lines: string[] = [];
  for (const entry of list.entries) {
    try {
      next.push(await refreshed(entry, opts));
    } catch (err) {
      return { code: 1, lines: [`error: ${entry.id}: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }
  const written = renderOfficialList(next);
  // The new text must pass the strict reader too: a manifest name past the cap, say, stops here.
  const again = parseOfficialList(parseJson(written));
  if (!again.ok) return { code: 1, lines: [`error: the refreshed list would be refused: ${again.reason}`] };
  for (const [i, entry] of list.entries.entries()) {
    const now = next[i];
    if (now !== undefined) lines.push(...differences(entry, now));
  }
  if (opts.check) {
    if (written === text) return { code: 0, lines: [`ok: ${opts.file} is in step with ${opts.commit.slice(0, 12)}`] };
    return { code: 1, lines: [...lines, `stale: ${opts.file} is not in step with ${opts.commit.slice(0, 12)}. Run without --check to write it.`] };
  }
  if (written !== text) await writeFile(opts.file, written);
  for (const entry of next) lines.push(`${entry.id}  ${entry.commit.slice(0, 12)}  ${entry.hash}`);
  lines.push(written === text ? `ok: ${opts.file} was already in step` : `wrote ${opts.file}`);
  return { code: 0, lines };
}

/** The flags, or a usage line. */
export function parseArgs(args: readonly string[]): { ok: true; opts: OfficialRunOptions } | { ok: false; usage: string } {
  const usage = "usage: bun scripts/official-tricks.ts --repo-dir <checkout> --commit <40 hex> [--check] [--file <list.json>]";
  const value = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args[at + 1];
  };
  const repoDir = value("--repo-dir");
  const commit = value("--commit");
  const file = value("--file") ?? LIST_FILE;
  if (repoDir === undefined || commit === undefined || repoDir.startsWith("-") || commit.startsWith("-") || file.startsWith("-")) return { ok: false, usage };
  return { ok: true, opts: { repoDir, commit, check: args.includes("--check"), file } };
}

async function main(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    console.error(parsed.usage);
    return 2;
  }
  const run = await runOfficial(parsed.opts);
  for (const line of run.lines) (run.code === 0 ? console.log : console.error)(line);
  return run.code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
