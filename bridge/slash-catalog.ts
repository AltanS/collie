import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "./json.ts";
import type { LiveSlashCommand } from "./types.ts";

// Live slash-command dumps written by the omp extension (contrib/omp/collie-slash-catalog.ts).
// Same posture as a beacon (ADR 0024): a hint file the running agent wrote, never a control
// channel and never a reason to spawn `omp --mode rpc`. The phone merges these into the palette;
// Collie still types `/name` into the PTY.
//
// This file is the parse boundary: every `typeof` below sits inside a field reader, which is why
// `anti-slop/no-runtime-typeof` is off for this ONE file in `.oxlintrc.json`.

const SCHEMA_VERSION = 1;
const HARNESS = "omp";
const SKIP_NAMES = new Set(["collie-catalog"]);
const MAX_COMMANDS = 200;
const DESCRIPTION_MAX = 140;

/** Directory under the Collie state dir. The extension writes the same path. */
export function slashCatalogDir(stateDir: string): string {
  return join(stateDir, "slash-catalog");
}

function readObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function readText(row: JsonObject, key: string): string | null {
  const value = row[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function slashName(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^\//, "");
  if (!trimmed || SKIP_NAMES.has(trimmed)) return undefined;
  return `/${trimmed}`;
}

function oneLine(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}

function paneIdOf(file: string, row: JsonObject): string | undefined {
  const herdrPaneId = readText(row, "herdrPaneId");
  if (herdrPaneId) return herdrPaneId;
  const paneKey = readText(row, "paneKey");
  if (paneKey?.startsWith("herdr-")) {
    const id = paneKey.slice("herdr-".length).trim();
    return id || undefined;
  }
  const base = file.replace(/\.json$/u, "");
  if (base.startsWith("herdr-")) {
    const id = base.slice("herdr-".length);
    return id || undefined;
  }
  return undefined;
}

function parseRecord(file: string, text: string): { paneId: string; commands: LiveSlashCommand[] } | undefined {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);

  } catch {
    return undefined;
  }
  const rec = readObject(parsed);
  if (rec === null) return undefined;
  if (rec.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (rec.harness !== HARNESS) return undefined;
  const paneId = paneIdOf(file, rec);
  if (!paneId) return undefined;
  const listed = rec.commands;
  const rows = Array.isArray(listed) ? listed : [];
  const seen = new Set<string>();
  const commands: LiveSlashCommand[] = [];
  for (const entry of rows) {
    const row = readObject(entry);
    if (row === null) continue;
    const name = readText(row, "name");
    if (name === null) continue;
    const command = slashName(name);
    if (!command || seen.has(command)) continue;
    seen.add(command);
    const description = readText(row, "description");
    commands.push({ command, description: description ? oneLine(description) : "" });
    if (commands.length >= MAX_COMMANDS) break;
  }
  return { paneId, commands };
}

/**
 * Read every per-pane dump. `latest.json` is a convenience copy for operators and is ignored.
 * Fail-closed: a missing dir, a broken file, or a record without a Herdr pane id is skipped.
 */
export function readSlashCatalogs(dir: string): Map<string, LiveSlashCommand[]> {
  const out = new Map<string, LiveSlashCommand[]>();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (file === "latest.json" || !file.endsWith(".json")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseRecord(file, text);
    if (!parsed) continue;
    out.set(parsed.paneId, parsed.commands);
  }
  return out;
}

/** Snapshot-path cache: readdir is cheap; skip it when the directory has not changed. */
export function createSlashCatalogReader(dir: string): () => Map<string, LiveSlashCommand[]> {
  let stamp = "";
  let rows = new Map<string, LiveSlashCommand[]>();
  return () => {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      stamp = "";
      rows = new Map();
      return rows;
    }
    const next = files
      .filter((f) => f.endsWith(".json"))
      .toSorted()
      .map((file) => {
        try {
          return `${file}:${statSync(join(dir, file)).mtimeMs}`;
        } catch {
          return file;
        }
      })
      .join("\0");
    if (next === stamp) return rows;
    stamp = next;
    rows = readSlashCatalogs(dir);
    return rows;
  };
}
