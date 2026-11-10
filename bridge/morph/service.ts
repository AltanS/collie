// Morph: a third view of an agent session beside Terminal and Chat. The operator turns it on per
// session from the phone and sends a request; the agent answers by drawing ONE screen with
// `collie morph show <file.json>`, in a trick part's node vocabulary. A tap on a button in that screen
// is sent by the phone as an ordinary operator message through the Send Protocol: nothing here types
// into a pane, and nothing here knows a harness or a multiplexer.
//
// Two ways in, both through this service:
//   - the walky socket, for the CLI in an agent's pane (`show`, `clear`, `on`, `off`, `status`). The
//     socket names the session from the pane's markers; an argument never names it.
//   - the phone, `GET /api/morph` and `POST /api/morph/switch` (bridge/server.ts).
//
// A SESSION IS ITS WALKY ADDRESS with the instance token, as the hill names a session. The phone's
// switch is resolved through the same probe the hill uses (walkyPlace), so `local/` and this bridge's
// own member id name the same pane, and an address that names no live agent session here is refused.
//
// PRUNING. The store keeps an entry while it says something: an entry with Morph off, no screen and no
// show counted is dropped at the next write, and so is one whose session is gone, once the bridge lists sessions at
// all (a bridge right after boot lists none, and must not forget every switch). The store also caps
// the list (store.ts). Every entry held is served: the phone matches entries to its panes by key.
//
// THIS MACHINE ONLY, as the hill: a crew member refuses a show (its phone reads the lead), and the
// lead's routes refuse `?host=` (server.ts).

import { isAbsolute } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonString } from "../../web/src/lib/json.ts";
import {
  cleanMorphLine,
  MORPH_HINT_MAX,
  MORPH_TITLE_MAX,
  parseMorphView,
  type MorphAnswer,
  type MorphSession,
  type MorphSwitchBody,
  type MorphView,
} from "../../web/src/lib/morph/wire.ts";
import type { Refusal } from "../../web/src/lib/tricks/schema.ts";
import type { MorphEntry, MorphStore } from "./store.ts";

/** How the bridge sits in a crew. A member (`peer`) refuses a show: the phone reads the lead. */
export type MorphCrewMode = "solo" | "lead" | "peer";

/** Why the bridge refuses a socket operation. */
export type MorphRefusalCode = "bad_view" | "bad_title" | "not_on_lead" | "unsaved";

/** The sentence a crew member answers a show or a switch with. */
export const MORPH_NOT_ON_LEAD = "Morph reads this machine only for now; run it in a session on the lead machine";
/** The sentence when the state file could not be written. */
export const MORPH_UNSAVED = "the bridge could not save Morph's state; nothing changed";
/** The sentence the phone's switch gets for an address that names no live agent session here. */
export const MORPH_NO_SESSION = "that address names no live agent session on this machine";

/** The most refusals a show answers with, so a view that is wrong everywhere stays readable. */
export const MORPH_REFUSALS_SHOWN = 8;

/** The live agent session a walky address names now: its address with the instance token. */
export interface MorphPlace {
  readonly address: string;
}

export interface MorphServiceDeps {
  readonly store: MorphStore;
  /** The probe the hill uses (hill/walky.ts `walkyPlace`): null for a scope, a shell, a gone pane. */
  readonly place: (address: string) => MorphPlace | null;
  /** False until the bridge lists any session: pruning waits for it. */
  readonly sessionsKnown: () => boolean;
  readonly crewMode: () => MorphCrewMode;
  /** The absolute path of this bridge's own `collie` binary, named in the hint. */
  readonly binary: string;
  readonly now?: () => number;
}

/** A socket operation's answer: the caller's session as served, or a refusal with its code. */
export type MorphOpAnswer =
  | { readonly ok: true; readonly session: MorphSession }
  | { readonly ok: false; readonly error: string; readonly code: MorphRefusalCode; readonly refusals?: readonly Refusal[] };

/** The phone's switch: the session as served, or an HTTP status with a sentence. */
export type MorphSwitchAnswer = { readonly ok: true; readonly session: MorphSession } | { readonly ok: false; readonly status: 400 | 404 | 503; readonly error: string };

/** A show's fields, read from the socket: the view as raw JSON (checked here) and the title. */
export interface MorphShowFields {
  readonly view: JsonValue | undefined;
  readonly title: string | null;
}

/** The hint wordings, longest first. The first one under {@link MORPH_HINT_MAX} is used. */
const HINT_WORDINGS: readonly ((bin: string) => string)[] = [
  (bin) => `[morph: I read this on Collie's Morph view. Answer by drawing one screen: ${bin} morph show <file.json>. Kinds and an example: ${bin} morph help]`,
  (bin) => `[morph: read on Collie's Morph view. Answer with one screen: ${bin} morph show <file.json>. How: ${bin} morph help]`,
  (bin) => `[morph: read on Collie's Morph view. Answer with one screen: ${bin} morph show <file.json>. How: the same binary with morph help]`,
];

/**
 * The one line the phone appends to a request sent from Morph, naming this bridge's own binary by its
 * absolute path (the `collie` on PATH may be another lane's, without the verb). Throws when the path is
 * so long that no wording fits on one line under the cap: the caller then runs without Morph.
 */
export function morphHint(binary: string): string {
  // eslint-disable-next-line no-control-regex
  if (!isAbsolute(binary) || /[\u0000-\u001f\u007f']/u.test(binary)) throw new Error(`morph: the binary path is not an absolute path a shell line can carry: ${binary}`);
  // A path with a blank is quoted, so the line still runs as one command.
  const bin = /\s/u.test(binary) ? `'${binary}'` : binary;
  const fits = HINT_WORDINGS.map((wording) => wording(bin)).find((line) => line.length < MORPH_HINT_MAX);
  if (fits === undefined) throw new Error(`morph: the binary path is too long for a one-line hint: ${binary}`);
  return fits;
}

function refusalWords(refusals: readonly Refusal[]): string {
  const shown = refusals.slice(0, MORPH_REFUSALS_SHOWN).map((refusal) => `${refusal.path || "/"}: ${refusal.reason}`);
  const more = refusals.length - shown.length;
  return more > 0 ? `${shown.join("; ")}; and ${String(more)} more` : shown.join("; ");
}

export class MorphService {
  private readonly hintLine: string;
  private readonly now: () => number;

  constructor(private readonly deps: MorphServiceDeps) {
    this.hintLine = morphHint(deps.binary);
    this.now = deps.now ?? Date.now;
  }

  /** The hint every served session carries. */
  hint(): string {
    return this.hintLine;
  }

  /** The revision for the snapshot's `morphRev`, undefined while Morph was never used here. */
  rev(): number | undefined {
    return this.deps.store.rev();
  }

  /** What `GET /api/morph` serves. Rev 0 while no state file exists: the phone then shows every switch off. */
  answer(): MorphAnswer {
    return { rev: this.deps.store.rev() ?? 0, sessions: this.deps.store.all().map((entry) => this.served(entry)) };
  }

  /** One session as served. A session the store does not hold is off with no screen. */
  status(session: string): MorphSession {
    const entry = this.deps.store.get(session);
    return entry === undefined ? { session, on: false, hint: this.hintLine } : this.served(entry);
  }

  /** `morph on` and `morph off` from the socket, for the caller's own session. */
  setOn(session: string, on: boolean): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session);
    if (held?.on === on) return { ok: true, session: this.served(held) };
    return this.commit({ ...this.base(session), on });
  }

  /** `morph clear` from the socket: the screen goes, the switch stays. */
  clear(session: string): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session);
    if (held?.view === undefined) return { ok: true, session: this.status(session) };
    return this.commit({ session, on: held.on, shows: held.shows, changedAt: this.now() });
  }

  /** `morph show` from the socket: one screen for the caller's session, stored even while Morph is off. */
  show(session: string, fields: MorphShowFields): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const title = fields.title === null ? null : cleanMorphLine(fields.title, MORPH_TITLE_MAX);
    if (fields.title !== null && title === null) return { ok: false, error: `a title is one line of 1 to ${String(MORPH_TITLE_MAX)} characters`, code: "bad_title" };
    const parsed = parseMorphView(fields.view);
    if (parsed.view === undefined) return { ok: false, error: `the view was refused: ${refusalWords(parsed.refusals)}`, code: "bad_view", refusals: parsed.refusals.slice(0, MORPH_REFUSALS_SHOWN) };
    const base = this.base(session);
    const shows = base.shows + 1;
    const view: MorphView = title === null ? { rev: shows, at: new Date(this.now()).toISOString(), view: parsed.view } : { rev: shows, at: new Date(this.now()).toISOString(), title, view: parsed.view };
    return this.commit({ session, on: base.on, shows, view, changedAt: this.now() });
  }

  /** The phone's switch: the address is resolved to the live session it names here, then switched. */
  switch(body: MorphSwitchBody): MorphSwitchAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, status: 400, error: MORPH_NOT_ON_LEAD };
    const placed = this.deps.place(body.session);
    if (placed === null) return { ok: false, status: 404, error: MORPH_NO_SESSION };
    const answer = this.setOn(placed.address, body.on);
    if (answer.ok) return answer;
    return { ok: false, status: answer.code === "unsaved" ? 503 : 400, error: answer.error };
  }

  /** The held entry, or a fresh one that is off with no screen. */
  private base(session: string): MorphEntry {
    return this.deps.store.get(session) ?? { session, on: false, shows: 0, changedAt: this.now() };
  }

  /** Write one changed entry, and prune the rest by the rules in the header. */
  private commit(changed: MorphEntry): MorphOpAnswer {
    const entry: MorphEntry = { ...changed, changedAt: this.now() };
    const known = this.deps.sessionsKnown();
    const rest = this.deps.store.all().filter((held) => held.session !== entry.session && this.worthKeeping(held) && (!known || this.deps.place(held.session) !== null));
    const next = this.worthKeeping(entry) ? [...rest, entry] : rest;
    if (!this.deps.store.replace(next)) return { ok: false, error: MORPH_UNSAVED, code: "unsaved" };
    return { ok: true, session: this.served(entry) };
  }

  /** An entry says something while Morph is on, a screen is up, or a show was counted (the next rev). */
  private worthKeeping(entry: MorphEntry): boolean {
    return entry.on || entry.view !== undefined || entry.shows > 0;
  }

  private served(entry: MorphEntry): MorphSession {
    const session: MorphSession = { session: entry.session, on: entry.on, hint: this.hintLine };
    if (entry.view !== undefined) session.view = entry.view;
    return session;
  }
}

/** A `morph.show` request's fields, as the socket carries them: `view` (any JSON) and an optional `title`. */
export function readShowFields(fields: JsonObject): MorphShowFields | { readonly error: string } {
  const title = fields.title === undefined || fields.title === null ? null : asJsonString(fields.title);
  if (title === undefined) return { error: "a title is text" };
  return { view: fields.view, title };
}
