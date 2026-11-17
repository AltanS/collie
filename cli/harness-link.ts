// `collie harness link <harness>`, `collie harness unlink <harness>`, `collie harness status` and
// `collie harness sync` (M99 spec 09, README decision 12): the opt-in for the data path. Nothing links
// by itself.
//
// The verbs live in their own tree, `harness`, beside `mux`. The bare `collie link` and `collie unlink`
// keep their one meaning, the name on PATH (cli/link.ts, ADR 0021), and refuse an argument
// ({@link bareLinkRefusal}).
//
// RULES
//  - Claude Code: the mod is written to `<config home>/collie/inside/claude/`, a folder marketplace,
//    and registered through Claude Code's own CLI at the user scope (`claude plugin marketplace add`,
//    `claude plugin install`). Claude Code reads a folder-marketplace plugin from that folder, so a
//    rewrite reaches a session at its next `/reload-plugins`. No settings file is edited by hand, and
//    nothing is fetched.
//  - pi, omp, opencode: one file, whose first line is the Collie marker. A file without the marker is
//    somebody else's and is refused; unlink removes only a file with it.
//  - One part per machine user, shared by every instance. A link never replaces a newer part with an
//    older one; `harness sync` (run by `collie update`) rewrites a linked part with this build's.
//  - The link record (`<harness>.link.json` beside the parts) is written last and removed first. The
//    bridge opens its inside socket while one is there (bridge/inside/links.ts).
//  - No unit, no bridge and no session is restarted, and no settings file is touched.

import { HOST } from "../bridge/host.ts";
import { join } from "node:path";

import { hookTargetFileName, hookTargetsDir, parseHookTarget } from "../bridge/beacon/hook-targets.ts";
import { linkRecordPath, parseLinkRecord, partsRoot, configHome } from "../bridge/inside/links.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { compareSemver } from "../web/src/lib/semver.ts";
import type { CliContext } from "./context.ts";
import { collieVersionBare } from "./context.ts";
import { managedSettingsPath } from "./hold-entry.ts";
import { CLAUDE_MOD_FILES, CLAUDE_MOD_NAME, claudeModVersion } from "./inside-embed.ts";
import { ok, skipped, warn, type Finding } from "./finding.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";

/** The harnesses a part may exist for, in the order the verbs and the doctor list them. */
export const LINK_HARNESSES = ["claude", "pi", "omp", "opencode"] as const;
export type LinkHarness = (typeof LINK_HARNESSES)[number];

export function isLinkHarness(word: string): word is LinkHarness {
  return LINK_HARNESSES.some((harness) => harness === word);
}

/**
 * The word a person reads for the piece Collie installs into a harness. All four are a plugin today.
 * Protocol and code say "part" (`bridge/inside/WIRE.md`); a sentence for a person never does. A harness
 * whose own word differs sets it here when its piece ships, and no sentence changes.
 */
export const INSTALL_WORD = {
  claude: "plugin",
  pi: "plugin",
  omp: "plugin",
  opencode: "plugin",
} satisfies Readonly<Record<LinkHarness, string>>;

/** The distinct install words of some harnesses, in order, for a sentence about several at once. */
function installWords(harnesses: readonly LinkHarness[]): string[] {
  return [...new Set(harnesses.map((harness) => INSTALL_WORD[harness]))];
}

/** The words for a sentence about every harness: "plugin", or "plugin or extension" once two differ. */
export function installWordAny(harnesses: readonly LinkHarness[] = LINK_HARNESSES): string {
  return installWords(harnesses).join(" or ");
}

/** The same, plural: "plugins", or "plugins and extensions". */
export function installWordsPlural(harnesses: readonly LinkHarness[] = LINK_HARNESSES): string {
  return installWords(harnesses)
    .map((word) => `${word}s`)
    .join(" and ");
}

/** The marketplace the Claude mod is registered from, and the plugin id Claude Code lists. */
export const CLAUDE_MARKETPLACE = "collie-inside";
export const CLAUDE_PLUGIN_ID = `${CLAUDE_MOD_NAME}@${CLAUDE_MARKETPLACE}`;
/** The first Claude Code version the mod was proven on (its API, 2.1.323). Older is not verified. */
export const CLAUDE_DATA_PATH_FROM = "2.1.323";
const CLAUDE_CALL_MS = 30_000;

/** The marker a file part carries on its first line. */
export const PART_MARKER = "// collie-inside part";
const markerLine = (harness: string, version: string): string => `${PART_MARKER} ${harness} ${version}`;

/** The part text this build carries for a file harness, or null: no part for it in this build. */
export type PartTexts = Readonly<Record<"pi" | "omp" | "opencode", string | null>>;
/** No file part ships yet (M99 specs 06 and 08 add them). */
export const BUILT_PARTS = { pi: null, omp: null, opencode: null } satisfies PartTexts;

export interface HarnessLinkDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly files: Files;
  readonly exec: Exec;
  readonly now?: () => number;
  /** The file parts this build carries. Defaults to {@link BUILT_PARTS}. */
  readonly parts?: PartTexts;
  /** The managed settings file Claude Code reads. Defaults to the platform's own. */
  readonly managedSettings?: string;
  /** This build's part version. Defaults to the embedded mod's version. */
  readonly version?: string;
  /** `process.platform`, through the host. Defaults to {@link HOST}'s. */
  readonly platform?: string;
}

/** The name a half-written part carries until it is renamed into place. Ours by name alone. */
const TEMP_SUFFIX = ".collie-tmp";
/** The name the old part folder carries for the moment between the two renames. */
const OLD_SUFFIX = ".collie-old";

/** Where a file part goes. */
export function filePartPath(ctx: Pick<CliContext, "env" | "home">, harness: "pi" | "omp" | "opencode"): string {
  if (harness === "pi") return join(ctx.home, ".pi", "agent", "extensions", "collie-inside.ts");
  if (harness === "omp") return join(ctx.home, ".omp", "agent", "extensions", "collie-inside.ts");
  return join(configHome(ctx.env, ctx.home), "opencode", "plugin", "collie-inside.js");
}

/** The Claude mod's folder. */
export function claudePartDir(ctx: Pick<CliContext, "env" | "home">): string {
  return join(partsRoot(ctx.env, ctx.home), "claude");
}

const ourVersion = (deps: HarnessLinkDeps): string => deps.version ?? claudeModVersion() ?? collieVersionBare(deps.ctx.root);

/** The marketplace file that makes the mod's folder a marketplace of one plugin. */
export function marketplaceText(): string {
  return `${JSON.stringify({ name: CLAUDE_MARKETPLACE, owner: { name: "Collie" }, plugins: [{ name: CLAUDE_MOD_NAME, source: "./" }] }, null, 2)}\n`;
}

/** The version of the part on disk, or null when there is none of ours. */
export function partOnDisk(deps: Pick<HarnessLinkDeps, "ctx" | "files">, harness: LinkHarness): string | null {
  if (harness === "claude") {
    const dir = claudePartDir(deps.ctx);
    const market = deps.files.read(join(dir, ".claude-plugin", "marketplace.json"));
    if (market === null || !market.includes(`"${CLAUDE_MARKETPLACE}"`)) return null;
    const manifest = deps.files.read(join(dir, ".claude-plugin", "plugin.json"));
    return /"version"\s*:\s*"([^"]+)"/u.exec(manifest ?? "")?.[1] ?? null;
  }
  const first = (deps.files.read(filePartPath(deps.ctx, harness)) ?? "").split("\n", 1)[0] ?? "";
  if (!first.startsWith(`${PART_MARKER} ${harness} `)) return null;
  return first.slice(`${PART_MARKER} ${harness} `.length).trim() || null;
}

/** Whether an administrator's managed setting stops the hooks of user plugins. */
export function blockedByPolicy(deps: Pick<HarnessLinkDeps, "files" | "managedSettings" | "ctx">, harness: LinkHarness): boolean {
  if (harness !== "claude") return false;
  const text = deps.files.read(deps.managedSettings ?? managedSettingsPath(HOST.platform));
  if (text === null) return false;
  return parseJsonObject(text)?.allowManagedHooksOnly === true;
}

/** Write this build's part, unless a newer one is there. Returns what happened. */
/** What a write of a part did, and the version now there. */
export interface PartWrite {
  readonly kind: "written" | "kept-newer" | "no-part" | "foreign";
  readonly version: string | null;
}

export function writePart(deps: HarnessLinkDeps, harness: LinkHarness): PartWrite {
  const ours = ourVersion(deps);
  const there = partOnDisk(deps, harness);
  if (there !== null && compareSemver(there, ours) > 0) return { kind: "kept-newer", version: there };
  if (harness === "claude") {
    const dir = claudePartDir(deps.ctx);
    if (there === null && deps.files.exists(dir)) return { kind: "foreign", version: null };
    // Into a sibling folder first, renamed into place whole: an interrupted link leaves only a folder
    // with our temporary name, which the next run removes, never a half part under the real name.
    const temp = `${dir}.collie-tmp`;
    const old = `${dir}${OLD_SUFFIX}`;
    deps.files.removeTree(temp);
    deps.files.removeTree(old);
    for (const file of CLAUDE_MOD_FILES) {
      const target = join(temp, file.path);
      deps.files.mkdirp(join(target, ".."), 0o755);
      deps.files.write(target, file.text, 0o644);
    }
    deps.files.write(join(temp, ".claude-plugin", "marketplace.json"), marketplaceText(), 0o644);
    if (deps.files.exists(dir)) deps.files.rename(dir, old);
    deps.files.rename(temp, dir);
    deps.files.removeTree(old);
    return { kind: "written", version: ours };
  }
  const text = (deps.parts ?? BUILT_PARTS)[harness];
  if (text === null) return { kind: "no-part", version: null };
  const path = filePartPath(deps.ctx, harness);
  if (there === null && deps.files.exists(path)) return { kind: "foreign", version: null };
  deps.files.mkdirp(join(path, ".."), 0o755);
  // The same for a file part: a whole file or none, under the real name.
  deps.files.write(`${path}${TEMP_SUFFIX}`, `${markerLine(harness, ours)}\n${text}`, 0o644);
  deps.files.rename(`${path}${TEMP_SUFFIX}`, path);
  return { kind: "written", version: ours };
}

function writeRecord(deps: HarnessLinkDeps, harness: LinkHarness, version: string): void {
  const path = linkRecordPath(deps.ctx.env, deps.ctx.home, harness);
  deps.files.mkdirp(join(path, ".."), 0o755);
  deps.files.write(path, `${JSON.stringify({ harness, version, at: (deps.now ?? Date.now)() })}\n`, 0o644);
}

/** Whether a harness is linked: its record is there. */
export function isLinked(deps: Pick<HarnessLinkDeps, "ctx" | "files">, harness: LinkHarness): boolean {
  return parseLinkRecord(deps.files.read(linkRecordPath(deps.ctx.env, deps.ctx.home, harness)), harness) !== null;
}

/** What one `claude plugin ...` call answered. */
interface ClaudeCall {
  readonly ok: boolean;
  readonly out: string;
  readonly why: string;
}

/** What an unlink did: whether anything of ours was there, and a warning or null. */
interface Unlinked {
  readonly removed: boolean;
  readonly note: string | null;
}

/** One `claude plugin ...` call. */
function claude(deps: HarnessLinkDeps, args: readonly string[]): ClaudeCall {
  const r = deps.exec.capture("claude", ["plugin", ...args], CLAUDE_CALL_MS);
  if (!r.found) return { ok: false, out: "", why: "claude is not on PATH" };
  const why = (r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? "";
  return { ok: r.code === 0, out: r.stdout, why: why === "" ? `exit ${String(r.code)}` : why };
}

/** Register the mod's folder with Claude Code at the user scope, each step only when it is not done. */
function registerClaude(deps: HarnessLinkDeps): string | null {
  const markets = claude(deps, ["marketplace", "list", "--json"]);
  if (!markets.ok) return markets.why;
  if (!markets.out.includes(`"${CLAUDE_MARKETPLACE}"`)) {
    const added = claude(deps, ["marketplace", "add", claudePartDir(deps.ctx), "--scope", "user", "--json"]);
    if (!added.ok) return added.why;
  }
  const plugins = claude(deps, ["list", "--json"]);
  if (!plugins.ok) return plugins.why;
  if (!plugins.out.includes(CLAUDE_PLUGIN_ID)) {
    const installed = claude(deps, ["install", CLAUDE_PLUGIN_ID, "--scope", "user", "--json"]);
    if (!installed.ok) return installed.why;
  }
  return null;
}

/** `collie harness link <harness>`. */
export function cmdHarnessLink(deps: HarnessLinkDeps, harness: LinkHarness): number {
  const { io } = deps;
  // The bridge keeps the screen path on Windows in this version (`bridge/inside/gate.ts`): a link
  // there would say "linked" and change nothing.
  if ((deps.platform ?? HOST.platform) === "win32") {
    io.err("error: sending by data is not available on Windows yet. Collie keeps the screen path there.");
    return EXIT.FAIL;
  }
  if (harness === "claude" && deps.exec.which("claude") === null) {
    io.err("error: claude is not on PATH. Install Claude Code first, then run `collie harness link claude` again.");
    return EXIT.FAIL;
  }
  const wrote = writePart(deps, harness);
  if (wrote.kind === "no-part") {
    io.err(`error: this Collie has no ${INSTALL_WORD[harness]} for ${harness}.`);
    return EXIT.FAIL;
  }
  if (wrote.kind === "foreign") {
    const where = harness === "claude" ? claudePartDir(deps.ctx) : filePartPath(deps.ctx, harness);
    io.err(`error: ${where} is not a Collie ${INSTALL_WORD[harness]}. Leaving it alone.`);
    return EXIT.FAIL;
  }
  if (wrote.kind === "kept-newer") io.out(`kept the ${INSTALL_WORD[harness]} ${wrote.version ?? "?"} that is there: it is newer than this Collie (${ourVersion(deps)}).`);
  if (harness === "claude") {
    const failed = registerClaude(deps);
    if (failed !== null) {
      io.err(`error: Claude Code did not register the ${INSTALL_WORD[harness]}: ${failed}`);
      io.err(`  The ${INSTALL_WORD[harness]} is written but not linked. Run \`collie harness link claude\` again.`);
      return EXIT.FAIL;
    }
  }
  const version = wrote.version ?? ourVersion(deps);
  writeRecord(deps, harness, version);
  io.out(`linked ${harness}: ${INSTALL_WORD[harness]} ${version}.`);
  if (harness === "claude") io.out("  A running Claude Code session takes it after /reload-plugins; a new session takes it at start.");
  io.out(`  This is an experiment, for Claude Code only. The screen path stays the normal road. \`collie harness unlink ${harness}\` turns it off.`);
  if (blockedByPolicy(deps, harness)) io.out(`  note: a managed setting (allowManagedHooksOnly) stops the hooks of user plugins here, so the ${INSTALL_WORD[harness]} stays idle.`);
  return EXIT.OK;
}

/** Take a harness's part away: the record first, then the registration, then the files that are ours. */
function unlinkOne(deps: HarnessLinkDeps, harness: LinkHarness): Unlinked {
  const record = linkRecordPath(deps.ctx.env, deps.ctx.home, harness);
  const had = deps.files.exists(record);
  if (had) deps.files.remove(record);
  if (harness === "claude") {
    const note = unregisterClaude(deps);
    const ours = partOnDisk(deps, harness) !== null;
    // The folder goes only once Claude Code no longer names it: a registration left pointing at a
    // missing folder is one no verb of ours can see again. A rerun of `unlink` finishes the job.
    if (ours && note === null) deps.files.removeTree(claudePartDir(deps.ctx));
    if (note === null) return { removed: had || ours, note: null };
    return { removed: had || ours, note: ours ? `${note}; the ${INSTALL_WORD[harness]}'s folder is kept, run \`collie harness unlink claude\` again` : note };
  }
  const ours = partOnDisk(deps, harness) !== null;
  if (ours) deps.files.remove(filePartPath(deps.ctx, harness));
  return { removed: had || ours, note: null };
}

/** Take the mod's registration away; a warning when any step failed or could not be checked. */
function unregisterClaude(deps: HarnessLinkDeps): string | null {
  if (deps.exec.which("claude") === null) return `claude is not on PATH, so its plugin list still names the ${INSTALL_WORD.claude}`;
  const plugins = claude(deps, ["list", "--json"]);
  if (!plugins.ok) return `Claude Code did not list its plugins: ${plugins.why}`;
  if (plugins.out.includes(CLAUDE_PLUGIN_ID)) {
    const gone = claude(deps, ["uninstall", CLAUDE_PLUGIN_ID, "--scope", "user", "--json"]);
    if (!gone.ok) return `Claude Code did not uninstall the ${INSTALL_WORD.claude}: ${gone.why}`;
  }
  const markets = claude(deps, ["marketplace", "list", "--json"]);
  if (!markets.ok) return `Claude Code did not list its marketplaces: ${markets.why}`;
  if (markets.out.includes(`"${CLAUDE_MARKETPLACE}"`)) {
    const gone = claude(deps, ["marketplace", "remove", CLAUDE_MARKETPLACE, "--scope", "user", "--json"]);
    if (!gone.ok) return `Claude Code did not remove the marketplace: ${gone.why}`;
  }
  return null;
}

/** `collie harness unlink <harness>`. */
export function cmdHarnessUnlink(deps: HarnessLinkDeps, harness: LinkHarness): number {
  const done = unlinkOne(deps, harness);
  if (!done.removed && done.note === null) {
    deps.io.out(`${harness} is not linked.`);
    return EXIT.OK;
  }
  deps.io.out(`unlinked ${harness}.`);
  if (done.note !== null) deps.io.err(`  warning: ${done.note}`);
  if (harness === "claude") deps.io.out("  A running Claude Code session keeps its copy until /reload-plugins or its end.");
  return done.note === null ? EXIT.OK : EXIT.FAIL;
}

/** One harness's link state, as `harness status` and `doctor` read it. Files only; no harness is run. */
export type LinkState =
  | { readonly kind: "not-linked" }
  | { readonly kind: "linked"; readonly version: string }
  | { readonly kind: "older"; readonly version: string; readonly ours: string }
  | { readonly kind: "missing" }
  | { readonly kind: "blocked"; readonly version: string };

export function linkState(deps: Pick<HarnessLinkDeps, "ctx" | "files" | "managedSettings" | "version">, harness: LinkHarness): LinkState {
  if (!isLinked(deps, harness)) return { kind: "not-linked" };
  const version = partOnDisk(deps, harness);
  if (version === null) return { kind: "missing" };
  if (blockedByPolicy(deps, harness)) return { kind: "blocked", version };
  const ours = deps.version ?? claudeModVersion() ?? collieVersionBare(deps.ctx.root);
  if (compareSemver(version, ours) < 0) return { kind: "older", version, ours };
  return { kind: "linked", version };
}

/** The words of a state, one line. */
export function linkStateWords(harness: LinkHarness, state: LinkState): string {
  switch (state.kind) {
    case "not-linked":
      return "not linked";
    case "linked":
      return `linked, ${INSTALL_WORD[harness]} ${state.version}`;
    case "older":
      return `linked, ${INSTALL_WORD[harness]} ${state.version} is older than this Collie (${state.ours}): run \`collie harness link ${harness}\``;
    case "missing":
      return `linked, but the ${INSTALL_WORD[harness]} is gone: run \`collie harness link ${harness}\``;
    case "blocked":
      return `linked, ${INSTALL_WORD[harness]} ${state.version}, blocked by policy: a managed setting (allowManagedHooksOnly) stops the hooks of user plugins`;
  }
}

/** `collie harness status`. */
export function cmdHarnessStatus(deps: HarnessLinkDeps): number {
  for (const harness of LINK_HARNESSES) deps.io.out(`${harness}: ${linkStateWords(harness, linkState(deps, harness))}`);
  return EXIT.OK;
}

/**
 * `collie harness sync`, run by `collie update` through the new binary: rewrite each linked part with
 * this build's, never over a newer one. Registers nothing and runs no harness: a Claude Code
 * folder-marketplace plugin is read from its folder. One line per harness it touched.
 */
export function cmdHarnessSync(deps: HarnessLinkDeps): number {
  for (const harness of LINK_HARNESSES) {
    if (!isLinked(deps, harness)) continue;
    const wrote = writePart(deps, harness);
    if (wrote.kind === "written" && wrote.version !== null) {
      writeRecord(deps, harness, wrote.version);
      deps.io.out(`harness sync: ${harness} ${INSTALL_WORD[harness]} ${wrote.version}`);
    } else if (wrote.kind === "kept-newer") deps.io.out(`harness sync: ${harness} kept the newer ${INSTALL_WORD[harness]} ${wrote.version ?? "?"}`);
  }
  return EXIT.OK;
}

/** `collie uninstall`: unlink every linked harness. One line each. */
/** The harnesses with a link record or a part of ours on disk: what `unlinkAll` would take away. */
export function linkedHarnessNames(ctx: CliContext, files: HarnessLinkDeps["files"]): LinkHarness[] {
  return LINK_HARNESSES.filter((harness) => isLinked({ ctx, files }, harness) || partOnDisk({ ctx, files }, harness) !== null);
}

export function unlinkAll(deps: HarnessLinkDeps): void {
  for (const harness of linkedHarnessNames(deps.ctx, deps.files)) {
    const done = unlinkOne(deps, harness);
    deps.io.out(`  unlinked ${harness}${done.note === null ? "" : ` (warning: ${done.note})`}`);
  }
}

/** The sub-verbs of `collie harness`, in the order the usage block prints them. */
export const HARNESS_SUBCOMMANDS = ["link", "unlink", "status", "sync"] as const;

/** The usage line of the harness verbs. */
export function harnessUsage(): string {
  return `usage: collie harness link <${LINK_HARNESSES.join("|")}> | collie harness unlink <harness> | collie harness status | collie harness sync`;
}

/**
 * The bare `collie link` and `collie unlink` with an argument: refused. They have one meaning, the name
 * on PATH (ADR 0021), and take no argument; the harness verbs are `collie harness link` and `unlink`.
 */
export function bareLinkRefusal(verb: "link" | "unlink"): string {
  const what = verb === "link" ? "puts `collie` on your PATH" : "removes `collie` from your PATH";
  return `error: \`collie ${verb}\` takes no argument; it ${what}. To ${verb} a harness, run \`collie harness ${verb} <harness>\`.`;
}

/** The doctor rows, one per harness (`link-<harness>`). Files only; the harness version comes from the harness rows. */
export function linkFindings(deps: Pick<HarnessLinkDeps, "ctx" | "files" | "managedSettings" | "version" | "parts">, harnessVersion: (harness: string) => string | null): Finding[] {
  const rows = LINK_HARNESSES.map((harness) => {
    const check = `link-${harness}`;
    const state = linkState(deps, harness);
    const words = linkStateWords(harness, state);
    if (state.kind === "not-linked") {
      const built = harness === "claude" || (deps.parts ?? BUILT_PARTS)[harness] !== null;
      return ok(check, built ? `not linked: an optional experiment; Collie uses the screen path` : `not linked: no ${INSTALL_WORD[harness]} for it in this build`);
    }
    if (state.kind === "older" || state.kind === "missing") return warn(check, words, `\`collie harness link ${harness}\` writes this build's ${INSTALL_WORD[harness]}`);
    if (state.kind === "blocked") return warn(check, words, "ask the administrator to allow the hooks of user plugins, or leave it: Collie uses the screen path");
    const version = harnessVersion(harness);
    if (harness === "claude" && version !== null && compareSemver(version, CLAUDE_DATA_PATH_FROM) < 0) {
      return warn(check, `${words}; Claude Code ${version} is not verified for the data path`, `update Claude Code to ${CLAUDE_DATA_PATH_FROM} or later; until then Collie may fall back to the screen path`);
    }
    return ok(check, words);
  });
  return linked(deps) ? [...rows, folderFinding(deps)] : rows;
}

/** Whether any harness is linked: only then does the folder row speak. */
function linked(deps: Pick<HarnessLinkDeps, "ctx" | "files">): boolean {
  return LINK_HARNESSES.some((harness) => isLinked(deps, harness));
}

/**
 * `link-folder`: the parts folder this shell links into against the one this instance's running bridge
 * reads, from its hook target file. A unit written before the folder moved does not carry it, and the
 * bridge then never sees the link: `collie restart` writes the unit again with the folder.
 */
function folderFinding(deps: Pick<HarnessLinkDeps, "ctx" | "files">): Finding {
  const mine = partsRoot(deps.ctx.env, deps.ctx.home);
  const text = deps.files.read(join(hookTargetsDir(deps.ctx.env, deps.ctx.home), hookTargetFileName(deps.ctx.stateDir)));
  const record = text === null ? null : parseHookTarget(text);
  if (record === null) return skipped("link-folder", "the bridge is not running: it reads the plugins folder at its start", "`collie start`");
  if (record.parts === undefined || record.parts === null) return skipped("link-folder", "the running bridge does not name its plugins folder (an older build)", "`collie restart` after the update");
  if (record.parts === mine) return ok("link-folder", `the bridge reads the same plugins folder: ${mine}`);
  return warn("link-folder", `the bridge reads ${record.parts}, this shell links into ${mine}: the bridge does not see the link`, "`collie restart` writes the folder into the service and restarts the bridge");
}
