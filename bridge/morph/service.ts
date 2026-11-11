// Morph: a third view of an agent session beside Terminal and Chat. The operator turns it on per
// session from the phone and sends a request; the agent answers by drawing ONE screen with
// `collie morph show <file.json>`, in a trick part's node vocabulary. A tap on a button in that screen
// is sent by the phone as an ordinary operator message through the Send Protocol: nothing here types
// into a pane, and nothing here knows a harness or a multiplexer.
//
// Two ways in, both through this service:
//   - the walky socket, for the CLI in an agent's pane (`start`, `show`, `clear`, `on`, `off`, `status`).
//     The socket names the session from the pane's markers. A request MAY also name it (`--session`),
//     and the bridge then checks the name against the markers: a session never draws for another one.
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
// THE RULES HANDSHAKE. A request from the phone carries a head that names the session,
// `[morph <address>] from operator:`, and, while the session is not known to hold the rules, a tail that
// points at them, `[rules: <bin> morph help --session <address>]`. A session proves it holds them with
// `morph start --rules <id>`: the id is a hash of every rule text Morph gives an agent (cli/morph-skill.ts
// `morphRulesId`, handed in as `rulesId`). While the session's LAST start carried the current id, the
// session is served with no tail. A missing or another id is no refusal; it only means "no rules known".
// The proof is held in memory with the pane's mark at that start (`paneMark`: the harness and the
// conversation the bridge already knows of the pane), and it goes when the mark changes (another harness
// or another conversation in the pane, or the pane gone), on `morph off`, and on `morph clear`. A bridge
// restart forgets every proof: the next request then carries the tail once more, the safe side.
//
// THIS MACHINE ONLY, as the hill: a crew member refuses a show (its phone reads the lead), and the
// lead's routes refuse `?host=` (server.ts).

import { isAbsolute } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { LOCAL_MEMBER, parseAddress } from "../walky/address.ts";
import {
  cleanMorphLine,
  MORPH_DRAWING_MAX_MS,
  MORPH_HEAD_MAX,
  MORPH_HINT_MAX,
  MORPH_MEDIA_ID_RE,
  MORPH_MEDIA_MAX,
  MORPH_SET_RE,
  morphShellWord,
  MORPH_CHOICE_BLOCK,
  MORPH_NOTE_MAX,
  MORPH_NOTES_MAX,
  MORPH_TITLE_MAX,
  parseMorphChoice,
  parseMorphView,
  type MorphAnswer,
  type MorphBlock,
  type MorphChoice,
  type MorphDrawing,
  type MorphSession,
  type MorphSwitchBody,
  type MorphView,
} from "../../web/src/lib/morph/wire.ts";
import type { Refusal } from "../../web/src/lib/tricks/schema.ts";
import { keepPictures, MORPH_MINTERS, MORPH_TOO_MANY_IMAGES, readImageFields, type MorphFieldError, type MorphImageInput, type MorphMediaKeep, type MorphMinters, type MorphPictureSet } from "./media.ts";
import { draftOf, keptBlocks, PENDING_NODE, placed, removed, shownBlocks, type MorphDraft, type MorphPendingFields, type MorphSetFields } from "./blocks.ts";
import { morphEntry, type MorphEntry, type MorphStore } from "./store.ts";

/** How the bridge sits in a crew. A member (`peer`) refuses a show: the phone reads the lead. */
export type MorphCrewMode = "solo" | "lead" | "peer";

/** Why the bridge refuses a socket operation. */
export type MorphRefusalCode =
  | "bad_view"
  | "bad_title"
  | "bad_note"
  | "not_on_lead"
  | "unsaved"
  | "wrong_session"
  // Pictures and the decision block: added, never a change to the codes above.
  | "bad_image"
  | "too_many_images"
  | "image_too_large"
  | "bad_choice"
  // Blocks: an id off its pattern or naming no block, and an edit of a screen that is not there.
  | "bad_block"
  | "no_screen";

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
  /**
   * Where pictures are kept: a second instance of the hill's media store, rooted at Morph's own folder
   * (bridge/morph/media.ts). Absent, a command that names a picture is refused and nothing else changes.
   */
  readonly media?: MorphMediaKeep;
  /** How set and picture ids are minted. A test pins them. */
  readonly mint?: MorphMinters;
  /** This build's rules id (cli/morph-skill.ts `morphRulesId`). Absent, no session is ever known to hold the rules. */
  readonly rulesId?: string | undefined;
  /**
   * What the pane a session names runs now, as one opaque word: its harness and its conversation, as far
   * as the bridge knows them (bridge/morph/mark.ts). Null when the pane is not live. Absent: no mark, so a
   * proof ends only on off, clear or a start without the id.
   */
  readonly paneMark?: (session: string) => string | null;
}

/** A socket operation's answer: the caller's session as served, or a refusal with its code. */
export type MorphOpAnswer =
  | { readonly ok: true; readonly session: MorphSession }
  | { readonly ok: false; readonly error: string; readonly code: MorphRefusalCode; readonly refusals?: readonly Refusal[] };

/** The phone's switch: the session as served, or an HTTP status with a sentence. */
export type MorphSwitchAnswer = { readonly ok: true; readonly session: MorphSession } | { readonly ok: false; readonly status: 400 | 404 | 503; readonly error: string };

/** A show's fields, read from the socket: the view and the choice as raw JSON (checked here), the title and the pictures. */
export interface MorphShowFields {
  readonly view: JsonValue | undefined;
  readonly title: string | null;
  /** Absolute paths on this machine; the bridge reads the files. Absent or empty for none. */
  readonly images?: readonly MorphImageInput[];
  /** The decision block, absent for none. */
  readonly choice?: JsonValue;
}

/** One picture's bytes and type, for the media route. */
export interface MorphMediaFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mime: string;
}

/**
 * The head of an earlier build, and the one a session gets whose address cannot ride the head (no shell
 * word, or too long): who wrote it, with no address. Such a session always gets the tail too.
 */
export const MORPH_HEAD = "[morph] from operator:";

/**
 * The head the phone puts in front of a request sent from Morph: who wrote it, and the session it is for,
 * `[morph <address>] from operator:`, so an agent that holds the rules copies the address from it.
 */
export function morphHead(session: string): string {
  const word = morphShellWord(session);
  const head = word === null ? MORPH_HEAD : `[morph ${word}] from operator:`;
  return head.length <= MORPH_HEAD_MAX ? head : MORPH_HEAD;
}

/**
 * The tail the phone appends to a request sent from Morph for ONE session: where the rules are, with the
 * session's own address filled in, so the agent copies the line and never invents an address. It names
 * this bridge's own binary by its absolute path (the `collie` on PATH may be another lane's, without the
 * verb). Throws when the path is so long that even the fallback does not fit on one line under the cap:
 * the caller then runs without Morph. A session whose address cannot ride a shell line, or does not fit,
 * gets the fallback without it.
 */
export function morphHint(binary: string, session: string): string {
  // eslint-disable-next-line no-control-regex
  if (!isAbsolute(binary) || /[\u0000-\u001f\u007f']/u.test(binary)) throw new Error(`morph: the binary path is not an absolute path a shell line can carry: ${binary}`);
  // A path with a blank is quoted, so the line still runs as one command.
  const bin = /\s/u.test(binary) ? `'${binary}'` : binary;
  const word = morphShellWord(session);
  const lines = [...(word === null ? [] : [`[rules: ${bin} morph help --session ${word}]`]), `[rules: ${bin} morph help]`];
  const fits = lines.find((line) => line.length < MORPH_HINT_MAX);
  if (fits === undefined) throw new Error(`morph: the binary path is too long for a one-line hint: ${binary}`);
  return fits;
}

/** An address a hint is probed with at boot: a pane id of the usual length, and a member id of a crew member's. */
const PROBE_SESSION = "bluefin-hc/terminal_12345#ab12";

/**
 * Whether the address a request names is the session the markers placed. Canonical, as the hill's probe
 * reads an address: `local/` and this bridge's own member id name the same machine, and an address
 * without the `#token` names whatever session holds the pane id now. A given token that is not the
 * session's own is another session in the same pane.
 */
export function sameSession({ own, given }: { own: string; given: string }): boolean {
  const mine = parseAddress(own);
  const named = parseAddress(given);
  if (mine?.kind !== "pane" || named?.kind !== "pane") return false;
  if (named.memberId !== mine.memberId && named.memberId !== LOCAL_MEMBER) return false;
  return named.paneId === mine.paneId && (named.instance === null || named.instance === mine.instance);
}

/** The sentence a request that names another session than its pane's own is refused with. */
export function wrongSessionWords({ own, given }: { own: string; given: string }): string {
  return `this pane is ${own}, the command names ${given}; copy the session from the request line, or leave --session out`;
}

function refusalWords(refusals: readonly Refusal[]): string {
  const shown = refusals.slice(0, MORPH_REFUSALS_SHOWN).map((refusal) => `${refusal.path || "/"}: ${refusal.reason}`);
  const more = refusals.length - shown.length;
  return more > 0 ? `${shown.join("; ")}; and ${String(more)} more` : shown.join("; ");
}

/** A session's proof that it holds the rules: the pane's mark when its start carried the current id. */
interface RulesProof {
  readonly mark: string | null;
}

export class MorphService {
  private readonly now: () => number;
  private readonly mint: MorphMinters;
  /** Sessions whose last `morph start` carried the current rules id, in memory only. */
  private readonly proofs = new Map<string, RulesProof>();

  constructor(private readonly deps: MorphServiceDeps) {
    // Probed once, so a path that fits no wording leaves the bridge without Morph at boot, not at a serve.
    morphHint(deps.binary, PROBE_SESSION);
    this.now = deps.now ?? Date.now;
    this.mint = deps.mint ?? MORPH_MINTERS;
  }

  /** The tail one session carries: the same words for every session, with that session's own address. */
  hint(session: string): string {
    return morphHint(this.deps.binary, session);
  }

  /** The revision for the snapshot's `morphRev`, undefined while Morph was never used here. */
  rev(): number | undefined {
    return this.deps.store.rev();
  }

  /** What `GET /api/morph` serves. Rev 0 while no state file exists: the phone then shows every switch off. */
  answer(): MorphAnswer {
    // The sessions first: a proof that ends while they are served moves the revision this answer carries.
    const sessions = this.deps.store.all().map((entry) => this.served(entry));
    return { rev: this.deps.store.rev() ?? 0, sessions };
  }

  /** One session as served. A session the store does not hold is off with no screen. */
  status(session: string): MorphSession {
    const entry = this.deps.store.get(session);
    return entry === undefined ? this.wording({ session, on: false }) : this.served(entry);
  }

  /** The head, and the tail unless the session holds the rules. */
  private wording(session: MorphSession): MorphSession {
    const head = morphHead(session.session);
    session.head = head;
    // A head without the address leaves the agent nothing to copy it from: the tail carries it then.
    if (head === MORPH_HEAD || !this.holdsRules(session.session)) session.hint = this.hint(session.session);
    return session;
  }

  /**
   * Whether the session's last start carried the current rules id, and its pane still runs what it ran
   * then. A proof whose mark moved is dropped here, and the revision moves, so the phone reads again.
   */
  holdsRules(session: string): boolean {
    const proof = this.proofs.get(session);
    if (proof === undefined) return false;
    if (this.deps.paneMark === undefined || this.deps.paneMark(session) === proof.mark) return true;
    this.dropProof(session);
    return false;
  }

  /**
   * The bridge's look at every proof, on its refresh timer: a proof whose pane runs another harness or
   * another conversation, or is gone, ends here. Cheap: one mark per session that holds a proof.
   */
  noteMarks(): void {
    for (const session of this.proofs.keys()) this.holdsRules(session);
  }

  /** End a session's proof. The revision moves when there was one, so the phone fetches the tail again. */
  private dropProof(session: string): void {
    if (this.proofs.delete(session)) this.deps.store.touch();
  }

  /**
   * `morph start` from the socket: the agent says it is drawing, until its show, a clear, the switch going
   * off, or ten minutes. Taken while Morph is off, as a show is: the entry keeps it and the phone shows it
   * once the operator turns Morph on.
   */
  start(session: string, fields: MorphStartFields): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const note = fields.note === null ? null : cleanMorphLine(fields.note, MORPH_NOTE_MAX);
    if (fields.note !== null && note === null) return { ok: false, error: `a note is one line of 1 to ${String(MORPH_NOTE_MAX)} characters`, code: "bad_note" };
    const at = new Date(this.now()).toISOString();
    const base = this.base(session);
    // The rules: this start's id decides, whatever an earlier start said. The write below moves the
    // revision, so the phone reads the session again with the tail or without it.
    const proven = this.deps.rulesId !== undefined && fields.rules === this.deps.rulesId;
    const before = this.proofs.get(session);
    if (proven) this.proofs.set(session, { mark: this.deps.paneMark?.(session) ?? null });
    else this.proofs.delete(session);
    // A start inside a run adds its note to the run's list; a start with no run held begins one.
    const prior = this.freshDrawing(base)?.notes ?? [];
    const notes = note === null ? prior : [...prior, { at, note }].slice(-MORPH_NOTES_MAX);
    const drawing: MorphDrawing = note === null ? { at } : { at, note };
    if (notes.length > 0) drawing.notes = notes;
    const answer = this.commit({ ...base, drawing, changedAt: this.now() });
    if (!answer.ok) {
      if (before === undefined) this.proofs.delete(session);
      else this.proofs.set(session, before);
    }
    return answer;
  }

  /** `morph on` and `morph off` from the socket, for the caller's own session. */
  setOn(session: string, on: boolean): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session);
    // Off ends the rules proof: the next session after an on starts with the tail.
    if (!on) this.dropProof(session);
    // Off ends a drawing too, so an off that only has a drawing to end is still a change.
    if (held?.on === on && !(on === false && held.drawing !== undefined)) return { ok: true, session: this.served(held) };
    const base = this.base(session);
    if (on) return this.commit({ ...base, on });
    return this.commit(morphEntry({ session, on, shows: base.shows, changedAt: this.now(), view: base.view, drawing: undefined }));
  }

  /** `morph clear` from the socket: the screen and the drawing go, the switch stays. */
  clear(session: string): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session);
    // A clear ends the rules proof too (and moves the revision when there was one).
    this.dropProof(session);
    if (held === undefined || (held.view === undefined && held.drawing === undefined)) return { ok: true, session: this.status(session) };
    return this.commit({ session, on: held.on, shows: held.shows, changedAt: this.now() });
  }

  /**
   * `morph show` from the socket: one screen for the caller's session, stored even while Morph is off.
   * Checked cheapest first: the title, the picture count, the view and the choice, and only then are the
   * pictures read and written. A refusal anywhere changes nothing.
   */
  show(session: string, fields: MorphShowFields): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const title = fields.title === null ? null : cleanMorphLine(fields.title, MORPH_TITLE_MAX);
    if (fields.title !== null && title === null) return { ok: false, error: `a title is one line of 1 to ${String(MORPH_TITLE_MAX)} characters`, code: "bad_title" };
    const named = fields.images ?? [];
    const images = named.length;
    if (images > MORPH_MEDIA_MAX) return { ok: false, error: MORPH_TOO_MANY_IMAGES, code: "too_many_images" };
    const parsed = parseMorphView(fields.view, "/view", { images });
    if (parsed.view === undefined) return { ok: false, error: `the view was refused: ${refusalWords(parsed.refusals)}`, code: "bad_view", refusals: parsed.refusals.slice(0, MORPH_REFUSALS_SHOWN) };
    const choice = this.choiceOf(fields.choice, images);
    if (!choice.ok) return choice;
    const kept = images === 0 ? null : keepPictures({ keep: this.deps.media, mint: this.mint, held: null, added: named });
    if (kept !== null && !kept.ok) return { ok: false, error: kept.error, code: kept.code };
    const pictures = kept === null ? null : kept.pictures;
    const base = this.base(session);
    const shows = base.shows + 1;
    const at = new Date(this.now()).toISOString();
    // A show stamps every block fresh and drops everything older.
    const blocks = shownBlocks(parsed.ids ?? parsed.view.map(() => null), at);
    const view = screenOf({ rev: shows, at, title, view: parsed.view, pictures, choice: choice.choice, choiceAt: at, blocks });
    const answer = this.commit({ session, on: base.on, shows, view, changedAt: this.now() });
    if (!answer.ok && pictures !== null) this.deps.media?.remove(pictures.set);
    return answer;
  }

  /**
   * `morph set <id>` from the socket: replace one block, or insert it (at the end, first, or after another
   * block). Pictures named here are ADDED to the screen's set, four in all. With no screen yet, the block
   * starts one. The whole screen that results must pass `parseMorphView`, or nothing changes.
   */
  set(session: string, fields: MorphSetFields): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session)?.view;
    const node = singleNode(fields.node, fields.id);
    if ("error" in node) return { ok: false, error: node.error, code: "bad_view" };
    const heldPictures = picturesOf(held);
    const images = (heldPictures?.media.length ?? 0) + fields.images.length;
    if (images > MORPH_MEDIA_MAX) return { ok: false, error: MORPH_TOO_MANY_IMAGES, code: "too_many_images" };
    const at = new Date(this.now()).toISOString();
    const draft = placed(draftOf(held), { node: node.node, block: { id: fields.id, at }, place: fields.place });
    if ("error" in draft) return { ok: false, error: draft.error, code: "bad_block" };
    // The screen is checked with the picture count it will have before any picture is read.
    const checked = this.checkDraft(draft, images);
    if (checked !== null) return checked;
    const kept = fields.images.length === 0 ? null : keepPictures({ keep: this.deps.media, mint: this.mint, held: heldPictures, added: fields.images });
    if (kept !== null && !kept.ok) return { ok: false, error: kept.error, code: kept.code };
    return this.finish(session, { draft, held, pictures: kept === null ? heldPictures : kept.pictures, added: kept === null ? null : kept.pictures.set });
  }

  /** `morph pending <id> "<label>"` from the socket: a placeholder block, a `spacer` in the view and its label in `blocks`. */
  pending(session: string, fields: MorphPendingFields): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session)?.view;
    const block: MorphBlock = { id: fields.id, at: new Date(this.now()).toISOString(), pending: fields.label };
    const draft = placed(draftOf(held), { node: PENDING_NODE, block, place: fields.place });
    if ("error" in draft) return { ok: false, error: draft.error, code: "bad_block" };
    return this.finish(session, { draft, held, pictures: picturesOf(held), added: null });
  }

  /** `morph remove <id>` from the socket: one block goes; the last block stays (`morph clear` takes the screen). */
  remove(session: string, id: string): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session)?.view;
    if (held === undefined) return { ok: false, error: MORPH_NO_SCREEN, code: "no_screen" };
    const draft = removed(draftOf(held), id);
    if ("error" in draft) return { ok: false, error: draft.error, code: "bad_block" };
    return this.finish(session, { draft, held, pictures: picturesOf(held), added: null });
  }

  /** `morph keep <id>... | --all` from the socket: those blocks are still valid for the current request, re-stamped without being sent again. */
  keep(session: string, ids: readonly string[] | "all"): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session)?.view;
    if (held === undefined) return { ok: false, error: MORPH_NO_SCREEN, code: "no_screen" };
    const at = new Date(this.now()).toISOString();
    if (ids !== "all" && ids.includes(MORPH_CHOICE_BLOCK) && held.choice === undefined) return { ok: false, error: "this screen has no choice to keep", code: "bad_block" };
    const draft = keptBlocks(draftOf(held), { ids, at });
    if ("error" in draft) return { ok: false, error: draft.error, code: "bad_block" };
    const keepChoice = held.choice !== undefined && (ids === "all" || ids.includes(MORPH_CHOICE_BLOCK));
    return this.finish(session, { draft, held, pictures: picturesOf(held), added: null, choiceAt: keepChoice ? at : held.choiceAt });
  }

  /** `morph choice <file> | --clear` from the socket: set or drop the decision block alone. */
  setChoice(session: string, raw: JsonValue | null): MorphOpAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, error: MORPH_NOT_ON_LEAD, code: "not_on_lead" };
    const held = this.deps.store.get(session)?.view;
    if (held === undefined) return { ok: false, error: MORPH_NO_SCREEN, code: "no_screen" };
    const pictures = picturesOf(held);
    if (raw === null) return this.finish(session, { draft: draftOf(held), held, pictures, added: null, choice: null });
    const choice = this.choiceOf(raw, pictures?.media.length ?? 0);
    if (!choice.ok) return choice;
    return this.finish(session, { draft: draftOf(held), held, pictures, added: null, choice: choice.choice ?? null, choiceAt: new Date(this.now()).toISOString() });
  }

  /** The refusal for a draft whose whole screen does not pass, or null when it passes. */
  private checkDraft(draft: MorphDraft, images: number): Extract<MorphOpAnswer, { ok: false }> | null {
    const parsed = parseMorphView([...draft.nodes], "/view", { images });
    if (parsed.view !== undefined) return null;
    return { ok: false, error: `the screen would be refused: ${refusalWords(parsed.refusals)}`, code: "bad_view", refusals: parsed.refusals.slice(0, MORPH_REFUSALS_SHOWN) };
  }

  /**
   * Store an edited screen: checked whole, a new rev and `at`, the title kept, the drawing kept (only a
   * show ends a drawing run). A picture set minted for this edit (`added`) is removed again on a refusal.
   * `choice` null drops the decision block, undefined keeps the held one.
   */
  private finish(
    session: string,
    edit: { draft: MorphDraft; held: MorphView | undefined; pictures: MorphPictureSet | null; added: string | null; choice?: MorphChoice | null; choiceAt?: string | undefined },
  ): MorphOpAnswer {
    const images = edit.pictures?.media.length ?? 0;
    const parsed = parseMorphView([...edit.draft.nodes], "/view", { images });
    const drop = () => {
      if (edit.added !== null) this.deps.media?.remove(edit.added);
    };
    if (parsed.view === undefined) {
      drop();
      return { ok: false, error: `the screen would be refused: ${refusalWords(parsed.refusals)}`, code: "bad_view", refusals: parsed.refusals.slice(0, MORPH_REFUSALS_SHOWN) };
    }
    const base = this.base(session);
    const shows = base.shows + 1;
    const at = new Date(this.now()).toISOString();
    const choice = edit.choice === undefined ? edit.held?.choice : (edit.choice ?? undefined);
    const choiceAt = choice === undefined ? undefined : (edit.choiceAt ?? edit.held?.choiceAt ?? at);
    const view = screenOf({ rev: shows, at, title: edit.held?.title ?? null, view: parsed.view, pictures: edit.pictures, choice, choiceAt, blocks: [...edit.draft.blocks] });
    const answer = this.commit(morphEntry({ session, on: base.on, shows, changedAt: this.now(), view, drawing: base.drawing }));
    if (!answer.ok) drop();
    return answer;
  }

  /** The bytes of one picture a held screen names, or null. Both ids are checked before the store is asked. */
  mediaFile(set: string, mediaId: string): MorphMediaFile | null {
    if (!MORPH_SET_RE.test(set) || !MORPH_MEDIA_ID_RE.test(mediaId) || this.deps.media === undefined) return null;
    const view = this.deps.store.all().find((entry) => entry.view?.set === set)?.view;
    const media = view?.media?.find((item) => item.id === mediaId);
    if (media === undefined) return null;
    const bytes = this.deps.media.bytesOf(set, media);
    return bytes === null ? null : { bytes, mime: media.mime };
  }

  /** Remove every picture set no held screen names: at boot, as the hill prunes its media. */
  pruneMedia(): void {
    this.deps.media?.prune(this.heldSets(this.deps.store.all()));
  }

  /** The decision block, read with the screen's picture count; undefined for none. */
  private choiceOf(raw: JsonValue | undefined, images: number): { readonly ok: true; readonly choice: MorphChoice | undefined } | Extract<MorphOpAnswer, { ok: false }> {
    if (raw === undefined) return { ok: true, choice: undefined };
    const parsed = parseMorphChoice(raw, "/choice", { images });
    if (parsed.choice === undefined) return { ok: false, error: `the choice was refused: ${refusalWords(parsed.refusals)}`, code: "bad_choice", refusals: parsed.refusals.slice(0, MORPH_REFUSALS_SHOWN) };
    return { ok: true, choice: parsed.choice };
  }

  private heldSets(entries: readonly MorphEntry[]): Set<string> {
    return new Set(entries.flatMap((entry) => (entry.view?.set === undefined ? [] : [entry.view.set])));
  }

  /** The phone's switch: the address is resolved to the live session it names here, then switched. */
  switch(body: MorphSwitchBody): MorphSwitchAnswer {
    if (this.deps.crewMode() === "peer") return { ok: false, status: 400, error: MORPH_NOT_ON_LEAD };
    const where = this.deps.place(body.session);
    if (where === null) return { ok: false, status: 404, error: MORPH_NO_SESSION };
    const answer = this.setOn(where.address, body.on);
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
    // A set no held screen names goes with the write that dropped it, as the hill prunes on write.
    this.deps.media?.prune(this.heldSets(this.deps.store.all()));
    return { ok: true, session: this.served(entry) };
  }

  /** A drawing counts for ten minutes: checked when it is read, with no timer. */
  private freshDrawing(entry: MorphEntry): MorphDrawing | undefined {
    if (entry.drawing === undefined) return undefined;
    const age = this.now() - Date.parse(entry.drawing.at);
    return age < MORPH_DRAWING_MAX_MS ? entry.drawing : undefined;
  }

  /** An entry says something while Morph is on, a screen is up, a show was counted (the next rev), or a drawing is fresh. */
  private worthKeeping(entry: MorphEntry): boolean {
    return entry.on || entry.view !== undefined || entry.shows > 0 || this.freshDrawing(entry) !== undefined;
  }

  private served(entry: MorphEntry): MorphSession {
    const session: MorphSession = this.wording({ session: entry.session, on: entry.on });
    if (entry.view !== undefined) session.view = entry.view;
    const drawing = this.freshDrawing(entry);
    if (drawing !== undefined) session.drawing = drawing;
    return session;
  }
}

/** A `morph.start` request's fields, as the socket carries them: an optional `note` and an optional `rules` id. */
export interface MorphStartFields {
  readonly note: string | null;
  /** The rules id the session says it holds. Null for none; a value that is not text reads as none. */
  readonly rules?: string | null;
}

/** A `morph.start` request's fields: the note and the rules id, or the reason the note is not one. */
export function readStartFields(fields: JsonObject): MorphStartFields | { readonly error: string } {
  const note = fields.note === undefined || fields.note === null ? null : asJsonString(fields.note);
  if (note === undefined) return { error: "a note is text" };
  // A wrong rules id is never a refusal: the start works, and the session gets the tail.
  const rules = asJsonString(fields.rules) ?? null;
  return { note, rules };
}

/** One screen built from its parts: the pictures, the choice and the blocks are on it only when given. */
export function screenOf(parts: {
  rev: number;
  at: string;
  title: string | null;
  view: MorphView["view"];
  pictures: MorphPictureSet | null;
  choice: MorphChoice | undefined;
  choiceAt?: string | undefined;
  blocks?: MorphBlock[];
}): MorphView {
  const screen: MorphView = { rev: parts.rev, at: parts.at, view: parts.view };
  if (parts.title !== null) screen.title = parts.title;
  if (parts.pictures !== null) {
    screen.set = parts.pictures.set;
    screen.media = [...parts.pictures.media];
  }
  if (parts.choice !== undefined) {
    screen.choice = parts.choice;
    screen.choiceAt = parts.choiceAt ?? parts.at;
  }
  if (parts.blocks !== undefined) screen.blocks = parts.blocks;
  return screen;
}

/** The sentence an edit of a session with no screen yet is refused with. */
export const MORPH_NO_SCREEN = "this session has no screen yet; draw one with `morph show` first";

/** A screen's picture set, or null. */
function picturesOf(view: MorphView | undefined): MorphPictureSet | null {
  return view?.set === undefined || view.media === undefined ? null : { set: view.set, media: view.media };
}

/**
 * The ONE node of a `set`: a node, or a list of exactly one. A node may carry `id` only when it is the
 * block's own id (as a `show` file would spell it); it is taken off, since the schema refuses it.
 */
export function singleNode(raw: JsonValue, id: string): { readonly node: JsonValue } | { readonly error: string } {
  const one = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  const obj = asJsonObject(one);
  if (obj === undefined) return { error: "a block is ONE node, or a list of exactly one" };
  if (obj.id === undefined) return { node: obj };
  const { id: named, ...node } = obj;
  if (named !== id) return { error: `the node names the block "${asJsonString(named) ?? "?"}", the command names "${id}"` };
  return { node };
}

/** A `morph.show` request's fields, as the socket carries them: `view` and `choice` (any JSON), an optional `title`, and `images`. */
export function readShowFields(fields: JsonObject): MorphShowFields | MorphFieldError {
  const title = fields.title === undefined || fields.title === null ? null : asJsonString(fields.title);
  if (title === undefined) return { error: "a title is text", code: "bad_title" };
  const images = readImageFields(fields.images);
  if ("error" in images) return images;
  if (fields.choice === undefined || fields.choice === null) return { view: fields.view, title, images };
  return { view: fields.view, title, images, choice: fields.choice };
}
