import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { REPO_INDEX_BYTES_MAX, REPO_INDEX_TIMEOUT_MS } from "../../web/src/lib/tricks/limits.ts";
import { parseRepoIndex, readPhoneSource, REPO_INDEX_FILE, type PhoneSource, type RepoAddReply, type RepoIndex, type RepoListReply } from "../../web/src/lib/tricks/repo-index.ts";
import { isTrickId, type TricksRunsOn } from "../../web/src/lib/tricks/schema.ts";
import { isRequestId, payloadDigest } from "../worktree-receipts.ts";
import { forgetLeftovers } from "./approved.ts";
import { fetchSource, FetchRefused, FetchSlot, readCandidate, type Candidate, type Fetched, type GitRunner } from "./fetch.ts";
import { fetchHome, officialFetchOptions } from "./official-install.ts";
import { renderOrigin } from "./origin.ts";
import { tricksConfigDir, tricksStateDir } from "./paths.ts";
import { writeNewTrick } from "./proposal-install.ts";
import { SeenWrites } from "./values.ts";

// A REPOSITORY'S INDEX ON THE PHONE (2026-11-17, package J): Settings, Tricks and the Hill, "Add a trick from a repository".
//
//   POST /api/tricks/repo/list  { rid, url }                  → RepoListReply, the index at the commit read
//   POST /api/tricks/repo/add   { rid, url, folder, commit }  → RepoAddReply, the trick added OFF
//
// Both are write-gated (routes.ts `TRICKS_ROUTE_RIGHTS.repoList` / `repoAdd`): a tap makes the bridge fetch.
// THE RULES, each in one place:
//   * HOSTS. The link must pass web/src/lib/tricks/repo-index.ts `readPhoneSource`: https, no user name or
//     password, no query, a host of `REPO_INDEX_HOSTS` written exactly (no port, lower case), so an IP
//     address, `localhost` and every other host answer `host` with `REPO_INDEX_TERMINAL_LINE`. Checked
//     before anything else is touched, and again by the fetch's own `https` only.
//   * THE FETCH is the official list's (official-install.ts `officialFetchOptions`): fetch.ts's hardening
//     (bare repository, no hooks, https only, depth 1), `http.followRedirects=false` (no redirect, so never
//     another host), `credential.helper=` and `GIT_CONFIG_GLOBAL` the null device (no operator git config),
//     the byte cap `OFFICIAL_FETCH_BYTES_MAX` watched while git runs, every git run ended by the deadline
//     `REPO_INDEX_TIMEOUT_MS` after the tap. Only the default branch: the list shows the commit it read.
//   * ONE FETCH AT A TIME per bridge: fetch.ts `FetchSlot`, shared with the official add; a second tap
//     answers `busy`.
//   * THE INDEX is read from git's objects only: `collie-tricks.json` at the top, a regular file of at most
//     `REPO_INDEX_BYTES_MAX`, parsed strictly. Its `name` and `about` are untrusted text: they go out as the
//     parser took them (no control or invisible character, cut to their caps) and the phone cleans them again.
//   * AN ADD fetches the default branch again and must find the commit the list showed (`moved` otherwise),
//     the folder in that commit's index (`not-listed`), and a trick in it whose manifest id is the folder.
//     fetch.ts `readCandidate` checks the folder as for `collie trick add`. The trick lands by one rename
//     (proposal-install.ts `writeNewTrick`), SWITCHED OFF (a switch entry left for that id is written off
//     first), with its own code hash, and an origin record with no `official`: an index never makes a trick
//     official. The switch then asks as for any trick.
//   * REQUEST IDS. Each route takes a `rid` (a UUID) and answers a receipt that carries it. The same `rid` with
//     the same body answers the same receipt and fetches nothing again, so the same add twice adds once; the
//     same `rid` with another body is `request-id-reused`. In memory (values.ts `SeenWrites`), as the value
//     writes: after a restart an add repeated finds the trick here and answers `taken`.
//   * TRICKS SWITCHED OFF as a whole: both routes answer `tricks-off` with its sentence, before any fetch.
//   * AUDIT: one line per read and per add that passed the host rule, with the host, the repository path, the
//     commit and the result. Never the URL as pasted, never a token (a URL with a credential never gets here).

/** The name every temp folder of this flow under `<stateDir>/tricks/` starts with. */
export const REPO_FETCH_PREFIX = ".fetch-repo-";

/** The plain refusals, as the bridge says them; the phone says them in its own words by `error`. */
export const REPO_LINES = {
  busy: "Collie is fetching another trick. Try again in a moment.",
  runsOn: "This machine runs no tricks: the lead of its crew does.",
  reused: "This request id was already used for another request.",
  unreachable: "The repository did not answer. Nothing was added.",
  tooLarge: "The repository is larger than Collie fetches from the phone. Nothing was added.",
  noIndex: `The repository has no ${REPO_INDEX_FILE}. Add one of its tricks at the terminal with \`collie trick add <url>//<folder>\`.`,
  taken: "A trick with this name is already here.",
  moved: "The repository changed since you read its list. Read the list again.",
  notListed: "The repository's list does not name this folder.",
  failed: "The trick could not be added. Nothing was changed.",
} as const;

/** Every refusal code of the two routes. */
export type RepoRefusalCode =
  | "host"
  | "invalid"
  | "tricks-off"
  | "windows"
  | "runs-on"
  | "busy"
  | "request-id-reused"
  | "taken"
  | "moved"
  | "not-listed"
  | "no-index"
  | "index-refused"
  | "too-large"
  | "refused"
  | "unreachable"
  | "failed";

const STATUS = {
  host: 409,
  invalid: 409,
  "tricks-off": 409,
  windows: 409,
  "runs-on": 409,
  busy: 409,
  "request-id-reused": 409,
  taken: 409,
  moved: 409,
  "not-listed": 409,
  "no-index": 422,
  "index-refused": 422,
  "too-large": 422,
  refused: 422,
  unreachable: 502,
  failed: 500,
} as const satisfies Readonly<Record<RepoRefusalCode, 409 | 422 | 502 | 500>>;

export type RepoRefusal =
  | { status: 400; body: { error: "repo-invalid" } }
  | { status: 409 | 422 | 502 | 500; body: { error: RepoRefusalCode; message: string; rid?: string } };
export type RepoListAnswer = { status: 200; body: RepoListReply } | RepoRefusal;
export type RepoAddAnswer = { status: 200; body: RepoAddReply } | RepoRefusal;

/** What the server needs of this flow. */
export interface RepoIndexSurface {
  list(body: JsonValue | undefined): Promise<RepoListAnswer>;
  add(body: JsonValue | undefined): Promise<RepoAddAnswer>;
}

export interface RepoIndexDeps {
  configDir: string;
  stateDir: string;
  /** The unit's environment; a git run gets it without any `GIT_*` and with no global config. */
  env: Record<string, string | undefined>;
  /** The bridge's one fetch slot, shared with the official add. Absent: a slot of its own. */
  slot?: FetchSlot;
  /** The line while tricks as a whole are switched off (service.ts `offLine`), or null while they are on. */
  offLine?: () => string | null;
  /** An add forgets what an earlier trick of that id left beside its files: its agent views and Hill keys (approved.ts `forgetLeftovers`). Absent: none held. */
  forgetTrick?: (id: string) => void | Promise<void>;
  /** The Windows gate's line (service.ts `gateLine`), or null where tricks run. */
  gate?: () => string | null;
  /** Non-null when this bridge runs no tricks (a crew member): nothing is fetched. */
  runsOn?: () => TricksRunsOn | null;
  /** Run a write in the tricks runner's serial lane (service.ts `officialLane`). Absent: run it as it is. */
  lane?: <T>(work: () => Promise<T>) => Promise<T>;
  /** One audit line per read and per add. */
  audit?: (entry: { action: string; detail: Record<string, string> }) => void;
  warn?: (line: string) => void;
  now?: () => number;
  /** TEST SEAM: the git runner, a `file://` source, a shorter deadline, a lower byte cap. The bridge never sets them. */
  git?: GitRunner;
  allowFile?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

function refusal(error: RepoRefusalCode, message: string, rid?: string): RepoRefusal {
  return { status: STATUS[error], body: rid === undefined ? { error, message } : { error, message, rid } };
}

/** A refusal that stops a step, carried up to the route's answer. */
class Stop extends Error {
  constructor(readonly answer: RepoRefusal) {
    super("stop");
  }
}

/** A body of exactly `keys`, each a string, read into a map, or undefined. */
function stringsOf(body: JsonValue | undefined, keys: readonly string[]): ReadonlyMap<string, string> | undefined {
  const doc = asJsonObject(body);
  if (doc === undefined || Object.keys(doc).length !== keys.length) return undefined;
  const out = new Map<string, string>();
  for (const key of keys) {
    const value = asJsonString(doc[key]);
    if (value === undefined) return undefined;
    out.set(key, value);
  }
  return out;
}

/** The list route's body: `{ rid, url }` and nothing else. */
function readListBody(body: JsonValue | undefined): { rid: string; url: string } | undefined {
  const got = stringsOf(body, ["rid", "url"]);
  const rid = got?.get("rid");
  const url = got?.get("url");
  if (rid === undefined || url === undefined || !isRequestId(rid)) return undefined;
  return { rid, url };
}

/** The add route's body: `{ rid, url, folder, commit }` and nothing else; the folder a trick id, the commit 40 hex. */
function readAddBody(body: JsonValue | undefined): { rid: string; url: string; folder: string; commit: string } | undefined {
  const got = stringsOf(body, ["rid", "url", "folder", "commit"]);
  const rid = got?.get("rid");
  const url = got?.get("url");
  const folder = got?.get("folder");
  const commit = got?.get("commit");
  if (rid === undefined || url === undefined || folder === undefined || commit === undefined) return undefined;
  if (!isRequestId(rid) || !isTrickId(folder) || !/^[0-9a-f]{40}$/u.test(commit)) return undefined;
  return { rid, url, folder, commit };
}

/**
 * Run a request once per `rid`: a receipt already given is answered again, a request in flight is waited for,
 * another body under the same `rid` is refused. Only a 200 is kept, so a refused request (busy, off,
 * unreachable) may be sent again under its `rid` and runs then.
 */
class OnceById<T extends { status: 200 }> {
  private readonly seen = new SeenWrites<T>();
  private readonly flying = new Map<string, { digest: string; answer: Promise<T | RepoRefusal> }>();

  async run(rid: string, digest: string, work: () => Promise<T | RepoRefusal>): Promise<T | RepoRefusal> {
    const kept = this.seen.get(rid);
    if (kept !== undefined) return kept.digest === digest ? kept.answer : refusal("request-id-reused", REPO_LINES.reused, rid);
    const flying = this.flying.get(rid);
    if (flying !== undefined) return flying.digest === digest ? await flying.answer : refusal("request-id-reused", REPO_LINES.reused, rid);
    const answer = work();
    this.flying.set(rid, { digest, answer });
    try {
      const done = await answer;
      if (done.status === 200) this.seen.remember(rid, digest, done);
      return done;
    } finally {
      this.flying.delete(rid);
    }
  }
}

/** The index file of a fetched tree, read and parsed; a {@link Stop} for none or a refused one. */
async function readIndex(fetched: Fetched): Promise<RepoIndex> {
  const entry = fetched.tree.find((e) => e.path === REPO_INDEX_FILE);
  if (entry === undefined) throw new Stop(refusal("no-index", REPO_LINES.noIndex));
  // A link or a submodule is no file: its target is never read.
  if (entry.mode !== "100644" && entry.mode !== "100755") throw new Stop(refusal("index-refused", `${REPO_INDEX_FILE} is not a regular file.`));
  if (entry.size > REPO_INDEX_BYTES_MAX) throw new Stop(refusal("index-refused", `${REPO_INDEX_FILE} is larger than ${String(REPO_INDEX_BYTES_MAX / 1024)} KiB.`));
  const bytes = (await fetched.blobs([entry.oid])).get(entry.oid);
  if (bytes === undefined || bytes.length !== entry.size) throw new FetchRefused(`git did not hand over ${REPO_INDEX_FILE}`);
  const read = parseRepoIndex(bytes);
  if (!read.ok) throw new Stop(refusal("index-refused", read.reason));
  return read.index;
}

/**
 * The link git is given: the pasted one, with `.git` added when its path has none. Redirects are off in the
 * fetch, and gitlab.com answers a link without the suffix with a redirect, so the bare link fails there.
 * github.com, gitlab.com and codeberg.org all accept the suffix. The link the phone shows stays as pasted:
 * only this one goes to git.
 */
export function gitLinkOf(source: PhoneSource): string {
  return source.url.endsWith(".git") ? source.url : `${source.url}.git`;
}

export class RepoIndexTricks implements RepoIndexSurface {
  private readonly slot: FetchSlot;
  private readonly lists = new OnceById<{ status: 200; body: RepoListReply }>();
  private readonly adds = new OnceById<{ status: 200; body: RepoAddReply }>();

  constructor(private readonly deps: RepoIndexDeps) {
    this.slot = deps.slot ?? new FetchSlot();
  }

  /** Remove the temp folders a bridge that stopped mid-fetch left (names starting with {@link REPO_FETCH_PREFIX}). */
  async sweep(): Promise<number> {
    if (this.slot.busy) return 0;
    const root = tricksStateDir(this.deps.stateDir);
    const names = await readdir(root).catch(() => []);
    const stale = names.filter((name) => name.startsWith(REPO_FETCH_PREFIX));
    for (const name of stale) await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
    return stale.length;
  }

  async list(body: JsonValue | undefined): Promise<RepoListAnswer> {
    const ask = readListBody(body);
    if (ask === undefined) return { status: 400, body: { error: "repo-invalid" } };
    return await this.lists.run(ask.rid, payloadDigest(["list", ask.url]), async () => await this.runList(ask.rid, ask.url));
  }

  async add(body: JsonValue | undefined): Promise<RepoAddAnswer> {
    const ask = readAddBody(body);
    if (ask === undefined) return { status: 400, body: { error: "repo-invalid" } };
    return await this.adds.run(ask.rid, payloadDigest(["add", ask.url, ask.folder, ask.commit]), async () => await this.runAdd(ask.rid, ask.url, ask.folder, ask.commit));
  }

  /** The checks before any fetch: the link, the Windows gate, the switch of tricks, a crew member. */
  private before(url: string): { source: PhoneSource } | { answer: RepoRefusal } {
    const source = readPhoneSource(url);
    if ("code" in source) return { answer: refusal(source.code, source.message) };
    const gate = this.deps.gate?.() ?? null;
    if (gate !== null) return { answer: refusal("windows", gate) };
    const off = this.deps.offLine?.() ?? null;
    if (off !== null) return { answer: refusal("tricks-off", off) };
    if ((this.deps.runsOn?.() ?? null) !== null) return { answer: refusal("runs-on", REPO_LINES.runsOn) };
    return { source };
  }

  /** Fetch the default branch of `source` under the slot and hand the tree to `use`; the temp folder goes on every path. */
  private async withFetch<T>(source: PhoneSource, use: (fetched: Fetched) => Promise<T>): Promise<T> {
    if (!this.slot.take()) throw new Stop(refusal("busy", REPO_LINES.busy));
    let fetchDir: string | null = null;
    try {
      const now = this.deps.now ?? Date.now;
      const deadline = now() + (this.deps.timeoutMs ?? REPO_INDEX_TIMEOUT_MS);
      const root = tricksStateDir(this.deps.stateDir);
      await mkdir(root, { recursive: true, mode: 0o700 });
      fetchDir = await mkdtemp(join(root, REPO_FETCH_PREFIX));
      let fetched: Fetched;
      try {
        fetched = await fetchSource({ url: gitLinkOf(source), ref: null }, fetchDir, officialFetchOptions(this.deps, deadline, await fetchHome(fetchDir)));
      } catch (err) {
        if (!(err instanceof FetchRefused)) throw err;
        this.deps.warn?.(`a repository fetch from ${source.host}/${source.repo} was refused (${err.step}): ${err.message}`);
        if (err.step === "fetch") throw new Stop(refusal("unreachable", REPO_LINES.unreachable));
        if (err.step === "size") throw new Stop(refusal("too-large", REPO_LINES.tooLarge));
        throw err;
      }
      if (now() > deadline) throw new Stop(refusal("unreachable", REPO_LINES.unreachable));
      return await use(fetched);
    } finally {
      if (fetchDir !== null) await rm(fetchDir, { recursive: true, force: true }).catch(() => {});
      this.slot.free();
    }
  }

  private audit(action: "list" | "add", source: PhoneSource, detail: Record<string, string>): void {
    this.deps.audit?.({ action: `trick.repo.${action}`, detail: { host: source.host, repo: source.repo, ...detail } });
  }

  /** A failure as an answer: a {@link Stop} as it is, a refused check as `refused`, anything else `failed`. */
  private failure(err: Error, action: "list" | "add", source: PhoneSource): RepoRefusal {
    let answer: RepoRefusal;
    if (err instanceof Stop) answer = err.answer;
    else if (err instanceof FetchRefused) answer = refusal("refused", `${err.message.replace(/\.$/u, "")}. Nothing was added.`);
    else {
      this.deps.warn?.(`a repository ${action} from ${source.host}/${source.repo} failed: ${err.message}`);
      answer = refusal("failed", REPO_LINES.failed);
    }
    this.audit(action, source, { result: answer.body.error });
    return answer;
  }

  private async runList(rid: string, url: string): Promise<RepoListAnswer> {
    const pre = this.before(url);
    if ("answer" in pre) return pre.answer;
    const { source } = pre;
    try {
      return await this.withFetch(source, async (fetched) => {
        const index = await readIndex(fetched);
        const root = tricksConfigDir(this.deps.configDir);
        const tricks = await Promise.all(index.tricks.map(async (entry) => ({ folder: entry.folder, name: entry.name, about: entry.about, here: (await lstat(join(root, entry.folder)).catch(() => null)) !== null })));
        this.audit("list", source, { commit: fetched.commit.slice(0, 12), result: "ok", tricks: String(tricks.length) });
        return { status: 200, body: { rid, code: "ok", url: source.url, host: source.host, repo: source.repo, commit: fetched.commit, tricks } };
      });
    } catch (err) {
      return this.failure(err instanceof Error ? err : new Error(String(err)), "list", source);
    }
  }

  private async runAdd(rid: string, url: string, folder: string, commit: string): Promise<RepoAddAnswer> {
    const pre = this.before(url);
    if ("answer" in pre) return pre.answer;
    const { source } = pre;
    const root = tricksConfigDir(this.deps.configDir);
    try {
      if ((await lstat(join(root, folder)).catch(() => null)) !== null) throw new Stop(refusal("taken", REPO_LINES.taken));
      const candidate = await this.withFetch(source, async (fetched): Promise<Candidate> => {
        if (fetched.commit !== commit) throw new Stop(refusal("moved", REPO_LINES.moved));
        const index = await readIndex(fetched);
        if (!index.tricks.some((entry) => entry.folder === folder)) throw new Stop(refusal("not-listed", REPO_LINES.notListed));
        const read = await readCandidate(fetched, folder);
        if (read.id !== folder) throw new FetchRefused(`the folder ${folder} holds the trick ${read.id}, not ${folder}`);
        return read;
      });
      const lane = this.deps.lane ?? (async <T>(work: () => Promise<T>) => await work());
      const written = await lane(async () => {
        const at = new Date((this.deps.now ?? Date.now)()).toISOString();
        // Added means switched off: a switch entry a removed folder left behind for this id goes first.
        await forgetLeftovers({ stateDir: this.deps.stateDir, configDir: this.deps.configDir, id: folder, at, forget: this.deps.forgetTrick });
        // No `official` in the origin record: a repository's index never makes a trick official.
        return await writeNewTrick(root, folder, candidate.files, renderOrigin({ url: source.url, ref: null, commit, subdir: folder, at }));
      });
      if (!written.ok && written.code === "exists") throw new Stop(refusal("taken", REPO_LINES.taken));
      if (!written.ok) throw new FetchRefused(written.reason);
      this.audit("add", source, { commit: commit.slice(0, 12), trick: folder, hash: written.codeHash.slice(0, 16), result: "ok" });
      return { status: 200, body: { rid, code: "ok", id: folder, hash: written.codeHash } };
    } catch (err) {
      return this.failure(err instanceof Error ? err : new Error(String(err)), "add", source);
    }
  }
}
