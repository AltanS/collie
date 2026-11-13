// `collie link <harness>`, `collie unlink <harness>`, `collie link status` (M99 spec 09, README
// decision 12): the opt-in for the data path. Nothing links by itself.
//
// The bare `collie link` and `collie unlink` keep their meaning (the PATH name, cli/link.ts, ADR 0021);
// a harness word, or `status`, picks this module.
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
//    older one; `link sync` (run by `collie update`) rewrites a linked part with this build's.
//  - The link record (`<harness>.link.json` beside the parts) is written last and removed first. The
//    bridge opens its inside socket while one is there (bridge/inside/links.ts).
//  - No unit, no bridge and no session is restarted, and no settings file is touched.

import { HOST } from "../bridge/host.ts";
import { join } from "node:path";

import { linkRecordPath, parseLinkRecord, partsRoot, configHome } from "../bridge/inside/links.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { compareSemver } from "../web/src/lib/semver.ts";
import type { CliContext } from "./context.ts";
import { collieVersionBare } from "./context.ts";
import { managedSettingsPath } from "./hold-entry.ts";
import { CLAUDE_MOD_FILES, CLAUDE_MOD_NAME, claudeModVersion } from "./inside-embed.ts";
import { ok, warn, type Finding } from "./finding.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";

/** The harnesses a part may exist for, in the order the verbs and the doctor list them. */
export const LINK_HARNESSES = ["claude", "pi", "omp", "opencode"] as const;
export type LinkHarness = (typeof LINK_HARNESSES)[number];

export function isLinkHarness(word: string): word is LinkHarness {
  return LINK_HARNESSES.some((harness) => harness === word);
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

/** The part text this build carries for a file harness, or null: no part for it in this build yet. */
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
}

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
    for (const file of CLAUDE_MOD_FILES) {
      const target = join(dir, file.path);
      deps.files.mkdirp(join(target, ".."), 0o755);
      deps.files.write(target, file.text, 0o644);
    }
    deps.files.write(join(dir, ".claude-plugin", "marketplace.json"), marketplaceText(), 0o644);
    return { kind: "written", version: ours };
  }
  const text = (deps.parts ?? BUILT_PARTS)[harness];
  if (text === null) return { kind: "no-part", version: null };
  const path = filePartPath(deps.ctx, harness);
  if (there === null && deps.files.exists(path)) return { kind: "foreign", version: null };
  deps.files.mkdirp(join(path, ".."), 0o755);
  deps.files.write(path, `${markerLine(harness, ours)}\n${text}`, 0o644);
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

/** `collie link <harness>`. */
export function cmdHarnessLink(deps: HarnessLinkDeps, harness: LinkHarness): number {
  const { io } = deps;
  if (harness === "claude" && deps.exec.which("claude") === null) {
    io.err("error: claude is not on PATH. Install Claude Code first, then run `collie link claude` again.");
    return EXIT.FAIL;
  }
  const wrote = writePart(deps, harness);
  if (wrote.kind === "no-part") {
    io.err(`error: this Collie has no part for ${harness} yet.`);
    return EXIT.FAIL;
  }
  if (wrote.kind === "foreign") {
    const where = harness === "claude" ? claudePartDir(deps.ctx) : filePartPath(deps.ctx, harness);
    io.err(`error: ${where} is not a Collie part. Leaving it alone.`);
    return EXIT.FAIL;
  }
  if (wrote.kind === "kept-newer") io.out(`kept the part ${wrote.version ?? "?"} that is there: it is newer than this Collie (${ourVersion(deps)}).`);
  if (harness === "claude") {
    const failed = registerClaude(deps);
    if (failed !== null) {
      io.err(`error: Claude Code did not register the part: ${failed}`);
      io.err("  The part is written but not linked. Run `collie link claude` again.");
      return EXIT.FAIL;
    }
  }
  const version = wrote.version ?? ourVersion(deps);
  writeRecord(deps, harness, version);
  io.out(`linked ${harness}: part ${version}.`);
  if (harness === "claude") io.out("  A running Claude Code session takes it after /reload-plugins; a new session takes it at start.");
  if (blockedByPolicy(deps, harness)) io.out("  note: a managed setting (allowManagedHooksOnly) stops the hooks of user plugins here, so the part stays idle.");
  return EXIT.OK;
}

/** Take a harness's part away: the record first, then the registration, then the files that are ours. */
function unlinkOne(deps: HarnessLinkDeps, harness: LinkHarness): Unlinked {
  const record = linkRecordPath(deps.ctx.env, deps.ctx.home, harness);
  const had = deps.files.exists(record);
  if (had) deps.files.remove(record);
  let note: string | null = null;
  if (harness === "claude") {
    if (deps.exec.which("claude") === null) note = "claude is not on PATH, so its plugin list still names the part";
    else {
      const plugins = claude(deps, ["list", "--json"]);
      if (plugins.ok && plugins.out.includes(CLAUDE_PLUGIN_ID)) {
        const gone = claude(deps, ["uninstall", CLAUDE_PLUGIN_ID, "--scope", "user", "--json"]);
        if (!gone.ok) note = `Claude Code did not uninstall the part: ${gone.why}`;
      }
      const markets = claude(deps, ["marketplace", "list", "--json"]);
      if (markets.ok && markets.out.includes(`"${CLAUDE_MARKETPLACE}"`)) {
        const gone = claude(deps, ["marketplace", "remove", CLAUDE_MARKETPLACE, "--scope", "user", "--json"]);
        if (!gone.ok) note ??= `Claude Code did not remove the marketplace: ${gone.why}`;
      }
    }
    const ours = partOnDisk(deps, harness) !== null;
    if (ours) deps.files.removeTree(claudePartDir(deps.ctx));
    return { removed: had || ours, note };
  }
  const ours = partOnDisk(deps, harness) !== null;
  if (ours) deps.files.remove(filePartPath(deps.ctx, harness));
  return { removed: had || ours, note };
}

/** `collie unlink <harness>`. */
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

/** One harness's link state, as `link status` and `doctor` read it. Files only; no harness is run. */
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
      return `linked, part ${state.version}`;
    case "older":
      return `linked, part ${state.version} is older than this Collie (${state.ours}): run \`collie link ${harness}\``;
    case "missing":
      return `linked, but the part is gone: run \`collie link ${harness}\``;
    case "blocked":
      return `linked, part ${state.version}, blocked by policy: a managed setting (allowManagedHooksOnly) stops the hooks of user plugins`;
  }
}

/** `collie link status`. */
export function cmdLinkStatus(deps: HarnessLinkDeps): number {
  for (const harness of LINK_HARNESSES) deps.io.out(`${harness}: ${linkStateWords(harness, linkState(deps, harness))}`);
  return EXIT.OK;
}

/**
 * `collie link sync`, run by `collie update` through the new binary: rewrite each linked part with
 * this build's, never over a newer one. Registers nothing and runs no harness: a Claude Code
 * folder-marketplace plugin is read from its folder. One line per harness it touched.
 */
export function cmdLinkSync(deps: HarnessLinkDeps): number {
  for (const harness of LINK_HARNESSES) {
    if (!isLinked(deps, harness)) continue;
    const wrote = writePart(deps, harness);
    if (wrote.kind === "written" && wrote.version !== null) {
      writeRecord(deps, harness, wrote.version);
      deps.io.out(`link sync: ${harness} part ${wrote.version}`);
    } else if (wrote.kind === "kept-newer") deps.io.out(`link sync: ${harness} kept the newer part ${wrote.version ?? "?"}`);
  }
  return EXIT.OK;
}

/** `collie uninstall`: unlink every linked harness. One line each. */
export function unlinkAll(deps: HarnessLinkDeps): void {
  for (const harness of LINK_HARNESSES) {
    if (!isLinked(deps, harness) && partOnDisk(deps, harness) === null) continue;
    const done = unlinkOne(deps, harness);
    deps.io.out(`  unlinked ${harness}${done.note === null ? "" : ` (warning: ${done.note})`}`);
  }
}

/** The usage line of the harness verbs. */
export function harnessLinkUsage(): string {
  return `usage: collie link <${LINK_HARNESSES.join("|")}> | collie unlink <harness> | collie link status`;
}

/** The doctor rows, one per harness (`link-<harness>`). Files only; the harness version comes from the harness rows. */
export function linkFindings(deps: Pick<HarnessLinkDeps, "ctx" | "files" | "managedSettings" | "version" | "parts">, harnessVersion: (harness: string) => string | null): Finding[] {
  return LINK_HARNESSES.map((harness) => {
    const check = `link-${harness}`;
    const state = linkState(deps, harness);
    const words = linkStateWords(harness, state);
    if (state.kind === "not-linked") {
      const built = harness === "claude" || (deps.parts ?? BUILT_PARTS)[harness] !== null;
      return ok(check, built ? `not linked: \`collie link ${harness}\` lets Collie send to it by data` : "not linked: no part for it in this build yet");
    }
    if (state.kind === "older" || state.kind === "missing") return warn(check, words, `\`collie link ${harness}\` writes this build's part`);
    if (state.kind === "blocked") return warn(check, words, "ask the administrator to allow the hooks of user plugins, or leave it: Collie uses the screen path");
    const version = harnessVersion(harness);
    if (harness === "claude" && version !== null && compareSemver(version, CLAUDE_DATA_PATH_FROM) < 0) {
      return warn(check, `${words}; Claude Code ${version} is not verified for the data path`, `update Claude Code to ${CLAUDE_DATA_PATH_FROM} or later; until then Collie may fall back to the screen path`);
    }
    return ok(check, words);
  });
}
