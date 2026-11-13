// The request id of a create that got no answer, kept for a short time so a retap never creates twice.
//
// A quick launch, a tab create and a space create carry a request id, and the bridge answers a known
// id from the receipt it wrote, or joins the run in flight, or says the outcome is unknown. That only
// helps when the second tap sends the SAME id. A time-out, a lost connection or a 504
// `write_outcome_unknown` left no answer, and the next tap minted a new id: the bridge created again
// while the first pane might exist.
//
// This store keeps the id per (host, session) and per ACTION: the same command beside the same pane,
// the same space, the same folder. It holds the id for 30 seconds. A success, a plain refusal, another
// action or a later tap gets a new id. Same style as lib/send-intent.ts: sessionStorage behind a
// guard, a memory map beside it, wiped at the end of a pairing. A lost id costs only the old
// behaviour (a new id), never a failed create.

import { asJsonNumber, asJsonString, parseJsonObject } from "./json";
import { mintRequestId } from "./worktree-name";
import { normalizeScope, type Scope } from "./scope";

const PREFIX = "collie:create-intent:";

/** How long an id of a create with no answer stays the id of a retap, in milliseconds. */
export const CREATE_INTENT_WINDOW_MS = 30_000;

interface Stored {
  readonly requestId: string;
  readonly at: number;
}

const memory = new Map<string, Stored>();

/** The action a create is: what it makes, where, and in which folder. Two taps of one action share a key. */
export type CreateAction =
  | { kind: "launch"; command: string; beside: string | undefined }
  | { kind: "tab"; workspaceId: string; cwd: string | undefined; label: string | undefined }
  | { kind: "space"; cwd: string | undefined; label: string | undefined };

function actionKey(action: CreateAction): string {
  if (action.kind === "launch") return JSON.stringify(["launch", action.command, action.beside ?? null]);
  if (action.kind === "tab") return JSON.stringify(["tab", action.workspaceId, action.cwd ?? null, action.label ?? null]);
  return JSON.stringify(["space", action.cwd ?? null, action.label ?? null]);
}

function keyFor(scope: Scope | undefined, action: CreateAction): string {
  const { host, session } = normalizeScope(scope);
  return `${PREFIX}${host ? `${host}@` : ""}${session ?? "default"}:${actionKey(action)}`;
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function parse(raw: string | null): Stored | null {
  if (raw === null) return null;
  const value = parseJsonObject(raw);
  const requestId = asJsonString(value?.requestId);
  const at = asJsonNumber(value?.at);
  if (requestId === undefined || at === undefined) return null;
  return { requestId, at };
}

function read(key: string): Stored | null {
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    return parse(storage()?.getItem(key) ?? null);
  } catch {
    return null;
  }
}

function drop(key: string): void {
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to remove from a store that cannot be reached.
  }
}

/**
 * The id for a create: the id an earlier tap of the SAME action left without an answer, when that was
 * less than 30 seconds ago, else a new one.
 */
export function createRequestId(scope: Scope | undefined, action: CreateAction, now: number = Date.now()): string {
  const key = keyFor(scope, action);
  const stored = read(key);
  if (stored === null) return mintRequestId();
  if (now - stored.at > CREATE_INTENT_WINDOW_MS || now < stored.at) {
    drop(key);
    return mintRequestId();
  }
  return stored.requestId;
}

/** A create got no answer (no reply, a network error, a 504): the next tap of this action inside the window sends this id again. */
export function holdCreateId(scope: Scope | undefined, action: CreateAction, requestId: string, now: number = Date.now()): void {
  const key = keyFor(scope, action);
  const stored: Stored = { requestId, at: now };
  memory.set(key, stored);
  try {
    storage()?.setItem(key, JSON.stringify(stored));
  } catch {
    // Quota or private mode: the memory copy still holds for this page.
  }
}

/** A create got an answer, a success or a plain refusal: that id is done. */
export function releaseCreateId(scope: Scope | undefined, action: CreateAction): void {
  drop(keyFor(scope, action));
}

/** Drop every held id, memory and storage. The wipe at the end of a pairing runs it: a key holds a folder path. */
export function forgetAllCreateIntents(): void {
  memory.clear();
  try {
    const store = storage();
    if (store === null) return;
    const held: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(PREFIX)) held.push(key);
    }
    for (const key of held) store.removeItem(key);
  } catch {
    // Locked-down storage kept nothing.
  }
}

/** Test seam: forget the memory copies, as a reload does, and leave sessionStorage as it is. */
export function __forgetCreateIntentMemory(): void {
  memory.clear();
}
