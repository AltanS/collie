import type { JsonObject, JsonValue } from "./json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString } from "../web/src/lib/json.ts";

// ── WHAT THE BRIDGE'S OWN LOCAL KEY MAY READ, AND WHAT IT GETS BACK ─────────────────────────────
//
// The local key (`<stateDir>/local-secret`, bridge/local-secret.ts) is a Bearer the bridge writes for
// the CLI beside it. Any program that runs as the operator can read that file, an agent in a pane
// included. So the key reads no screen and no message: no pane text, no history, no chat, no ask, no
// held send, no trick output. A script that reads panes sends a paired device's token (COLLIE_TOKEN).
//
// DENY BY DEFAULT, BY A MARK. {@link LOCAL_KEY_ROUTES} names every route the key may reach, each with
// the caller that needs it. `apiFrontGate` (bridge/server.ts) refuses the key on every other `/api/`
// path, before any route matches and before any `?host=` forward, so a new route is closed to the key
// until someone adds it here with a reason.
//
// ALLOW-LISTED ANSWERS. Four of those routes answer a phone with more than the CLI reads: the snapshot
// (titles, asks, held sends, todos), the tricks list (parts, About, rules), the update check (the run
// record and its log tail, release notes) and the config (the operator's rows, the push key, speech).
// For the key they answer a VIEW built field by field from the fields the CLI reads
// ({@link localSnapshotView}, {@link localTricksView}, {@link localUpdateCheckView},
// {@link localConfigView}). A field a body gains later stays out of the view until it is added here.

/** One route the local key may reach, and why. */
export interface LocalKeyRoute {
  readonly method: "GET";
  readonly path: string;
  readonly reason: string;
}

/** Every route the local key may reach. Exact path, exact method; the query is the route's own business. */
export const LOCAL_KEY_ROUTES: readonly LocalKeyRoute[] = [
  {
    method: "GET",
    path: "/api/snapshot",
    reason:
      "collie doctor (history and restart rows), collie status, collie sessions and the update preflight count panes and read the restart verdict; the key gets localSnapshotView",
  },
  {
    method: "GET",
    path: "/api/tricks",
    reason: "collie trick list and the doctor's tricks row read each trick's switch, state, last run and last error, and the runner's PATH; the key gets localTricksView",
  },
  {
    method: "GET",
    path: "/api/telemetry",
    reason: "the doctor's telemetry row: on or off, and which switch decided; the body holds no screen or message text",
  },
  {
    method: "GET",
    path: "/api/update/check",
    reason: "collie crew update prints the verdicts the lead banked for its members; the key gets localUpdateCheckView",
  },
  {
    method: "GET",
    path: "/api/config",
    reason: "collie durable list asks whether the bridge loaded a durable session (?session=): 200 or 404; the key gets localConfigView",
  },
];

/** Whether the local key may reach this method and path. */
export function isLocalKeyRoute(pathname: string, method: string): boolean {
  return LOCAL_KEY_ROUTES.some((r) => r.path === pathname && r.method === method);
}

// ── The views ────────────────────────────────────────────────────────────────

/** A field kept only when it has the type the CLI reads; anything else is left out. */
type Pick = (value: JsonValue | undefined) => JsonValue | undefined;

const str: Pick = (v) => asJsonString(v);
const num: Pick = (v) => asJsonNumber(v);
const bool: Pick = (v) => asJsonBoolean(v);
/** A list of strings: the strings of an array, in order; anything else is left out. */
const strList: Pick = (v) => (Array.isArray(v) ? v.filter((e): e is string => asJsonString(e) !== undefined) : undefined);

/** A view's fields: each name with the check its value must pass. */
type FieldTable = Readonly<Record<string, Pick>>;

/** Copy exactly the named fields of `from`, each through its type check. Absent stays absent. */
function pickFields(from: JsonObject, fields: FieldTable): JsonObject {
  const out: JsonObject = {};
  for (const [key, check] of Object.entries(fields)) {
    const value = check(from[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The objects of an array field, each through `view`; a non-array is an empty list. */
function listOf(value: JsonValue | undefined, view: (o: JsonObject) => JsonObject): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const o = asJsonObject(entry);
    return o === undefined ? [] : [view(o)];
  });
}

/**
 * The pane fields of the local view, and who reads each:
 *   - `paneId`, `kind`, `agent`, `hasSession`: cli/history.ts (doctor's agent-sessions and integration rows).
 *   - `status`: cli/census.ts (collie status) and cli/sessions.ts (STATE column).
 *   - `host`, `session`, `model`, `workspaceLabel`, `workspaceNumber`, `lastActiveAt`: cli/sessions.ts
 *     (MEMBER, MUX, SEAT, HARNESS and ACTIVE columns, and the sort).
 * `workspaceLabel` can come from a terminal title a program set, and `model` is the harness's own
 * word; both are printed by `collie sessions`, so both stay.
 */
const PANE_FIELDS = {
  paneId: str,
  kind: str,
  agent: str,
  hasSession: bool,
  status: str,
  host: str,
  session: str,
  model: str,
  workspaceLabel: str,
  workspaceNumber: num,
  lastActiveAt: num,
} as const satisfies FieldTable;

/** The session entry fields: cli/sessions.ts matches a pane to its entry and prints its mux. */
const SESSION_FIELDS = {
  name: str,
  host: str,
  isPrimary: bool,
  kind: str,
  mux: str,
} as const satisfies FieldTable;

/** The server fields: cli/sessions.ts names members, asks the reachable peers wide, and prints their mux. */
const SERVER_FIELDS = {
  id: str,
  name: str,
  isLead: bool,
  reachable: bool,
  mux: str,
} as const satisfies FieldTable;

/** The update fields: cli/doctor.ts `restart-pending` reads the bridge's own verdict and its command. */
const UPDATE_FIELDS = {
  restartNeeded: bool,
  restartCommand: str,
} as const satisfies FieldTable;

/**
 * `GET /api/snapshot` for the local key: the fields the CLI reads, and nothing else (see the field
 * tables above). `servers` and `update` ride only when the snapshot had them, as on the phone's body.
 */
export function localSnapshotView(snapshot: JsonObject): JsonObject {
  const out: JsonObject = {
    agents: listOf(snapshot.agents, (p) => pickFields(p, PANE_FIELDS)),
    shellPanes: listOf(snapshot.shellPanes, (p) => pickFields(p, PANE_FIELDS)),
    sessions: listOf(snapshot.sessions, (s) => pickFields(s, SESSION_FIELDS)),
  };
  if (Array.isArray(snapshot.servers)) out.servers = listOf(snapshot.servers, (s) => pickFields(s, SERVER_FIELDS));
  const update = asJsonObject(snapshot.update);
  if (update !== undefined) out.update = pickFields(update, UPDATE_FIELDS);
  return out;
}

/**
 * The trick fields of the local view, all read by cli/trick.ts (`collie trick list`, and the doctor's
 * tricks row through it): `id`, `on`, `state`, `lastRunAt`, `error`, and whether a version waits
 * (`pending`, sent as an empty object: the CLI asks only whether one is there). `error` is the trick's
 * last error, masked by the runner, and `collie trick list` prints it in LAST ERROR, so it stays.
 */
const TRICK_FIELDS = {
  id: str,
  on: bool,
  state: str,
  lastRunAt: str,
  error: str,
  pending: (v) => (asJsonObject(v) === undefined ? undefined : {}),
} as const satisfies FieldTable;

/**
 * `GET /api/tricks` for the local key: each trick's row (above), the runner's `path` (doctor prints
 * it) and `runsOn.lead` (trick list prints it). No parts, no About, no rules, no fields or values.
 */
export function localTricksView(reply: JsonObject): JsonObject {
  const out: JsonObject = { tricks: listOf(reply.tricks, (t) => pickFields(t, TRICK_FIELDS)) };
  const path = asJsonString(reply.path);
  if (path !== undefined) out.path = path;
  const runsOn = asJsonObject(reply.runsOn);
  if (runsOn !== undefined) out.runsOn = pickFields(runsOn, { lead: str });
  return out;
}

/**
 * The crew row fields of the local view, all read by cli/crew-update.ts `bankedPeerVerdicts`, through
 * `parseCrewRows` (bridge/update-action.ts), and then `peerReportLines`, which prints them:
 *   - `name`: matched against the members this run names, and printed.
 *   - `verdict`: printed, and compared with the ssh walk's verdict.
 *   - `reasons`: the first one is printed after the verdict.
 *   - `asOf`: printed as the report's age.
 * `parseCrewRows` also takes `version` and `installKind` when they are there, but nothing after it
 * reads them on this path, and it reads their absence as null and unknown; so they stay out.
 */
const CREW_ROW_FIELDS = {
  name: str,
  verdict: str,
  reasons: strList,
  asOf: num,
} as const satisfies FieldTable;

/**
 * `GET /api/update/check` for the local key: the `crew` rows (above), and nothing else. No run record
 * and no log tail, no release notes, no preflight, no install facts.
 */
export function localUpdateCheckView(reply: JsonObject): JsonObject {
  return { crew: listOf(reply.crew, (r) => pickFields(r, CREW_ROW_FIELDS)) };
}

/**
 * `GET /api/config` for the local key: an empty object. Its one caller, cli/durable-attach.ts
 * `stateOf` (`collie durable list`), reads the status alone: 200 is loaded, 404 or 400 is not. The
 * 404 for an unknown session is answered before this view, as for a phone.
 */
export function localConfigView(): JsonObject {
  return {};
}
