import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { fetchFilesDir } from "@/lib/api";
import { dirUnderRoot } from "@/lib/file-paths";
import { resolveAtQuery, suggestFiles, type AtToken, type FileSuggestion } from "@/lib/file-suggest";
import type { Scope } from "@/lib/scope";
import type { FileEntry } from "@/lib/types";

/** How long one folder's listing stays fresh in memory for `@` completion. */
export const FILE_SUGGEST_TTL_MS = 30_000;
const MAX_FOLDER_CACHE = 64;

type ContextRootEntry =
  | { readonly kind: "known"; readonly root: string; readonly baseDir: string; readonly at: number }
  | { readonly kind: "unavailable"; readonly at: number };

interface FolderEntry {
  readonly state: "idle" | "ready" | "loading" | "missing" | "failed" | "unavailable";
  readonly entries: readonly FileEntry[];
  readonly at: number;
}

interface RequestPlan {
  readonly kind: "discover" | "known";
  readonly apiDir: string;
  readonly cacheKey: string | null;
  readonly inFlightKey: string;
  readonly failKey: string;
  readonly tokenSig: string;
}

const EMPTY_ENTRIES: readonly FileEntry[] = [];
const IDLE_FOLDER: FolderEntry = { state: "idle", entries: EMPTY_ENTRIES, at: 0 };
const LOADING_FOLDER: FolderEntry = { state: "loading", entries: EMPTY_ENTRIES, at: 0 };
const MISSING_FOLDER: FolderEntry = { state: "missing", entries: EMPTY_ENTRIES, at: 0 };
const FAILED_FOLDER: FolderEntry = { state: "failed", entries: EMPTY_ENTRIES, at: 0 };
const UNAVAILABLE_FOLDER: FolderEntry = { state: "unavailable", entries: EMPTY_ENTRIES, at: 0 };

let cacheEpoch = 0;
const paneRoots = new Map<string, ContextRootEntry>();
const folderCache = new Map<string, FolderEntry>();
const inFlight = new Set<string>();
// Keyed by `failKey` -> `tokenSig`: suppresses immediate effect re-firing on a thrown network error
// without poisoning the 30s folder cache, so changing the token or reopening `@` retries cleanly.
const failedTokens = new Map<string, string>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isFresh(at: number): boolean {
  return Date.now() - at < FILE_SUGGEST_TTL_MS;
}

function setPaneRoot(contextKey: string, entry: ContextRootEntry): void {
  paneRoots.delete(contextKey);
  paneRoots.set(contextKey, entry);
  while (paneRoots.size > MAX_FOLDER_CACHE) {
    const oldest = paneRoots.keys().next().value;
    if (oldest === undefined) break;
    paneRoots.delete(oldest);
  }
}

function freshPaneRoot(contextKey: string): ContextRootEntry | null {
  const held = paneRoots.get(contextKey);
  if (held === undefined) return null;
  if (!isFresh(held.at)) {
    paneRoots.delete(contextKey);
    return null;
  }
  return held;
}

/**
 * Computes `cwd` relative to the authoritative `root` returned by the bridge. When `cwd` lies outside
 * `root` or inside `.git`, marks the context unavailable rather than falling back to `""` (which would
 * suggest files from a root the pane is not actually inside).
 */
function recordRoot(contextKey: string, root: string, cwd: string | undefined): ContextRootEntry {
  const at = Date.now();
  if (cwd === undefined || cwd.trim() === "") {
    const entry: ContextRootEntry = { kind: "known", root, baseDir: "", at };
    setPaneRoot(contextKey, entry);
    return entry;
  }
  const rel = dirUnderRoot(root, cwd);
  if (rel === null) {
    const entry: ContextRootEntry = { kind: "unavailable", at };
    setPaneRoot(contextKey, entry);
    return entry;
  }
  const entry: ContextRootEntry = { kind: "known", root, baseDir: rel, at };
  setPaneRoot(contextKey, entry);
  return entry;
}

function rememberFolder(cacheKey: string, entries: readonly FileEntry[]): void {
  folderCache.delete(cacheKey);
  folderCache.set(cacheKey, { state: "ready", entries, at: Date.now() });
  while (folderCache.size > MAX_FOLDER_CACHE) {
    const oldest = folderCache.keys().next().value;
    if (oldest === undefined) break;
    folderCache.delete(oldest);
  }
}

/** Rejects malformed `@` syntax before probing `dir=""`, while still permitting `../` climbs prior to root discovery. */
function isValidAtRaw(raw: string): boolean {
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) return false;
  const slash = raw.lastIndexOf("/");
  const query = slash === -1 ? raw : raw.slice(slash + 1);
  if (query.toLowerCase() === ".git") return false;
  if (slash !== -1) {
    for (const part of raw.slice(0, slash).split("/")) {
      if (part === "" || part.toLowerCase() === ".git") return false;
    }
  }
  return true;
}

function readPlanFolder(contextKey: string, plan: RequestPlan | null): FolderEntry {
  if (plan === null) return IDLE_FOLDER;
  const rootEntry = freshPaneRoot(contextKey);
  if (rootEntry?.kind === "unavailable") return UNAVAILABLE_FOLDER;
  if (plan.cacheKey !== null) {
    const cached = folderCache.get(plan.cacheKey);
    if (cached !== undefined) {
      if (isFresh(cached.at)) return cached;
      folderCache.delete(plan.cacheKey);
    }
  }
  if (inFlight.has(plan.inFlightKey)) return LOADING_FOLDER;
  if (failedTokens.get(plan.failKey) === plan.tokenSig) return FAILED_FOLDER;
  return MISSING_FOLDER;
}

async function requestPlan(
  paneId: string,
  host: string,
  session: string,
  panePrefix: string,
  contextKey: string,
  cwd: string | undefined,
  plan: RequestPlan,
): Promise<void> {
  if (inFlight.has(plan.inFlightKey)) return;
  const current = readPlanFolder(contextKey, plan);
  if (current.state !== "missing") return;

  const epoch = cacheEpoch;
  inFlight.add(plan.inFlightKey);
  notifyListeners();

  const requestScope: Scope = {};
  if (host !== "") requestScope.host = host;
  if (session !== "") requestScope.session = session;

  try {
    const answer = await fetchFilesDir({ kind: "pane", paneId }, plan.apiDir, requestScope);
    if (epoch !== cacheEpoch) return;

    if (answer.outcome === "body") {
      if (!answer.body.available) {
        setPaneRoot(contextKey, { kind: "unavailable", at: Date.now() });
      } else {
        const recorded = recordRoot(contextKey, answer.body.root, cwd);
        if (recorded.kind === "known") {
          rememberFolder(`${panePrefix}\0${answer.body.root}\0${plan.apiDir}`, answer.body.entries);
        }
        failedTokens.delete(plan.failKey);
      }
    } else if (answer.outcome === "unknown-path") {
      if (plan.kind === "known" && plan.cacheKey !== null) {
        rememberFolder(plan.cacheKey, EMPTY_ENTRIES);
        failedTokens.delete(plan.failKey);
      } else if (plan.apiDir !== "" && freshPaneRoot(contextKey) === null) {
        // A `filesDir` hint can disagree with the bridge's realpath-resolved Files root (e.g. a symlinked
        // pane folder); probing `dir=""` once learns the authoritative root instead of getting stuck on 404.
        const probe = await fetchFilesDir({ kind: "pane", paneId }, "", requestScope);
        if (epoch !== cacheEpoch) return;
        if (probe.outcome === "body" && probe.body.available) {
          const recorded = recordRoot(contextKey, probe.body.root, cwd);
          if (recorded.kind === "known") {
            rememberFolder(`${panePrefix}\0${probe.body.root}\0`, probe.body.entries);
            rememberFolder(`${panePrefix}\0${probe.body.root}\0${plan.apiDir}`, EMPTY_ENTRIES);
          }
          failedTokens.delete(plan.failKey);
        } else {
          setPaneRoot(contextKey, { kind: "unavailable", at: Date.now() });
        }
      } else if (freshPaneRoot(contextKey) === null) {
        setPaneRoot(contextKey, { kind: "unavailable", at: Date.now() });
      }
    } else {
      setPaneRoot(contextKey, { kind: "unavailable", at: Date.now() });
    }
  } catch {
    if (epoch !== cacheEpoch) return;
    failedTokens.set(plan.failKey, plan.tokenSig);
  } finally {
    if (epoch === cacheEpoch) {
      inFlight.delete(plan.inFlightKey);
      notifyListeners();
    }
  }
}

export function __resetFileSuggestionsCache(): void {
  cacheEpoch += 1;
  paneRoots.clear();
  folderCache.clear();
  inFlight.clear();
  failedTokens.clear();
}

export interface FileSuggestionsInput {
  activeAt: AtToken | null;
  paneId: string;
  scope: Scope | undefined;
  cwd: string | undefined;
  /** The pane's `cwd` relative to the Files root when already known on the pane view. */
  filesDir?: string | null;
}

export interface FileSuggestionsResult {
  suggestions: readonly FileSuggestion[];
  loading: boolean;
}

/**
 * Single-folder `@` file suggestions for an agent pane (#757), reusing `GET /api/pane/:id/files?dir=`
 * within ADR 0150's single-folder bound and caching each read for 30s per `(host, session, paneId, root, dir)`.
 */
export function useFileSuggestions({
  activeAt,
  paneId,
  scope,
  cwd,
  filesDir,
}: FileSuggestionsInput): FileSuggestionsResult {
  const host = scope?.host ?? "";
  const session = scope?.session ?? "";
  const panePrefix = `${host}\0${session}\0${paneId}`;
  const contextKey = `${panePrefix}\0${cwd ?? ""}`;

  const getRootEntry = useCallback(() => freshPaneRoot(contextKey), [contextKey]);
  const rootEntry = useSyncExternalStore(subscribeStore, getRootEntry, getRootEntry);

  const resolved = useMemo(() => {
    if (activeAt === null || rootEntry?.kind !== "known") return null;
    return resolveAtQuery(activeAt.raw, rootEntry.baseDir);
  }, [activeAt, rootEntry]);

  const plan = useMemo((): RequestPlan | null => {
    if (activeAt === null || rootEntry?.kind === "unavailable") return null;
    const tokenSig = `${activeAt.start}\0${activeAt.raw}`;
    if (rootEntry?.kind === "known") {
      if (resolved === null) return null;
      const cacheKey = `${panePrefix}\0${rootEntry.root}\0${resolved.apiDir}`;
      return {
        kind: "known",
        apiDir: resolved.apiDir,
        cacheKey,
        inFlightKey: cacheKey,
        failKey: `${contextKey}\0folder\0${rootEntry.root}\0${resolved.apiDir}`,
        tokenSig,
      };
    }
    if (!isValidAtRaw(activeAt.raw)) return null;
    const hinted =
      filesDir !== undefined && filesDir !== null && filesDir !== ""
        ? resolveAtQuery(activeAt.raw, filesDir)
        : null;
    const initialDir = hinted !== null ? hinted.apiDir : "";
    return {
      kind: "discover",
      apiDir: initialDir,
      cacheKey: null,
      inFlightKey: `discover\0${contextKey}\0${initialDir}`,
      failKey: `${contextKey}\0discover\0${initialDir}`,
      tokenSig,
    };
  }, [activeAt, rootEntry, resolved, panePrefix, contextKey, filesDir]);

  const getFolder = useCallback(() => readPlanFolder(contextKey, plan), [contextKey, plan]);
  const folder = useSyncExternalStore(subscribeStore, getFolder, getFolder);

  useEffect(() => {
    if (activeAt !== null) return;
    for (const key of failedTokens.keys()) {
      if (key.startsWith(`${contextKey}\0`)) failedTokens.delete(key);
    }
  }, [activeAt, contextKey]);

  useEffect(() => {
    if (plan === null || folder.state !== "missing") return;
    void requestPlan(paneId, host, session, panePrefix, contextKey, cwd, plan);
  }, [paneId, host, session, panePrefix, contextKey, cwd, plan, folder.state]);

  const suggestions = useMemo(() => {
    if (resolved === null || folder.state !== "ready") return [];
    return suggestFiles(folder.entries, resolved.insertPrefix, resolved.query);
  }, [resolved, folder]);

  return {
    suggestions,
    loading: folder.state === "missing" || folder.state === "loading",
  };
}
