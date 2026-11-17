import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { rulesTextProblems, TRICKS_WINDOWS_SHELL_LINE, type OfficialState, type OfficialTricksReply, type TricksRunsOn } from "../../web/src/lib/tricks/schema.ts";
import { forgetLeftovers } from "./approved.ts";
import { isCodePath, officialExtrasHash, trickCodeHash } from "./code-hash.ts";
import { fetchSource, FetchRefused, FetchSlot, readCandidate, writeCandidateFiles, type Candidate, type FetchOptions, type GitRunner } from "./fetch.ts";
import { officialStanding, officialStateOf, officialWire, pinnedPlaces, shippedOfficialList, type OfficialEntry, type OfficialStanding } from "./official.ts";
import type { RepoFactsPort } from "./repo-facts.ts";
import { renderOrigin } from "./origin.ts";
import { tricksConfigDir, tricksStateDir } from "./paths.ts";
import { replaceCode, writeNewTrick, type ProposalWrite } from "./proposal-install.ts";

// ADDING A TRICK FROM THE FROM COLLIE LIST (M94). The only network use of the feature, and only on the
// person's tap: `POST /api/tricks/official/<id>/add` (or `/update`), write-gated like the trick switch
// (routes.ts `TRICKS_ROUTE_RIGHTS.officialAdd`: a paired phone's device key with the write right; the host's
// own read credential, an agent's CLI and the walky socket never reach it). No fetch at start, none in the
// background, no telemetry.
//
//   1. FETCH exactly the listed commit from the listed repository, with the hardened fetch `collie trick add`
//      runs (fetch.ts), into a fresh temp folder under the state folder, plus {@link OFFICIAL_GIT}: no
//      redirect followed, no credential helper, and no global git config read (`GIT_CONFIG_GLOBAL` is the
//      null device), so nothing of the operator's or the repository's config steers it. The temp repository
//      may hold at most {@link OFFICIAL_FETCH_BYTES_MAX}: it is measured while git runs and once after, and
//      past it the fetch (git's whole process group) is killed and refused as `too-large`, before anything
//      is read from it. The commit git resolved must be the listed one.
//   2. READ the one folder by fetch.ts `readCandidate`: no link, no submodule, regular files only, 300 files,
//      5 MB, 8 levels, safe names, a manifest the strict reader takes, and its id must be the entry's.
//      The files beside the code that an add installs (`config.toml`, `media/`) must hash to the entry's
//      `extras` (code-hash.ts `officialExtrasHash`); any other file the code hash leaves out refuses it.
//   3. HASH what would land: the files are written into a staged sibling in the tricks folder and hashed by
//      code-hash.ts `trickCodeHash`, the hash a switch approves. Another hash than the list's removes the
//      stage and answers "The code did not match. Nothing was added."
//   4. INSTALL by one rename (proposal-install.ts `writeNewTrick`), never over a folder of that name, with the
//      origin record `{ url, ref: commit, commit, subdir, at, official: true }`, SWITCHED OFF: a switch entry
//      left for that id is written off first. No approved copy is made: the switch makes it, as for any trick.
//
// UPDATE (state `update`: the folder came from this repository and folder at another commit, older or newer)
// runs 1 to 2 the same way, then replaces ONLY the folder's code (proposal-install.ts `replaceCode`, the rule
// of a proposal's version write): each file the code hash walks is written or removed, held to the list's
// hash before anything changes. Every other entry of the folder, at any depth (`config.toml`, `media/`,
// `captures/`, `inputs/`, logs, dot files, a file Collie does not know), stays where it is, untouched; the
// new version's own config.toml and pictures are not taken. A code edit the person made in the folder is
// replaced. When the new code needs a name the person's own files hold (a file of theirs where it puts a
// folder, or a folder with their files where it puts a file), nothing changes and the answer is `blocked`.
// A trick that is off runs nothing, so that is all.
// A trick that is on keeps running its approved copy: its folder now differs from it, so the runner's own
// new version path takes it (a pending copy and the card on the Hill, or `auto` when the person chose it).
// There is no second consent path.
//
// One fetch at a time per bridge (fetch.ts `FetchSlot`, shared with a repository's index): a second one while one runs answers `busy`. Every git run ends by the
// deadline {@link OFFICIAL_ADD_TIMEOUT_MS} after the tap. The temp folder and any stage go on every path.
// The write itself runs in the tricks runner's serial lane (service.ts `officialLane`), so no switch write
// or version change runs beside it.

/** The whole add or update, fetch included, from the tap. */
export const OFFICIAL_ADD_TIMEOUT_MS = 120_000;

/**
 * The most bytes an official fetch may bring into its temp repository: one commit at depth 1. The tricks
 * themselves are capped at 5 MB (fetch.ts `ADD_LIMITS.bytes`); the rest is room for the other folders of
 * the repository at that commit.
 */
export const OFFICIAL_FETCH_BYTES_MAX = 20 * 1024 * 1024;

/** The name every official temp folder under `<stateDir>/tricks/` starts with. */
export const OFFICIAL_FETCH_PREFIX = ".fetch-official-";

/** The `-c` settings an official fetch adds to fetch.ts's hardening. */
export const OFFICIAL_GIT: readonly string[] = ["http.followRedirects=false", "credential.helper="];

/** The plain refusals, as the bridge says them; the phone says them in its own words by `error`. */
export const OFFICIAL_LINES = {
  unreachable: "GitHub did not answer. Nothing was added.",
  mismatch: "The code did not match. Nothing was added.",
  updateUnreachable: "GitHub did not answer. Nothing was changed.",
  updateMismatch: "The code did not match. Nothing was changed.",
  blocked: "Your own files block it. Nothing was changed.",
  changed: "You edited its files. Update it on the machine.",
  busy: "Collie is adding another trick. Try again in a moment.",
  taken: "A trick with this name is already here.",
  added: "This trick is already added.",
  noUpdate: "There is no newer version of this trick to take.",
  notAdded: "This trick is not added yet.",
} as const;

/** What the add and update routes answer. */
export type OfficialAnswer =
  | { status: 200; body: { id: string; state: OfficialState } }
  | { status: 400; body: { error: "official-invalid" } }
  | { status: 404; body: { error: "unknown-official" } }
  | { status: 409; body: { error: "runs-on" | "windows" | "windows-shell" | "tricks-off" | "busy" | "taken" | "added" | "no-update" | "not-added" | "blocked" | "changed"; message: string } }
  | { status: 422; body: { error: "mismatch" | "too-large"; message: string } }
  | { status: 502; body: { error: "unreachable"; message: string } }
  | { status: 500; body: { error: "failed"; message: string } };

/** What the server needs of the list. */
export interface OfficialTricksSurface {
  /** `GET /api/tricks/official`. */
  reply(): Promise<OfficialTricksReply>;
  /** `POST /api/tricks/official/<id>/add` and `/update`. */
  install(id: string, mode: "add" | "update"): Promise<OfficialAnswer>;
}

export interface OfficialTricksDeps {
  configDir: string;
  stateDir: string;
  /** The unit's environment; a git run gets it without any `GIT_*` (fetch.ts `gitRunEnv`). */
  env: Record<string, string | undefined>;
  /** The list. Default: the one this binary carries. */
  entries?: () => readonly OfficialEntry[];
  /** Where tricks run when this bridge runs none (service.ts `runsOn`): then the list is empty and nothing is added. */
  runsOn?: () => TricksRunsOn | null;
  /** The Windows gate's line (service.ts `gateLine`), or null where tricks run: then the list is empty and nothing is fetched. */
  gate?: () => string | null;
  /**
   * The line while tricks as a whole are switched off (service.ts `offLine`), or null while they are on: then
   * the list stays readable and an add or an update is refused before anything is fetched.
   */
  offLine?: () => string | null;
  /** An add forgets what an earlier trick of that id left beside its files: its agent views and Hill keys (approved.ts `forgetLeftovers`). Absent: none held. */
  forgetTrick?: (id: string) => void | Promise<void>;
  /** The platform: on Windows an entry marked `posix` (a shell run line) is not added. Default `HOST.platform` (bridge/host.ts). */
  platform?: NodeJS.Platform;
  /** Run a write in the tricks runner's serial lane and wait for its next scan (service.ts `officialLane`). Absent: run it as it is. */
  lane?: <T>(work: () => Promise<T>) => Promise<T>;
  /** One audit line per add and update. */
  audit?: (entry: { action: string; detail: Record<string, string> }) => void;
  /** The list's repository facts (repo-facts.ts): a read of the list asks for the stale ones and carries what is cached. Absent: none. */
  repoFacts?: RepoFactsPort;
  warn?: (line: string) => void;
  now?: () => number;
  /** The bridge's one fetch slot, shared with a repository's index (repo-index.ts). Absent: a slot of its own. */
  slot?: FetchSlot;
  /** TEST SEAM: the git runner, a `file://` source, a shorter deadline, a lower byte cap. The bridge never sets them. */
  git?: GitRunner;
  allowFile?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/** A refusal of one step, as a route answers it. */
class Stop extends Error {
  constructor(readonly answer: OfficialAnswer) {
    super("stop");
  }
}

/**
 * Fetch one entry's commit into `fetchDir` and read its folder: the listed commit and the entry's id, or a
 * {@link FetchRefused} (`fetch` when git could not reach the source, `check` for anything that came back
 * wrong, `local` for Collie's own temp repository). Shared with the maintainer script.
 */
export async function fetchOfficial(entry: Pick<OfficialEntry, "id" | "repo" | "dir" | "commit">, fetchDir: string, opts: FetchOptions): Promise<Candidate> {
  const fetched = await fetchSource({ url: entry.repo, ref: entry.commit }, fetchDir, opts);
  if (fetched.commit !== entry.commit) throw new FetchRefused(`the repository answered with commit ${fetched.commit.slice(0, 12)}, not ${entry.commit.slice(0, 12)}`);
  const candidate = await readCandidate(fetched, entry.dir);
  if (candidate.id !== entry.id) throw new FetchRefused(`the folder ${entry.dir} holds the trick ${candidate.id}, not ${entry.id}`);
  return candidate;
}

/**
 * The sha256 of the instructions a candidate gives its agents, by the manifest's own rules for the file
 * (schema.ts `rulesTextProblems`), null when its manifest names none. Shared with the maintainer script.
 */
export function candidateRules(candidate: Pick<Candidate, "manifest" | "files">): { ok: true; sha256: string | null } | { ok: false; reason: string } {
  const file = candidate.manifest.rules;
  if (file === undefined) return { ok: true, sha256: null };
  const bytes = candidate.files.find((f) => f.rel === file)?.bytes;
  if (bytes === undefined) return { ok: false, reason: `${file} is not in the folder` };
  const problem = rulesTextProblems(bytes, file)[0];
  if (problem !== undefined) return { ok: false, reason: problem.reason };
  return { ok: true, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

/** The code hash a candidate's files have once written: written into `dir` (a fresh folder) and hashed, as an install hashes its stage. */
export async function candidateHash(candidate: Candidate, dir: string): Promise<string> {
  await writeCandidateFiles(dir, candidate.files);
  const hashed = await trickCodeHash(dir);
  if (!hashed.ok) throw new FetchRefused(hashed.reason);
  return hashed.hash;
}

/**
 * An empty folder for one fetch to call its home: `home` inside the fetch's temp folder, so it goes with it.
 * git reads `~/.netrc` through curl, and a login the operator keeps for one of the three hosts would go to
 * that host on a phone fetch or an official add; with HOME and CURL_HOME here there is nothing to read.
 */
export async function fetchHome(fetchDir: string): Promise<string> {
  const home = join(fetchDir, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * The fetch options of an official fetch: the hardening, {@link OFFICIAL_GIT}, no global config, the deadline,
 * and `home` (from {@link fetchHome}) as the home of every git run, so no `~/.netrc`, no XDG config and no
 * user config is read.
 */
export function officialFetchOptions(deps: Pick<OfficialTricksDeps, "env" | "git" | "allowFile" | "now" | "maxBytes">, deadline: number, home: string): FetchOptions {
  const opts: FetchOptions = {
    env: deps.env,
    allowFile: deps.allowFile === true,
    extraConfig: OFFICIAL_GIT,
    extraEnv: { GIT_CONFIG_GLOBAL: devNull, HOME: home, CURL_HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
    deadline,
    maxBytes: deps.maxBytes ?? OFFICIAL_FETCH_BYTES_MAX,
  };
  if (deps.git !== undefined) opts.git = deps.git;
  if (deps.now !== undefined) opts.now = deps.now;
  return opts;
}

export class OfficialTricks implements OfficialTricksSurface {
  private warned = false;
  private readonly slot: FetchSlot;

  constructor(private readonly deps: OfficialTricksDeps) {
    this.slot = deps.slot ?? new FetchSlot();
  }

  /** The list, or none with the reason said once when the list this binary carries was refused. */
  private entries(): readonly OfficialEntry[] {
    if (this.deps.entries !== undefined) return this.deps.entries();
    const list = shippedOfficialList();
    if (list.ok) return list.entries;
    if (!this.warned) (this.deps.warn ?? ((line) => console.warn(`[tricks] ${line}`)))(`the official list is refused, so it offers nothing: ${list.reason}`);
    this.warned = true;
    return [];
  }

  /**
   * Remove the temp folders a bridge that stopped mid-fetch left under `<stateDir>/tricks/` (a crash, a kill,
   * a power cut). Run once at bridge start; while an add or update runs it leaves its folder alone. Only names
   * that start with {@link OFFICIAL_FETCH_PREFIX}; `rm` removes a link itself, never what it points at.
   */
  async sweep(): Promise<number> {
    if (this.slot.busy) return 0;
    const root = tricksStateDir(this.deps.stateDir);
    const names = await readdir(root).catch(() => []);
    const stale = names.filter((name) => name.startsWith(OFFICIAL_FETCH_PREFIX));
    for (const name of stale) await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
    return stale.length;
  }

  async reply(): Promise<OfficialTricksReply> {
    if ((this.deps.gate?.() ?? null) !== null) return { tricks: [], gate: "windows" };
    const runsOn = this.deps.runsOn?.() ?? null;
    if (runsOn !== null) return { tricks: [], runsOn };
    const entries = this.entries();
    const tricks = await officialWire(this.deps.configDir, entries);
    const facts = this.deps.repoFacts;
    if (facts === undefined) return { tricks };
    // The repository's stars and last commit from the cache; a stale one is read in the background, never waited for.
    facts.want(new Set(entries.map((e) => e.repo)));
    for (const wire of tricks) {
      const known = facts.facts(wire.repo);
      if (known !== undefined) wire.repoFacts = known;
    }
    return { tricks };
  }

  async install(id: string, mode: "add" | "update"): Promise<OfficialAnswer> {
    const gate = this.deps.gate?.() ?? null;
    if (gate !== null) return { status: 409, body: { error: "windows", message: gate } };
    const off = this.deps.offLine?.() ?? null;
    if (off !== null) return { status: 409, body: { error: "tricks-off", message: off } };
    const runsOn = this.deps.runsOn?.() ?? null;
    if (runsOn !== null) return { status: 409, body: { error: "runs-on", message: "This machine runs no tricks: the lead of its crew does." } };
    const entry = this.entries().find((e) => e.id === id);
    if (entry === undefined) return { status: 404, body: { error: "unknown-official" } };
    // Fault d: a POSIX trick (a shell run line) never runs on Windows, so its add fetches nothing there.
    if (entry.posix === true && (this.deps.platform ?? HOST.platform) === "win32") return { status: 409, body: { error: "windows-shell", message: TRICKS_WINDOWS_SHELL_LINE } };
    if (!this.slot.take()) return { status: 409, body: { error: "busy", message: OFFICIAL_LINES.busy } };
    let fetchDir: string | null = null;
    try {
      const wrong = stateRefusal(await officialStanding(this.deps.configDir, entry), mode);
      if (wrong !== null) return wrong;
      const now = this.deps.now ?? Date.now;
      const deadline = now() + (this.deps.timeoutMs ?? OFFICIAL_ADD_TIMEOUT_MS);
      const root = tricksStateDir(this.deps.stateDir);
      await mkdir(root, { recursive: true, mode: 0o700 });
      fetchDir = await mkdtemp(join(root, OFFICIAL_FETCH_PREFIX));
      const candidate = await this.fetch(entry, fetchDir, mode, deadline);
      if (now() > deadline) return unreachable(mode);
      const lane = this.deps.lane ?? (async <T>(work: () => Promise<T>) => await work());
      return await lane(async () => await this.write(entry, candidate, mode));
    } catch (err) {
      if (err instanceof Stop) return err.answer;
      const message = err instanceof Error ? err.message : String(err);
      this.deps.warn?.(`${id}: the official ${mode} failed: ${message}`);
      return { status: 500, body: { error: "failed", message: `The trick could not be ${mode === "add" ? "added" : "updated"}. Nothing was changed.` } };
    } finally {
      if (fetchDir !== null) await rm(fetchDir, { recursive: true, force: true }).catch(() => {});
      this.slot.free();
    }
  }

  /** Steps 1 and 2: the fetch and the folder, each refusal as its answer. */
  private async fetch(entry: OfficialEntry, fetchDir: string, mode: "add" | "update", deadline: number): Promise<Candidate> {
    let candidate: Candidate;
    try {
      candidate = await fetchOfficial(entry, fetchDir, officialFetchOptions(this.deps, deadline, await fetchHome(fetchDir)));
    } catch (err) {
      if (!(err instanceof FetchRefused)) throw err;
      this.deps.warn?.(`${entry.id}: the official fetch was refused (${err.step}): ${err.message}`);
      if (err.step === "fetch") throw new Stop(unreachable(mode));
      if (err.step === "local") throw err;
      // More than a listed commit can be: the same answer class as a mismatch, with its own code.
      if (err.step === "size") throw new Stop({ status: 422, body: { error: "too-large", message: mode === "add" ? OFFICIAL_LINES.mismatch : OFFICIAL_LINES.updateMismatch } });
      throw new Stop(mismatch(mode));
    }
    // The instructions the trick gives its agents must be the ones the list pins (review 8 V-N3): the phone
    // said "gives instructions" or not from the list alone, so a folder that differs installs nothing.
    const rules = candidateRules(candidate);
    if (!rules.ok || rules.sha256 !== entry.rules) {
      this.deps.warn?.(`${entry.id}: the official ${mode} was refused: ${rules.ok ? "the rules differ from the list's" : rules.reason}`);
      throw new Stop(mismatch(mode));
    }
    // The places too (contract 2, the menu place): the phone said "Adds rows to a session's settings." or
    // not from the list alone, so a folder whose manifest lists other places installs nothing.
    const places = pinnedPlaces(candidate.manifest);
    if (JSON.stringify(places) !== JSON.stringify(entry.places)) {
      this.deps.warn?.(`${entry.id}: the official ${mode} was refused: the places differ from the list's`);
      throw new Stop(mismatch(mode));
    }
    // And `decides`: the phone said "Uses agent tokens" or not from the list alone (a pin always follows the
    // code hash, so this only stops a list written by hand).
    if (candidate.manifest.decides !== entry.decides) {
      this.deps.warn?.(`${entry.id}: the official ${mode} was refused: decides differs from the list's`);
      throw new Stop(mismatch(mode));
    }
    // An add writes config.toml and media/ too, which the code hash leaves out: the extras hash pins them.
    // An update takes only code, so it has nothing of them to check.
    if (mode === "add") {
      const extras = officialExtrasHash(candidate.files);
      if (!extras.ok || extras.hash !== entry.extras) {
        this.deps.warn?.(`${entry.id}: the official add was refused: ${extras.ok ? "the extras hash differs from the list's" : `${extras.rel} is neither code, config.toml nor under media/`}`);
        throw new Stop(mismatch(mode));
      }
    }
    return candidate;
  }

  /** Steps 3 and 4, in the runner's lane: the state again, then the staged write held to the list's hash. */
  private async write(entry: OfficialEntry, candidate: Candidate, mode: "add" | "update"): Promise<OfficialAnswer> {
    // Again in the lane, the code hash included: a file changed during the fetch stops the update here.
    const again = stateRefusal(await officialStanding(this.deps.configDir, entry), mode);
    if (again !== null) return again;
    const root = tricksConfigDir(this.deps.configDir);
    const at = new Date((this.deps.now ?? Date.now)()).toISOString();
    const originText = renderOrigin({ url: entry.repo, ref: entry.commit, commit: entry.commit, subdir: entry.dir, at, official: true });
    let written: ProposalWrite;
    if (mode === "add") {
      // Added means switched off: a switch entry a removed folder left behind for this id goes first.
      await forgetLeftovers({ stateDir: this.deps.stateDir, configDir: this.deps.configDir, id: entry.id, at, forget: this.deps.forgetTrick });
      written = await writeNewTrick(root, entry.id, candidate.files, originText, { expect: entry.hash });
    } else {
      // Only code moves (the proposal version write's rule): the new version's config.toml, pictures and
      // other files the hash does not read are left out, and the person's stay where they are.
      written = await replaceCode(root, entry.id, candidate.files.filter((file) => isCodePath(file.rel)), originText, { expect: entry.hash });
    }
    if (!written.ok && written.code === "mismatch") return mismatch(mode);
    if (!written.ok && written.code === "exists") return { status: 409, body: { error: "taken", message: OFFICIAL_LINES.taken } };
    if (!written.ok && written.code === "blocked") return { status: 409, body: { error: "blocked", message: OFFICIAL_LINES.blocked } };
    if (!written.ok) {
      this.deps.warn?.(`${entry.id}: the official ${mode} could not write: ${written.reason}`);
      return { status: 500, body: { error: "failed", message: `The trick could not be ${mode === "add" ? "added" : "updated"}. Nothing was changed.` } };
    }
    this.deps.audit?.({ action: `trick.official.${mode}`, detail: { trick: entry.id, commit: entry.commit.slice(0, 12), hash: written.codeHash.slice(0, 16) } });
    return { status: 200, body: { id: entry.id, state: await officialStateOf(this.deps.configDir, entry) } };
  }
}

function unreachable(mode: "add" | "update"): OfficialAnswer {
  return { status: 502, body: { error: "unreachable", message: mode === "add" ? OFFICIAL_LINES.unreachable : OFFICIAL_LINES.updateUnreachable } };
}

function mismatch(mode: "add" | "update"): OfficialAnswer {
  return { status: 422, body: { error: "mismatch", message: mode === "add" ? OFFICIAL_LINES.mismatch : OFFICIAL_LINES.updateMismatch } };
}

/** Why an entry standing so cannot take `mode`, or null when it can: add needs `absent`, update needs `update`. */
function stateRefusal(standing: OfficialStanding, mode: "add" | "update"): OfficialAnswer | null {
  const { state } = standing;
  // A version of the list whose files the person changed: Collie never moves or removes them.
  if (standing.changed) return { status: 409, body: { error: "changed", message: OFFICIAL_LINES.changed } };
  if (state === "taken") return { status: 409, body: { error: "taken", message: OFFICIAL_LINES.taken } };
  if (mode === "add" && state === "absent") return null;
  if (mode === "update" && state === "update") return null;
  if (state === "added") return { status: 409, body: { error: mode === "add" ? "added" : "no-update", message: mode === "add" ? OFFICIAL_LINES.added : OFFICIAL_LINES.noUpdate } };
  if (state === "update") return { status: 409, body: { error: "added", message: OFFICIAL_LINES.added } };
  return { status: 409, body: { error: "not-added", message: OFFICIAL_LINES.notAdded } };
}
