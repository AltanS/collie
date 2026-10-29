// The login of a Claude run (M56 spec 10). A fresh config dir has no login, so the lab copies the
// person's OAuth file into the run directory and deletes the copy when the run ends.
//
// ONE RULE ABOVE THE REST: the copy has no refresh token. A refresh in the lab would turn the person's
// refresh token over, and the real login on this machine would stop working. With no refresh token the
// run can only use the access token it was given, and a run that outlives it fails and is marked failed.
// The lab refuses to start when the access token has less than {@link MIN_MINUTES_LEFT} minutes left.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { codexHome, EMPTY_MCP_FILE, type EnvMap, type HarnessSpec, type RunDirs } from "./harnesses";
import { dirname, join } from "node:path";
import { asJsonObject, asJsonNumber, asJsonString, parseJson, type JsonObject } from "../../../web/src/lib/json";

/** The access token must last this long, so the run never meets its end. A run takes about ten minutes. */
export const MIN_MINUTES_LEFT = 25;

export class LabInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabInfraError";
  }
}

/** The login is not usable yet. Nothing was run and nothing was spent, so no ledger row is written. */
export class LabDeferred extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabDeferred";
  }
}

export interface SeedSource {
  /** The person's Claude config dir, default `~/.claude`. */
  readonly configDir: string;
  /** The person's `.claude.json`, default `~/.claude.json`. */
  readonly stateFile: string;
}

export function defaultSource(home: string = homedir()): SeedSource {
  return { configDir: join(home, ".claude"), stateFile: join(home, ".claude.json") };
}

/** The credentials text without any refresh token. Pure, for the test. */
export interface Stripped {
  readonly text: string;
  readonly minutesLeft: number;
}

export function withoutRefresh(text: string): Stripped {
  const root = asJsonObject(parseJson(text));
  const oauth = asJsonObject(root?.claudeAiOauth);
  const expiresAt = asJsonNumber(oauth?.expiresAt);
  if (root === undefined || oauth === undefined || expiresAt === undefined) throw new LabInfraError("the Claude login file has no claudeAiOauth block with an expiry");
  const copy: JsonObject = {};
  for (const [key, value] of Object.entries(oauth)) if (!/refresh/iu.test(key)) copy[key] = value;
  return { text: JSON.stringify({ ...root, claudeAiOauth: copy }), minutesLeft: (expiresAt - Date.now()) / 60_000 };
}

/** The `.claude.json` of the run: the account, no project history, and this one project trusted. */
export function runState(text: string, project: string): string {
  const root = asJsonObject(parseJson(text)) ?? {};
  const keep: JsonObject = {};
  for (const key of ["oauthAccount", "userID", "hasCompletedOnboarding", "numStartups", "installMethod", "firstStartTime"]) {
    const value = root[key];
    if (value !== undefined) keep[key] = value;
  }
  keep.hasCompletedOnboarding = true;
  // Claude 2.1.301 asks a fresh config "Try the new fullscreen renderer?" until this counter reaches 3.
  // The lab is a fresh config on every run, so the question would be its first screen every time.
  keep.fullscreenUpsellSeenCount = 3;
  keep.projects = { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } };
  return JSON.stringify(keep);
}

/** Copy the login into `configDir`. Returns the minutes the access token has left. */
export function seedClaude(configDir: string, project: string, source: SeedSource = defaultSource(), minMinutes: number = MIN_MINUTES_LEFT): number {
  const credentials = join(source.configDir, ".credentials.json");
  if (!existsSync(credentials)) throw new LabDeferred(`no Claude login at ${credentials}`);
  const { text, minutesLeft } = withoutRefresh(readFileSync(credentials, "utf8"));
  if (minutesLeft < minMinutes) {
    throw new LabDeferred(`the Claude access token has ${String(Math.max(0, Math.floor(minutesLeft)))} minutes left, and the lab needs ${String(minMinutes)}; a live Claude session refreshes it`);
  }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const target = join(configDir, ".credentials.json");
  writeFileSync(target, text, { mode: 0o600 });
  chmodSync(target, 0o600);
  const state = existsSync(source.stateFile) ? readFileSync(source.stateFile, "utf8") : "{}";
  writeFileSync(join(configDir, ".claude.json"), runState(state, project), { mode: 0o600 });
  // `--strict-mcp-config` reads this file and nothing else, so no MCP server of the person starts.
  writeFileSync(join(configDir, EMPTY_MCP_FILE), `${JSON.stringify({ mcpServers: {} })}\n`);
  return minutesLeft;
}

/** The access token of a replayed Claude (M67 spec 07): not a token at all, and shaped like no key. */
export const REPLAY_TOKEN = "collie-rig-replay-no-token";

/**
 * The credentials text of a replayed Claude, pure: the real file's `scopes`, `subscriptionType` and
 * `rateLimitTier` (so the screen's header reads as it does live), the dummy access token, an expiry one
 * day ahead, and no refresh token. With no real file (`null`), a Max login with the inference scope.
 * The real access token is never read into the result.
 */
export function replayLogin(text: string | null, now: number = Date.now()): string {
  const oauth = text === null ? undefined : asJsonObject(asJsonObject(parseJson(text))?.claudeAiOauth);
  const copy: JsonObject = { scopes: ["user:inference"], subscriptionType: "max" };
  for (const key of ["scopes", "subscriptionType", "rateLimitTier"]) {
    const value = oauth?.[key];
    if (value !== undefined) copy[key] = value;
  }
  return JSON.stringify({ claudeAiOauth: { ...copy, accessToken: REPLAY_TOKEN, expiresAt: now + 24 * 60 * 60_000 } });
}

/**
 * Seed a Claude whose model calls the rig's stub replays (M67 spec 07): the same config as seedClaude,
 * but a dummy login, so a replay needs no Claude login and never meets the 25-minute rule. Claude
 * 2.1.312 starts and answers from the stub on such a file (probed 2026-10-29); with it, its own calls
 * to Anthropic (account extras) fail quietly, and nothing real is ever sent.
 */
export function seedClaudeReplay(configDir: string, project: string, source: SeedSource = defaultSource()): void {
  const credentials = join(source.configDir, ".credentials.json");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const target = join(configDir, ".credentials.json");
  writeFileSync(target, replayLogin(existsSync(credentials) ? readFileSync(credentials, "utf8") : null), { mode: 0o600 });
  chmodSync(target, 0o600);
  const state = existsSync(source.stateFile) ? readFileSync(source.stateFile, "utf8") : "{}";
  writeFileSync(join(configDir, ".claude.json"), runState(state, project), { mode: 0o600 });
  writeFileSync(join(configDir, EMPTY_MCP_FILE), `${JSON.stringify({ mcpServers: {} })}\n`);
}

/** The person's Codex login file, default `~/.codex/auth.json`. */
export interface CodexSource {
  readonly authFile: string;
}

export function defaultCodexSource(home: string = homedir()): CodexSource {
  return { authFile: join(home, ".codex", "auth.json") };
}

/**
 * The Codex login text for a run, or a refusal. Only an API key login is copied: a ChatGPT login holds a
 * refresh token, and a refresh inside the lab would turn the real one over, as with Claude. An API key has
 * nothing to turn over, and the copy is deleted with the run folder.
 */
export function codexLoginText(text: string): string {
  const root = asJsonObject(parseJson(text));
  const key = asJsonString(root?.OPENAI_API_KEY);
  const holdsToken = root !== undefined && Object.keys(root).some((name) => /token/iu.test(name));
  if (root === undefined || key === undefined || key.length === 0) {
    throw new LabDeferred("the Codex login is not an API key login, and the lab copies only that: a ChatGPT login holds a refresh token that a run could turn over");
  }
  if (holdsToken) throw new LabDeferred("the Codex login file holds a token beside the API key, and the lab will not copy a refresh token");
  return text;
}

/** Copy the Codex API key login into the run's `CODEX_HOME`, mode 600. */
export function seedCodex(home: string, source: CodexSource = defaultCodexSource()): void {
  if (!existsSync(source.authFile)) throw new LabDeferred(`no Codex login at ${source.authFile}`);
  const text = codexLoginText(readFileSync(source.authFile, "utf8"));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = join(home, "auth.json");
  writeFileSync(target, text, { mode: 0o600 });
  chmodSync(target, 0o600);
}

/**
 * The OpenRouter key an omp run signs in with: `OPENROUTER_API_KEY` of the lab's own environment, or that
 * name in the dotenv file `COLLIE_RIG_KEY_FILE` names, as the browser rig reads it. It travels in the
 * environment of the lab's tmux server only: never in a file of the run, never on a command line.
 */
export function openrouterKey(env: Readonly<Record<string, string | undefined>>): string {
  const direct = env.OPENROUTER_API_KEY;
  if (direct !== undefined && direct !== "") return direct;
  const file = env.COLLIE_RIG_KEY_FILE;
  if (file === undefined || file === "") throw new LabDeferred("no OpenRouter key: set OPENROUTER_API_KEY, or COLLIE_RIG_KEY_FILE to a dotenv file that holds it");
  if (!existsSync(file)) throw new LabDeferred(`COLLIE_RIG_KEY_FILE names ${file}, which does not exist`);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/u.exec(line);
    const value = match?.[1]?.replace(/^(["'])(.*)\1$/u, "$2");
    if (value !== undefined && value !== "") return value;
  }
  throw new LabDeferred(`${file} holds no OPENROUTER_API_KEY`);
}

/** The login a harness signs in with through its environment: only omp's OpenRouter key today. */
export function loginEnv(spec: HarnessSpec, env: Readonly<Record<string, string | undefined>>): EnvMap {
  return spec.login === "openrouter" ? { OPENROUTER_API_KEY: openrouterKey(env) } : {};
}

export interface PrepareOptions {
  readonly seedSource?: SeedSource | undefined;
  readonly minLoginMinutes?: number | undefined;
  readonly codexSource?: CodexSource | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Everything a harness needs before its first start: its folders, its config files and its login copy.
 * It throws {@link LabDeferred} when the login is not usable. Nothing was spent then, and no row is written.
 */
export function prepareRun(spec: HarnessSpec, dirs: RunDirs, options: PrepareOptions = {}): void {
  for (const folder of spec.folders(dirs)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const [path, text] of Object.entries(spec.files(dirs))) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  }
  switch (spec.login) {
    case "claude":
      seedClaude(dirs.config, dirs.project, options.seedSource, options.minLoginMinutes);
      return;
    case "codex":
      seedCodex(codexHome(dirs), options.codexSource);
      return;
    case "openrouter":
      // Checked here so that a missing key defers the run before the claim. The key itself is passed to tmux.
      openrouterKey(options.env ?? process.env);
      return;
    case "none":
      return;
  }
}
