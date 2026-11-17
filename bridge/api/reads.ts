// THE FIVE READS OF THE LOCAL API (M105 spec 03, decisions 4, 12, 15 to 17): `sessions`, `brief`,
// `read`, `accounts` and `hill.list`. They fill the five rows of the operation table that
// operations.ts declares and leaves to a handler (`TableDeps.reads`).
//
// READ ONLY, BY CONSTRUCTION. A handler gets the bridge only through {@link ReadsDeps}, an interface of
// seven getters. None of them types, answers, presses a key or writes: reads.ts imports no module that
// does (ask-reach.test.ts walks the import graph and reads the names on this interface). A handler built
// here cannot answer an ask, because nothing it holds can.
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
// `read` MASKS ALWAYS. The text goes through `maskPaneRead`, the phone's own mask for a mirror read
// (bridge/answer-mask.ts), whatever `COLLIE_REDACT` says: a program of the same Unix user is not the
// person's own phone, and the operator's switch was made for the phone. The mask is BEST EFFORT
// (decision 17): it finds the secret shapes bridge/redact.ts knows, and a secret in another shape passes.
// The docs say so. The escapes are stripped after the mask, so the answer is plain text. The text is cut
// below the socket's answer cap (a line boundary, the newest lines kept) and `truncated` says so.

import { maskPaneRead } from "../answer-mask.ts";
import type { BusEvent, EventBus } from "../events/bus.ts";
import { stripAnsi } from "../journal/text.ts";
import type { JsonObject } from "../json.ts";
import { personName } from "../pane-name.ts";
import type { AccountRow, AccountsBody, AgentStatus, AgentView, PaneAccount } from "../types.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";
import { idOf, resolveSession, type PaneSighting, type SessionView } from "./ids.ts";
import type { OpResult, ReadHandlers } from "./operations.ts";

/** One agent or shell pane of this bridge and the multiplexer session it sits in. */
export interface PaneSource {
  readonly muxSession: string;
  readonly pane: AgentView;
}

/** A screen read: the text as the multiplexer renders it (escapes kept), or that it could not be read. */
export type ScreenRead = { readonly ok: true; readonly text: string; readonly truncated: boolean } | { readonly ok: false };

/**
 * Everything the five reads see of the bridge. Getters only: no method here sends, answers, presses a
 * key or writes (ask-reach.test.ts pins the names). Each is read at the moment of a call.
 */
export interface ReadsDeps {
  /** This bridge's stable id (bridge/bridge-id.ts). */
  machine(): string;
  /** Every pane of every multiplexer session of this bridge now. Agent panes are picked here. */
  panes(): readonly PaneSource[];
  /** The instance token a pane holds now, or null. Must mint nothing (`WalkyInstances.peek`). */
  instanceOf(muxSession: string, paneId: string): string | null;
  /** The bus, for the end of the newest turn. Read only. */
  bus: Pick<EventBus, "since">;
  /** The added account a pane runs under, from memory (`Accounts.paneAccount`). */
  paneAccount(muxSession: string, pane: AgentView): PaneAccount | undefined;
  /** The accounts of this machine, as `GET /api/accounts` has them; null when this machine offers none. */
  accountsBody(): Promise<Pick<AccountsBody, "accounts"> | null>;
  /** Whether the pane's box holds a draft, when a data link knows; null when none does. */
  draftState(muxSession: string, paneId: string): boolean | null;
  /** The screen of one pane, `lines` rows (`MuxAdapter.readGrid`, the phone's own read). */
  readScreen(muxSession: string, paneId: string, lines: number): Promise<ScreenRead>;
  /** The Hill's open decisions, or null when this bridge has no Hill. */
  hillOpen(): readonly HillDecision[] | null;
  /** The lines a `read` takes when the caller names none (`COLLIE_READ_LINES`). */
  defaultLines: number;
}

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

/** FNV-1a, 32 bit, over the text's UTF-8 bytes. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The pane is an agent's, not a bare shell and not a trick's own session. */
function isAgentPane(pane: AgentView): boolean {
  return pane.kind !== "shell" && pane.kind !== "trick";
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

/** The five handlers, over the bridge's getters. */
export function buildReads(deps: ReadsDeps): ReadHandlers {
  const agentPanes = (): PaneSource[] => deps.panes().filter((source) => isAgentPane(source.pane));

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

  const sessions = async (): Promise<OpResult> => {
    const rows: JsonObject[] = [];
    for (const source of agentPanes()) {
      const instance = deps.instanceOf(source.muxSession, source.pane.paneId);
      if (instance === null) continue;
      rows.push(wireOf(sessionRow(source, instance)));
    }
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
        // The ask observer is the move into `blocked` (events/sources.ts): a pane that stands there has an ask open.
        ask: source.pane.status === "blocked",
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

  const accounts = async (): Promise<OpResult> => {
    const body = await deps.accountsBody();
    const rows: JsonObject[] = (body?.accounts ?? []).map((account: AccountRow) => ({
      id: account.id,
      agent: account.harness,
      label: account.label,
      kind: account.kind,
      signedIn: account.identity?.signedIn ?? null,
      running: account.running ?? 0,
    }));
    return { ok: true, answer: { accounts: rows } };
  };

  const hillList = async (): Promise<OpResult> => {
    const open = deps.hillOpen() ?? [];
    const cards: JsonObject[] = open
      .filter((decision) => decision.state === "open")
      .map((decision) => ({
        id: decision.id,
        sender: { kind: decision.from.kind, label: clip(decision.from.label) },
        title: clip(decision.title),
        urgency: decision.priority,
        date: new Date(decision.at).toISOString(),
      }));
    return { ok: true, answer: { cards } };
  };

  return { sessions, brief, read, accounts, "hill.list": hillList };
}
