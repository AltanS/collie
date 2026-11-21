import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { edgeStateDirs, readEnvMarkers } from "./beacon.ts";
import type { HillDeps } from "./hill.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT } from "./io.ts";
import { checkStatic, helperOlderNote, leadsCrewOnDisk, proposalCards, reportFails, runAgainstFixture } from "./trick.ts";
import { readTrickFolder, type LeftPicture } from "./trick-folder.ts";

export { PROPOSE_WALK_MAX, readTrickFolder, type FolderRead, type LeftPicture } from "./trick-folder.ts";
import { AskLate, NO_SOCKET_TEXT, shown } from "./walky.ts";
import { asJsonBoolean, asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "../web/src/lib/json.ts";
import type { JsonObject } from "../bridge/json.ts";
import { PROPOSE_ASK_MS } from "../bridge/tricks/propose-door.ts";
import { manifestGivesRules, PROPOSE_HAS_RULES, readProposal, shownPath, wireFiles, type ProposedFile } from "../bridge/tricks/propose-wire.ts";
import type { TrickManifest } from "../web/src/lib/tricks/schema.ts";
import { MANIFEST_FILE } from "../bridge/tricks/paths.ts";
import { warningLines } from "../bridge/tricks/scan.ts";
import { unknownOp } from "../bridge/walky/refusals.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import { isRequestId } from "../bridge/worktree-receipts.ts";

// `collie trick propose <folder>` (crew slice 8): hand a trick to the person. An agent may run it in its
// own pane: it switches nothing on. The folder is checked as `collie trick check` checks it, read the
// hardened way (regular files only, never through a link, within the caps of `collie trick add`), and
// sent over the walky socket to this machine's bridge, which keeps it on a lead or a solo Collie and
// forwards it to the lead on a crew member (bridge/tricks/propose-door.ts). The person sees a card of
// Collie's own, on the Hill or, with the Hill off, in Settings, Tricks and the Hill (M96 spec 14); nothing runs before
// their yes.
//
// Left behind, never sent: dot files and dot folders (`.env`, `.git`), `node_modules/`, `*.log`, the
// bridge's own `inputs/`, and `config.toml`: the program reads it, so the person writes it on the machine
// (security review F2). The top `media/` and `captures/` folders send their PICTURES only (2026-11-18,
// cli/trick-folder.ts): each other file there is named with the reason it stays behind.

/** What the CLI prints when no bridge on this machine takes proposals. */
export const PROPOSE_UNKNOWN = "No running Collie on this machine takes trick proposals. Update Collie, or start it.";
/** What it prints when a bridge that knows proposals answered, and none of them drives this pane. */
export const PROPOSE_NOT_HERE = "No Collie bridge on this machine knows this pane.";

/**
 * Where the person finds a proposal's card (M96 spec 14): it needs no Hill, so the words never tell anyone
 * to switch the Hill on. The words of a bridge that does not say where the card is (before package I).
 */
export const PROPOSE_WHERE = "on the Hill, or in Settings, Tricks and the Hill, while the Hill is off";

/**
 * Where the card really is (package I, 2026-11-17), from the bridge's `where`: in the proposer's session on
 * the phone while the card is tied to it, on the Hill only while the Hill is on, and always in Settings,
 * Tricks. No `where` (an older bridge): {@link PROPOSE_WHERE}.
 */
export function proposeWhere(where: JsonValue | undefined): string {
  const row = asJsonObject(where);
  const session = asJsonBoolean(row?.session);
  const hill = asJsonBoolean(row?.hill);
  if (session === undefined || hill === undefined) return PROPOSE_WHERE;
  if (session && hill) return "in this session on the phone, on the Hill, and in Settings, Tricks and the Hill";
  if (session) return "in this session on the phone, and in Settings, Tricks and the Hill";
  if (hill) return "on the Hill, and in Settings, Tricks and the Hill";
  return "in Settings, Tricks and the Hill, on the phone";
}

/** What the CLI prints after "Sent …": the kinds of file a proposal never carries. */
export const PROPOSE_LEFT_KINDS = "dot files, node_modules, logs, inputs/, config.toml, and any file in media/ or captures/ that is not a picture";
/** The most files of `media/` and `captures/` the CLI names one by one as left behind. */
export const PROPOSE_LEFT_PICTURES_SHOWN = 10;

/** "Sent 3 files and 2 pictures." */
export function sentLine(files: number, pictures: number): string {
  const code = files === 1 ? "1 file" : `${String(files)} files`;
  if (pictures === 0) return `Sent ${code}.`;
  return `Sent ${code} and ${pictures === 1 ? "1 picture" : `${String(pictures)} pictures`}.`;
}

/** One line for each file of `media/` and `captures/` that stays behind, at most {@link PROPOSE_LEFT_PICTURES_SHOWN}, then how many more. */
export function leftPictureLines(left: readonly LeftPicture[]): string[] {
  const lines = left.slice(0, PROPOSE_LEFT_PICTURES_SHOWN).map((row) => `Left behind: ${shownPath(row.rel)} ${row.why}.`);
  const more = left.length - PROPOSE_LEFT_PICTURES_SHOWN;
  return more > 0 ? [...lines, `Left behind: ${String(more)} more files of media/ and captures/.`] : lines;
}

/** What the CLI says when the folder's config.toml stayed behind. */
export const PROPOSE_CONFIG_LEFT = "config.toml stays behind: your person sets the trick up on the machine.";
/** The warning for a trick that, run without its config.toml, drew nothing, failed or printed a part Collie refuses (decision 7). */
export const PROPOSE_NEEDS_CONFIG =
  "warning: run without config.toml, the trick drew nothing, failed or printed a part Collie refuses. It is proposed all the same, and the card tells your person it may show nothing until they add config.toml on the machine. Make the trick draw a short message when a setting is missing.";

/**
 * Run the files that go once, without the config.toml that stays behind, as the bridge would run them
 * after the yes: true when the run draws no part, fails, or prints a part Collie refuses (the first full
 * trick run, 2026-11-16, decision 7). Runs in a scratch folder of its own, removed after.
 */
async function needsItsConfig(manifest: TrickManifest, files: readonly ProposedFile[], env: ProposeDeps["ctx"]["env"]): Promise<boolean> {
  // `files` holds the pictures too, so a program that reads its own media/ runs as it will after the yes.
  const dir = await mkdtemp(join(tmpdir(), `collie-propose-${manifest.id}-`));
  try {
    for (const file of files) {
      await mkdir(dirname(join(dir, file.rel)), { recursive: true });
      await writeFile(join(dir, file.rel), file.bytes, { mode: file.executable ? 0o755 : 0o644 });
    }
    const ran = await runAgainstFixture(manifest, dir, env);
    return ran.problem !== null || ran.parsed === null || ran.parsed.parts.length === 0 || ran.parsed.refusals.length > 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type ProposeDeps = HillDeps;

/** Every bridge socket on this machine worth asking, this install's own first, as `collie hill` asks them. */
function socketPaths(deps: ProposeDeps): string[] {
  const own = walkySocketPath(deps.ctx.stateDir);
  const listed = deps.sockets?.() ?? [own, ...edgeStateDirs(deps).map((dir) => walkySocketPath(dir))];
  return [...new Set(listed)].filter((path) => holdSocketSafe(deps, path));
}

type Asked = { ok: true; body: JsonObject } | { ok: false; error: string; code: string | null; exit: number };

/**
 * The exit code of a refusal: a state, a lead away is unreachable, the rest refused. `hill_off` comes only
 * from a lead older than spec 14 (a 1.29.0 Edge build), which still refused a proposal with its Hill off.
 */
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

/** The tail of the service's refusal for a trick that is in the tricks folder and not a proposal (bridge/tricks/service.ts `targetOf`). */
const ADDED_HERE = "was added on this machine. Change it there.";
/** What the CLI adds to that refusal: the way out for an agent that made its trick in the tricks folder. */
export const PROPOSE_ADDED_HERE_HINT = "Copy the folder outside the tricks folder and propose the copy, or ask the person to switch it on.";

/** What `trick.propose` carries: the request id, the files, and `settings` when the trick needs the config.toml it leaves behind. */
type ProposeFields = {
  requestId: string;
  files: ReturnType<typeof wireFiles>;
  settings?: true;
};

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
  // A trick that gives agents instructions is never sent: no agent may hand a person its author's words for
  // their agents. The lead refuses it again (propose-wire.ts `checkProposedFiles`).
  const manifestText = deps.files.read(join(folder, MANIFEST_FILE));
  if (manifestText !== null && manifestGivesRules(manifestText)) return fail(PROPOSE_HAS_RULES, "has_rules", EXIT.REFUSED);
  // First what `collie trick check` says: a trick it refuses is never sent.
  const report = await checkStatic(folder, deps.files, { crew: leadsCrewOnDisk(deps) });
  if (reportFails(report)) {
    const first = report.refusals.find((r) => r.code !== "later");
    const why = first === undefined ? (report.problems[0] ?? `There is no usable ${MANIFEST_FILE}.`) : `${MANIFEST_FILE}${first.path === "" ? "" : ` ${first.path}`}: ${first.reason}`;
    return fail(`${why} Run collie trick check ${rest[0]!}, fix what it says, then propose again.`, "bad_manifest", EXIT.FAIL);
  }
  const read = await readTrickFolder(folder);
  if (!read.ok) return fail(read.error, "bad_files", EXIT.FAIL);
  // The cards the phone would show: a trick larger than a group, or with a line no card shows as it is,
  // is refused here, and again on the lead.
  const cards = proposalCards(report, [...read.files, ...read.pictures], leadsCrewOnDisk(deps), rest[0]!);
  if (!cards.ok) return fail(cards.error, cards.code, EXIT.REFUSED);
  // A helper of an older Collie is Collie's code and is sent as it is; the person is told once, on stderr.
  if (!json && report.helper !== undefined && !report.helper.current && !report.helper.modified) deps.io.err(helperOlderNote(report.helper.version, rest[0]!));
  const rid = requestId ?? (deps.mintRequestId ?? randomUUID)();
  // A trick whose config.toml stays behind runs once without it: the person adds the settings only after the yes.
  const sent = [...read.files, ...read.pictures];
  const settings = read.config && report.manifest!.run !== undefined && (await needsItsConfig(report.manifest!, sent, deps.ctx.env));
  // The one reader the bridge and the lead use: what it refuses, they refuse.
  const fields: ProposeFields = { requestId: rid, files: wireFiles(sent) };
  if (settings) fields.settings = true;
  const checked = readProposal(fields);
  if (!checked.ok) return fail(checked.refusal.error, checked.refusal.code, EXIT.FAIL);
  if (!json) for (const line of warningLines(report.warnings)) deps.io.err(line);
  if (!json && settings) deps.io.err(PROPOSE_NEEDS_CONFIG);
  // The op first: the bridge reads a long line only when it opens with it (parse.ts PROPOSE_LINE_PREFIX).
  const line = `${JSON.stringify({ op: "trick.propose", v: 1, markers: readEnvMarkers(deps.ctx.env), ...fields })}\n`;
  const answer = await ask(deps, line, rid);
  if (!answer.ok) {
    const exit = fail(answer.error, answer.code, answer.exit);
    if (!json && answer.error.endsWith(ADDED_HERE)) deps.io.err(`propose: ${PROPOSE_ADDED_HERE_HINT}`);
    if (!json && answer.code !== "lead_unreachable") deps.io.err(`propose: request id ${rid}`);
    return exit;
  }
  const body = answer.body;
  const kind = asJsonString(body.kind) === "version" ? "version" : "proposal";
  const id = asJsonString(body.id) ?? checked.proposal.manifest.id;
  const decision = asJsonString(body.decision) ?? null;
  const replaced = asJsonString(body.replaced) ?? null;
  const place = proposeWhere(body.where);
  if (json) {
    deps.io.out(JSON.stringify({ ok: true, kind, id, hash: checked.proposal.hash, decision, replaced, requestId: rid, files: read.files.length, pictures: read.pictures.map((p) => p.rel), left: read.left, leftPictures: read.leftPictures, warnings: report.warnings.map((w) => w.kind), needsConfig: settings, where: place }));
    return EXIT.OK;
  }
  deps.io.out(`${sentLine(read.files.length, read.pictures.length)} Left behind: ${String(read.left)} (${PROPOSE_LEFT_KINDS}).`);
  for (const leftLine of leftPictureLines(read.leftPictures)) deps.io.out(leftLine);
  if (read.config) deps.io.out(PROPOSE_CONFIG_LEFT);
  if (kind === "version") deps.io.out(`Proposed a new version of ${id}. Your person sees it as ${decision ?? "a card"} ${place}. Nothing of it is written or runs before their yes.`);
  else deps.io.out(`Proposed ${id}. Your person sees it as ${decision ?? "a card"} ${place}. Nothing runs before their yes.`);
  if (replaced !== null) deps.io.out(`It replaces your earlier proposal ${replaced}.`);
  if (decision !== null) deps.io.out(`Read the answer with: collie hill status ${decision}`);
  return EXIT.OK;
}
