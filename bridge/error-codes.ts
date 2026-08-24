// ── THE ERROR CODE CATALOGUE — one file, one place the wire's refusals are named ────────────────
//
// Collie's web app speaks the operator's language (web/src/lib/i18n/). The bridge does not: an
// `{ ok: false, error: "…" }` body is English prose written on the host, and it lands on the phone
// screen verbatim. This file is how that stops being the end of the story.
//
// THE RULE: an error body the phone can display carries a STABLE MACHINE CODE beside its sentence.
// The sentence is unchanged and stays the fallback — a client with no translation for a code still
// says something true, and an older client that ignores `code` behaves exactly as it does today.
// Nothing here renames a field, removes one, or moves a status code.
//
// THE SENTENCE AND THE CODE CANNOT DRIFT, because they are not written in two places: a handler
// names a code and {@link apiError} renders the sentence from THIS table. A handler cannot ship a
// code with different words than the catalogue says it has, because it never writes the words.
//
// TEMPLATES, NOT CONCATENATION. `{name}` marks a slot filled from the `detail` object — the same
// convention `web/src/lib/i18n/` uses, for the same reason: the translated sentence needs those
// values too, so they travel as NAMED FIELDS beside the code rather than baked into a string the
// client would have to re-parse. `{ maxBytes: 10485760 }` is usable; "max 10 MB" is not.
//
// A TEMPLATE THAT IS ONLY `{reason}` is not a mistake. Several refusals are the multiplexer's own
// words passed through (`herdr` said "no such pane"), and Collie must keep sending them byte for
// byte. The code says WHAT FAILED — which is the part a translator can act on — and `detail.reason`
// carries the untranslatable remainder.
//
// THE CLIENT MIRROR is `web/src/lib/api-error-codes.ts`. The two trees are type-checked separately
// (web/tsconfig.json includes only `src`), so the union is restated there rather than imported —
// the same arrangement `bridge/json.ts` / `web/src/lib/json.ts` already uses. They are held
// identical by `bridge/error-codes.test.ts`, which reads both files off disk and compares the sets.
// Adding a code here without adding it there fails that test.
//
// WHAT IS DELIBERATELY NOT IN HERE:
//   • Plain-text refusals (`text("bad body", 400)`, a 403 gate reason, a 405). They are not JSON, so
//     there is no field to add one to — coding them would mean changing the response shape, which is
//     exactly what this change promised not to do.
//   • Pack-link errors (`bridge/pack/`). That surface is versioned separately (PACK_PROTOCOL.md) and
//     is guarded at commit time (ADR 0025); it keeps today's bodies in this release.
//   • Push/OS notification text (`bridge/notifications.ts`). Different surface, different follow-up.

/** The values a sentence may need interpolated — named, so a translated sentence can use them too. */
export type ApiErrorDetail = Readonly<Record<string, string | number>>;

/**
 * Every code the bridge can put on an error body, mapped to the English sentence it ships with.
 *
 * The sentences are byte-for-byte what the handlers said before codes existed. Changing one is a
 * user-visible change; adding a code is not.
 */
export const ERROR_CODES = {
  // ── Sending into a pane: POST /api/pane/:id/{reply,keys} → ActionResponse ──────────
  /** The text reached the pane but the submit keypress did not. Do NOT resend — it would duplicate. */
  "reply.not_submitted": "typed into the pane but not submitted — check the pane before resending",
  /** The multiplexer refused the reply. Nothing (or only what `textDelivered` says) landed. */
  "reply.send_failed": "{reason}",
  /** The multiplexer refused the key batch. */
  "keys.send_failed": "{reason}",
  /**
   * The screen moved between the client reading it and the write arriving, so the bound write was
   * refused (409). GRANDFATHERED SPELLING: this code was already on the wire before the catalogue
   * existed and `web/src/lib/dialog-guard.ts` + friends match it literally, so it keeps its
   * un-namespaced name. New codes are `surface.thing`; this one is not, and must not be renamed.
   */
  prompt_changed: "prompt changed",
  /** The pre-write re-read of the pane did not happen at all (502), so nothing could be verified. */
  "prompt.read_failed": "{mux} read failed: {detail}",

  // ── Pane structure: POST /api/pane/:id/{close,rename,focus} → ActionResponse ───────
  "pane.close_failed": "{reason}",
  "pane.rename_failed": "{reason}",
  /** The multiplexer would not put this pane on the operator's screen (gone, or it cannot). */
  "pane.focus_failed": "{reason}",

  // ── Tab & space structure: POST /api/tab[/:id/…] , /api/workspace → CreateResponse ─
  "tab.create_failed": "{reason}",
  "tab.rename_failed": "{reason}",
  "tab.close_failed": "{reason}",
  /** The create body named no space to create the tab in. */
  "tab.workspace_required": "workspaceId required",
  "workspace.create_failed": "{reason}",

  // ── Image upload: POST /api/pane/:id/upload → UploadResponse ───────────────────────
  /** Refused on the declared Content-Length (413) or on the decoded size (200 + ok:false). */
  "upload.too_large": "image too large (max 10 MB)",
  /** The multipart body carried no `file` part. */
  "upload.no_file": "no file",
  /** A content type Collie has no extension for — it will not write bytes it cannot name. */
  "upload.bad_type": "unsupported type: {type}",
  /** The bytes arrived but the host write failed (disk full, permissions). */
  "upload.write_failed": "{reason}",

  // ── Speech to text: POST /api/stt (bridge/stt/http.ts) ─────────────────────────────
  "stt.unconfigured": "speech-to-text is not configured on this collie — run `collie stt setup`",
  "stt.too_large": "the recording is larger than 8 MiB",
  "stt.bad_format": "that is not an audio format Collie sends on",
  "stt.busy": "two recordings are already being transcribed — try again in a moment",
  "stt.unreadable": "the recording could not be read",
  "stt.empty": "the recording is empty",
  /** The provider itself failed. `detail.kind` is the SttError kind; the sentence is its own words. */
  "stt.provider_failed": "{reason}",

  // ── Device pairing: POST /api/pair, POST /api/devices/revoke ───────────────────────
  //
  // These sentences look like codes because they ARE the machine-readable reasons pairing has always
  // sent — `web/src/lib/api.ts` matches them against `PAIR_FAILURES` and `paired-devices.tsx` turns
  // the match into a translated line. The `code` field simply says the same thing in the same place
  // every other surface now says it, so a client can stop special-casing this route.
  "pairing.bad_request": "bad-request",
  "pairing.no_pending": "no-pending",
  "pairing.expired": "expired",
  "pairing.exhausted": "exhausted",
  "pairing.bad_code": "bad-code",
  "pairing.duplicate_label": "duplicate-label",
  /** Revoke named a label no device holds. */
  "device.unknown": "unknown device",

  // ── Addressing: the `(host, session)` a request named does not exist ───────────────
  "session.unknown": "unknown session: {session}",
  "host.unknown": "unknown host: {host}",
} as const;

/** Every code the bridge can send. The client mirror restates this union verbatim. */
export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * The same set as a runtime list, so the drift guard can compare what the module EXPORTS against
 * what it reads out of the two source files — a regex that quietly stopped matching would otherwise
 * pass by comparing two empty sets.
 */
export const ERROR_CODE_LIST: readonly ErrorCode[] = Object.keys(ERROR_CODES).filter(
  // The membership test IS the narrowing: a key `Object.keys` reported is a key the table has, so
  // no assertion is needed to say so — the predicate is checked, not asserted.
  (key): key is ErrorCode => key in ERROR_CODES,
);

/**
 * The error half of a response body: today's sentence, its stable code, and the named values the
 * sentence was built from.
 *
 * It is a FRAGMENT, not a whole body, because the three shapes that carry it disagree about the
 * rest — `ActionResponse` and friends lead with `ok: false`, a bare routing refusal has no `ok` at
 * all. Spreading one fragment into each keeps the three in agreement about the part that matters.
 */
export interface ApiErrorBody {
  error: string;
  code: ErrorCode;
  detail?: ApiErrorDetail;
}

/**
 * Build the error fragment for `code`, rendering its catalogued sentence with `detail`.
 *
 * `detail` is echoed on the wire as well as interpolated: the client needs the raw values to build
 * its own translated sentence, and re-parsing them out of English prose is not a thing anyone should
 * have to do.
 */
export function apiError(code: ErrorCode, detail?: ApiErrorDetail): ApiErrorBody {
  const body: ApiErrorBody = { error: renderTemplate(ERROR_CODES[code], detail), code };
  // Assigned, never conditionally spread: an error with nothing to interpolate must carry NO
  // `detail` key rather than an empty object a client would have to distinguish from a real one.
  if (detail !== undefined) body.detail = detail;
  return body;
}

/**
 * Fill `{name}` slots from `detail`, in ONE pass.
 *
 * One pass is the load-bearing part: several templates are `{reason}` filled with a multiplexer's
 * own words, and those words are not Collie's to trust. A second pass over the result would let a
 * refusal that happens to contain `{maxBytes}` reach into this table's other values.
 *
 * A slot with no matching field renders empty. That is a programming error, not a runtime condition
 * — `error-codes.test.ts` fails any `apiError` call that names a slotted code without passing a
 * detail object — so it does not throw here, where throwing would turn a wording bug into a 500 on
 * a live phone.
 */
function renderTemplate(template: string, detail: ApiErrorDetail | undefined): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = detail?.[name];
    return value === undefined ? "" : String(value);
  });
}
