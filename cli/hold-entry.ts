import { join } from "node:path";

import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonString, parseJson } from "../web/src/lib/json.ts";

// The hold entry in a settings file (M56 spec 12), read by two callers that must agree: `collie hooks`
// (cli/hooks.ts), which writes it, and the edge emitter (cli/beacon.ts), which says on each edge
// whether the agent's settings hold permissions. A module of its own, so neither imports the other.

/** What follows the binary in the hold command. */
export const HOLD_VERB = " beacon hold ";

/** The ownership marker prefix, the same text as `HOOK_MARKER_PREFIX` in cli/hooks.ts (a test pins it). */
export const HOLD_MARKER_PREFIX = "# collie-beacon v";

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value instanceof Object && !Array.isArray(value) ? value : null;
}

/** The marked hold command under `event` in a settings document, or null when there is none. */
export function holdCommandIn(document: JsonValue | null, event: string): string | null {
  const groups = asObject(asObject(document ?? undefined)?.hooks)?.[event];
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    const entries = asObject(group)?.hooks;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const command = asJsonString(asObject(entry)?.command);
      if (command === undefined) continue;
      if (command.includes(HOLD_MARKER_PREFIX) && command.includes(HOLD_VERB)) return command;
    }
  }
  return null;
}

/**
 * The settings file the agent in this environment reads: `$CLAUDE_CONFIG_DIR/settings.json`, else
 * `~/.claude/settings.json`. The variable name is the harness's own; this module is not under the
 * surface folders, where no harness name may live.
 */
export function agentSettingsPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(agentConfigRoot(env, home), "settings.json");
}

/** The harness's config root: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Its transcripts live under it. */
export function agentConfigRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir !== undefined && dir !== "" ? dir : join(home, ".claude");
}

/**
 * The managed settings file an administrator may install, which outranks every other (the harness's
 * documented paths per platform). It can turn every hook off, or allow only its own hooks.
 */
export function managedSettingsPath(platform: string): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** The project's two settings files, under the folder the agent runs in. */
export function projectSettingsPaths(cwd: string): string[] {
  return [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")];
}

/** The settings texts the agent reads, as far as the hold is concerned. Null: no such file, or unreadable. */
export interface AgentSettingsTexts {
  readonly user: string | null;
  readonly project: readonly (string | null)[];
  readonly managed: string | null;
}

function flagOn(text: string | null, key: string): boolean {
  if (text === null || text.trim() === "") return false;
  const document = parseJson(text);
  return document instanceof Object && !Array.isArray(document) && document[key] === true;
}

/**
 * Whether the agent's settings hold permissions for `event`, read as the harness reads them: the hold
 * entry in the user file or a project file, and no file that turns it off. `disableAllHooks` in any
 * file turns every hook off. `allowManagedHooksOnly` in the managed file runs only the administrator's
 * hooks, so the user's hold never runs.
 */
export function agentHolds(texts: AgentSettingsTexts, event: string): boolean {
  const all = [texts.user, ...texts.project, texts.managed];
  if (all.some((text) => flagOn(text, "disableAllHooks"))) return false;
  if (flagOn(texts.managed, "allowManagedHooksOnly")) return false;
  return [texts.user, ...texts.project].some((text) => settingsHold(text, event));
}

/** Whether the settings text holds the hold entry for `event`. Unreadable text holds nothing. */
export function settingsHold(text: string | null, event: string): boolean {
  if (text === null || text.trim() === "") return false;
  const document = parseJson(text);
  return document !== undefined && holdCommandIn(document, event) !== null;
}
