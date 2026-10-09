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
//   • Crew-link errors (`bridge/crew/`). That surface is versioned separately (CREW_PROTOCOL.md) and
//     is guarded at commit time (ADR 0025); it keeps today's bodies in this release.
//   • Push notification titles. Same rule, different surface: `bridge/push-titles.ts` is their catalogue.

import { renderTemplate } from "./template.ts";

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
  /**
   * The `command` the client named is in no row of the operator's `launchers.toml`. The rows ARE
   * the allowlist, so this is the whole of what a phone may start — nothing was created.
   */
  "launch.not_allowlisted": "command not allowlisted",
  /**
   * A launch named a `paneId` to open beside, and that pane is not in this session's current
   * snapshot — closed, or never existed. Nothing was created.
   */
  "launch.pane_unknown": "pane not found",
  /**
   * A launch named a `harness` id this host does not start (`bridge/harness-launch.ts`). The ids are
   * the list `GET /api/launchers` answered, so nothing a phone was shown is refused (ADR 0091).
   */
  "launch.unknown_harness": "unknown agent: {harness}",
  /** A launch's `cwd` carries a control character, a `..` segment, or `~name`. A path with no leading `/` or `~` is a folder under home. */
  "launch.bad_folder": "the folder cannot be used: no .. and no control characters",
  /** A launch's folder is not a directory on the machine that runs it. Nothing was created. */
  "launch.folder_missing": "there is no folder {folder} on this machine",

  // ── One-off runs and their history: POST /api/launch `{ run }`, /api/launch/recent/* (ADR 0095) ──
  /** A one-off run came with no paired device to attribute it to. Nothing ran. */
  "launch.no_device": "this request names no paired device",
  /** The operator turned one-off runs off on this machine (`[phone] run = false`). Nothing ran. */
  "launch.run_off": "running a one-off command from a phone is turned off on this machine",
  /** The line breaks the character rule, is empty, or is longer than {max} characters. Nothing ran. */
  "launch.bad_line": "the command cannot be run: {problem}",
  /** A one-off run never starts on a new branch. Nothing was created. */
  "launch.run_no_branch": "a one-off command cannot start on a new branch",
  /** No history entry has this line on this machine. */
  "launch.recent_unknown": "that command is not in this machine's history",
  /** `commands-recent.json` is there and is not a file this Collie may write over. */
  "launch.recent_unreadable": "commands-recent.json cannot be read; move it away to keep a history",

  // ── Rows added from a phone: POST /api/launchers/added, /remove, /rename (ADR 0094) ──────────
  // Each refusal is answered before the store is written: nothing was added, removed or renamed.
  /** The operator turned phone-added rows off on this machine (`[phone] adds = false`). */
  "launcher.adds_off": "adding launchers from a phone is turned off on this machine",
  /** The operator has not turned free lines on (`[phone] free_text`, off by default). */
  "launcher.free_text_off": "a command typed by hand is turned off on this machine",
  /** The line or the label breaks the character rule, is empty, or is too long. */
  "launcher.bad_text": "{field}: {problem}",
  /** A recipe named an agent Collie does not start, an option its table does not list, or two of one group. */
  "launcher.bad_recipe": "{reason}",
  /** The same line is already a row, in `launchers.toml` or added before. */
  "launcher.duplicate": "this command is already a launcher",
  /** This machine keeps at most {max} phone-added rows. */
  "launcher.added_full": "this machine already has {max} added launchers; remove one first",
  /** No added row has this id on this machine. */
  "launcher.unknown_row": "no such launcher",
  /** `launchers-added.json` is there and is not a file this Collie may write over. */
  "launcher.store_unreadable": "launchers-added.json cannot be read; move it away to add launchers",
  /** The write came with no device name, so the row could not be attributed. */
  "launcher.no_device": "this request names no paired device",

  // ── The new-space folder list: POST /api/folders/star (#289, M40/02) ───────────────
  /**
   * The folder is in neither list. Only a folder a space already opened in can be starred, so this
   * is a RACE GUARD: the sheet offers a star only on a row it read, and this is the tap that landed
   * after that row aged out of Recent on another device's create. Nothing was stored.
   */
  "folders.unknown": "{folder} is not in Recent, so it cannot be starred",
  /** Twelve favourites already. A star never drops one the operator chose, so nothing was stored. */
  "folders.favourites_full": "favourites are full ({max}); remove one first",

  // ── Worktrees: /api/workspace/:id/worktree[s|/open|/remove] (ADR 0032) ─────────────
  /** The list could not be read — the space is not in a Git work tree, or the mux refused. */
  "worktree.list_failed": "{reason}",
  /** Creation refused. `{reason}` is the multiplexer's own words, Git's sentence included. */
  "worktree.create_failed": "{reason}",
  /**
   * The checkout was made and could not be shown — the branch EXISTS and nothing displays it.
   * Distinct from `create_failed` because the recovery is opposite: open it, never create it again
   * (a second create answers `create_failed`, the path being taken). Probed on herdr 0.8.2.
   */
  "worktree.created_not_opened": "the worktree was created but could not be opened: {reason}",
  "worktree.open_failed": "{reason}",
  /** Another worktree operation is still running — herdr serialises them. Try again in a moment. */
  "worktree.busy": "{reason}",
  /** The branch name matched more than one thing, so the multiplexer would not guess. */
  "worktree.ambiguous_branch": "{reason}",
  /** The request named no branch, or named one that is only whitespace. */
  "worktree.branch_required": "branch required",
  /** This space is not in a Git work tree, so it has no worktrees to show. */
  "worktree.not_a_repo": "{reason}",
  /**
   * The branch name would read as a flag or is one Git refuses (`bridge/worktree-branch.ts`). Checked
   * before the multiplexer is touched, so nothing was created (ADR 0089).
   */
  "worktree.invalid_branch": "invalid branch",
  /**
   * The starting point is not `{ kind: "default" }` or `{ kind: "ref", ref }`, the ref is one Git
   * refuses, or it names no commit in this repo. Checked before the multiplexer is touched, so
   * nothing was created (ADR 0089, amended).
   */
  "worktree.invalid_base": "invalid base",

  // ── A branch's own folder: POST /api/worktree with a parent (ADR 0093) ────────────────
  // Each is a refusal of the parent folder the phone named, checked on every use by
  // `bridge/worktree-folder.ts` before the multiplexer is touched. Nothing was created.
  /** Empty, too long, a control character, relative, or a `..` segment. */
  "worktree.folder_invalid": "the folder must be an absolute path with no ..",
  /** Nothing is there, or it is not a directory. */
  "worktree.folder_missing": "the folder does not exist",
  /** A link sits somewhere in the path below the home folder. */
  "worktree.folder_link": "the folder goes through a link",
  /** The folder is not inside the home folder. */
  "worktree.folder_outside_home": "the folder must be inside the home folder",
  /** A folder whose name starts with a dot, `.git` included, is on the path. */
  "worktree.folder_hidden": "the folder may not be or sit inside a hidden folder",
  /** The folder is inside the repository the branch is cut from. */
  "worktree.folder_in_repo": "the folder may not be inside the repository",
  /** The branch's folder already exists there. */
  "worktree.target_exists": "{path} already exists",

  // ── Attachment upload: POST /api/pane/:id/upload → UploadResponse ──────────────────
  /**
   * Refused on the declared Content-Length (413) or on the decoded size (200 + ok:false). The
   * number is the HOST's own `COLLIE_MAX_UPLOAD_MB`, so it is interpolated rather than written:
   * two members of one crew may answer this with two different sentences, both true.
   */
  "upload.too_large": "file too large (max {maxMb} MB)",
  /** The multipart body carried no `file` part. */
  "upload.no_file": "no file",
  /** Not an image Collie recognises and not a text type it accepts — it will not write bytes it cannot name. */
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

  // ── The prompt-cache watch list: /api/notifications/cache-watch (ADR 0042) ─────────
  /**
   * The `(host, session, paneId)` the request named is in no current snapshot — closed, renumbered,
   * or on a member that has stopped answering. Nothing was stored.
   */
  "cache.pane_unknown": "pane not found",
  /**
   * The pane names no harness session, so there is nothing to key a watch by. A RACE GUARD: the read
   * already answered `watchable: false` and the sheet already disabled its switch, so this is the tap
   * that landed after the harness dropped its session.
   */
  "cache.no_session": "this pane's agent names no session",

  // ── Addressing: the `(host, session)` a request named does not exist ───────────────
  "session.unknown": "unknown session: {session}",
  "host.unknown": "unknown host: {host}",

  // ── The crew overview: GET /api/crew ───────────────────────────────────────────────
  /**
   * This collie is not a lead with a crew, so it has no crew to report. Both refusals are this one
   * code on purpose: a solo instance and a peer differ in what they ARE, not in what the phone can
   * do about it — a peer is not a front door (ADR 0013), so neither has an overview to show.
   */
  "crew.not_lead": "this collie is not the lead of a crew",

  // ── Starting an update from the phone: POST /api/update (M15/05) ───────────────────
  /** The body carried no confirm. One tap plus one confirm is the contract; nothing moved. */
  "update.confirm_required": "an update needs an explicit confirm",
  /** A run is already going. THE DOUBLE-TAP ANSWER — the second POST names the run, never starts one. */
  "update.in_progress": "an update is already running ({state}); nothing was started",
  /** The preflight could not be produced at all. "We could not check" is not "nothing is red". */
  "update.preflight_unavailable": "the update preflight could not be run here",
  /** The server re-ran the preflight and it is red. The check's own id and words, not a generic line. */
  "update.preflight_red": "preflight is red on {check}: {reason}",
  /** A major crossing needs its own consent (ADR 0020), exactly as `update --major` does on the CLI. */
  "update.major_confirm_required": "{version} crosses a major — a major crossing needs its own confirm",
  /** The card consented to a version this collie would no longer install. A stale card, refused. */
  "update.target_mismatch": "this device asked for {asked}, but this collie would install {would}",
  /** Nothing newer to take. */
  "update.none_available": "there is no newer release to take",
  /**
   * A peers-only start where the only member behind runs a packaged install (ADR 0035). Its own
   * package manager owns it, so no run from here can move it — which is a different answer from
   * "the crew is level", and the operator is owed the difference.
   */
  "update.peers_packaged": "{name} is a packaged install, so its updates come from its own package manager",
  /**
   * A package manager owns this install's folder (ADR 0035). Its own preflight is GREEN, so nothing
   * else on this gate would stop the start — which is exactly why this refusal exists here and not
   * only in the client, whose disabled button this file's own contract calls a courtesy.
   */
  "update.packaged": "updates come from this machine's package manager — Collie does not replace its files",
  /** The handoff itself failed — nothing was staged and nothing restarted. */
  "update.start_failed": "the update could not be started: {reason}",
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

