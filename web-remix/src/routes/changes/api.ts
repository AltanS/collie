// The reads behind Changes and Files (ADR 0065, 0083), on `bridgeGet` (lib/api.ts).
//
// web/src/lib/api.ts has the same functions, but it imports React hooks, so this shell cannot take
// it. The wire contract is the same: `?depth=&nested=` on the list, `?repo=&path=` on one file's diff,
// `?view=commit&repo=` for the last commit, `…/files` with `?dir=` or `?path=`. Every call is a GET,
// so nothing here writes and nothing marks the pane seen (a git view of the folder is not the
// pane's conversation).
//
// A Files read can be REFUSED, and the two 404s mean different things: `unknown-path` is the bridge's
// one answer for a path that is absent, outside the root, denied or the wrong kind; any other 404 is a
// member one release behind with no `files` segment (`stale`). A 403 is told apart by its plain-text
// body. Each becomes a value here instead of a throw, as web/'s `filesRead` does.
import { asJsonString, parseJsonObject } from "@web/lib/json";
import type { Scope } from "@web/lib/scope";
import type {
  ChangeCommitDiffResponse,
  ChangeCommitResponse,
  ChangeDiffResponse,
  ChangesResponse,
  FileReadResponse,
  FilesListResponse,
} from "@web/lib/types";

import { ApiError, bridgeGet } from "../../lib/api";
import { markNotPaired, NOT_PAIRED_BODY } from "../../lib/pairing";
import type { ChangesTarget } from "./target";
import { paneChangesUrl, paneFilesUrl, workspaceChangesUrl, workspaceFilesUrl } from "../../lib/urls";

/** How far the Changes view looks for repos below the workspace folder (Settings, Changes card). */
export interface ChangesLookup {
  depth: number;
  nested: boolean;
}

export interface ChangeRef {
  repo: string;
  path: string;
}

/** What a Files read came to. Only `body` carries data; the rest are the bridge's refusals. */
export type FilesAnswer<T> =
  | { outcome: "body"; body: T }
  | { outcome: "unknown-path" }
  | { outcome: "stale" }
  | { outcome: "not-paired" }
  | { outcome: "not-authorised" };

export type Refusal = Exclude<FilesAnswer<never>["outcome"], "body">;

const NOT_AUTHORISED_BODY = "device not authorised";

export function changesBase(target: ChangesTarget): string {
  return target.kind === "pane"
    ? paneChangesUrl(target.paneId)
    : workspaceChangesUrl(target.spaceId);
}

export function filesBase(target: ChangesTarget): string {
  return target.kind === "pane"
    ? paneFilesUrl(target.paneId)
    : workspaceFilesUrl(target.spaceId);
}

/** The query of a list read, a file's diff (`file`) or the commit view (`commit`, with a repo). */
export function changesQuery(lookup: ChangesLookup, file?: ChangeRef, commit?: { repo: string }): string {
  const q = new URLSearchParams({ depth: String(lookup.depth), nested: lookup.nested ? "1" : "0" });
  if (file) {
    q.set("repo", file.repo);
    q.set("path", file.path);
  }
  if (commit) {
    q.set("view", "commit");
    if (!file) q.set("repo", commit.repo);
  }
  return q.toString();
}

export function fetchChanges(target: ChangesTarget, lookup: ChangesLookup, scope: Scope, signal: AbortSignal): Promise<ChangesResponse> {
  return bridgeGet<ChangesResponse>(`${changesBase(target)}?${changesQuery(lookup)}`, scope, signal);
}

export function fetchChangeDiff(
  target: ChangesTarget,
  lookup: ChangesLookup,
  file: ChangeRef,
  scope: Scope,
  signal: AbortSignal,
): Promise<ChangeDiffResponse> {
  return bridgeGet<ChangeDiffResponse>(`${changesBase(target)}?${changesQuery(lookup, file)}`, scope, signal);
}

/** The last commit of one repo in the workspace (the commit view). HEAD only. */
export function fetchChangeCommit(
  target: ChangesTarget,
  lookup: ChangesLookup,
  repo: string,
  scope: Scope,
  signal: AbortSignal,
): Promise<ChangeCommitResponse> {
  return bridgeGet<ChangeCommitResponse>(`${changesBase(target)}?${changesQuery(lookup, undefined, { repo })}`, scope, signal);
}

/** One file of that commit. The bridge serves only a path the same read of HEAD listed. */
export function fetchChangeCommitDiff(
  target: ChangesTarget,
  lookup: ChangesLookup,
  file: ChangeRef,
  scope: Scope,
  signal: AbortSignal,
): Promise<ChangeCommitDiffResponse> {
  return bridgeGet<ChangeCommitDiffResponse>(`${changesBase(target)}?${changesQuery(lookup, file, { repo: file.repo })}`, scope, signal);
}

/**
 * A refusal told apart by status and body: a 404 by its JSON `error` value, a 403 by its plain-text
 * body (the same two bodies a refused write carries, lib/pairing.ts). Prefixes, not equality: a crew
 * member answers with a clause after the lead's words.
 */
export function refusalOf(status: number, detail: string): Refusal | null {
  if (status === 404) return asJsonString(parseJsonObject(detail)?.error) === "unknown-path" ? "unknown-path" : "stale";
  if (status !== 403) return null;
  const body = detail.trim();
  if (body.startsWith(NOT_PAIRED_BODY)) return "not-paired";
  return body.startsWith(NOT_AUTHORISED_BODY) ? "not-authorised" : null;
}

async function filesRead<T>(path: string, scope: Scope, signal: AbortSignal): Promise<FilesAnswer<T>> {
  try {
    return { outcome: "body", body: await bridgeGet<T>(path, scope, signal) };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const refusal = refusalOf(error.status, error.body);
    if (refusal === null) throw error;
    // Reads were ungated until Files, so nothing on a read could ever discover an unpaired device.
    // Latch it as a refused write does: the read-only strip then names the remedy, once.
    if (refusal === "not-paired") markNotPaired();
    return { outcome: refusal };
  }
}

/** One folder of the root (`dir` is relative, `""` the root). Fetched on open and on refresh only. */
export function fetchFilesDir(target: ChangesTarget, dir: string, scope: Scope, signal: AbortSignal): Promise<FilesAnswer<FilesListResponse>> {
  const q = dir === "" ? "" : `?${new URLSearchParams({ dir }).toString()}`;
  return filesRead<FilesListResponse>(`${filesBase(target)}${q}`, scope, signal);
}

/** One file under the root, as text: cut at the bridge's cap, `binary` with no text. */
export function fetchFileText(target: ChangesTarget, path: string, scope: Scope, signal: AbortSignal): Promise<FilesAnswer<FileReadResponse>> {
  return filesRead<FileReadResponse>(`${filesBase(target)}?${new URLSearchParams({ path }).toString()}`, scope, signal);
}
