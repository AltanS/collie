// The login of a Claude run (M56 spec 10). A fresh config dir has no login, so the lab copies the
// person's OAuth file into the run directory and deletes the copy when the run ends.
//
// ONE RULE ABOVE THE REST: the copy has no refresh token. A refresh in the lab would turn the person's
// refresh token over, and the real login on this machine would stop working. With no refresh token the
// run can only use the access token it was given, and a run that outlives it fails and is marked failed.
// The lab refuses to start when the access token has less than {@link MIN_MINUTES_LEFT} minutes left.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { EMPTY_MCP_FILE } from "./harnesses";
import { join } from "node:path";
import { asJsonObject, asJsonNumber, parseJson, type JsonObject } from "../../../web/src/lib/json";

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
