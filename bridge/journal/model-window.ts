// How big a model's context window is, from the harness's OWN model catalog on disk (.adr/0115,
// amended 2026-10-25). The context dot needs a window, and pi, Oh My Pi and OpenCode do not write one
// into the session log. Each keeps a catalog of the models it can call, with the window per model, in
// a file of its own. Collie reads that file, and only that file.
//
// ── THE RULE: NO WINDOW, NO CONTEXT ───────────────────────────────────────────────────────────────
//
// A window comes from the session log (Codex, read by its probe), else from one of the catalogs below
// when it names the model, else from nowhere: no context dot, and the model label still draws. Collie
// ships no table of windows, guesses none, spawns no process and asks no network for one. A catalog
// that is missing, too big, unreadable or silent about the model is "no window".
//
//   pi        `<agent dir>/models-store.json`  { <provider>: { models: [{ id, contextWindow }] } }
//   Oh My Pi  `<agent dir>/models.db`          table `model_cache(provider_id, models)`, the row named
//                                              by the provider (`openrouter`, or `openrouter:<suffix>`),
//                                              `models` a JSON array of { id, contextWindow }
//   OpenCode  `$XDG_CACHE_HOME/opencode/models.json` (models.dev's catalog)
//                                              { <provider>: { models: { <id>: { limit: { context } } } } }
//
// Read on this machine on 2026-10-25: pi 0.87.1's store, OMP 18.6.1's database (its OpenRouter row is
// `openrouter:pseudo-api`) and OpenCode's cache all name `openai/gpt-6-luna` at 1,050,000.
//
// ── WHAT IT COSTS ─────────────────────────────────────────────────────────────────────────────────
//
// A catalog is a few megabytes, so each answer is kept for the bridge's run: one read per model id,
// not per probe. A model the catalog does not name is asked again after {@link CATALOG_MISS_RETRY_MS},
// because the harness refreshes its catalog on its own. A file over {@link CATALOG_MAX_BYTES} (or a
// database row over it) is not read at all. Nothing is ever written; the database opens read-only.

import { Database } from "bun:sqlite";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { asRecord } from "./cache-probe.ts";

/** A catalog bigger than this is not read. OpenCode's is about 6 MB, OMP's largest row about 3 MB. */
export const CATALOG_MAX_BYTES = 16 * 1024 * 1024;

/** How long a model the catalog did not name stays unnamed before the catalog is asked again. */
export const CATALOG_MISS_RETRY_MS = 10 * 60 * 1000;

/** The largest window a catalog may name. A bound on a strange file, not a model's window. */
const WINDOW_MAX = 100_000_000;

/** A window as a catalog may state it: a whole, positive number of tokens under the bound. */
export function asWindow(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= WINDOW_MAX ? value : undefined;
}

/** The context a probe measured on one turn, with the provider and model that turn ran on. */
export interface MeasuredContext {
  tokens: number;
  provider?: string;
  model?: string;
}

/** One catalog's answer for `provider` and `model`, or undefined. Never throws. */
export type CatalogLookup = (provider: string, model: string) => Promise<number | undefined>;

/** The text of a catalog file, or null when it is absent, not a file or too big. */
async function catalogText(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > CATALOG_MAX_BYTES) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function parsed(text: string): JsonValue | undefined {
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; every read below goes through
    // `asRecord` or `asWindow`.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** An object's OWN member, so a name from a log (`constructor`, `__proto__`) never reaches a prototype. */
function own(value: JsonValue | undefined, key: string): JsonValue | undefined {
  const record = asRecord(value);
  return record !== null && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The window an array of `{ id, contextWindow }` entries names for `model`. */
function windowInList(list: JsonValue | undefined, model: string): number | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    const entry = asRecord(item);
    if (entry !== null && entry.id === model) return asWindow(entry.contextWindow);
  }
  return undefined;
}

/** pi's `models-store.json`: per provider, the models it fetched, each with its `contextWindow`. */
export function piModelsStoreWindow(path: string): CatalogLookup {
  return async (provider, model) => {
    const text = await catalogText(path);
    if (text === null) return undefined;
    return windowInList(own(own(parsed(text), provider), "models"), model);
  };
}

/**
 * Oh My Pi's `models.db`. The row is the provider's own (`anthropic`) or a variant of it
 * (`openrouter:pseudo-api`); the plain row is tried first.
 */
export function ompModelsDbWindow(path: string): CatalogLookup {
  return async (provider, model) => {
    try {
      const info = await stat(path);
      if (!info.isFile()) return undefined;
    } catch {
      return undefined;
    }
    let db: Database;
    try {
      db = new Database(path, { readonly: true });
    } catch {
      return undefined;
    }
    try {
      const rows = db
        .query<{ provider_id: string; models: string }, [string, number, string, number]>(
          "select provider_id, models from model_cache where (provider_id = ?1 or substr(provider_id, 1, ?2) = ?3) and length(models) <= ?4 order by provider_id = ?1 desc, provider_id",
        )
        .all(provider, provider.length + 1, `${provider}:`, CATALOG_MAX_BYTES);
      for (const row of rows) {
        const window = windowInList(parsed(row.models), model);
        if (window !== undefined) return window;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      db.close();
    }
  };
}

/** OpenCode's copy of the models.dev catalog: `<provider>.models.<id>.limit.context`. */
export function opencodeModelsWindow(path: string): CatalogLookup {
  return async (provider, model) => {
    const text = await catalogText(path);
    if (text === null) return undefined;
    return asWindow(own(own(own(own(own(parsed(text), provider), "models"), model), "limit"), "context"));
  };
}

/** The catalogs an agent dir of pi or Oh My Pi may hold, pi's first. */
export function piAgentDirLookups(agentDir: string): CatalogLookup[] {
  return [piModelsStoreWindow(join(agentDir, "models-store.json")), ompModelsDbWindow(join(agentDir, "models.db"))];
}

interface Held {
  window: number | undefined;
  at: number;
}

/**
 * The answers of a set of catalogs, kept for the bridge's run. A name the catalogs know is read once;
 * one they do not know is asked again after {@link CATALOG_MISS_RETRY_MS}.
 */
export class WindowCatalog {
  private readonly held = new Map<string, Held>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The first window `lookups` name for `provider` and `model`, in order. `scope` keeps two catalog
   * sets apart (pi's agent dir and OMP's), so the same model id in each is asked of its own.
   */
  async window(scope: string, lookups: readonly CatalogLookup[], provider: string, model: string): Promise<number | undefined> {
    const key = `${scope}\u0000${provider}\u0000${model}`;
    const known = this.held.get(key);
    const at = this.now();
    if (known !== undefined && (known.window !== undefined || at - known.at < CATALOG_MISS_RETRY_MS)) return known.window;
    let window: number | undefined;
    for (const lookup of lookups) {
      window = await lookup(provider, model);
      if (window !== undefined) break;
    }
    this.held.set(key, { window, at });
    return window;
  }
}
