// THE SIX READS OF THE LOCAL API (M105 spec 03, decisions 4, 12, 15 to 17; spec 04, decision 6):
// `sessions`, `brief`, `read`, `accounts`, `hill.list` and `machines`. They fill the six rows of the
// operation table that operations.ts declares and leaves to a handler (`TableDeps.reads`).
//
// READ ONLY, BY CONSTRUCTION. A handler gets the bridge only through `ApiWorld` (world.ts), the one
// narrow interface of getters the operations see, and bridge/index.ts builds an object of exactly that
// type. None of its members types, answers, presses a key or writes. ask-reach.test.ts holds this three
// ways: the import walk (no module here reaches one that writes), the key test (the world has exactly
// the interface's keys), and the spy test (every operation run against a world whose write methods all
// throw calls none of them).
//
// AN EXPLICIT ALLOW-LIST PER ANSWER. Every answer below is built field by field from a bridge object and
// never by a spread, so a field the bridge adds later reaches no caller until a person adds it here.
// leak.test.ts fills EVERY field the phone's bodies carry a secret in, and asserts none reaches an answer.
//
// WHICH SESSIONS. The AGENT panes of THIS bridge, across all its multiplexer sessions: no shell pane, no
// trick's session, no crew member's pane (a member answers for itself, decision 6). A pane whose instance
// token the registry does not hold is left out of `sessions`: the token is peeked, never minted, so a
// read never makes a session id the rest of the bridge did not.
//
// THE FIELDS OF `sessions`:
//   id       the opaque session id (ids.ts) of the pane instance.
//   machine  this bridge's stable id, the `machine` inside the id and in every event.
//   agent    the agent word as the bridge reports it (`AgentView.agent`); no list of agents lives here.
//   label    a name a PERSON gave the session: Collie's rename, else the name set in the harness, else the
//            name of a one-pane tab the person named (the first three steps of bridge/pane-name.ts
//            `personName`), else the agent word. It leaves out the phone's two further steps, the title
//            the agent wrote (`agentTitle`) and the program's terminal title: those are written by the
//            agent or by a program in the pane, so they can hold a path, a command or a question, and
//            decision 4 keeps such text out. Cut at 120 characters.
//   folder   the folder NAME, the last part of the pane's cwd, never the path; absent when unknown.
//   state    the agent's status.
//   account  the LABEL of the added account the pane runs under (`Accounts.paneAccount`); never an
//            email, a plan or a folder; absent for the Default account or an unknown one.
//   rev      a number that changes when this row changes: FNV-1a (32 bit) over the row's other fields.
//            Equal rows have equal revs, so a caller that holds a rev may skip a row it has seen; a
//            collision (about 1 in 4 billion per change) only costs that caller one skipped update.
//
// THE FIELDS OF `machines` (spec 04, decision 6), one row per machine of the Machines page, the lead first:
//   id         the machine's id. For the machine that answers, this bridge's stable id, the `machine` of
//              `sessions` and of every event; for a crew member, its member id (the same value).
//   label      the Machines page's name of the machine (`MachineRow.name`): a member's join label, the
//              lead's short host name. Only its first dot-separated part, and only when that part is a
//              plain name (letters, digits, `-`, `_`, not all digits); otherwise the id. So a full host
//              name, an address or anything with a user name or a path never reaches the answer.
//   reachable  whether the lead reaches the machine now (`health` is `reachable`); the answering one is.
//   version    the Collie version the machine reported, when it reads as a version (`1.29.0`,
//              `1.29.0-beta.2`); this bridge's own for itself; null when unknown or of another shape.
//   load       `cpu` (busy fraction of all cores) and `memory` (used over total), each 0..1 to two
//              places, from the last sample the watch holds, null with none; `sessions`, the agent
//              sessions: for this machine the rows `sessions` lists, for a member the count its own
//              snapshot answer gave, null when it gave none.
// Nothing here dials: the rows are the watch's memory and the crew overview's (world.ts).
//
// `read` MASKS ALWAYS. The text goes through `maskPaneRead`, the phone's own mask for a mirror read
// (bridge/answer-mask.ts), whatever `COLLIE_REDACT` says: a program of the same Unix user is not the
// person's own phone, and the operator's switch was made for the phone. The mask is BEST EFFORT
// (decision 17): it finds the secret shapes bridge/redact.ts knows, and a secret in another shape passes.
// The docs say so. The escapes are stripped after the mask, so the answer is plain text. The text is cut
// below the socket's answer cap (a line boundary, the newest lines kept) and `truncated` says so.

import { maskPaneRead } from "../answer-mask.ts";
import type { BusEvent } from "../events/bus.ts";
import { stripAnsi } from "../journal/text.ts";
import type { JsonObject } from "../json.ts";
import { personName } from "../pane-name.ts";
import { isQuestionPane, type AccountRow, type AgentStatus, type AgentView, type CrewMemberStatus, type MachineRow } from "../types.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";
import { idOf, resolveSession, type PaneSighting, type SessionView } from "./ids.ts";
import { apiListedPane } from "./listed.ts";
import type { OpResult, ReadHandlers } from "./operations.ts";
import type { ApiWorld } from "./world.ts";

/** One agent or shell pane of this bridge and the multiplexer session it sits in. */
export interface PaneSource {
  readonly muxSession: string;
  readonly pane: AgentView;
}

/** A screen read: the text as the multiplexer renders it (escapes kept), or that it could not be read. */
export type ScreenRead = { readonly ok: true; readonly text: string; readonly truncated: boolean } | { readonly ok: false };

/** One machine as the Machines page knows it: its row there, and on a lead the crew overview's row of the same id. */
export interface MachineSource {
  readonly row: MachineRow;
  readonly member: CrewMemberStatus | undefined;
}

/** What the six reads see of the bridge: the API's world (world.ts). */
export type ReadsDeps = ApiWorld;

/** The text of a `read` answer is cut to this many bytes of the serialized JSON, below the socket's 1 MiB cap. */
export const READ_TEXT_MAX_BYTES = 900 * 1024;
/** The longest label and folder name an answer carries, in characters. */
export const NAME_MAX = 120;

// A cursor no bus can have written: `since` answers a `reset` and then EVERY buffered event, which is how
// the newest `turn.end` of a session is found without a second store.
const WHOLE_RING = "-";

/** The cut of a name: at most {@link NAME_MAX} characters, never half a surrogate pair. */
function clip(text: string): string {
  const chars = [...text.trim()];
  return chars.length <= NAME_MAX ? chars.join("") : chars.slice(0, NAME_MAX).join("");
}

/** The folder NAME of a cwd: its last part, never the path. Empty for a root or an unreadable path. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/u).filter((part) => part !== "" && part !== "." && part !== ".." && !/^[A-Za-z]:$/u.test(part));
  return clip(parts.at(-1) ?? "");
}

/** What a person named a session, else the agent word: see the header. */
export function labelOf(pane: AgentView): string {
  const named = personName(pane)?.name;
  return clip(named ?? pane.agent) || pane.agent;
}

/** A plain machine name: letters, digits, `-` and `_`, at most 63, not all digits. */
const MACHINE_NAME = /^(?![0-9]+$)[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u;

/** The label of a machine: the first part of its name when that is a plain name, else its id (header). */
export function machineLabel(name: string, id: string): string {
  const first = name.trim().split(".")[0] ?? "";
  return MACHINE_NAME.test(first) ? first : id;
}

/** A bare version as the crew wire spells one: three numbers, then an optional `-<word>` and `.<number>`s (`-beta.2`). */
const BARE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z][0-9A-Za-z-]{0,30}(?:\.\d{1,6}){0,3})?$/u;

/** A version a member reported, or null when it gave none or one of another shape. */
function memberVersion(version: string | undefined): string | null {
  return version !== undefined && BARE_VERSION.test(version) ? version : null;
}

/** A fraction to two places, or null when it is no number. */
function fraction(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** The sender label of Collie's own card on the Hill. */
export const SENDER_COLLIE = "Collie";
/** The sender label of an agent that is no session on this bridge (another machine, or gone). */
export const SENDER_AGENT = "agent";
/** The sender label of a trick's card whose name is empty. */
export const SENDER_TRICK = "trick";

/** An epoch-ms time as an ISO date, or undefined when it is no date. */
function isoDate(at: number): string | undefined {
  if (!Number.isFinite(at)) return undefined;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** FNV-1a, 32 bit, over the text's UTF-8 bytes. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The agent panes of a list, by the one predicate {@link apiListedPane} (listed.ts): a pane of kind `agent`
 * (or of no kind, as older panes report), so a bare shell and any kind added later are left out. The bus
 * source publishes for the same panes only. A trick's own session is not even in the list: the world hands
 * its panes over through `realAgentPanes` (bridge/tricks/panes.ts, the one filter of review row 30) in
 * bridge/index.ts, since bridge/api/ may not import bridge/tricks/ (events/seam.test.ts).
 */
function agentPanesOf(sources: readonly PaneSource[]): PaneSource[] {
  return sources.filter((source) => apiListedPane(source.pane));
}

interface SessionRow {
  readonly id: string;
  readonly machine: string;
  readonly agent: string;
  readonly label: string;
  readonly folder: string | undefined;
  readonly state: AgentStatus;
  readonly account: string | undefined;
}

/** A row as the wire carries it: the allow-list, with the absent fields left out. */
function wireOf(row: SessionRow): JsonObject {
  const wire: JsonObject = { id: row.id, machine: row.machine, agent: row.agent, label: row.label };
  if (row.folder !== undefined) wire.folder = row.folder;
  wire.state = row.state;
  if (row.account !== undefined) wire.account = row.account;
  wire.rev = fnv1a(JSON.stringify([row.id, row.agent, row.label, row.folder ?? null, row.state, row.account ?? null]));
  return wire;
}

/** The bytes one line costs inside a serialized JSON string: its escaped form, less the two quotes. */
function cost(line: string): number {
  return Buffer.byteLength(JSON.stringify(line)) - 2;
}

/** A text cut to a budget, and whether anything was cut. */
export interface CappedText {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * The text cut to fit `maxBytes` of its serialized JSON string: whole lines, the NEWEST kept (a screen's
 * bottom is where the agent is). A cut of anything sets `truncated`. Even one line past the budget leaves
 * the text empty, never half a line.
 */
export function capText(text: string, maxBytes: number): CappedText {
  const lines = text.split("\n");
  // Each kept line costs its escaped bytes and the escaped newline that joins it to the next (`\n`, two bytes).
  let used = 0;
  let from = lines.length;
  while (from > 0) {
    const add = cost(lines[from - 1]!) + (from === lines.length ? 0 : 2);
    if (used + add > maxBytes) break;
    used += add;
    from -= 1;
  }
  if (from === 0) return { text, cut: false };
  return { text: lines.slice(from).join("\n"), cut: true };
}

/** The six handlers, over the bridge's getters. */
export function buildReads(deps: ReadsDeps): ReadHandlers {
  const agentPanes = (): PaneSource[] => agentPanesOf(deps.panes());

  // Resolves a session id as ids.ts says, over the agent panes only: a shell pane's id is unknown here.
  const view: SessionView = {
    machine: () => deps.machine(),
    panes: (): PaneSighting[] => agentPanes().map((source) => ({ muxSession: source.muxSession, paneId: source.pane.paneId })),
    instanceOf: (muxSession, paneId) => deps.instanceOf(muxSession, paneId),
  };

  const sessionRow = (source: PaneSource, instance: string): SessionRow => {
    const folder = folderName(source.pane.cwd);
    const account = deps.paneAccount(source.muxSession, source.pane)?.label;
    return {
      id: idOf(deps.machine(), source.pane.paneId, instance),
      machine: deps.machine(),
      agent: source.pane.agent,
      label: labelOf(source.pane),
      folder: folder === "" ? undefined : folder,
      state: source.pane.status,
      account: account === undefined || account === "" ? undefined : clip(account),
    };
  };

  /** The agent panes `sessions` lists: those whose instance token the registry holds. */
  const listed = (): { readonly source: PaneSource; readonly instance: string }[] =>
    agentPanes().flatMap((source) => {
      const instance = deps.instanceOf(source.muxSession, source.pane.paneId);
      return instance === null ? [] : [{ source, instance }];
    });

  const sessions = async (): Promise<OpResult> => {
    const rows = listed().map(({ source, instance }) => wireOf(sessionRow(source, instance)));
    return { ok: true, answer: { sessions: rows } };
  };

  const lastTurnEnd = (session: string): string | null => {
    const events: readonly BusEvent[] = deps.bus.since(WHOLE_RING).events;
    let newest: string | null = null;
    for (const event of events) if (event.type === "turn.end" && event.session === session) newest = event.ts;
    return newest;
  };

  const brief = async (args: { readonly session: string }): Promise<OpResult> => {
    const found = resolveSession(args.session, view);
    if (!found.ok) return { ok: false, code: found.code };
    const source = agentPanes().find((one) => one.muxSession === found.muxSession && one.pane.paneId === found.paneId);
    if (source === undefined) return { ok: false, code: "api.session_unknown" };
    return {
      ok: true,
      answer: {
        session: found.id,
        state: source.pane.status,
        // The ask observer is the move into `blocked` (events/sources.ts): a pane that stands there has an ask
        // open, unless it stopped on an error (`blockedBy: "error"`), which asks nothing.
        ask: isQuestionPane(source.pane),
        lastTurnEnd: lastTurnEnd(found.id),
        draft: deps.draftState(found.muxSession, found.paneId),
      },
    };
  };

  const read = async (args: { readonly session: string; readonly lines: number | undefined }): Promise<OpResult> => {
    const found = resolveSession(args.session, view);
    if (!found.ok) return { ok: false, code: found.code };
    const lines = args.lines ?? deps.defaultLines;
    const screen = await deps.readScreen(found.muxSession, found.paneId, lines);
    if (!screen.ok) return { ok: false, code: "api.failed" };
    // The mask, always (header). `revision` is the mirror's race-guard number and is not part of this answer.
    const masked = maskPaneRead({ paneId: found.paneId, text: screen.text, truncated: screen.truncated, revision: 0 });
    const capped = capText(stripAnsi(masked.text), READ_TEXT_MAX_BYTES);
    return { ok: true, answer: { session: found.id, text: capped.text, lines, truncated: screen.truncated || capped.cut } };
  };

  // HOUSEKEEPING (security read 1, note 2). `accounts` and `hill.list` read through the same getters the
  // phone's routes read through, and those getters do the bookkeeping the phone's reads do: the walky token
  // stamp of the Hill's look (at most every 10 s) and the agent's own status command behind the accounts
  // cache. No operation changes what a person sees or types; these two reads do the same housekeeping as
  // the phone's reads.
  const accounts = async (): Promise<OpResult> => {
    const body = await deps.accountsBody();
    const rows: JsonObject[] = (body?.accounts ?? []).map((account: AccountRow) => ({
      id: account.id,
      agent: account.harness,
      label: clip(account.label),
      kind: account.kind,
      signedIn: account.identity?.signedIn ?? null,
      running: account.running ?? 0,
    }));
    return { ok: true, answer: { accounts: rows } };
  };

  // The pane of this bridge an agent card's sender stands for, or undefined: the card was posted on another
  // machine, or the pane is gone or holds another session now. The address is the poster's walky address,
  // `<member>/<pane id>` with `#<token>` when it names one instance (bridge/walky/address.ts, which this
  // module may not import: bridge/walky/ writes). An address that does not read that way names no pane here.
  const senderPane = (from: HillDecision["from"]): AgentView | undefined => {
    if (from.address === null || from.memberId !== deps.machine()) return undefined;
    const slash = from.address.indexOf("/");
    if (slash <= 0) return undefined;
    const rest = from.address.slice(slash + 1);
    const hash = rest.indexOf("#");
    const paneId = hash < 0 ? rest : rest.slice(0, hash);
    const instance = hash < 0 ? null : rest.slice(hash + 1);
    const found = agentPanes().filter((source) => source.pane.paneId === paneId && (instance === null || deps.instanceOf(source.muxSession, paneId) === instance));
    return found.length === 1 ? found[0]!.pane : undefined;
  };

  // The sender's label (security read 1, item 2): built by `labelOf`, the SAME function as `sessions.label`,
  // from the sender's pane where it is a session on this bridge. Never the stored `from.label` of an agent:
  // the Hill's list renames an open card's sender with `paneName`, which falls back to the title the agent
  // wrote and the terminal title. A trick's card carries the trick's name, stamped by the bridge from its
  // manifest (bridge/tricks/hill.ts); Collie's own card a fixed word; an agent that is no session here (on
  // another machine, or gone) a fixed neutral word.
  const senderLabel = (from: HillDecision["from"]): string => {
    switch (from.kind) {
      case "collie":
        return SENDER_COLLIE;
      case "trick":
        return clip(from.label) || SENDER_TRICK;
      case "agent": {
        const pane = senderPane(from);
        return pane === undefined ? SENDER_AGENT : labelOf(pane);
      }
      default: {
        const never: never = from.kind;
        throw new TypeError(`api: an unknown sender kind ${String(never)}`);
      }
    }
  };

  const hillList = async (): Promise<OpResult> => {
    const open = deps.hillOpen() ?? [];
    const cards: JsonObject[] = open
      .filter((decision) => decision.state === "open")
      .map((decision) => {
        const card: JsonObject = {
          id: decision.id,
          // The bridge the poster runs on (bridge/bridge-id.ts), spelled as `sessions.machine` is, so a caller
          // on a crew's lead, which lists the whole Hill as the person sees it there, can keep only one
          // machine's cards. Null only on a card stored before every bridge had an id.
          machine: decision.from.memberId,
          sender: { kind: decision.from.kind, label: senderLabel(decision.from) },
          title: clip(decision.title),
          urgency: decision.priority,
        };
        // One bad date leaves that card's date out, never the list.
        const date = isoDate(decision.at);
        if (date !== undefined) card.date = date;
        return card;
      });
    return { ok: true, answer: { cards } };
  };

  // `machines` (spec 04, decision 6): built field by field, so an address, a key, a path or a reason the
  // rows carry never reaches the answer (header).
  const machineRow = ({ row, member }: MachineSource): JsonObject => {
    const self = row.isLead;
    const id = self ? deps.machine() : row.id;
    const sample = row.sample;
    return {
      id,
      label: machineLabel(row.name, id),
      reachable: row.health === "reachable",
      version: self ? deps.version() : memberVersion(member?.version),
      load: {
        cpu: sample === undefined ? null : fraction(sample.cpu),
        memory: sample === undefined || sample.memTotal <= 0 ? null : fraction(sample.memUsed / sample.memTotal),
        sessions: self ? listed().length : (member?.panes ?? null),
      },
    };
  };

  const machines = async (): Promise<OpResult> => ({ ok: true, answer: { machines: deps.machines().map(machineRow) } });

  return { sessions, brief, read, accounts, "hill.list": hillList, machines };
}
