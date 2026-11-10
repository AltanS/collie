import { paneName } from "../pane-name.ts";
import type { AgentView, WorkspaceView } from "../types.ts";
import {
  FACT_SESSIONS_MAX,
  FACT_SESSIONS_MAX_BYTES,
  FACT_SPACES_MAX,
  FACT_TEXT_MAX_BYTES,
  isScopeKey,
  TRICK_CONTRACT,
  type FactsSession,
  type FactsSpace,
  type FactsTrigger,
  type TrickFacts,
} from "../../web/src/lib/tricks/schema.ts";

// THE FACTS A PROGRAM GETS ON STDIN (M94 slice 01): what the phone already sees, in the trick's words.
//
// Sessions are the snapshot's panes, agents and shells, each keyed by its scope key `<memberId>:paneId`
// (never a name, so a draft or an open can name a session the bridge can find again). The member id is
// this bridge's stable id (bridge/bridge-id.ts): the crew member id, or the install id on a solo
// install. Never the host name: `host` is the machine's name for display only. Spaces are the
// multiplexer's workspaces with their folders, then the folders `spaces.toml` gives its sessions.
//
// Not in the facts, on purpose: the instance name, any token, the pane's agent session ref (a filesystem
// path, stripped from the wire too), and the screen. This is not a wall: `trick.dir` is the trick's own
// folder, inside the config folder that holds the `.env` with the token, and the program runs with the
// full rights of the user, so it can read that `.env` like any other file of the user. A program that
// wants more reads it itself, as the operator.

/** One multiplexer session's view, as the state engine holds it. */
export interface FactsRuntime {
  /** The registry name, the key `spaces.toml` uses. */
  name: string;
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
  workspaces: readonly WorkspaceView[];
}

/** Everything about the machine a program is told, before the trigger and the trick are added. */
export interface FactsWorld {
  /** This bridge's stable id (bridge/bridge-id.ts): the key of the session ids and the parts. */
  memberId: string;
  /** The machine's display name, what the facts' `host` fields say (what an agent's Decision shows too). */
  machine: string;
  sessions: FactsSession[];
  spaces: FactsSpace[];
  /** How many sessions were left out past the caps (crew facts only). Absent when none. */
  sessionsOmitted?: number;
}

/** A pane as the facts read it: the local engine's view, or a crew member's pane off the sweep's body. */
export type FactsPane = Omit<AgentView, "agentSession" | "sessionAgent">;

const encoder = new TextEncoder();

/** A text cut to the facts' byte cap at a code point, or undefined when empty. */
function factText(text: string | undefined): string | undefined {
  if (text === undefined || text === "") return undefined;
  if (encoder.encode(text).length <= FACT_TEXT_MAX_BYTES) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (bytes + n > FACT_TEXT_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** One pane as a facts session, or null when its id cannot make a scope key. */
export function factsSessionOf(memberId: string, machine: string, pane: FactsPane, lastActiveMs: number | undefined): FactsSession | null {
  const id = `${memberId}:${pane.paneId}`;
  if (!isScopeKey(id)) return null;
  // DECISION (M94 re-cut): until v2 session ids exist, the session id is the scope key and the member id
  // is this bridge's stable id; both are documented as opaque, so a later id change breaks no trick.
  // `host` is the machine's display name, never a key: a trick passes `id`, `memberId` and `sessionId` back.
  const out: FactsSession = { id, memberId, sessionId: id, paneId: pane.paneId, host: machine, status: pane.status };
  const name = factText(paneName(pane));
  if (name !== undefined) out.name = name;
  if (pane.kind !== "shell") {
    const agent = factText(pane.agent);
    if (agent !== undefined) out.agent = agent;
  }
  const cwd = factText(pane.cwd);
  if (cwd !== undefined) out.cwd = cwd;
  const space = factText(pane.workspaceLabel);
  if (space !== undefined) out.space = space;
  const tab = factText(pane.tabLabel);
  if (tab !== undefined) out.tab = tab;
  if (lastActiveMs !== undefined && Number.isFinite(lastActiveMs) && lastActiveMs > 0) {
    out.lastActiveAt = new Date(lastActiveMs).toISOString();
  }
  return out;
}

export interface FactsWorldInput {
  /** This bridge's stable id (bridge/bridge-id.ts): keys the session ids. */
  memberId: string;
  /** The machine's display name, the same value a decision's `from.host` carries. */
  machine: string;
  runtimes: readonly FactsRuntime[];
  /** A registry session's folder from `spaces.toml`, or undefined. */
  folderOf?: (name: string) => string | undefined;
  /** A registry session's label from `spaces.toml`, or undefined. */
  labelOf?: (name: string) => string | undefined;
  /** When a pane was last active, epoch ms, or undefined. */
  activeAt?: (session: string, paneId: string) => number | undefined;
}

/** The sessions and spaces of every local runtime, capped as the schema caps them. Pure. */
export function factsWorldOf(input: FactsWorldInput): FactsWorld {
  const sessions: FactsSession[] = [];
  const seen = new Set<string>();
  const spaces: FactsSpace[] = [];
  const spaceNames = new Set<string>();
  const addSpace = (name: string | undefined, folder: string | undefined): void => {
    const n = factText(name?.trim());
    if (n === undefined || spaceNames.has(n) || spaces.length >= FACT_SPACES_MAX) return;
    spaceNames.add(n);
    const f = factText(folder);
    spaces.push(f === undefined ? { name: n } : { name: n, folder: f });
  };
  for (const rt of input.runtimes) {
    for (const pane of [...rt.agents, ...rt.shellPanes]) {
      if (sessions.length >= FACT_SESSIONS_MAX) break;
      const s = factsSessionOf(input.memberId, input.machine, pane, input.activeAt?.(rt.name, pane.paneId));
      if (s === null || seen.has(s.id)) continue;
      seen.add(s.id);
      sessions.push(s);
    }
    for (const ws of rt.workspaces) addSpace(ws.label, ws.folder ?? ws.repoRoot);
  }
  for (const rt of input.runtimes) {
    const folder = input.folderOf?.(rt.name);
    if (folder !== undefined) addSpace(input.labelOf?.(rt.name) ?? rt.name, folder);
  }
  return { memberId: input.memberId, machine: input.machine, sessions, spaces };
}

/** One crew member as the lead's sweep holds it, as far as the facts read it. */
export interface CrewFactsMember {
  /** The member id from the lead's trust store, never a word of the member's own. */
  memberId: string;
  /** The member's display name, the crew page's. */
  name: string;
  /** Whether the lead's last sweep reached it. */
  reachable: boolean;
  /** The sweep's last body of the member, or null when the lead never read one. */
  body: { readonly agents: readonly FactsPane[]; readonly shellPanes: readonly FactsPane[] } | null;
}

/** One session's size in the facts, as JSON bytes. */
function sessionBytes(session: FactsSession): number {
  return encoder.encode(JSON.stringify(session)).length;
}

/**
 * The facts of a crew's LEAD (M99 slice 5): its own world, then every member's sessions off the sweep's
 * bodies, each with its own `memberId`, its machine's name as `host`, and `reachable`. The lead's own
 * sessions say `reachable: true` and come first, so a cap never cuts them. Past {@link FACT_SESSIONS_MAX}
 * sessions or {@link FACT_SESSIONS_MAX_BYTES} the rest are left out and counted in `sessionsOmitted`.
 * A member's session takes its key from the trust store's member id, never from the member's body, and a
 * member id that is this lead's own (`own`) is skipped: no member can pose as the lead. Pure.
 */
export function crewFactsWorld(world: FactsWorld, members: readonly CrewFactsMember[], own: (memberId: string) => boolean): FactsWorld {
  const sessions: FactsSession[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let omitted = world.sessionsOmitted ?? 0;
  const add = (session: FactsSession): void => {
    if (seen.has(session.id)) return;
    const size = sessionBytes(session);
    if (sessions.length >= FACT_SESSIONS_MAX || bytes + size > FACT_SESSIONS_MAX_BYTES) {
      omitted += 1;
      return;
    }
    seen.add(session.id);
    sessions.push(session);
    bytes += size;
  };
  for (const session of world.sessions) add({ ...session, reachable: true });
  for (const member of members) {
    if (own(member.memberId) || member.body === null) continue;
    for (const pane of [...member.body.agents, ...member.body.shellPanes]) {
      const session = factsSessionOf(member.memberId, member.name, pane, undefined);
      if (session !== null) add({ ...session, reachable: member.reachable });
    }
  }
  const out: FactsWorld = { memberId: world.memberId, machine: world.machine, sessions, spaces: world.spaces };
  if (omitted > 0) out.sessionsOmitted = omitted;
  return out;
}

/** The whole facts document for one run. `memberId` is the key a program may keep; `host` is display only. */
export function buildFacts(world: FactsWorld, trick: { id: string; dir: string; state: string }, trigger: FactsTrigger): TrickFacts {
  const facts: TrickFacts = { contract: TRICK_CONTRACT, trigger, trick, memberId: world.memberId, host: world.machine, sessions: world.sessions, spaces: world.spaces };
  if (world.sessionsOmitted !== undefined && world.sessionsOmitted > 0) facts.sessionsOmitted = world.sessionsOmitted;
  return facts;
}
