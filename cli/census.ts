import type { CrewMode } from "../bridge/crew/mode.ts";
import type { CrewFetch } from "../bridge/crew/peer-client.ts";
import { parseTrustStore, trustStorePath, type TrustedMember } from "../bridge/crew/trust-store.ts";
import { escapeLabelForTerminal } from "../bridge/pairing.ts";
import type { AgentStatus } from "../bridge/types.ts";
import type { CliContext } from "./context.ts";
import { memberStatusOf, probeMemberReach } from "./crew.ts";
import { groupMembersByHost } from "./host-groups.ts";
import { pairedRegistryOf } from "./pairing.ts";
import { readOwnSnapshot } from "./snapshot-read.ts";
import type { Files } from "./sys.ts";

// The census `collie status` prints under its head (M76 spec 01): which machines are in the crew, which
// phones are paired, and which agent sessions exist and in what state. Three blocks, each a value first
// and a few lines of words second, so `status --json` and the plain text read the same facts.
//
// Every read here is a READ. The members come from the same `hello` and `snapshot` dials `collie crew
// status` makes (`probeMemberReach`), and not from its printing: that verb also stamps first contact and converges the
// anchor record, and a status line must write nothing. The sessions come from this bridge's own
// `/api/snapshot` on the local read credential (`cli/snapshot-read.ts`), never a Tailscale header.

/** A device list longer than this prints its count only; five names fit a line, forty do not. */
export const DEVICE_NAMES_LIMIT = 5;

/** The budget for the sessions read. Status is a glance, and the members are dialled beside it. */
const SESSIONS_BUDGET_MS = 2000;

export type MemberLink = "reachable" | "unreachable" | "incompatible" | "unenrolled";

export interface CensusMember {
  /** The member id the crew calls this machine. */
  readonly name: string;
  readonly role: "lead" | "peer";
  readonly link: MemberLink;
  /** The version it reported on `hello`, or `null` when it did not answer or reports none. */
  readonly version: string | null;
  /** The multiplexer it drives, as it reported it. `null` when it did not answer or says none (an older build): shown as `-`. */
  readonly mux: string | null;
  /** The agent panes it serves. `null` when it sent no count (an older build, or a bridge still starting): shown as `-`, never `0`. */
  readonly panes: number | null;
  /** The host name it reported for its machine (M77 spec 01). `null` when it did not say: that member is its own machine. */
  readonly host: string | null;
}

export interface CensusDevices {
  readonly count: number;
  /** Every label, escaped for a terminal. The plain text shows them only up to {@link DEVICE_NAMES_LIMIT}. */
  readonly names: readonly string[];
}

/** Why the sessions block has no counts. `ok` means it has. */
export type SessionsRead = "ok" | "bridge-not-running" | "refused" | "unreadable";

export type SessionCounts = Readonly<Record<AgentStatus, number>>;

export interface CensusSessions {
  readonly read: SessionsRead;
  /** The HTTP status of a refusal, else `null`. */
  readonly refusedWith: number | null;
  /** Agent panes in the snapshot, or `null` when it was not read: absence is never shown as zero. */
  readonly total: number | null;
  readonly byState: SessionCounts | null;
  /** How many of them report a session id, so a History link can be drawn. */
  readonly withSessionId: number | null;
}

export interface Census {
  readonly members: readonly CensusMember[];
  readonly devices: CensusDevices;
  readonly sessions: CensusSessions;
}

/** What `status` knows before it asks: whether the bridge answers and which crew mode this install is in. */
export interface CensusInput {
  readonly running: boolean;
  readonly crew: CrewMode;
}

/** The census as `status` wants it: one async call, behind a seam so `cmdStatus` is tested with a value. */
export type CensusReader = (input: CensusInput) => Promise<Census>;

export interface CensusDeps {
  readonly ctx: CliContext;
  readonly files: Files;
  readonly fetch: CrewFetch;
  readonly now: () => number;
}

const STATES: readonly AgentStatus[] = ["working", "blocked", "idle", "done", "unknown"];

/** Read all three parts. The member dials and the snapshot read run side by side, not one after another. */
export async function gatherCensus(deps: CensusDeps, input: CensusInput): Promise<Census> {
  const [members, sessions] = await Promise.all([gatherMembers(deps), gatherSessions(deps, input.running)]);
  return { members, devices: gatherDevices(deps, input.crew), sessions };
}

function gatherDevices(deps: CensusDeps, crew: CrewMode): CensusDevices {
  // A peer holds no devices of its own (the lead's door serves the crew), as `pairedDevices` says.
  if (crew === "peer") return { count: 0, names: [] };
  const { devices } = pairedRegistryOf(deps.files, deps.ctx.stateDir);
  return { count: devices.length, names: devices.map((d) => escapeLabelForTerminal(d.label)) };
}

async function gatherMembers(deps: CensusDeps): Promise<CensusMember[]> {
  const raw = deps.files.read(trustStorePath(deps.ctx.stateDir));
  const data = raw === null ? null : parseTrustStore(raw);
  if (data === null || data.crew === null) return [];
  const roster: readonly TrustedMember[] = data.lead === null ? data.peers : [data.lead, ...data.peers];
  const reaches = await probeMemberReach(deps, data, roster);
  return roster.map((m): CensusMember => {
    if (m.status !== "enrolled") return memberRow(m, "unenrolled", null, undefined);
    const reach = reaches.get(m.memberId);
    if (reach === undefined) return memberRow(m, "unreachable", null, undefined);
    if (reach.hello.ok) return memberRow(m, "reachable", reach.hello.value.version, reach);
    return memberRow(m, reach.hello.state === "incompatible" ? "incompatible" : "unreachable", null, undefined);
  });
}

/** One row. Mux and pane count are what the member said (`memberStatusOf`), `null` where it said nothing. */
function memberRow(m: TrustedMember, link: MemberLink, version: string | null, reach: Parameters<typeof memberStatusOf>[0]): CensusMember {
  const { mux, panes, host } = memberStatusOf(reach);
  return { name: m.memberId, role: m.role === "lead" ? "lead" : "peer", link, version, mux, panes, host };
}

/** The wire this block reads: every field optional, so a body that disagrees degrades to "unreadable". */
interface SnapshotAgentsWire {
  readonly agents?: readonly { readonly kind?: string; readonly status?: string; readonly hasSession?: boolean }[];
}

const NOT_READ: Omit<CensusSessions, "read" | "refusedWith"> = { total: null, byState: null, withSessionId: null };

async function gatherSessions(deps: CensusDeps, running: boolean): Promise<CensusSessions> {
  // No bridge, no read: the answer is known, and a dial at a closed port is a wasted budget.
  if (!running) return { read: "bridge-not-running", refusedWith: null, ...NOT_READ };
  const read = await readOwnSnapshot(deps, { budgetMs: SESSIONS_BUDGET_MS });
  if (read.kind === "silent") return { read: "unreadable", refusedWith: null, ...NOT_READ };
  if (read.kind === "refused") return { read: "refused", refusedWith: read.status, ...NOT_READ };
  const counts = countSessions(read.text);
  if (counts === null) return { read: "unreadable", refusedWith: null, ...NOT_READ };
  return { read: "ok", refusedWith: null, ...counts };
}

/** The agent panes of a `/api/snapshot` body by state, or `null` when the body is not a snapshot. */
export function countSessions(
  text: string,
): { total: number; byState: SessionCounts; withSessionId: number } | null {
  let agents: SnapshotAgentsWire["agents"];
  try {
    // SAFETY: the shape `bridge/server.ts` serialises for `/api/snapshot`; every field is optional and
    // read through `?.`. A body that is not an object (`null`) throws on the read and is refused below.
    agents = (JSON.parse(text.trim() === "" ? "{}" : text) as SnapshotAgentsWire).agents;
  } catch {
    return null;
  }
  if (agents === undefined || !Array.isArray(agents)) return null;
  const byState = { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 };
  let total = 0;
  let withSessionId = 0;
  for (const pane of agents) {
    if (pane.kind !== "agent") continue;
    total += 1;
    // A state this build does not know is `unknown`, never a new bucket: the wire may be newer.
    const state = STATES.find((s) => s === pane.status) ?? "unknown";
    byState[state] += 1;
    if (pane.hasSession === true) withSessionId += 1;
  }
  return { total, byState, withSessionId };
}

// ── The words ────────────────────────────────────────────────────────────────

const dash = (value: string | number | null): string => (value === null ? "-" : String(value));

/** The three blocks as plain lines, indented to sit under the banner's rows. */
export function censusLines(census: Census, crew: CrewMode): string[] {
  return [...memberLines(census.members, crew), deviceLine(census.devices, crew), ...sessionLines(census.sessions)];
}

function memberLines(members: readonly CensusMember[], crew: CrewMode): string[] {
  if (crew === "solo") return ["  crew      no crew, this install is solo"];
  if (members.length === 0) return ["  members   none yet, mint an invite and run `collie join` on the other machine"];
  const name = Math.max(...members.map((m) => m.name.length));
  const role = Math.max(...members.map((m) => m.role.length));
  const link = Math.max(...members.map((m) => m.link.length));
  const version = Math.max(...members.map((m) => dash(m.version).length));
  const tail = (m: CensusMember): string => `mux ${dash(m.mux)}  panes ${dash(m.panes)}`;
  const grouping = groupMembersByHost(members, { idOf: (m) => m.name, hostOf: (m) => m.host });
  // Flat, exactly as before, unless some machine runs two instances (M77).
  if (!grouping.shared) {
    return [
      "  members",
      ...members.map((m) => `    ${m.name.padEnd(name)}  ${m.link.padEnd(link)}  ${dash(m.version).padEnd(version)}  ${tail(m)}`),
    ];
  }
  const lines = ["  members"];
  for (const g of grouping.groups) {
    lines.push(`    ${g.host}`);
    for (const m of g.members) {
      lines.push(
        `      ${m.name.padEnd(name)}  ${m.role.padEnd(role)}  ${m.link.padEnd(link)}  ${dash(m.version).padEnd(version)}  ${tail(m)}`,
      );
    }
  }
  return lines;
}

function deviceLine(devices: CensusDevices, crew: CrewMode): string {
  if (crew === "peer") return "  devices   none here, the lead's door serves the crew";
  if (devices.count === 0) return "  devices   none paired";
  const names = devices.count <= DEVICE_NAMES_LIMIT ? ` (${devices.names.join(", ")})` : "";
  return `  devices   ${devices.count} paired${names}`;
}

function sessionLines(sessions: CensusSessions): string[] {
  switch (sessions.read) {
    case "bridge-not-running":
      return ["  sessions  bridge not running"];
    case "refused":
      return [`  sessions  the bridge refused the local read (${dash(sessions.refusedWith)}), run \`collie doctor\``];
    case "unreadable":
      return ["  sessions  the bridge did not give a readable snapshot"];
    case "ok": {
      const by = sessions.byState;
      if (by === null) return ["  sessions  the bridge did not give a readable snapshot"];
      const states = STATES.map((s) => `${s} ${by[s]}`).join("  ");
      return [`  sessions  ${sessions.total} agents  ${states}  (${dash(sessions.withSessionId)} report a session id)`];
    }
  }
}
