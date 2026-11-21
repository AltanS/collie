import { asJsonBoolean, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { asFieldValue } from "../../web/src/lib/tricks/schema.ts";
import type { GateLevel } from "../crew/peer-gate.ts";
import type { JsonValue } from "../json.ts";
import type { TrickMediaFile } from "./media.ts";
import type { OfficialAnswer, OfficialTricksSurface } from "./official-install.ts";
import type { RemoveAnswer } from "./remove-receipts.ts";
import type { CodeAnswer, TricksSurface, SwitchAnswer, TapAnswer, ValueAnswer, VersionRouteAnswer } from "./service.ts";

// The tricks routes' request halves (M94 slices 01 and 04), kept out of server.ts so that file only
// dispatches. The gate, the watch stamp and the response are server.ts's.
//
//   GET  /api/tricks?since=<rev>          → TricksReply (web/src/lib/tricks/schema.ts)
//   POST /api/tricks/<host>/<id>/tap      → TrickTapReply (`rid`, a tree receipt code), or 400 `tap-invalid`,
//                                         404 `unknown-host` / `unknown-trick`, 409 `request-id-reused`
//   GET|POST /api/tricks/switch           → the switch for tricks as a whole: `{ on }`, body `{ "on": boolean }`
//                                         (server.ts `tricksFeatureRoute`)
//   POST /api/tricks/<host>/<id>/switch   → body `{ "on": boolean }`; the trick's WireTrickInfo as it now
//                                         reads, or 400 `switch-invalid`, 404 `unknown-host` / `unknown-trick`
//   GET  /api/tricks/<host>/<id>/media/<file> → one picture of the trick's `media/` folder (media.ts), or
//                                         404 "no such image" for every miss
//   GET  /api/tricks/<host>/<id>/code[?file=<rel>] → the index of the trick's code, or one file of it, masked and
//                                         marked (code-view.ts): the About sheet's "Read the code" folds
//   GET  /api/tricks/official             → OfficialTricksReply: the official list with each entry's state
//   POST /api/tricks/official/<id>/add    → body `{}`; fetch the listed commit, check its hash, install it
//   POST /api/tricks/official/<id>/update   off (official-install.ts); `{ id, state }`, or a refusal
//   POST /api/tricks/repo/list            → body `{ rid, url }`: a repository's `collie-tricks.json` at the commit
//                                         read (repo-index.ts), a receipt with `rid`; github.com, gitlab.com and
//                                         codeberg.org only. 400 `repo-invalid`, 409/422/502 `{ error, message }`
//   POST /api/tricks/repo/add             → body `{ rid, url, folder, commit }`: one trick of that list, added off
//   POST /api/tricks/<host>/<id>/value    → body `{ rid, key, value }` (contract 3, values.ts): one field's
//                                         value, null to clear it; a receipt `{ rid, code: "ok", key,
//                                         changed, info }`, or 400 `value-invalid` / `value-refused` (with
//                                         `code` and `message`), 404, 409 `request-id-reused` / `not-here`
//   POST /api/tricks/<host>/<id>/remove   → body `{ rid }` (ADR 0168, remove.ts): remove a trick that is off; a receipt
//                                         `{ rid, code: "removed", id }`, or 400 `remove-invalid`, 404 `unknown-host` /
//                                         `unknown-trick`, 409 `on` / `running` / `link` / `request-id-reused` /
//                                         `unknown` (with `message`), 503 `write-failed`. No GET removes anything.
//
// Both are this bridge's own for now: a host that is not this one is 404, and the crew merge is a
// later slice.

/**
 * The right each tricks route needs. Every intent (a tap, a decision's answer) and the switch need a
 * device key with the write right: a tap runs the program, and the switch changes what runs. The
 * list is read only. server.ts gates each route at its level here, so the requirement has one home.
 */
export const TRICKS_ROUTE_RIGHTS = {
  reply: "read",
  tap: "write",
  switch: "write",
  media: "read",
  // A trick's code for the About sheet's folds: the approved copy's bytes, masked. It changes nothing and
  // shows what the list and a Hill proposal card already show a paired phone, so it is a read like them.
  code: "read",
  // Update this trick without asking, and go back a version (crew slice 3): both change what code runs.
  auto: "write",
  undo: "write",
  // The official list (official.ts) is read only. Adding or updating from it fetches code onto the
  // machine on a tap: a write, like the switch, so only a paired phone with the write right reaches it.
  official: "read",
  officialAdd: "write",
  // A repository's index (repo-index.ts): reading it and adding from it both make the bridge fetch from a
  // host the person pasted, so both need the write right, the official add's level.
  repoList: "write",
  repoAdd: "write",
  // The switch for tricks as a whole (feature-switch.ts): it decides whether any program runs, so the write
  // right, the Hill switch's level. Its read is the list's level.
  feature: "write",
  // A trick's settings (contract 3): what a person keeps for it, so the switch's level. A value starts a run.
  value: "write",
  // Removing a trick (ADR 0168): it deletes the trick's folder, its saved settings and its approved code, so the
  // write right, as the switch. A read-only device and the host's own read key are refused at the gate.
  remove: "write",
} as const satisfies Readonly<Record<"reply" | "tap" | "switch" | "media" | "code" | "auto" | "undo" | "official" | "officialAdd" | "repoList" | "repoAdd" | "feature" | "value" | "remove", GateLevel>>;

/** `since` as a rev, or undefined (every part) when absent or not a whole number at or above 0. */
export function parseSince(raw: string | null): number | undefined {
  if (raw === null || !/^\d{1,16}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A path segment decoded, or null when it does not decode. */
function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Run a tap whose path matched server.ts's `TRICKS_TAP_ROUTE`: group 1 the host, group 2 the trick id. */
export async function tricksTapRoute(tricks: TricksSurface, match: RegExpExecArray, body: JsonValue | undefined, query?: URLSearchParams): Promise<TapAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null) return { status: 404, body: { error: "unknown-trick" } };
  return await tricks.tap(host, id, body, { bound: asksBound(query) });
}

/**
 * Whether a phone asks for bound parts (contract 2, bound.ts): `bound=1` on `GET /api/tricks` and on a tap.
 * A phone that does not ask draws no part bound to sessions, so it never draws one in every session.
 */
export function asksBound(query: URLSearchParams | undefined): boolean {
  return query?.get("bound") === "1";
}

/** Run a switch whose path matched server.ts's `TRICKS_SWITCH_ROUTE`; the body is `{ "on": boolean }`, with `"hash"` the code read. */
export async function tricksSwitchRoute(tricks: TricksSurface, match: RegExpExecArray, body: JsonValue | undefined): Promise<SwitchAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null) return { status: 404, body: { error: "unknown-trick" } };
  const doc = asJsonObject(body);
  const on = asJsonBoolean(doc?.on);
  // Review 8 V-N1: `{ on, hash }`, the hash the code the person read (64 hex); `{ on }` names none.
  const hash = doc?.hash === undefined ? null : asJsonString(doc.hash);
  const keys = doc === undefined ? [] : Object.keys(doc);
  if (doc === undefined || on === undefined || hash === undefined || (hash !== null && !/^[0-9a-f]{64}$/u.test(hash)) || keys.length !== (doc.hash === undefined ? 1 : 2)) return { status: 400, body: { error: "switch-invalid" } };
  return await tricks.setSwitch(host, id, on, hash);
}

/** `POST /api/tricks/<host>/<id>/auto` with `{ "on": true|false }` and nothing else. */
export async function tricksAutoRoute(tricks: TricksSurface, match: RegExpExecArray, body: JsonValue | undefined): Promise<VersionRouteAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null) return { status: 404, body: { error: "unknown-trick" } };
  const doc = asJsonObject(body);
  const on = asJsonBoolean(doc?.on);
  if (doc === undefined || on === undefined || Object.keys(doc).length !== 1) return { status: 400, body: { error: "auto-invalid" } };
  return await tricks.autoRoute(host, id, on);
}

/** `POST /api/tricks/<host>/<id>/undo` with `{}`: an empty object, so a stray field is never read as consent. */
export async function tricksUndoRoute(tricks: TricksSurface, match: RegExpExecArray, body: JsonValue | undefined): Promise<VersionRouteAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null) return { status: 404, body: { error: "unknown-trick" } };
  const doc = asJsonObject(body);
  if (doc === undefined || Object.keys(doc).length !== 0) return { status: 400, body: { error: "undo-invalid" } };
  return await tricks.undoRoute(host, id);
}

/**
 * `POST /api/tricks/<host>/<id>/value` with `{ rid, key, value }` and nothing else (contract 3): `rid` a UUID
 * the phone minted, `key` a field key, `value` text, true or false, a number, or null to clear. Anything else
 * is `value-invalid`, so a stray field is never read. The field's own rule is the service's check.
 * The only writer of values in this version: no terminal verb. Known limits (the lead, 2026-11-17): the
 * seen-id store is memory only (a restart forgets ids; the same id then writes the same value again), and
 * value writes are not rate limited beyond the trick's one-run slot.
 */
export async function tricksValueRoute(tricks: TricksSurface, match: RegExpExecArray, body: JsonValue | undefined): Promise<ValueAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null || tricks.setValue === undefined) return { status: 404, body: { error: "unknown-trick" } };
  const doc = asJsonObject(body);
  const rid = asJsonString(doc?.rid);
  const key = asJsonString(doc?.key);
  const raw = doc?.value;
  const value = raw === null ? null : asFieldValue(raw);
  if (doc === undefined || rid === undefined || key === undefined || value === undefined || Object.keys(doc).length !== 3) return { status: 400, body: { error: "value-invalid" } };
  return await tricks.setValue(host, id, { rid, key, value });
}

/**
 * `POST /api/tricks/<host>/<id>/remove` with `{ rid }` and nothing else (ADR 0168): `rid` a UUID the phone minted for
 * this one confirm. Anything else is `remove-invalid`, so a stray field is never read. The id is a path segment that
 * must decode and pass `isTrickId` in the service; nothing is joined from it here.
 */
export async function tricksRemoveRoute(tricks: TricksSurface, match: RegExpExecArray, body: JsonValue | undefined, device: string | null): Promise<RemoveAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null || tricks.remove === undefined) return { status: 404, body: { error: "unknown-trick" } };
  const doc = asJsonObject(body);
  const rid = asJsonString(doc?.rid);
  if (doc === undefined || rid === undefined || Object.keys(doc).length !== 1) return { status: 400, body: { error: "remove-invalid" } };
  return await tricks.remove(host, id, rid, device);
}

/**
 * `POST /api/tricks/official/<id>/add` or `/update` with `{}`, matched by server.ts's `TRICKS_OFFICIAL_ROUTE`:
 * group 1 the trick id, group 2 the verb. The body must be an empty object, so a stray field is never read
 * as a source, a commit or a hash: those come from the list this binary carries, and from nowhere else.
 */
export async function tricksOfficialRoute(official: OfficialTricksSurface, match: RegExpExecArray, body: JsonValue | undefined): Promise<OfficialAnswer> {
  const id = segment(match[1] ?? "");
  const verb = match[2];
  if (id === null || (verb !== "add" && verb !== "update")) return { status: 404, body: { error: "unknown-official" } };
  const doc = asJsonObject(body);
  if (doc === undefined || Object.keys(doc).length !== 0) return { status: 400, body: { error: "official-invalid" } };
  return await official.install(id, verb);
}

/**
 * Read one picture whose path matched server.ts's `TRICKS_MEDIA_ROUTE`: group 1 the host, group 2 the
 * trick id, group 3 `media/` and the file. A segment that does not decode is a miss like any other;
 * media.ts checks the file against the image `src` rule before a path is built.
 */
export async function tricksMediaRoute(tricks: Pick<TricksSurface, "media">, match: RegExpExecArray): Promise<TrickMediaFile | null> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  const rel = segment(match[3] ?? "");
  if (host === null || id === null || rel === null) return null;
  return await tricks.media(host, id, rel);
}

/** The longest file path the code route takes: the proposal limit on one path, so no real file name is refused. */
const CODE_FILE_PARAM_MAX = 512;

/**
 * Read the code of a trick whose path matched server.ts's `TRICKS_CODE_ROUTE`: group 1 the host, group 2 the
 * trick id. No `file` is the index; `file=<rel>` one file, a name code-view.ts checks against the walk of the
 * code, never a path that is joined to anything first. An empty or very long name is a miss.
 */
export async function tricksCodeRoute(tricks: TricksSurface, match: RegExpExecArray, query: URLSearchParams): Promise<CodeAnswer> {
  const host = segment(match[1] ?? "");
  const id = segment(match[2] ?? "");
  if (host === null) return { status: 404, body: { error: "unknown-host" } };
  if (id === null) return { status: 404, body: { error: "unknown-trick" } };
  const file = query.get("file");
  if (file !== null && (file === "" || file.length > CODE_FILE_PARAM_MAX)) return { status: 404, body: { error: "no-file" } };
  return await tricks.code(host, id, file);
}
