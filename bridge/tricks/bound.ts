import type { FactsSession, ParsedPart, ParsedTrickDocument, Refusal, WireBound } from "../../web/src/lib/tricks/schema.ts";

// BOUND PARTS: A PART THAT NAMES ITS SESSIONS (contract 2, the menu place).
//
// A belt mark or a menu part may name `sessions`, the facts' ids it is drawn in. A pane id is the
// multiplexer's, and the multiplexer hands a closed pane's id to the next pane it opens, so an id alone
// would show a trick's rows in a session the program never saw. At store time each named id is resolved
// against the run's own facts (an agent session there, or it is gone) and stamped with the walky instance
// token its pane held when those facts were read (service.ts `tokensOf`, review 12 N6;
// bridge/walky/instances.ts): the token changes when the pane id is reused. The
// phone draws a bound part only where the session's scope key AND its instance match, and the tap check
// asks the same (service.ts `tapRefusal`).
//
// Fail closed: a session with no instance token (a crew member that sent none, a pane the registry has
// not seen) is dropped with a note, never stamped with a guess. A part with no session left is not
// stored, so its last version goes away with it: it never falls back to every session.

/** The current walky instance token of a facts session id, or null when there is none to bind to. */
export type InstanceOf = (sessionId: string) => string | null;

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
  return parsed.place === "belt" || parsed.place === "menu" ? parsed.part.sessions : undefined;
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
