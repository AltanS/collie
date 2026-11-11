import { createHash } from "node:crypto";

import { HILL_SUMMARY_MAX, type HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { inputsSentence, TEXT_MAX, type TrickManifest, type ViewNode } from "../../web/src/lib/tricks/schema.ts";
import { unsafeText } from "./code-hash.ts";
import { WARN_PLAIN } from "./scan.ts";
import { filesSentence, fitView, listWords, newInputs, newRights, placeWords, rightsHead, shownSentence, VERSION_NOT_SHOWN, versionTitle, WARN_VERBS } from "./version-card.ts";
import type { VersionDiff } from "./version-diff.ts";

// THE PROPOSAL CARD (crew slice 8): one Decision of Collie's own on the lead's Hill for each trick an agent
// or a terminal proposed with `collie trick propose`. Nothing of the trick runs before the person's yes.
//
// ── WHAT THE PERSON SEES ───────────────────────────────────────────────────────────────────────────
// Title "Switch on the trick <id>?": the trick's id, which is 1 to 32 of a-z, 0-9 and -, never its free
// text name, so a proposal cannot dress its card in words Collie uses. The summary is Collie's own facts,
// in this order: who proposed it, as the lead knows them (an agent session's name and its machine from
// the lead's own session list, or "a terminal" and the machine the signed crew call came from), how many
// files it has, what it asks for (its places and environment names, its `inputs` globs, what a text
// search of its code finds), and how much of the code the card shows. The view: the rights as chips, the
// inputs sentence, the warnings, then the author's name, description and about in one group headed
// "Its author's words. Collie did not check them.", then the files and their code, fitted like the "new
// version" card's (version-card.ts `fitView`): a file counts as shown only when its whole text is.
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
}

/** One line of somebody else's words for a sentence: every character a card could misread as `?`, cut. */
function plain(raw: string, max: number): string {
  const chars = [...raw.replace(/\s+/gu, " ").trim()].map((ch) => (unsafeText(ch) ? "?" : ch));
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** "An agent session (repo#one) on minibuch proposes it." */
export function proposerSentence(proposer: ProposerFacts): string {
  const host = plain(proposer.host, 40);
  if (proposer.by === "terminal") return `A terminal on ${host} proposes it.`;
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

/** The author's words as paragraphs: the name, the description, and each paragraph of `about`. */
function authorWords(manifest: Pick<TrickManifest, "name" | "description" | "about">): ViewNode[] {
  const paras = [manifest.name, manifest.description ?? "", ...(manifest.about ?? "").split(/\n\s*\n/u)].map((text) => plain(text, TEXT_MAX)).filter((text) => text !== "");
  return paras.map((text): ViewNode => ({ kind: "para", text, attrs: { role: "quote" } }));
}

/** The card for one proposal: title, summary, options, no recommendation, and the view. */
export function proposalCard(input: ProposalCardInput): Omit<HillPostInput, "requestId"> {
  const { manifest } = input;
  const rights = proposalRights(manifest);
  const reads = manifest.inputs ?? [];
  const also = [
    ...(rights.length > 0 ? [`asks for ${listWords(rights)}`] : []),
    ...(reads.length > 0 ? [input.crew ? "reads files in your agent sessions' folders on every machine of the crew" : "reads files in your agent sessions' folders"] : []),
    ...input.warnings.map((kind) => WARN_VERBS[kind]),
  ];
  const alsoWords = also.length <= 1 ? also.join("") : `${also.slice(0, -1).join(", ")}, and ${also.at(-1) ?? ""}`;
  const fact = also.length > 0 ? `It ${alsoWords}.` : "It asks for no rights.";
  const head = rightsHead("It asks for", rights, input.warnings, reads.length > 0 ? inputsSentence(reads, input.crew) : null);
  head.push({ kind: "group", attrs: { label: PROPOSAL_AUTHOR_WORDS }, kids: authorWords(manifest) });
  const shown = fitView(head, input.diff);
  const total = input.diff.files.length;
  const whole = shown.view !== null && shown.shown >= total;
  const tail = shown.view === null ? ` ${VERSION_NOT_SHOWN}` : whole ? "" : ` ${shownSentence(shown.shown, total)}`;
  const files = total === 1 ? "It has 1 file." : `It has ${String(total)} files.`;
  const who = proposerSentence(input.proposer);
  const full = `${who} ${files} ${fact}${tail}`;
  const short = `${who} ${files} It asks for rights, listed below.${tail}`;
  const summary = [...full].length <= HILL_SUMMARY_MAX ? full : short;
  const card: Omit<HillPostInput, "requestId"> = {
    title: proposalTitle(input.id),
    summary,
    options: [{ ...PROPOSAL_ON }, { ...PROPOSAL_LATER }],
    text: "none",
    priority: "today",
    recommends: null,
  };
  return shown.view === null ? card : { ...card, view: shown.view };
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
}

/** The card for a proposed new version of a trick a proposal made: the version card, named and never recommended. */
export function proposalVersionCard(input: ProposalVersionCardInput): Omit<HillPostInput, "requestId"> {
  const rights = newRights(input.baseManifest, input.manifest);
  const reads = newInputs(input.baseManifest, input.manifest);
  const also = [
    ...(rights.length > 0 ? [`asks for ${listWords(rights)}`] : []),
    ...(reads.length > 0 ? [input.crew ? "reads files in your agent sessions' folders on every machine of the crew" : "reads files in your agent sessions' folders"] : []),
    ...input.warnings.map((kind) => WARN_VERBS[kind]),
  ];
  const alsoWords = also.length <= 1 ? also.join("") : `${also.slice(0, -1).join(", ")}, and ${also.at(-1) ?? ""}`;
  const fact = also.length > 0 ? `It now also ${alsoWords}.` : "It asks for no new rights.";
  const head = rightsHead("New rights", rights, input.warnings, reads.length > 0 ? inputsSentence(reads, input.crew) : null);
  const shown = fitView(head, input.diff);
  const total = input.diff.files.length;
  const whole = shown.view !== null && shown.shown >= total;
  const tail = shown.view === null ? ` ${VERSION_NOT_SHOWN}` : whole ? "" : ` ${shownSentence(shown.shown, total)}`;
  const who = proposerSentence(input.proposer);
  const full = `${who} ${filesSentence(total)} ${fact}${tail}`;
  const short = `${who} ${filesSentence(total)} ${rights.length > 0 ? "It asks for new rights, listed below." : "It does something new, listed below."}${tail}`;
  const summary = [...full].length <= HILL_SUMMARY_MAX ? full : short;
  const card: Omit<HillPostInput, "requestId"> = {
    title: versionTitle(input.id),
    summary,
    options: [{ ...PROPOSAL_USE }, { ...PROPOSAL_KEEP }],
    text: "none",
    priority: "today",
    recommends: null,
  };
  return shown.view === null ? card : { ...card, view: shown.view };
}
