import { createHash } from "node:crypto";

import { parseJson } from "../../web/src/lib/json.ts";
import { HILL_SUMMARY_MAX, type HillCollieRef, type HillDecision, type HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { DECISION_VIEW_LIMITS, DIFF_LIMITS, LINE_MAX, parseDecisionView, PLACE_KINDS, TABLE_LIMITS, type PlaceKind, type TrickManifest, type View, type ViewNode } from "../../web/src/lib/tricks/schema.ts";
import type { HillCollieSender, HillCollieVerdict, HillOneAnswer, HillPostAnswer } from "../hill/service.ts";
import { unsafeText } from "./code-hash.ts";
import { WARN_PLAIN } from "./scan.ts";
import type { TrickVersionsPort, TrickVersionSubject, VersionAnswer } from "./service.ts";
import { versionDiff, type ChangedFile, type VersionDiff } from "./version-diff.ts";

// THE "NEW VERSION" CARD (crew slice 3): one Decision of Collie's own on the Hill for each trick that is
// on and whose new version waits for a yes. It asks the same yes the Settings row and `collie trick on`
// ask, so whichever answers first, the others follow.
//
// ── ONE CARD PER TRICK ─────────────────────────────────────────────────────────────────────────────
// The card is keyed `version:<id>` (its ref's type and id). A newer waiting version supersedes the card
// of the older one. A card goes (withdrawn) when nothing new waits any more: the version was approved or
// declined elsewhere, the folder went back to the approved code, the trick was switched off or removed.
// While the snapshot of a moved folder settles, the card stays: a bridge restart does not drop it.
//
// ── WHAT THE PERSON SEES ───────────────────────────────────────────────────────────────────────────
// Title "Use the new version of <name>?". The summary says what changed and the deciding fact: "3
// files changed. It asks for no new rights." or "It now also asks for GITHUB_TOKEN." Options: use,
// always (only when the rights did not change), keep. The view, at most 8 KiB: a chip per new right,
// the new warnings, the table of changed files with their line counts, the hunks of the largest text
// changes as many as fit, "and N more files".
//
// WHAT IS SHOWN DECIDES THE RECOMMENDATION (security re-review B2, B6). A file counts as shown only
// when its whole hunk is in the view: no line cut at 200 characters, no line past the hunk's cap, no key
// masked in it, and git's output not cut. Collie recommends `use` only when every changed file is
// shown, the rights did not change and a text search finds nothing new. Otherwise the summary says how
// much is shown ("1 of 3 files shown."), and a card with no view at all says "The change is too large
// to show here. Read it on the machine before you say yes." A file name is cleaned for the view (a
// character the view refuses becomes `?`); the walk refuses such names anyway (code-hash.ts).
//
// ── THE ANSWER ─────────────────────────────────────────────────────────────────────────────────────
// `answer` runs inside the Hill's claim (hill/service.ts `onCollieAnswer`), with the ref's hash: use
// approves exactly that snapshot, always approves it and turns auto on, keep declines it. A hash that is
// no longer the one waiting is refused in plain words, and the card stays until the next card replaces it.

/** The card's sender name. Display only. */
export const VERSION_CARD_SENDER = "Collie";
/** Why a card closes when nothing new waits any more. */
export const VERSION_CARD_GONE = "the new version no longer waits";
/** A title stays within this many characters (cli/hill-rules.ts: a title is short). */
export const VERSION_TITLE_MAX = 60;

/** The words the card speaks on a refusal of the answer. */
export const VERSION_MOVED = "The trick changed again since this card. A new card replaces this one.";
export const VERSION_NOT_WAITING = "This version no longer waits for an answer.";
export const VERSION_OFF = "The trick is off now.";
export const VERSION_GONE = "The trick is gone.";
export const VERSION_NEW_RIGHTS = "This version asks for new rights, so later changes cannot be taken without asking.";

/** What the card needs of the Hill: the door no agent, crew member or trick reaches (hill/service.ts). */
export interface VersionCardHill {
  postCollie(from: HillCollieSender, input: HillPostInput): HillPostAnswer;
  withdrawCollie(from: HillCollieSender, id: string, reason: string): HillOneAnswer;
  collieDecisions(type: HillCollieRef["type"]): HillDecision[];
}

/** What the card needs of the tricks runner (tricks/service.ts). */
export interface VersionCardTricks {
  approvePending(id: string, hash: string, by?: string): Promise<VersionAnswer>;
  declinePending(id: string, hash: string): Promise<VersionAnswer>;
  setAuto(id: string, on: boolean): Promise<VersionAnswer>;
}

export interface VersionCardDeps {
  hill: VersionCardHill;
  /** Read lazily: the runner is built after the Hill (bridge/index.ts). */
  tricks: () => VersionCardTricks | null;
  /** The diff of two folders. Default: version-diff.ts `versionDiff`. */
  diff?: (base: string | null, next: string) => Promise<VersionDiff>;
  warn?: (line: string) => void;
}

/** A place a trick draws in, as the card says it. */
const PLACE_WORDS = {
  belt: "the belt",
  session: "a session of its own",
  dashboard: "the Dashboard",
  status: "the status line",
  tabbar: "the bottom bar",
} as const satisfies Readonly<Record<PlaceKind, string>>;

function placeWords(place: string): string {
  const kind = PLACE_KINDS.find((candidate) => candidate === place);
  return kind === undefined ? place : PLACE_WORDS[kind];
}

/** A warning kind as the card's second sentence says it, after "It now also". */
const WARN_VERBS = {
  spawn: "starts other programs",
  network: "reaches the network",
  write: "writes files outside its state folder",
  model: "starts an agent or calls a model",
  import: "imports a package Collie does not install",
} as const satisfies Readonly<Record<keyof typeof WARN_PLAIN, string>>;

/** The rights a manifest asks for past the base: its environment names and its places. */
function rightsOf(manifest: Pick<TrickManifest, "env" | "places"> | undefined): Set<string> {
  if (manifest === undefined) return new Set();
  return new Set([...(manifest.env ?? []).map((name) => `env:${name}`), ...manifest.places.map((place) => `place:${place}`)]);
}

/** What the new version asks for that the approved one did not, as chip words. */
export function newRights(base: Pick<TrickManifest, "env" | "places"> | undefined, next: Pick<TrickManifest, "env" | "places"> | undefined): string[] {
  const was = rightsOf(base);
  return [...rightsOf(next)].filter((right) => !was.has(right)).map((right) => (right.startsWith("env:") ? right.slice(4) : placeWords(right.slice(6))));
}

/** "a", "a and b", "a, b and c", "a, b and 2 more". */
function listWords(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items.join("");
  const shown = items.length > max ? [...items.slice(0, max - 1), `${String(items.length - max + 1)} more`] : [...items];
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1) ?? ""}`;
}

/** The card's question around a name. */
function titleFrame(name: string): string {
  return `Use the new version of ${name}?`;
}

/** The card's title: the trick's name cut so the question stays within {@link VERSION_TITLE_MAX}. */
export function versionTitle(name: string): string {
  const room = VERSION_TITLE_MAX - titleFrame("").length;
  const chars = [...name];
  return titleFrame(chars.length <= room ? name : `${chars.slice(0, room - 1).join("")}…`);
}

/** "1 file changed." or "3 files changed." */
function filesSentence(count: number): string {
  return count === 1 ? "1 file changed." : `${String(count)} files changed.`;
}

/** The summary's sentence for a card whose view could not be made at all. */
export const VERSION_NOT_SHOWN = "The change is too large to show here. Read it on the machine before you say yes.";

/** "1 of 3 files shown." */
function shownSentence(shown: number, total: number): string {
  return `${String(shown)} of ${String(total)} ${total === 1 ? "file" : "files"} shown.`;
}

/** The card for one waiting version: title, summary, options, recommendation and view. */
export function versionCard(subject: TrickVersionSubject, diff: VersionDiff): Omit<HillPostInput, "requestId"> | null {
  const pending = subject.pending;
  if (pending === null) return null;
  const rights = newRights(subject.base?.manifest, pending.manifest);
  const warnings = pending.info.warnings.map((warning) => warning.kind).filter((kind): kind is keyof typeof WARN_PLAIN => kind in WARN_PLAIN);
  const counts = pending.info.files;
  const fileCount = counts.added + counts.changed + counts.removed;
  const also = [...(rights.length > 0 ? [`asks for ${listWords(rights)}`] : []), ...warnings.map((kind) => WARN_VERBS[kind])];
  const powersChanged = pending.info.powersChanged || rights.length > 0;
  // The outer list takes a comma before its last part, as a part may itself say "a and b".
  const alsoWords = also.length <= 1 ? also.join("") : `${also.slice(0, -1).join(", ")}, and ${also.at(-1) ?? ""}`;
  const fact = also.length > 0 ? `It now also ${alsoWords}.` : powersChanged ? "Its rights changed." : "It asks for no new rights.";
  // The view is what the person reads before the yes: how much of the change it holds decides the rest.
  const shown = versionViewShown(rights, warnings, diff);
  const total = Math.max(fileCount, diff.files.length);
  const whole = shown.view !== null && shown.shown >= total;
  const tail = shown.view === null ? ` ${VERSION_NOT_SHOWN}` : whole ? "" : ` ${shownSentence(shown.shown, total)}`;
  // A long list of new rights is cut to its gist so the summary stays within the Hill's cap; the chips say it all.
  const short = rights.length > 0 ? "It asks for new rights, listed below." : "It does something new, listed below.";
  const full = `${filesSentence(fileCount)} ${fact}${tail}`;
  const summary = [...full].length <= HILL_SUMMARY_MAX ? full : `${filesSentence(fileCount)} ${short}${tail}`;
  const options: HillPostInput["options"] = [{ intent: "use", label: "Use the new version" }];
  if (!powersChanged) options.push({ intent: "always", label: "Use it and stop asking", detail: "Later changes are taken without asking, unless they ask for new rights." });
  options.push({ intent: "keep", label: "Keep the old version" });
  const card: Omit<HillPostInput, "requestId"> = {
    title: versionTitle(subject.name),
    summary,
    options,
    text: "none",
    priority: "today",
    recommends: powersChanged || warnings.length > 0 || !whole ? null : { intent: "use", why: "It asks for no new rights, and a text search of its code finds nothing new." },
  };
  return shown.view === null ? card : { ...card, view: shown.view };
}

/** A path as one cell: any character the view refuses as `?`, cut from the start to fit, so the file name shows. */
function cellPath(rel: string): string {
  const chars = [...rel].map((ch) => (unsafeText(ch) ? "?" : ch));
  return chars.length <= LINE_MAX ? chars.join("") : `…${chars.slice(chars.length - LINE_MAX + 1).join("")}`;
}

function countCell(n: number | null, sign: string): string {
  return n === null || n === 0 ? "" : `${sign}${String(n)}`;
}

/** The rows of the files table, at most {@link TABLE_LIMITS} rows, with the column heads first. */
function filesTable(files: readonly ChangedFile[], rows: number): ViewNode {
  const kids: ViewNode[] = [
    { kind: "col", text: "File" },
    { kind: "col", text: "Change" },
    { kind: "col", text: "+", attrs: { align: "end" } },
    { kind: "col", text: "−", attrs: { align: "end" } },
  ];
  for (const file of files.slice(0, rows)) {
    kids.push({ kind: "cell", text: cellPath(file.rel) }, { kind: "cell", text: file.change }, { kind: "cell", text: countCell(file.plus, "+") }, { kind: "cell", text: countCell(file.minus, "−") });
  }
  return { kind: "table", kids };
}

/** One hunk as a diff node: at most `lines` lines of {@link DIFF_LIMITS} characters, and whether it is the whole hunk. */
function hunkNode(file: ChangedFile, lines: number): { node: ViewNode; whole: boolean } | null {
  const all = file.hunk ?? [];
  const hunk = all.slice(0, lines).map((line) => [...line].slice(0, DIFF_LIMITS.lineChars).join(""));
  if (hunk.length === 0) return null;
  const whole = file.cut !== true && all.length <= lines && all.every((line) => [...line].length <= DIFF_LIMITS.lineChars);
  return { node: { kind: "diff", text: hunk.join("\n"), attrs: { file: cellPath(file.rel) } }, whole };
}

function bytesOf(view: View): number {
  return new TextEncoder().encode(JSON.stringify(view)).byteLength;
}

/** The view as the schema reads it back (the one reader every Decision's view goes through), or undefined. */
function checked(view: View): View | undefined {
  return parseDecisionView(parseJson(JSON.stringify(view))).view;
}

/**
 * The card's view: a chip per new right, the new warnings, the changed files, the hunks of the largest
 * text changes as many as fit, and "and N more files". Cut until it fits {@link DECISION_VIEW_LIMITS} and
 * the schema takes it: the smallest hunk first, then the last hunk's lines, then the table's rows. Null
 * when there is nothing to show or nothing fits.
 */
export function versionView(rights: readonly string[], warnings: readonly (keyof typeof WARN_PLAIN)[], diff: VersionDiff): View | null {
  return versionViewShown(rights, warnings, diff).view;
}

/** The card's view, and how many changed files it shows whole: a row in the table and its whole hunk. */
export interface VersionViewShown {
  view: View | null;
  shown: number;
}

/** The view, and how many changed files it shows whole: a row in the table and its whole hunk. */
export function versionViewShown(rights: readonly string[], warnings: readonly (keyof typeof WARN_PLAIN)[], diff: VersionDiff): VersionViewShown {
  const head: ViewNode[] = [];
  if (rights.length > 0) head.push({ kind: "bar", attrs: { label: "New rights" }, kids: rights.slice(0, 8).map((right): ViewNode => ({ kind: "chip", text: [...right].slice(0, 60).join(""), attrs: { tone: "warn" } })) });
  for (const kind of warnings) head.push({ kind: "para", text: WARN_PLAIN[kind] });
  const files = diff.files;
  const largest = files.filter((file) => (file.hunk ?? []).length > 0).toSorted((a, b) => (b.plus ?? 0) + (b.minus ?? 0) - ((a.plus ?? 0) + (a.minus ?? 0)));
  let rows = Math.min(files.length, TABLE_LIMITS.rows.max);
  let hunks = largest.length;
  let lines: number = DIFF_LIMITS.lines;
  // Bounded: every miss takes one hunk, halves the last hunk's lines, or takes one row.
  for (let tries = 0; tries < 256; tries += 1) {
    const view: View = [...head];
    if (rows > 0) view.push(filesTable(files, rows));
    let shown = 0;
    const listed = new Set(files.slice(0, rows).map((file) => file.rel));
    for (const [i, file] of largest.slice(0, hunks).entries()) {
      const hunk = hunkNode(file, i === hunks - 1 ? lines : DIFF_LIMITS.lines);
      if (hunk === null) continue;
      view.push(hunk.node);
      if (hunk.whole && listed.has(file.rel)) shown += 1;
    }
    const more = files.length - rows;
    if (more > 0) view.push({ kind: "line", text: more === 1 ? "and 1 more file" : `and ${String(more)} more files`, attrs: { role: "note" } });
    if (view.length === 0) return { view: null, shown: 0 };
    const read = bytesOf(view) <= DECISION_VIEW_LIMITS.bytes ? checked(view) : undefined;
    if (read !== undefined) return { view: read, shown };
    if (hunks > 1 && lines >= DIFF_LIMITS.lines) hunks -= 1;
    else if (hunks >= 1 && lines > 8) lines = Math.floor(lines / 2);
    else if (hunks >= 1) {
      hunks -= 1;
      lines = DIFF_LIMITS.lines;
    } else if (rows > 1) rows -= 1;
    else return { view: head.length > 0 ? (checked(head) ?? null) : null, shown: 0 };
  }
  return { view: null, shown: 0 };
}

/** A canonical UUID for one card: the trick, the hash and how many cards of this trick came before. */
export function versionRequestId(id: string, hash: string, seq: number): string {
  const hex = createHash("sha256").update(`collie-version-card\0${id}\0${hash}\0${String(seq)}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The sender of a card about `id` at `hash`. */
function senderOf(id: string, hash: string): HillCollieSender {
  return { kind: "collie", ref: { type: "version", id, hash }, label: VERSION_CARD_SENDER };
}

/** States after which the same version never asks again by itself: the person saw it. */
const SEEN_STATES: ReadonlySet<HillDecision["state"]> = new Set(["answered", "dismissed", "expired"]);

export class VersionCards implements TrickVersionsPort {
  private readonly deps: VersionCardDeps;
  private readonly diff: (base: string | null, next: string) => Promise<VersionDiff>;
  private readonly warn: (line: string) => void;
  /** The last subjects seen, by trick id: a card being built posts only while its version still waits. */
  private latest = new Map<string, TrickVersionSubject>();
  /** The card builds in flight, `<id>@<hash>`, so one version is built once at a time. */
  private building = new Set<string>();
  /** Refusals already said, `<id>@<hash>@<code>`, so a Hill that is off is not logged every scan. */
  private said = new Set<string>();
  /** The last build, so a test waits for it. */
  private last: Promise<void> = Promise.resolve();

  constructor(deps: VersionCardDeps) {
    this.deps = deps;
    this.diff = deps.diff ?? ((base, next) => versionDiff({ base, next }));
    this.warn = deps.warn ?? (() => undefined);
  }

  /** Wait for every card build started so far. For tests and a graceful stop. */
  async settled(): Promise<void> {
    await this.last;
  }

  sync(subjects: readonly TrickVersionSubject[]): void {
    this.latest = new Map(subjects.map((subject) => [subject.id, subject]));
    const open = this.deps.hill.collieDecisions("version").filter((decision) => decision.state === "open");
    for (const decision of open) {
      const ref = decision.from.ref;
      if (ref === undefined) continue;
      const subject = this.latest.get(ref.id);
      // Off, removed, or nothing new waits: the card goes. A version still settling keeps its card.
      if (subject === undefined || !subject.waiting) this.withdraw(decision, ref);
    }
    for (const subject of subjects) {
      const pending = subject.pending;
      if (!subject.waiting || pending === null) continue;
      if (this.answered(subject.id, pending.hash)) continue;
      const key = `${subject.id}@${pending.hash}`;
      if (this.building.has(key)) continue;
      this.building.add(key);
      const build = this.build(subject).finally(() => this.building.delete(key));
      this.last = this.last.then(() => build).catch(() => undefined);
    }
  }

  /** Whether this version already has an open card, or one the person answered, dismissed or let expire. */
  private answered(id: string, hash: string): boolean {
    return this.deps.hill.collieDecisions("version").some((decision) => decision.from.ref?.id === id && decision.from.ref.hash === hash && (decision.state === "open" || SEEN_STATES.has(decision.state)));
  }

  private withdraw(decision: HillDecision, ref: HillCollieRef): void {
    const out = this.deps.hill.withdrawCollie(senderOf(ref.id, ref.hash), decision.id, VERSION_CARD_GONE);
    // While its answer runs the Hill refuses; the answer closes it, so nothing is left to do.
    if (!out.ok && !out.missing) return;
  }

  private async build(subject: TrickVersionSubject): Promise<void> {
    const pending = subject.pending;
    if (pending === null) return;
    const diff = await this.diff(subject.base?.dir ?? null, pending.dir).catch((): VersionDiff => ({ files: [], counted: false }));
    // The version may have moved while the diff ran: post only for the one still waiting.
    const now = this.latest.get(subject.id);
    if (now === undefined || !now.waiting || now.pending?.hash !== pending.hash || this.answered(subject.id, pending.hash)) return;
    const card = versionCard(now, diff);
    if (card === null) return;
    const mine = this.deps.hill.collieDecisions("version").filter((decision) => decision.from.ref?.id === subject.id);
    const older = mine.find((decision) => decision.state === "open");
    const input: HillPostInput = { ...card, requestId: versionRequestId(subject.id, pending.hash, mine.length) };
    if (older !== undefined) input.supersedes = older.id;
    const posted = this.deps.hill.postCollie(senderOf(subject.id, pending.hash), input);
    if (posted.ok) return;
    const said = `${subject.id}@${pending.hash}@${posted.code ?? "plain"}`;
    if (this.said.has(said)) return;
    this.said.add(said);
    this.warn(`${subject.id}: the new version card was not posted: ${posted.error}`);
  }

  /** The answer to a card, from the Hill's claim. Acts on exactly `ref.hash`; refuses in plain words. */
  async answer(ref: HillCollieRef, intent: string): Promise<HillCollieVerdict> {
    if (ref.type !== "version") return { ok: false, reason: "Collie does not know this kind of question." };
    const tricks = this.deps.tricks();
    if (tricks === null) return { ok: false, reason: "Tricks are not running on this bridge." };
    if (intent === "keep") return verdictOf(await tricks.declinePending(ref.id, ref.hash));
    if (intent !== "use" && intent !== "always") return { ok: false, reason: "That is not an option of this card." };
    if (intent === "always") {
      const subject = this.latest.get(ref.id);
      const pending = subject?.pending;
      if (pending?.hash === ref.hash && (pending.info.powersChanged || newRights(subject?.base?.manifest, pending.manifest).length > 0)) return { ok: false, reason: VERSION_NEW_RIGHTS };
    }
    const approved = verdictOf(await tricks.approvePending(ref.id, ref.hash, "phone"));
    if (!approved.ok || intent === "use") return approved;
    // The version is in; auto is the second step. If it fails the card still closes: the yes stands.
    const auto = await tricks.setAuto(ref.id, true);
    if (!auto.ok) this.warn(`${ref.id}: the new version is in, but take changes without asking could not be turned on: ${auto.message}`);
    return { ok: true };
  }
}

/** A version change's answer as the card's verdict, its refusal in the card's words. */
function verdictOf(answer: VersionAnswer): HillCollieVerdict {
  if (answer.ok) return { ok: true };
  switch (answer.code) {
    case "moved":
      return { ok: false, reason: VERSION_MOVED };
    case "no-pending":
      return { ok: false, reason: VERSION_NOT_WAITING };
    case "off":
      return { ok: false, reason: VERSION_OFF };
    case "unknown-trick":
      return { ok: false, reason: VERSION_GONE };
    case "no-previous":
    case "copy-failed":
      return { ok: false, reason: answer.message };
    default:
      return answer.code satisfies never;
  }
}
