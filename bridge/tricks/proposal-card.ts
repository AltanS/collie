import { createHash } from "node:crypto";

import { HILL_SUMMARY_MAX, type HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { DECISION_VIEW_LIMITS, inputsSentence, TEXT_MAX, type TrickManifest, type View, type ViewNode } from "../../web/src/lib/tricks/schema.ts";
import { unsafeText } from "./code-hash.ts";
import { WARN_PLAIN } from "./scan.ts";
import { addedDiff, codeGroup, changeCells, filesOnCards, GROUP_WIDE_GAP, groupOrder, helperNote, placesTables, shippedHelpers, sizeWords, type GroupRefusal } from "./card-group.ts";
import { bytesOf, checked, filesSentence, fitView, listWords, newInputs, newRights, placeWords, rightsHead, versionTitle, WARN_VERBS } from "./version-card.ts";
import type { ProposedFile } from "./propose-wire.ts";
import type { VersionDiff } from "./version-diff.ts";

// THE PROPOSAL CARD (crew slice 8): one Decision of Collie's own on the lead's Hill for each trick an agent
// or a terminal proposed with `collie trick propose`. Nothing of the trick runs before the person's yes.
//
// ── WHAT THE PERSON SEES ───────────────────────────────────────────────────────────────────────────
// Title "Switch on the trick <id>?": the trick's id, which is 1 to 32 of a-z, 0-9 and -, never its free
// text name, so a proposal cannot dress its card in words Collie uses. The summary is Collie's own facts,
// in this order: who proposed it, as the lead knows them (an agent session's name and its machine from
// the lead's own session list, or "Someone on <machine> … Collie could not confirm which session." when no
// agent pane was placed, with the machine the socket or the signed crew call came from), how many
// files it has, what it asks for (its places and environment names, its `inputs` globs, what a text
// search of its code finds), and how much of the code the card shows. The view: the rights as chips, the
// inputs sentence, the warnings, then the author's name, description and about in one group headed
// "Its author's words. Collie did not check them." (at most 3 paragraphs and 400 characters), then the
// files and their code, fitted like the "new version" card's (version-card.ts `fitView`): a file counts as
// shown only when its whole text is. The facts are never cut (review F1): the author's words go first
// when they would cost code, then code; when the facts alone do not fit, the proposal is refused.
//
// ── NO RECOMMENDATION ──────────────────────────────────────────────────────────────────────────────
// DECISION: the card never recommends "Switch it on". A proposal is code from an agent; the person's own
// reading is the whole check. Options: "Switch it on" (with a confirm tap) and "Not now". No "always":
// every proposal asks.
//
// ── A NEW VERSION ──────────────────────────────────────────────────────────────────────────────────
// A proposal for a trick a proposal made gets the same card as a version the runner found
// (version-card.ts): title "Use the new version of <id>?", the changed files against the approved copy,
// the new rights and the new warnings, how much is shown. It names the proposer first, never
// recommends, and has no "Use it and stop asking". Options: "Use the new version" (with a confirm tap)
// and "Keep the old version". A proposal never carries a config.toml (propose-wire.ts `PROPOSE_NO_CONFIG`).

/** The card's sender name. Display only. */
export const PROPOSAL_CARD_SENDER = "Collie";
/** The heading of the author's words in the card's view. */
export const PROPOSAL_AUTHOR_WORDS = "Its author's words. Collie did not check them.";
/** The two options. */
export const PROPOSAL_ON = { intent: "on", label: "Switch it on", confirm: "Yes, switch on" } as const;
export const PROPOSAL_LATER = { intent: "later", label: "Not now" } as const;
/** The two options of a new version's card: the same intents, the version card's words. */
export const PROPOSAL_USE = { intent: "on", label: "Use the new version", confirm: "Yes, use it" } as const;
export const PROPOSAL_KEEP = { intent: "later", label: "Keep the old version" } as const;


/** Who proposed the trick, as the lead knows them. */
export interface ProposerFacts {
  by: "agent" | "terminal";
  /** The machine, as the lead names it. */
  host: string;
  /** The session's name from the lead's own session list, or null when the lead does not list it. */
  label: string | null;
}

/** What the card is made of. */
export interface ProposalCardInput {
  id: string;
  manifest: TrickManifest;
  proposer: ProposerFacts;
  /** The proposal's code files as added (version-diff.ts with no base). */
  diff: VersionDiff;
  /** The warning kinds a text search of its code finds. */
  warnings: readonly (keyof typeof WARN_PLAIN)[];
  /** Whether this bridge leads a crew: its `inputs` then read on every machine. */
  crew: boolean;
  /** Whether it replaces the same session's open proposal of this id (review S2). */
  replaces?: boolean;
  /** Each file's size in bytes, for card 1 of a group. */
  sizes?: ReadonlyMap<string, number>;
  /** The files that are a helper this Collie ships, with its version (card-group.ts `shippedHelpers`): named on card 1, never shown. */
  helpers?: ReadonlyMap<string, number>;
}

/** One line of somebody else's words for a sentence: every character a card could misread as `?`, cut. */
function plain(raw: string, max: number): string {
  const chars = [...raw.replace(/\s+/gu, " ").trim()].map((ch) => (unsafeText(ch) ? "?" : ch));
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** "An agent session (repo#one) on minibuch proposes it." */
export function proposerSentence(proposer: ProposerFacts): string {
  const host = plain(proposer.host, 40);
  // No agent pane placed: the machine is known, the session is not (proposals.ts "WHAT IS CONFIRMED").
  if (proposer.by === "terminal") return `Someone on ${host} proposes it. Collie could not confirm which session.`;
  return proposer.label === null || proposer.label.trim() === "" ? `An agent session on ${host} proposes it.` : `An agent session (${plain(proposer.label, 40)}) on ${host} proposes it.`;
}

/** The card's title. */
export function proposalTitle(id: string): string {
  return `Switch on the trick ${id}?`;
}

/** What the trick asks for, as chip words: its environment names and its places. */
export function proposalRights(manifest: Pick<TrickManifest, "env" | "places">): string[] {
  return [...(manifest.env ?? []), ...manifest.places.map((place) => placeWords(place))];
}

/** The author's words on a card: at most this many paragraphs ... */
export const AUTHOR_PARAS_MAX = 3;
/** ... of at most this many characters together. A cut ends in "…". */
export const AUTHOR_CHARS_MAX = 400;

/**
 * The author's words as paragraphs: the name, the description, and the paragraphs of `about`, at most
 * {@link AUTHOR_PARAS_MAX} of them and {@link AUTHOR_CHARS_MAX} characters, so they never crowd out the facts.
 */
export function authorWords(manifest: Pick<TrickManifest, "name" | "description" | "about">): ViewNode[] {
  const all = [manifest.name, manifest.description ?? "", ...(manifest.about ?? "").split(/\n\s*\n/u)].map((text) => plain(text, TEXT_MAX)).filter((text) => text !== "");
  const paras: string[] = [];
  let left = AUTHOR_CHARS_MAX;
  let cut = all.length > AUTHOR_PARAS_MAX;
  for (const text of all.slice(0, AUTHOR_PARAS_MAX)) {
    const chars = [...text];
    if (chars.length <= left) {
      paras.push(text);
      left -= chars.length;
      continue;
    }
    if (left > 1) paras.push(chars.slice(0, left - 1).join(""));
    cut = true;
    break;
  }
  const last = paras.length - 1;
  if (cut && last >= 0) paras[last] = `${paras[last] ?? ""}…`;
  return paras.map((text): ViewNode => ({ kind: "para", text, attrs: { role: "quote" } }));
}

/** The line of a card that replaces the same session's earlier proposal of that id (review S2). */
export const PROPOSAL_REPLACES = "It replaces an earlier proposal from the same session.";

/** The summary: the full words when they fit the Hill's cap, else the short ones; the replace line when it fits. */
function summaryOf(who: string, replaces: boolean, full: string, short: string): string {
  const lead = replaces ? `${who} ${PROPOSAL_REPLACES}` : who;
  for (const text of [`${lead} ${full}`, `${lead} ${short}`]) if ([...text].length <= HILL_SUMMARY_MAX) return text;
  return `${who} ${short}`;
}

/** The refusal of a proposal whose facts do not fit one card (crew slice 8 review F1). */
export const PROPOSAL_TOO_LARGE = "This trick asks for more than a card can show, so it was not proposed. Ask your person to add it on the machine.";

/** A proposal's card, or why there is none: a refusal code of the propose wire and its plain words. */
export type ProposalCardResult = { ok: true; card: Omit<HillPostInput, "requestId"> } | { ok: false; code: "card_too_large" | GroupRefusal["code"]; error: string };

const TOO_LARGE_FACTS = { ok: false, code: "card_too_large", error: PROPOSAL_TOO_LARGE } as const;
/** A line with a run of spaces a phone would push out of sight: refused on one card and on a group alike (review 7 R2). */
const WIDE_GAP = { ok: false, code: "cannot_show", error: GROUP_WIDE_GAP } as const;

/** The sentence of what a trick asks for and does, after "It" or "It now also". */
function alsoSentence(rights: readonly string[], reads: readonly string[], warnings: readonly (keyof typeof WARN_PLAIN)[], crew: boolean): string {
  const also = [
    ...(rights.length > 0 ? [`asks for ${listWords(rights)}`] : []),
    ...(reads.length > 0 ? [crew ? "reads files in your agent sessions' folders on every machine of the crew" : "reads files in your agent sessions' folders"] : []),
    ...warnings.map((kind) => WARN_VERBS[kind]),
  ];
  return also.length <= 1 ? also.join("") : `${also.slice(0, -1).join(", ")}, and ${also.at(-1) ?? ""}`;
}

/** "It shows on 4 cards." */
export function cardsSentence(count: number): string {
  return `It shows on ${String(count)} cards.`;
}

/** A view checked by the schema's reader when it is within the byte cap. */
function fitsCard(view: View): View | undefined {
  return bytesOf(view) <= DECISION_VIEW_LIMITS.bytes ? checked(view) : undefined;
}

/**
 * Card 1 of a group: who proposes, the facts in full, which card shows which file, then the author's
 * words when they still fit (they never displace a fact). Null when the facts alone do not fit.
 */
function factsCard(head: readonly ViewNode[], count: number, codeCards: number, tables: readonly ViewNode[], author: readonly ViewNode[], helpers: ReadonlyMap<string, number> = new Map()): View | null {
  // A paragraph, not a note line: it is a sentence, and a line does not wrap.
  const helperLines = [...helpers.values()].map((version): ViewNode => ({ kind: "para", text: helperNote(version) }));
  const facts: View = [...head, { kind: "line", text: filesOnCards(count - helpers.size, codeCards), attrs: { role: "note" } }, ...helperLines, ...tables];
  return (author.length > 0 ? fitsCard([...facts, ...author]) : undefined) ?? fitsCard(facts) ?? null;
}

/**
 * The card for one proposal: title, summary, options, no recommendation, and the view. A trick whose
 * code fits one card whole gets one card, as before groups. Otherwise a group (card-group.ts): card 1 the
 * facts, cards 2 to n every line of the code; the yes needs every card opened. Refused when the facts
 * alone do not fit a card ({@link PROPOSAL_TOO_LARGE}), when the code needs more than 8 cards, or when a
 * line cannot be shown as it is (card-group.ts `codeGroup`).
 */
export function proposalCard(input: ProposalCardInput): ProposalCardResult {
  const { manifest } = input;
  if (input.diff.files.some((file) => file.gap === true)) return WIDE_GAP;
  const rights = proposalRights(manifest);
  const reads = manifest.inputs ?? [];
  const alsoWords = alsoSentence(rights, reads, input.warnings, input.crew);
  const fact = alsoWords !== "" ? `It ${alsoWords}.` : "It asks for no rights.";
  const head = [...(input.replaces === true ? [{ kind: "para", text: PROPOSAL_REPLACES } satisfies ViewNode] : []), ...rightsHead("It asks for", rights, input.warnings, reads.length > 0 ? inputsSentence(reads, input.crew) : null)];
  const words = authorWords(manifest);
  const author: ViewNode[] = words.length > 0 ? [{ kind: "group", attrs: { label: PROPOSAL_AUTHOR_WORDS }, kids: words }] : [];
  const shown = fitView(head, input.diff, author);
  if (!shown.headFits) return TOO_LARGE_FACTS;
  const total = input.diff.files.length;
  const files = total === 1 ? "It has 1 file." : `It has ${String(total)} files.`;
  const who = proposerSentence(input.proposer);
  const base: Omit<HillPostInput, "requestId" | "summary"> = { title: proposalTitle(input.id), options: [{ ...PROPOSAL_ON }, { ...PROPOSAL_LATER }], text: "none", priority: "today", recommends: null };
  if (total === 0 || (shown.view !== null && shown.shown >= total)) {
    const card = { ...base, summary: summaryOf(who, input.replaces === true, `${files} ${fact}`, `${files} It asks for rights, listed below.`) };
    return { ok: true, card: shown.view === null ? card : { ...card, view: shown.view } };
  }
  const helpers = input.helpers ?? new Map<string, number>();
  const code = codeGroup(input.diff.files, manifest.run, "refuse", helpers);
  if (!code.ok) return { ok: false, code: code.code, error: code.error };
  const rows = groupOrder(input.diff.files, manifest.run).map((file) => ({ rel: file.rel, cells: [sizeWords(input.sizes?.get(file.rel) ?? 0)] }));
  const first = factsCard([{ kind: "para", text: who }, ...head], total, code.cards.length, placesTables(rows, ["Size"], code.places, helpers), author, helpers);
  if (first === null) return TOO_LARGE_FACTS;
  const tail = ` ${cardsSentence(code.cards.length + 1)}`;
  const summary = summaryOf(who, input.replaces === true, `${files} ${fact}${tail}`, `${files} It asks for rights, listed below.${tail}`);
  return { ok: true, card: { ...base, summary, group: { decline: PROPOSAL_LATER.intent, parts: [first, ...code.cards] } } };
}

/** How many cards a proposal shows on, or why it cannot be proposed. */
export type ProposalCardCount = { ok: true; cards: number } | Extract<ProposalCardResult, { ok: false }>;

/**
 * The cards a trick's folder shows on as a proposal for a new trick, or why it cannot be proposed: what
 * `collie trick check` prints and `collie trick propose` refuses on, before anything is sent. The whole
 * trick counts, so a version is held to the same rule; the lead counts again on its own diff. The
 * proposer is a stand-in: the lead's sentence names the session, a few words longer.
 */
export function proposalCardCount(input: Pick<ProposalCardInput, "manifest" | "warnings" | "crew"> & { files: readonly Pick<ProposedFile, "rel" | "bytes">[] }): ProposalCardCount {
  const sizes = new Map(input.files.map((file) => [file.rel, file.bytes.byteLength]));
  const proposer: ProposerFacts = { by: "agent", host: "this machine", label: null };
  const made = proposalCard({ id: input.manifest.id, manifest: input.manifest, proposer, diff: addedDiff(input.files), warnings: input.warnings, crew: input.crew, sizes, helpers: shippedHelpers(input.files) });
  if (!made.ok) return made;
  return { ok: true, cards: made.card.group?.parts.length ?? 1 };
}

/** A canonical UUID for one proposal card: the trick, the hash and the proposal's own request id. */
export function proposalRequestId(id: string, hash: string, requestId: string): string {
  const hex = createHash("sha256").update(`collie-proposal-card\0${id}\0${hash}\0${requestId}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** What a new version's card is made of. */
export interface ProposalVersionCardInput {
  id: string;
  manifest: TrickManifest;
  /** The approved copy's manifest, or undefined when it could not be read: every right then counts as new. */
  baseManifest: TrickManifest | undefined;
  proposer: ProposerFacts;
  /** The code files against the approved copy. */
  diff: VersionDiff;
  /** The warning kinds the approved copy did not have. */
  warnings: readonly (keyof typeof WARN_PLAIN)[];
  crew: boolean;
  /** As {@link ProposalCardInput.replaces}. */
  replaces?: boolean;
  /** As {@link ProposalCardInput.helpers}: a changed file that is now a helper this Collie ships. */
  helpers?: ReadonlyMap<string, number>;
}

/** The card for a proposed new version of a trick a proposal made: the version card, named and never recommended, one card or a group as {@link proposalCard}. */
export function proposalVersionCard(input: ProposalVersionCardInput): ProposalCardResult {
  if (input.diff.files.some((file) => file.gap === true)) return WIDE_GAP;
  const rights = newRights(input.baseManifest, input.manifest);
  const reads = newInputs(input.baseManifest, input.manifest);
  const alsoWords = alsoSentence(rights, reads, input.warnings, input.crew);
  const fact = alsoWords !== "" ? `It now also ${alsoWords}.` : "It asks for no new rights.";
  const head = [...(input.replaces === true ? [{ kind: "para", text: PROPOSAL_REPLACES } satisfies ViewNode] : []), ...rightsHead("New rights", rights, input.warnings, reads.length > 0 ? inputsSentence(reads, input.crew) : null)];
  const shown = fitView(head, input.diff);
  if (!shown.headFits) return TOO_LARGE_FACTS;
  const total = input.diff.files.length;
  const who = proposerSentence(input.proposer);
  const short = rights.length > 0 ? "It asks for new rights, listed below." : "It does something new, listed below.";
  const base: Omit<HillPostInput, "requestId" | "summary"> = { title: versionTitle(input.id), options: [{ ...PROPOSAL_USE }, { ...PROPOSAL_KEEP }], text: "none", priority: "today", recommends: null };
  if (total === 0 || (shown.view !== null && shown.shown >= total)) {
    const card = { ...base, summary: summaryOf(who, input.replaces === true, `${filesSentence(total)} ${fact}`, `${filesSentence(total)} ${short}`) };
    return { ok: true, card: shown.view === null ? card : { ...card, view: shown.view } };
  }
  const changed = new Set(input.diff.files.map((file) => file.rel));
  const helpers = new Map([...(input.helpers ?? new Map<string, number>())].filter(([rel]) => changed.has(rel)));
  const code = codeGroup(input.diff.files, input.manifest.run, "refuse", helpers);
  if (!code.ok) return { ok: false, code: code.code, error: code.error };
  const rows = groupOrder(input.diff.files, input.manifest.run).map((file) => ({ rel: file.rel, cells: changeCells(file) }));
  const first = factsCard([{ kind: "para", text: who }, ...head], total, code.cards.length, placesTables(rows, ["Change", "Lines"], code.places, helpers), [], helpers);
  if (first === null) return TOO_LARGE_FACTS;
  const tail = ` ${cardsSentence(code.cards.length + 1)}`;
  const summary = summaryOf(who, input.replaces === true, `${filesSentence(total)} ${fact}${tail}`, `${filesSentence(total)} ${short}${tail}`);
  return { ok: true, card: { ...base, summary, group: { decline: PROPOSAL_KEEP.intent, parts: [first, ...code.cards] } } };
}
