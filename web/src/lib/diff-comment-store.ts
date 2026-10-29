// The batch of diff comments, kept for the life of the tab.
//
// The Changes screen holds the notes an operator is collecting for an agent. They used to live in
// component state alone, so a Back out of Changes, a reload or the OS evicting the installed app
// dropped them without a word. This keeps them in sessionStorage, under the scope and the target
// (`pane:<id>` or `space:<id>`) the batch will be staged into, so leaving Changes and coming back in
// the same tab restores it. Staging the batch into the agent's draft clears it.
//
// **sessionStorage, not localStorage.** A batch is unsent work tied to the screen that made it, not a
// message the operator typed: it should not outlive the tab, and a stale batch next week would quote
// lines of a diff that no longer exists. The composer draft (lib/drafts.ts) is the durable copy, and
// it takes over the moment the batch is staged.
//
// The notes quote session text, so a pairing that ends clears them (`forgetAllDiffComments`, run by
// lib/wipe.ts). Every access is behind a try/catch: Safari private mode throws on setItem, and a
// note is never important enough to break a render.

import type { DiffComment } from "./diff-comments";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "./json";
import { paneScopeKey, type Scope } from "./scope";

/** The key prefix. The version is part of it, so a changed shape starts a fresh batch. */
const PREFIX = "collie:diff-comments:v1:";

/** More than a phone screen can hold; a longer list is a bug or a damaged value, and is not stored. */
const MAX_COMMENTS = 200;

function keyOf(scope: Scope | undefined, target: string): string {
  return `${PREFIX}${paneScopeKey(scope, target)}`;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function stringList(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const text = asJsonString(item);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

function commentOf(value: JsonValue | undefined): DiffComment | undefined {
  const o = asJsonObject(value);
  if (o === undefined) return undefined;
  const id = asJsonNumber(o.id);
  const repo = asJsonString(o.repo);
  const path = asJsonString(o.path);
  const lineLabel = asJsonString(o.lineLabel);
  const note = asJsonString(o.note);
  const rowKeys = stringList(o.rowKeys);
  const linesText = stringList(o.linesText);
  if (
    id === undefined ||
    !Number.isInteger(id) ||
    repo === undefined ||
    path === undefined ||
    lineLabel === undefined ||
    note === undefined ||
    rowKeys === undefined ||
    linesText === undefined
  ) {
    return undefined;
  }
  const comment: DiffComment = { id, repo, path, rowKeys, lineLabel, linesText, note };
  const fileKey = asJsonString(o.fileKey);
  if (fileKey !== undefined) comment.fileKey = fileKey;
  return comment;
}

/** The batch held for this target, or an empty list when nothing readable is held. */
export function loadDiffComments(scope: Scope | undefined, target: string): DiffComment[] {
  try {
    const raw = safeStorage()?.getItem(keyOf(scope, target));
    const parsed = raw == null ? undefined : parseJson(raw);
    if (!Array.isArray(parsed)) return [];
    const out: DiffComment[] = [];
    for (const item of parsed) {
      const comment = commentOf(item);
      if (comment !== undefined) out.push(comment);
    }
    return out;
  } catch {
    return [];
  }
}

/** Hold the batch. An empty batch removes the entry, so storage keeps nothing for a cleared one. */
export function saveDiffComments(
  scope: Scope | undefined,
  target: string,
  comments: readonly DiffComment[],
): void {
  try {
    const storage = safeStorage();
    if (storage === undefined) return;
    if (comments.length === 0 || comments.length > MAX_COMMENTS) storage.removeItem(keyOf(scope, target));
    else storage.setItem(keyOf(scope, target), JSON.stringify(comments));
  } catch {
    // Private mode or a full quota: the batch lives in the screen's state, as it did before.
  }
}

/** Drop the batch for this target. Staging it into a draft calls this. */
export function clearDiffComments(scope: Scope | undefined, target: string): void {
  saveDiffComments(scope, target, []);
}

/** Drop every held batch. The wipe at the end of a pairing runs it. */
export function forgetAllDiffComments(): void {
  try {
    const storage = safeStorage();
    if (storage === undefined) return;
    const held: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(PREFIX)) held.push(key);
    }
    for (const key of held) storage.removeItem(key);
  } catch {
    // Locked-down storage kept nothing.
  }
}
