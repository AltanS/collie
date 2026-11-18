import type { FactsSession, ParsedPart, ParsedTrickDocument, Refusal, WireBound } from "../../web/src/lib/tricks/schema.ts";

// BOUND PARTS: A PART THAT NAMES ITS SESSIONS (contract 2, the menu place).
//
// A belt mark or a menu part may name `sessions`, the facts' ids it is drawn in. A pane id is the
// multiplexer's, and the multiplexer hands a closed pane's id to the next pane it opens, so an id alone
// would show a trick's rows in a session the program never saw. At store time each named id is resolved
// against the run's own facts (an agent session there, or it is gone) and stamped with the walky instance
// token its pane held when those facts were read (service.ts `tokensOf`, review 12 N6;
// bridge/walky/instances.ts): the token changes when the pane is out of sight past the grace, and the
// binding generation below covers a pane id taken inside it. The phone draws a bound part only where the session's scope key AND its instance match, and the tap check
// asks the same (service.ts `tapRefusal`).
//
// THE BINDING GENERATION (review 12, after M1). The instance token is WalkyTalky's: it changes only when
// a pane is out of sight past the grace, so a `/clear`, a resume or an agent restart in the same pane
// keeps its address. A trick's row is for the conversation its program saw, so each binding also keeps
// the pane's generation as the run's facts were read, `<agent>:<agent session or ->` (the Send
// Protocol's), on the bridge only. A pane whose generation changed for sure (another agent, or another
// session it named) loses the binding: the store drops it and takes a rev, so the phone loses the row,
// and a tap is refused. A pane whose generation is not known now (no session named yet, out of sight)
// refuses the tap and keeps the row until it is sure. A binding with no generation (a crew member's
// session: the wire carries no agent session) is checked by its instance token alone.
//
// Fail closed: a session with no instance token (a crew member that sent none, a pane the registry has
// not seen) is dropped with a note, never stamped with a guess. A part with no session left is not
// stored, so its last version goes away with it: it never falls back to every session.

/** The current walky instance token of a facts session id, or null when there is none to bind to. */
export type InstanceOf = (sessionId: string) => string | null;

/** The generation of a facts session's pane now, `<agent>:<agent session or ->`, or null when there is none to read. */
export type GenerationOf = (sessionId: string) => string | null;

/** A generation's agent and session. An agent name holds no colon; a session id may. */
function cut(generation: string): readonly [string, string] {
  const colon = generation.indexOf(":");
  return colon < 0 ? [generation, "-"] : [generation.slice(0, colon), generation.slice(colon + 1)];
}

/**
 * A binding's generation against the pane's now: `same` (or learned: a session named since, by the same
 * agent), `changed` for sure (another agent, or two different sessions named), or `unsure` (the pane is
 * not seen now, or names no session yet while the binding did). A binding with no generation is `same`.
 */
export function bindingAgainst(held: string | null, now: string | null): "same" | "changed" | "unsure" {
  if (held === null) return "same";
  if (now === null) return "unsure";
  const [agentHeld, sessionHeld] = cut(held);
  const [agentNow, sessionNow] = cut(now);
  if (agentHeld !== agentNow) return "changed";
  if (sessionHeld === "-") return "same";
  if (sessionNow === "-") return "unsure";
  return sessionHeld === sessionNow ? "same" : "changed";
}

/** A document with each bound part resolved: what the store keeps, the bindings, and a note per id dropped. */
export interface BoundDocument {
  parsed: ParsedTrickDocument;
  /** Part id to the sessions it is drawn in, for each bound part kept. */
  bound: Map<string, WireBound[]>;
  /** One `dropped` note per session id that did not resolve, and per part left with none. */
  notes: Refusal[];
}

/** The sessions a parsed part names, or undefined for an unbound one. */
function namedSessions(parsed: ParsedPart): readonly string[] | undefined {
  return parsed.place === "belt" || parsed.place === "menu" || parsed.place === "float" ? parsed.part.sessions : undefined;
}

/**
 * Resolve every bound part of a document against the run's facts (`sessions`, the list the program was
 * given) and the instance registry. An unbound part passes as it is.
 */
export function bindParts(parsed: ParsedTrickDocument, sessions: readonly FactsSession[], instanceOf: InstanceOf | undefined): BoundDocument {
  const bound = new Map<string, WireBound[]>();
  const notes: Refusal[] = [];
  const agents = new Set(sessions.filter((session) => session.agent !== undefined).map((session) => session.id));
  const parts: ParsedPart[] = [];
  for (const entry of parsed.parts) {
    const named = namedSessions(entry);
    if (named === undefined) {
      parts.push(entry);
      continue;
    }
    const id = entry.part.id;
    const kept: WireBound[] = [];
    for (const session of named) {
      if (!agents.has(session)) {
        notes.push({ code: "dropped", path: "", part: id, reason: `"${session}" is not an agent session in this run's facts, so the part does not show there.` });
        continue;
      }
      const instance = instanceOf?.(session) ?? null;
      if (instance === null) {
        notes.push({ code: "dropped", path: "", part: id, reason: `"${session}" has no instance Collie can bind to, so the part does not show there.` });
        continue;
      }
      kept.push({ session, instance });
    }
    if (kept.length === 0) {
      notes.push({ code: "dropped", path: "", part: id, reason: "None of the part's sessions is open, so the part is left out." });
      continue;
    }
    bound.set(id, kept);
    parts.push(entry);
  }
  return { parsed: { ...parsed, parts }, bound, notes };
}
