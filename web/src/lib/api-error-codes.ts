// The client mirror of `bridge/error-codes.ts` — the stable names for the bridge's refusals.
//
// The two trees are type-checked separately (web/tsconfig.json includes only `src`), so the union is
// restated here rather than imported, exactly as `bridge/json.ts` / `web/src/lib/json.ts` already
// do. KEEP THE TWO IDENTICAL: `bridge/error-codes.test.ts` reads both files off disk and fails when
// one set gains a code the other has not.
//
// What lives on each side is deliberately different, and that is the whole point of restating:
//   • The bridge owns the ENGLISH SENTENCE, because it is the fallback that ships on the wire.
//   • The phone owns the TRANSLATION, keyed by these codes through `web/src/lib/i18n/`.
// So this file carries the names and nothing else — no sentences to fall out of step with the
// bridge's, and no second place for English to hide.
//
// READING ONE OFF THE WIRE: `code` is OPTIONAL and always will be. A bridge older than the code it
// is talking to sends `{ ok: false, error: "…" }` with no `code` at all, and a bridge NEWER than
// this file may send a code this union has not met. Both are the same case and both have the same
// answer — fall back to the `error` string the body already carries, which is a true sentence in
// English. Never treat a missing or unknown code as a failure to display.
//
// `detail` rides beside the code and carries the values a sentence needs interpolated — the same
// `{name}` convention `t()` uses, so a translated string can consume them directly
// (e.g. `upload.too_large` + `{ maxBytes: 10485760 }`).

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "./json";

/** The values a bridge sentence was built from, for a translated one to reuse. */
export type ApiErrorDetail = Readonly<Record<string, string | number>>;

/**
 * Every code the bridge can send, in the bridge's own order.
 *
 * A runtime list as well as a type: recognising a code off the wire is a value question, and a
 * union alone cannot answer it.
 */
export const API_ERROR_CODES = [
  // Sending into a pane — POST /api/pane/:id/{reply,keys}
  "reply.not_submitted",
  "reply.send_failed",
  "keys.send_failed",
  // Grandfathered spelling: already on the wire before the catalogue existed, matched literally by
  // `lib/dialog-guard.ts`, `lib/preview-action.ts` and `components/composer.tsx`. Not renamed.
  "prompt_changed",
  "prompt.read_failed",

  // Pane structure — POST /api/pane/:id/{close,rename,focus}
  "pane.close_failed",
  "pane.rename_failed",
  "pane.focus_failed",

  // Tab & space structure — POST /api/tab[/:id/…], /api/workspace
  "tab.create_failed",
  "tab.rename_failed",
  "tab.close_failed",
  "tab.workspace_required",
  "workspace.create_failed",

  // Worktrees — /api/workspace/:id/worktree[s|/open|/remove] (ADR 0032)
  "worktree.list_failed",
  "worktree.create_failed",
  "worktree.created_not_opened",
  "worktree.open_failed",
  "worktree.remove_failed",
  "worktree.dirty",
  "worktree.busy",
  "worktree.ambiguous_branch",
  "worktree.branch_required",
  "worktree.not_a_repo",
  "worktree.not_open",

  // Image upload — POST /api/pane/:id/upload
  "upload.too_large",
  "upload.no_file",
  "upload.bad_type",
  "upload.write_failed",

  // Speech to text — POST /api/stt
  "stt.unconfigured",
  "stt.too_large",
  "stt.bad_format",
  "stt.busy",
  "stt.unreadable",
  "stt.empty",
  "stt.provider_failed",

  // Device pairing — POST /api/pair, POST /api/devices/revoke
  "pairing.bad_request",
  "pairing.no_pending",
  "pairing.expired",
  "pairing.exhausted",
  "pairing.bad_code",
  "pairing.duplicate_label",
  "device.unknown",

  // Addressing — the `(host, session)` a request named does not exist
  "session.unknown",
  "host.unknown",

  // The pack overview — this collie is not a lead with a pack (solo, or a peer)
  "pack.not_lead",
] as const;

/** Every code the bridge can send. Derived from the list, so there is exactly one place to edit. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Whether a value off the wire is a code THIS build knows how to translate.
 *
 * A `false` is ordinary, not an error: it means a newer bridge named something this client has no
 * sentence for, and the caller shows the body's `error` string instead.
 */
export function isApiErrorCode(value: string | undefined): value is ApiErrorCode {
  return API_ERROR_CODES.some((code) => code === value);
}

/**
 * The error half of a body, however it reached us — the fragment `bridge/error-codes.ts` builds.
 *
 * `code` is a plain `string`, NOT `ApiErrorCode`: a body parsed off the wire may name a code a newer
 * bridge invented, and typing the field as the union would be claiming a check that has not happened
 * yet. `isApiErrorCode` is that check, and `lib/api-error-message.ts` is where it is made. A typed
 * response body (`ActionResponse` and friends) is assignable here as it stands.
 */
export interface ApiErrorFields {
  readonly error?: string | undefined;
  readonly code?: string | undefined;
  readonly detail?: ApiErrorDetail | undefined;
}

/**
 * Read the code/detail/sentence off a bridge error body that arrived as TEXT — the non-2xx path,
 * where the response was never parsed into one of the typed shapes.
 *
 * `undefined` for anything that is not a Collie error body: a proxy's HTML page, a plain-text refusal
 * (`text("bad body", 400)`), an empty body. The caller then has nothing better than what it already
 * had, which is exactly the pre-catalogue behaviour.
 */
export function parseApiErrorFields(body: string): ApiErrorFields | undefined {
  const parsed = parseJsonObject(body);
  if (parsed === undefined) return undefined;
  const error = asJsonString(parsed.error);
  const code = asJsonString(parsed.code);
  // Neither half present ⇒ not an error body at all. A 200-shaped document that happens to be JSON
  // must not become a "refusal" with no words in it.
  if (error === undefined && code === undefined) return undefined;
  // Absent fields are carried as `undefined` rather than omitted: this object never goes back on the
  // wire (where the omission would be load-bearing — see `apiError` in bridge/error-codes.ts), and
  // every reader below branches on the value, not on the key.
  return { error, code, detail: readDetail(parsed.detail) };
}

/**
 * The `detail` object narrowed to the slot values a sentence can carry.
 *
 * Field by field rather than wholesale: `detail` is attacker-adjacent in exactly the way every other
 * wire field is, and a nested object or array in it would otherwise reach `String()` at interpolation
 * time and render as `[object Object]`. Anything that is not a string or a number is dropped, which
 * leaves its slot empty — the same outcome the bridge's own renderer gives an unfillable slot.
 */
function readDetail(value: JsonValue | undefined): ApiErrorDetail | undefined {
  const object = asJsonObject(value);
  if (object === undefined) return undefined;
  const entries: [string, string | number][] = [];
  for (const [slot, raw] of Object.entries(object)) {
    const text = asJsonString(raw);
    if (text !== undefined) {
      entries.push([slot, text]);
      continue;
    }
    const numeric = asJsonNumber(raw);
    if (numeric !== undefined) entries.push([slot, numeric]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
