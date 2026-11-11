import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { edgeStateDirs, readEnvMarkers } from "./beacon.ts";
import type { HillDeps } from "./hill.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT } from "./io.ts";
import { checkStatic, leadsCrewOnDisk, reportFails } from "./trick.ts";
import { AskLate, NO_SOCKET_TEXT, shown } from "./walky.ts";
import { asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import type { JsonObject } from "../bridge/json.ts";
import { isPictureName, PICTURE_DIRS } from "../bridge/tricks/code-hash.ts";
import { PROPOSE_ASK_MS } from "../bridge/tricks/propose-door.ts";
import { isConfigPath, PROPOSE_LIMITS, readProposal, wireFiles, type ProposedFile } from "../bridge/tricks/propose-wire.ts";
import { MANIFEST_FILE } from "../bridge/tricks/paths.ts";
import { warningLines } from "../bridge/tricks/scan.ts";
import { unknownOp } from "../bridge/walky/refusals.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import { isRequestId } from "../bridge/worktree-receipts.ts";

// `collie trick propose <folder>` (crew slice 8): hand a trick to the person. An agent may run it in its
// own pane: it switches nothing on. The folder is checked as `collie trick check` checks it, read the
// hardened way (regular files only, never through a link, within the caps of `collie trick add`), and
// sent over the walky socket to this machine's bridge, which keeps it on a lead or a solo Collie and
// forwards it to the lead on a crew member (bridge/tricks/propose-door.ts). The person sees a card on the
// Hill; nothing runs before their yes.
//
// Left behind, never sent: dot files and dot folders (`.env`, `.git`), `node_modules/`, `*.log`, the
// bridge's own `inputs/`, anything in `media/` or `captures/` that is not a picture, and `config.toml`:
// the program reads it, so the person writes it on the machine (security review F2).

/** What the CLI prints when no bridge on this machine takes proposals. */
export const PROPOSE_UNKNOWN = "No running Collie on this machine takes trick proposals. Update Collie, or start it.";
/** What it prints when a bridge that knows proposals answered, and none of them drives this pane. */
export const PROPOSE_NOT_HERE = "No Collie bridge on this machine knows this pane.";

/** What the CLI says when the folder's config.toml stayed behind. */
export const PROPOSE_CONFIG_LEFT = "config.toml stays behind: your person sets the trick up on the machine.";

/** The most entries the folder walk looks at, skipped ones included, before it gives up. */
export const PROPOSE_WALK_MAX = 2000;

export type ProposeDeps = HillDeps;

/** The folder read for a proposal: the files to send, and how many were left behind. */
export type FolderRead = { ok: true; files: ProposedFile[]; left: number; config: boolean } | { ok: false; error: string };

/** Whether a name is left behind: not code, or the bridge's own. */
function leftBehind(rel: string, isDir: boolean): boolean {
  const steps = rel.split("/");
  const name = steps.at(-1) ?? "";
  if (steps.some((step) => step.startsWith(".") || step === "node_modules")) return true;
  if (steps.length === 1 && isDir && name === "inputs") return true;
  if (steps.length === 1 && isConfigPath(name)) return true;
  if (!isDir && name.endsWith(".log")) return true;
  // A picture folder carries pictures only: anything else there is not copied by an approval either.
  if (!isDir && steps.length > 1 && PICTURE_DIRS.some((dir) => dir === steps[0]) && !isPictureName(rel)) return true;
  return false;
}

/** Read a trick folder for a proposal: regular files only, never through a link, within the caps. */
export async function readTrickFolder(folder: string): Promise<FolderRead> {
  const files: ProposedFile[] = [];
  let left = 0;
  let config = false;
  let seen = 0;
  let bytes = 0;
  const walk = async (rel: string, depth: number): Promise<string | null> => {
    const here = rel === "" ? folder : join(folder, rel);
    const entries = await readdir(here, { withFileTypes: true });
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      seen += 1;
      if (seen > PROPOSE_WALK_MAX) return `The folder holds more than ${String(PROPOSE_WALK_MAX)} entries. A trick is small.`;
      const sub = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const st = await lstat(join(folder, sub));
      if (leftBehind(sub, st.isDirectory())) {
        left += 1;
        if (isConfigPath(sub)) config = true;
        continue;
      }
      if (st.isSymbolicLink()) return `${sub} is a symbolic link. A trick holds regular files only.`;
      if (st.isDirectory()) {
        if (depth >= PROPOSE_LIMITS.depth) return `${sub} sits deeper than ${String(PROPOSE_LIMITS.depth)} folders.`;
        const deeper = await walk(sub, depth + 1);
        if (deeper !== null) return deeper;
        continue;
      }
      if (!st.isFile()) return `${sub} is not a regular file. A trick holds regular files only.`;
      bytes += st.size;
      if (files.length + 1 > PROPOSE_LIMITS.files) return `The trick holds more than ${String(PROPOSE_LIMITS.files)} files.`;
      if (bytes > PROPOSE_LIMITS.bytes) return `The trick holds more than ${String(PROPOSE_LIMITS.bytes / (1024 * 1024))} MB.`;
      const body = await readFile(join(folder, sub));
      files.push({ rel: sub, bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), executable: (st.mode & 0o111) !== 0 });
    }
    return null;
  };
  try {
    const error = await walk("", 0);
    return error === null ? { ok: true, files, left, config } : { ok: false, error };
  } catch (err) {
    return { ok: false, error: `The folder could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Every bridge socket on this machine worth asking, this install's own first, as `collie hill` asks them. */
function socketPaths(deps: ProposeDeps): string[] {
  const own = walkySocketPath(deps.ctx.stateDir);
  const listed = deps.sockets?.() ?? [own, ...edgeStateDirs(deps).map((dir) => walkySocketPath(dir))];
  return [...new Set(listed)].filter((path) => holdSocketSafe(deps, path));
}

type Asked = { ok: true; body: JsonObject } | { ok: false; error: string; code: string | null; exit: number };

/** The exit code of a refusal: the Hill off is a state, a lead away is unreachable, the rest refused. */
export function proposeExit(code: string | null): number {
  if (code === "lead_unreachable") return EXIT.UNREACHABLE;
  if (code === null || code === "hill_off" || code === "no_tricks" || code === "not_on_lead") return EXIT.STATE;
  if (code === "failed") return EXIT.FAIL;
  return EXIT.REFUSED;
}

/** Ask each bridge in turn until one takes or refuses the proposal. */
async function ask(deps: ProposeDeps, line: string, requestId: string): Promise<Asked> {
  let knows = false;
  let notHere = false;
  for (const path of socketPaths(deps)) {
    const { raw, late } = await deps.ask(path, line, PROPOSE_ASK_MS).then(
      (text) => ({ raw: text, late: false }),
      (err) => ({ raw: null, late: err instanceof AskLate }),
    );
    // The bridge took the proposal and did not answer in time: asking the next one could propose twice.
    if (late) {
      return { ok: false, error: `The bridge took the proposal and did not answer within ${String(PROPOSE_ASK_MS / 1000)} s. It may still reach the Hill. Propose again with --request-id ${requestId}: it is proposed once.`, code: "lead_unreachable", exit: EXIT.UNREACHABLE };
    }
    const answer = raw === null ? undefined : parseJsonObject(raw);
    if (answer === undefined) continue;
    if (answer.ok === true) return { ok: true, body: answer };
    const error = asJsonString(answer.error) ?? "failed";
    if (answer.propose === true) knows = true;
    if (error === "not here") {
      notHere = true;
      continue;
    }
    if (error === unknownOp("trick.propose") || error.startsWith("bad request")) continue;
    if (answer.propose !== true) continue;
    const code = asJsonString(answer.code) ?? null;
    return { ok: false, error, code, exit: proposeExit(code) };
  }
  if (knows && notHere) return { ok: false, error: PROPOSE_NOT_HERE, code: null, exit: EXIT.STATE };
  return { ok: false, error: PROPOSE_UNKNOWN, code: null, exit: EXIT.UNREACHABLE };
}

const USAGE = "usage: collie trick propose <folder> [--request-id <uuid>] [--json]";

/** `collie trick propose <folder>`: hand a trick to the person, through the lead's Hill. */
export async function cmdTrickPropose(deps: ProposeDeps, args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  let requestId: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "--request-id") {
      const value = args[i + 1];
      if (value === undefined || !isRequestId(value)) {
        deps.io.err("error: --request-id takes a UUID");
        deps.io.err(USAGE);
        return EXIT.USAGE;
      }
      requestId = value;
      i += 1;
      continue;
    }
    rest.push(arg);
  }
  if (rest.length !== 1 || rest[0]!.startsWith("-")) {
    deps.io.err(USAGE);
    return EXIT.USAGE;
  }
  if (deps.platform === "win32") {
    deps.io.err(NO_SOCKET_TEXT);
    return EXIT.STATE;
  }
  const folder = resolve(rest[0]!);
  if (deps.files.entryType(folder) !== "directory") {
    deps.io.err(`error: ${rest[0]!} is not a folder.`);
    return EXIT.USAGE;
  }
  const fail = (error: string, code: string | null, exit: number): number => {
    if (json) deps.io.out(JSON.stringify({ ok: false, code, error }));
    else deps.io.err(`propose: ${shown(error)}`);
    return exit;
  };
  // First what `collie trick check` says: a trick it refuses is never sent.
  const report = await checkStatic(folder, deps.files, { crew: leadsCrewOnDisk(deps) });
  if (reportFails(report)) {
    const first = report.refusals.find((r) => r.code !== "later");
    const why = first === undefined ? (report.problems[0] ?? `There is no usable ${MANIFEST_FILE}.`) : `${MANIFEST_FILE}${first.path === "" ? "" : ` ${first.path}`}: ${first.reason}`;
    return fail(`${why} Run collie trick check ${rest[0]!}, fix what it says, then propose again.`, "bad_manifest", EXIT.FAIL);
  }
  const read = await readTrickFolder(folder);
  if (!read.ok) return fail(read.error, "bad_files", EXIT.FAIL);
  const rid = requestId ?? (deps.mintRequestId ?? randomUUID)();
  // The one reader the bridge and the lead use: what it refuses, they refuse.
  const fields = { requestId: rid, files: wireFiles(read.files) };
  const checked = readProposal(fields);
  if (!checked.ok) return fail(checked.refusal.error, checked.refusal.code, EXIT.FAIL);
  if (!json) for (const line of warningLines(report.warnings)) deps.io.err(`warning: ${line}`);
  // The op first: the bridge reads a long line only when it opens with it (parse.ts PROPOSE_LINE_PREFIX).
  const line = `${JSON.stringify({ op: "trick.propose", v: 1, markers: readEnvMarkers(deps.ctx.env), ...fields })}\n`;
  const answer = await ask(deps, line, rid);
  if (!answer.ok) {
    const exit = fail(answer.error, answer.code, answer.exit);
    if (!json && answer.code !== "lead_unreachable") deps.io.err(`propose: request id ${rid}`);
    return exit;
  }
  const body = answer.body;
  const kind = asJsonString(body.kind) === "version" ? "version" : "proposal";
  const id = asJsonString(body.id) ?? checked.proposal.manifest.id;
  const decision = asJsonString(body.decision) ?? null;
  const replaced = asJsonString(body.replaced) ?? null;
  if (json) {
    deps.io.out(JSON.stringify({ ok: true, kind, id, hash: checked.proposal.hash, decision, replaced, requestId: rid, files: read.files.length, left: read.left, warnings: report.warnings.map((w) => w.kind) }));
    return EXIT.OK;
  }
  deps.io.out(`Sent ${String(read.files.length)} files. Left behind: ${String(read.left)} (dot files, node_modules, logs, inputs/, config.toml).`);
  if (read.config) deps.io.out(PROPOSE_CONFIG_LEFT);
  if (kind === "version") deps.io.out(`Proposed a new version of ${id}. Your person sees it on the Hill as ${decision ?? "a card"}. Nothing of it is written or runs before their yes.`);
  else deps.io.out(`Proposed ${id}. Your person sees it on the Hill as ${decision ?? "a card"}. Nothing runs before their yes.`);
  if (replaced !== null) deps.io.out(`It replaces your earlier proposal ${replaced}.`);
  if (decision !== null) deps.io.out(`Read the answer with: collie hill status ${decision}`);
  return EXIT.OK;
}
