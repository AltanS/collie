import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJson } from "../web/src/lib/json.ts";
import { LOCAL_MEMBER } from "../bridge/walky/address.ts";
import { DURABLE_AGENT } from "../bridge/mux/durable/protocol.ts";
import { HOST_PARAM } from "../bridge/crew/registry.ts";
import { SESSIONS_ALL, SESSIONS_PARAM } from "../bridge/sessions.ts";
import type { CrewFetch } from "../bridge/crew/peer-client.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { crewModeOnDisk } from "./serve.ts";
import type { Files } from "./sys.ts";
import type { SnapshotRead } from "./history.ts";
import { readOwnSnapshot } from "./snapshot-read.ts";

// `collie sessions`: every agent session this bridge sees, one row each. A READ of this bridge's own
// `/api/snapshot` and nothing else; it writes no file and restarts nothing.
//
// ── WHAT THE ROWS COME FROM ──────────────────────────────────────────────────
// The snapshot's `agents` list (and `shellPanes` for `--all`). Asked wide (`?sessions=all`), so a
// durable agent, which is a session of its own, is in the list. On a lead the peers stay narrow in
// that answer (their primary session only), so each reachable peer is asked once more with
// `?host=<id>&sessions=all` and contributes its own rows from that second answer.
//
// ── WHAT IS NOT IN THE SNAPSHOT ──────────────────────────────────────────────
// A mux name on every session summary. A summary carries one (`SessionCard.mux`) only on an instance
// that runs a durable program. For every other row the MUX column takes the name from the snapshot's
// `servers` row for that host (the lead states its own, and banks each member's off the status
// answer), and prints `-` where neither names one.
//
// No harness name and no mux name is written in this file: the columns print what the snapshot says.

/**
 * THE VERB'S NAME. The one place it is spelled in code; `cli/program.ts` routes through it, and the
 * docs carry it in one heading (docs/sessions.md). A rename to `agents` changes this line and that heading.
 */
export const SESSIONS_VERB = "sessions";

/** The snapshot read goes through these seams, so a test reads no disk and dials no bridge. */
export interface SessionsDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly files: Files;
  readonly fetch: CrewFetch;
  /** The clock, for the ACTIVE column. Absent reads as now. */
  readonly now?: () => number;
}

export const SESSIONS_USAGE = `usage: collie ${SESSIONS_VERB} [--state <state>] [--member <member>] [--all] [--json]`;

/** What the footer says on a member, whose snapshot holds its own panes only. */
export const MEMBER_FOOTER = "this member's panes only; run on the lead for the crew";

/**
 * The login this verb shows its own bridge next to the local read credential, or nothing when none
 * is configured: the same header `collie doctor` sends (issue #238).
 */
function identityHeader(deps: SessionsDeps): Record<string, string> | undefined {
  const login = deps.ctx.env.COLLIE_TRUSTED_USER ?? "";
  return login === "" ? undefined : { "Tailscale-User-Login": login };
}

/** One read of this bridge's own snapshot through the shared reader (`cli/snapshot-read.ts`). */
function readSnapshot(deps: SessionsDeps, query: string): Promise<SnapshotRead> {
  return readOwnSnapshot(deps, { query, extraHeaders: identityHeader(deps) });
}

/** The sentence for a refused read: the one `collie doctor` prints for the same case. */
export function refusedSentence(status: number): string {
  return (
    `the bridge refused this read of \`/api/snapshot\` (${String(status)}); it is up and serving, and no session can be listed from here. ` +
    "Run `collie restart` so the bridge writes its local read credential; if it still refuses, name your tailnet login in " +
    "`COLLIE_TRUSTED_USER` for this instance (`collie config` shows what is set), restart again, then run this again"
  );
}

// ── the wire, as far as this verb reads it ───────────────────────────────────

type Json = JsonObject;

/** A non-empty string field, or undefined. */
const text = (value: JsonValue | undefined): string | undefined => {
  const s = asJsonString(value);
  return s === undefined || s === "" ? undefined : s;
};
const num = (value: JsonValue | undefined): number | undefined => {
  const n = asJsonNumber(value);
  return n === undefined || !Number.isFinite(n) ? undefined : n;
};
/** The objects of an array field; anything else in it is dropped. */
const list = (value: JsonValue | undefined): Json[] => (Array.isArray(value) ? value.map(asJsonObject).filter((o): o is Json => o !== undefined) : []);

interface Server {
  readonly id: string;
  readonly name: string;
  readonly isLead: boolean;
  readonly reachable: boolean;
  /** The multiplexer this host drives, when the lead knows it. */
  readonly mux: string | undefined;
}

interface Body {
  readonly agents: Json[];
  readonly shellPanes: Json[];
  readonly sessions: Json[];
  readonly servers: Server[] | null;
}

/** A parsed snapshot, or null when the text is not one. */
function parseBody(raw: string): Body | null {
  const parsed = asJsonObject(parseJson(raw));
  if (parsed === undefined || !Array.isArray(parsed.agents)) return null;
  const servers = Array.isArray(parsed.servers)
    ? list(parsed.servers).flatMap((s): Server[] => {
        const id = text(s.id);
        if (id === undefined) return [];
        return [{ id, name: text(s.name) ?? id, isLead: asJsonBoolean(s.isLead) === true, reachable: asJsonBoolean(s.reachable) !== false, mux: text(s.mux) }];
      })
    : null;
  return { agents: list(parsed.agents), shellPanes: list(parsed.shellPanes), sessions: list(parsed.sessions), servers };
}

// ── the rows ─────────────────────────────────────────────────────────────────

/** One session as `--json` carries it: the snapshot's own fields, then the derived columns. */
export interface SessionRow extends Json {
  /** The member id: what `--member` and scripts match on. */
  readonly member: string;
  /** The server's name when it has one, else its id: what the MEMBER column prints. */
  readonly memberName: string;
  readonly mux: string | null;
  readonly seat: string | null;
  readonly harness: string;
  readonly state: string;
  readonly session: "yes" | "no";
  readonly active: string | null;
}

/** The mux a session summary names for one host and session, or null when the snapshot says none. */
function muxOf(sessions: readonly Json[], host: string | undefined, session: string | undefined): string | null {
  const ofHost = sessions.filter((s) => text(s.host) === host);
  const named = session === undefined ? undefined : ofHost.find((s) => text(s.name) === session);
  const entry = named ?? ofHost.find((s) => asJsonBoolean(s.isPrimary) === true && text(s.mux) !== undefined);
  return (entry === undefined ? undefined : text(entry.mux)) ?? null;
}

/** Age as a short word: `42s`, `3m`, `2h`, `5d`. A time ahead of the clock reads as `0s`. */
export function ageOf(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h`;
  return `${String(Math.floor(seconds / 86_400))}d`;
}

function rowOf(pane: Json, body: Body, servers: readonly Server[], selfMember: string, now: number): SessionRow {
  const host = text(pane.host);
  const member = host ?? selfMember;
  const server = servers.find((s) => s.id === member);
  const sessionName = text(pane.session);
  const entry = body.sessions.find((s) => text(s.host) === host && text(s.name) === sessionName);
  const durable = text(pane.agent) === DURABLE_AGENT || text(entry?.kind) === "program";
  const agent = text(pane.agent) ?? "-";
  const model = text(pane.model);
  const label = text(pane.workspaceLabel);
  const paneId = text(pane.paneId) ?? "-";
  const lastActiveAt = num(pane.lastActiveAt);
  return {
    ...pane,
    member,
    memberName: server?.name ?? member,
    mux: muxOf(body.sessions, host, sessionName) ?? server?.mux ?? null,
    seat: durable ? null : label === undefined ? paneId : `${label} (${paneId})`,
    harness: durable ? (sessionName ?? label ?? agent) : model === undefined ? agent : `${agent} ${model}`,
    state: text(pane.status) ?? "unknown",
    session: asJsonBoolean(pane.hasSession) === true ? "yes" : "no",
    active: lastActiveAt === undefined ? null : ageOf(lastActiveAt, now),
  };
}

/** Member, then workspace, then pane, so the order is the same on every run. */
function byPlace(a: SessionRow, b: SessionRow): number {
  const number = (row: SessionRow): number => num(row.workspaceNumber) ?? Number.MAX_SAFE_INTEGER;
  return (
    a.memberName.localeCompare(b.memberName) ||
    a.member.localeCompare(b.member) ||
    number(a) - number(b) ||
    String(a.workspaceLabel ?? "").localeCompare(String(b.workspaceLabel ?? "")) ||
    String(a.paneId ?? "").localeCompare(String(b.paneId ?? ""), undefined, { numeric: true })
  );
}

// ── the arguments ────────────────────────────────────────────────────────────

interface Options {
  readonly state: string | null;
  readonly member: string | null;
  readonly all: boolean;
  readonly json: boolean;
}

function parseArgs(args: readonly string[]): Options | { readonly error: string } {
  let state: string | null = null;
  let member: string | null = null;
  let all = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--all") all = true;
    else if (arg === "--json") json = true;
    else if (arg === "--state" || arg === "--member") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `\`${arg}\` needs a value` };
      if (arg === "--state") state = value;
      else member = value;
      i += 1;
    } else return { error: `unknown argument \`${arg}\`` };
  }
  return { state, member, all, json };
}

// ── the table ────────────────────────────────────────────────────────────────

const HEAD = ["MEMBER", "MUX", "SEAT", "HARNESS", "STATE", "SESSION", "ACTIVE"] as const;

/** Footer order for the states Collie names; any other state follows, alphabetical. */
const STATE_ORDER = ["blocked", "working", "idle", "done", "unknown"];

function footerOf(rows: readonly SessionRow[], member: boolean): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const rank = (state: string): number => {
    const at = STATE_ORDER.indexOf(state);
    return at === -1 ? STATE_ORDER.length : at;
  };
  const states = [...counts.keys()].toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const total = `${String(rows.length)} ${rows.length === 1 ? "session" : "sessions"}`;
  const by = states.map((s) => `${String(counts.get(s))} ${s}`).join(", ");
  const lines = [by === "" ? total : `${total}: ${by}`];
  if (member) lines.push(MEMBER_FOOTER);
  return lines;
}

function tableOf(rows: readonly SessionRow[]): string[] {
  const cells = rows.map((r) => [r.memberName, r.mux ?? "-", r.seat ?? "-", r.harness, r.state, r.session, r.active ?? "-"]);
  const widths = HEAD.map((title, c) => Math.max(title.length, ...cells.map((row) => row[c]!.length)));
  const line = (row: readonly string[]): string => row.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd();
  return [line(HEAD), ...cells.map(line)];
}

// ── the verb ─────────────────────────────────────────────────────────────────

function usage(deps: SessionsDeps, why: string): number {
  deps.io.err(`error: ${why}`);
  deps.io.err(SESSIONS_USAGE);
  return EXIT.USAGE;
}

/** Read one answer into a body, or say why not and give the exit code. */
function bodyOrFail(deps: SessionsDeps, answer: SnapshotRead): { readonly body: Body } | { readonly code: number } {
  if (answer.kind === "silent") {
    deps.io.err("error: no bridge answers here; start it with `collie start`, then run this again");
    return { code: EXIT.FAIL };
  }
  if (answer.kind === "refused") {
    deps.io.err(`error: ${refusedSentence(answer.status)}`);
    return { code: EXIT.FAIL };
  }
  const body = parseBody(answer.text);
  if (body !== null) return { body };
  deps.io.err("error: the bridge answered `/api/snapshot` with something that is not a snapshot");
  return { code: EXIT.FAIL };
}

/** `collie sessions [--state <s>] [--member <m>] [--all] [--json]`. */
export async function cmdSessions(deps: SessionsDeps, args: readonly string[]): Promise<number> {
  const options = parseArgs(args);
  if ("error" in options) return usage(deps, options.error);

  const read = bodyOrFail(deps, await readSnapshot(deps, `${SESSIONS_PARAM}=${SESSIONS_ALL}`));
  if ("code" in read) return read.code;
  const first = read.body;

  // On a lead the peers came back narrow. Ask for each reachable one wide, and take its own rows.
  const bodies = new Map<string, Body>();
  for (const server of first.servers ?? []) {
    if (server.isLead || !server.reachable) continue;
    const wide = await readSnapshot(deps, `${HOST_PARAM}=${encodeURIComponent(server.id)}&${SESSIONS_PARAM}=${SESSIONS_ALL}`);
    const parsed = wide.kind === "body" ? parseBody(wide.text) : null;
    if (parsed === null) {
      deps.io.err(`note: could not read ${server.id} wide; its primary session only`);
      continue;
    }
    bodies.set(server.id, parsed);
  }

  const lead = first.servers?.find((s) => s.isLead);
  const selfMember = lead?.id ?? LOCAL_MEMBER;
  const now = (deps.now ?? Date.now)();
  const panes = (pick: (b: Body) => Json[]): { pane: Json; body: Body }[] => [
    ...pick(first)
      .filter((p) => text(p.host) === undefined || text(p.host) === selfMember || !bodies.has(text(p.host)!))
      .map((pane) => ({ pane, body: first })),
    ...[...bodies].flatMap(([id, body]) =>
      pick(body)
        .filter((p) => text(p.host) === id)
        .map((pane) => ({ pane, body })),
    ),
  ];
  const wanted = options.all ? [...panes((b) => b.agents), ...panes((b) => b.shellPanes)] : panes((b) => b.agents);
  const rows = wanted
    .map(({ pane, body }) => rowOf(pane, body, first.servers ?? [], selfMember, now))
    .filter((row) => options.state === null || row.state.toLowerCase() === options.state.toLowerCase())
    .filter((row) => options.member === null || row.member === options.member || row.memberName === options.member)
    .toSorted(byPlace);

  // A member's snapshot holds its own panes and no `servers`; the trust store on disk says it is one.
  const onMember = crewModeOnDisk({ ctx: deps.ctx, files: deps.files }) === "peer" || (first.servers !== null && lead === undefined);

  if (options.json) {
    deps.io.out(JSON.stringify(onMember ? { rows, note: MEMBER_FOOTER } : { rows }));
    return EXIT.OK;
  }
  if (rows.length === 0) {
    deps.io.out("no agent sessions");
    if (onMember) deps.io.out(MEMBER_FOOTER);
    return EXIT.OK;
  }
  for (const line of tableOf(rows)) deps.io.out(line);
  deps.io.out("");
  for (const line of footerOf(rows, onMember)) deps.io.out(line);
  return EXIT.OK;
}
