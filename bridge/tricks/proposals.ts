import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "../../web/src/lib/json.ts";
import type { HillCollieRef, HillDecision, HillPostInput } from "../../web/src/lib/hill/wire.ts";
import type { JsonObject } from "../json.ts";
import type { TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { HILL_OFF, type HillCollieSender, type HillCollieVerdict, type HillOneAnswer, type HillPostAnswer, type HillPostOptions } from "../hill/service.ts";
import { unsafeText } from "./code-hash.ts";
import type { ProposalOrigin } from "./origin.ts";
import { hash16, tricksConfigDir, tricksStateDir } from "./paths.ts";
import { proposalCard, proposalRequestId, proposalVersionCard, PROPOSAL_CARD_SENDER, PROPOSAL_LATER, PROPOSAL_ON, type ProposerFacts } from "./proposal-card.ts";
import { checkProposedFiles, proposalHash, PROPOSE_LIMITS, type ProposalRead, type ProposedFile, type ProposeRefusalCode } from "./propose-wire.ts";
import { trickWarnings, WARN_PLAIN } from "./scan.ts";
import type { ProposalPlaced, ProposalTarget } from "./service.ts";
import { versionDiff, type VersionDiff } from "./version-diff.ts";

// TRICK PROPOSALS ON THE LEAD (crew slice 8). `collie trick propose <folder>` hands a trick's files to this
// bridge, from a session or a terminal on this machine (the walky socket) or on a crew member (the signed
// `POST /crew/v1/tricks/propose`, CREW_PROTOCOL §24). Only a lead or a solo bridge keeps proposals; a
// member forwards and keeps no copy.
//
// ── INERT UNTIL THE YES ────────────────────────────────────────────────────────────────────────────
// A proposal for a NEW trick is stored, never installed: `<configDir>/tricks/.collie-proposed/<id>/<hash16>/`,
// folders 0700, files 0600 with no executable bit (the mark is kept in `proposals.json`), written into a
// staged sibling and renamed. The tricks scanner never reads a dot folder (discover.ts), the approved-copy
// prune never touches this one (approved.ts `pruneCopies`), so nothing in it runs or is listed. The card
// on the Hill (proposal-card.ts) carries `ref: { type: "proposal", id, hash }`. On "Switch it on" the stored
// bytes are read back and hashed: only a hash equal to the card's is installed (service.ts
// `installProposed`), approved as exactly the code written, and switched on. "Not now", a dismiss, an
// expiry, a withdraw or a newer proposal from the same sender removes the stored copy.
//
// A proposal for a trick a proposal made, that is on and has nothing waiting, is a NEW VERSION. It is kept
// inert the same way, and its card (proposal-card.ts `proposalVersionCard`) shows it against the approved
// copy, names the proposer, and recommends nothing. Only on "Use the new version" does it touch the
// trick's folder: the trick must still be the one the card was made against, then its code is replaced
// and exactly that code approved (service.ts `installProposedVersion`). The trick's own config.toml stays.
// Before that yes nothing a proposer sends changes a file outside `.collie-proposed/` and `proposals.json`.
// Every other id that exists is refused in plain words (service.ts `proposalTarget`): a trick from a
// repository, one added on this machine, one that is off, one with a change waiting.
//
// ── LIMITS ─────────────────────────────────────────────────────────────────────────────────────────
// A sender is one session (its walky address on its machine) or one machine's terminal. Per sender at
// most {@link PROPOSALS_SENDER_OPEN_MAX} open and {@link PROPOSALS_SENDER_HOUR_MAX} in an hour; per crew
// machine {@link PROPOSALS_MEMBER_OPEN_MAX} open; on this lead {@link PROPOSALS_OPEN_MAX} open and
// {@link PROPOSED_BYTES_MAX} stored. One open proposal per trick id: the same sender's next one replaces
// it (the old card closes as replaced), anybody else's is refused. A request id is the proposal's replay
// key for {@link PROPOSAL_RID_KEEP_MS}: the same sender, request id and hash answers what it answered; the
// same request id with other files is refused.

/** Open proposals one sender may have. */
export const PROPOSALS_SENDER_OPEN_MAX = 2;
/** Proposals one sender may make in an hour, replacements included. */
export const PROPOSALS_SENDER_HOUR_MAX = 6;
/** Open proposals from one crew machine, its sessions and its terminal together. */
export const PROPOSALS_MEMBER_OPEN_MAX = 4;
/** Open proposals on this lead. */
export const PROPOSALS_OPEN_MAX = 8;
/** Bytes stored for open proposals on this lead. */
export const PROPOSED_BYTES_MAX = 32 * 1024 * 1024;
/** How long a proposal card waits for an answer before it closes `expired` and its copy goes. */
export const PROPOSAL_EXPIRY_MS = 3 * 24 * 60 * 60_000;
/** How long a request id answers as it did. */
export const PROPOSAL_RID_KEEP_MS = 24 * 60 * 60_000;
/** The most request ids kept. */
export const PROPOSAL_RIDS_MAX = 200;
/** A stored copy no open proposal names is removed once it is this old (a write in flight is younger). */
export const PROPOSAL_ORPHAN_MS = 60_000;
/** The folder under the tricks folder that holds proposals. A dot folder: never a trick. */
export const PROPOSED_DIR = ".collie-proposed";
/** The state file. */
export const PROPOSALS_FILE = "proposals.json";

/** The words a refused answer to a proposal card shows. */
export const PROPOSAL_GONE = "This proposal is no longer kept on this machine. Ask for it again.";
export const PROPOSAL_CHANGED = "The stored proposal does not match this card, so nothing was switched on.";
export const PROPOSAL_NOT_OPTION = "That is not an option of this card.";
export const PROPOSAL_NO_TRICKS = "Tricks are not set up on this Collie, so nothing was proposed.";

/** Every warning kind, for a code search that failed. */
const ALL_WARNINGS = ["spawn", "network", "write", "model", "import"] as const satisfies readonly (keyof typeof WARN_PLAIN)[];

/** Who proposes, as this bridge knows them. */
export interface Proposer extends ProposerFacts {
  /** The machine's crew id, or this bridge's own id. */
  memberId: string;
  /** The session's walky address with its instance token, or null for a terminal. */
  address: string | null;
}

/** What a proposal came to. */
export type ProposeAnswer = { ok: true; kind: "proposal" | "version"; id: string; hash: string; decision: string; replaced: string | null } | { ok: false; code: ProposeRefusalCode; error: string };

/** What proposals need of the Hill: Collie's own door, which no agent and no crew member reaches. */
export interface ProposalsHill {
  isOn(): boolean;
  isAnswering(id: string): boolean;
  postCollie(from: HillCollieSender, input: HillPostInput, opts?: Pick<HillPostOptions, "tellOf">): HillPostAnswer;
  withdrawCollie(from: HillCollieSender, id: string, reason: string): HillOneAnswer;
  collieDecisions(type: HillCollieRef["type"]): HillDecision[];
}

/** What proposals need of the tricks runner (service.ts). */
export interface ProposalsTricks {
  proposalTarget(id: string): Promise<ProposalTarget>;
  installProposed(id: string, files: readonly ProposedFile[], origin: ProposalOrigin): Promise<ProposalPlaced>;
  installProposedVersion(id: string, files: readonly ProposedFile[], origin: ProposalOrigin, baseHash: string): Promise<ProposalPlaced>;
}

export interface TrickProposalsDeps {
  configDir: string;
  stateDir: string;
  hill: ProposalsHill;
  /** Read lazily: the runner is built after the Hill. Null: no tricks on this bridge. */
  tricks: () => ProposalsTricks | null;
  /** Whether this bridge leads a crew (a trick's `inputs` then read on every machine). */
  crew?: () => boolean;
  diff?: (base: string | null, next: string) => Promise<VersionDiff>;
  now?: () => number;
  warn?: (line: string) => void;
  audit?: (entry: { action: string; detail: Record<string, string> }) => void;
}

/** One open proposal, as `proposals.json` keeps it. */
interface OpenProposal {
  /** A new trick, or a new version of a trick a proposal made. */
  kind: "new" | "version";
  /** For a version: the approved code hash the card was made against. */
  base: string | null;
  id: string;
  hash: string;
  decision: string;
  sender: string;
  memberId: string;
  address: string | null;
  proposer: ProposerFacts;
  /** The paths the proposal marked executable. */
  exec: string[];
  bytes: number;
  at: number;
}

interface RidEntry {
  sender: string;
  requestId: string;
  hash: string;
  answer: ProposeAnswer & { ok: true };
  at: number;
}

interface ProposalsState {
  open: OpenProposal[];
  recent: { sender: string; at: number }[];
  rids: RidEntry[];
}

function emptyState(): ProposalsState {
  return { open: [], recent: [], rids: [] };
}

function refused(code: ProposeRefusalCode, error: string): ProposeAnswer {
  return { ok: false, code, error };
}

/** The key one sender's limits count under. */
export function senderKey(proposer: Pick<Proposer, "memberId" | "address">): string {
  return `${proposer.memberId}\u0000${proposer.address ?? "terminal"}`;
}

const HASH_RE = /^[0-9a-f]{64}$/u;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** A list field, or an empty list. */
function listOf(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function readFacts(row: JsonObject | undefined): ProposerFacts | null {
  const by = asJsonString(row?.by);
  const host = asJsonString(row?.host);
  const label = row?.label === null ? null : asJsonString(row?.label);
  if ((by !== "agent" && by !== "terminal") || host === undefined || label === undefined) return null;
  return { by, host, label };
}

/** The state file read back, total over garbage: a row that does not read is dropped. */
export function parseProposalsState(text: string | null): ProposalsState {
  const doc = asJsonObject(text === null ? undefined : parseJson(text));
  if (doc === undefined || asJsonNumber(doc.v) !== 1) return emptyState();
  const state = emptyState();
  for (const raw of listOf(doc.open)) {
    const row = asJsonObject(raw);
    const id = asJsonString(row?.id);
    const hash = asJsonString(row?.hash);
    const decision = asJsonString(row?.decision);
    const sender = asJsonString(row?.sender);
    const memberId = asJsonString(row?.memberId);
    const address = row?.address === null ? null : asJsonString(row?.address);
    const proposer = readFacts(asJsonObject(row?.proposer));
    const exec = listOf(row?.exec).map((rel) => asJsonString(rel));
    const bytes = asJsonNumber(row?.bytes);
    const at = asJsonNumber(row?.at);
    const kind = row?.kind === undefined ? "new" : asJsonString(row.kind);
    const base = row?.base === undefined || row.base === null ? null : asJsonString(row.base);
    if ((kind !== "new" && kind !== "version") || base === undefined || (kind === "version") !== (base !== null && HASH_RE.test(base))) continue;
    if (id === undefined || !ID_RE.test(id) || hash === undefined || !HASH_RE.test(hash) || decision === undefined || sender === undefined || memberId === undefined) continue;
    if (address === undefined || proposer === null || exec.some((rel) => rel === undefined) || bytes === undefined || at === undefined) continue;
    state.open.push({ kind, base, id, hash, decision, sender, memberId, address, proposer, exec: exec.filter((rel): rel is string => rel !== undefined), bytes, at });
  }
  for (const raw of listOf(doc.recent)) {
    const row = asJsonObject(raw);
    const sender = asJsonString(row?.sender);
    const at = asJsonNumber(row?.at);
    if (sender !== undefined && at !== undefined) state.recent.push({ sender, at });
  }
  for (const raw of listOf(doc.rids)) {
    const row = asJsonObject(raw);
    const sender = asJsonString(row?.sender);
    const requestId = asJsonString(row?.requestId);
    const hash = asJsonString(row?.hash);
    const at = asJsonNumber(row?.at);
    const answer = asJsonObject(row?.answer);
    const kind = asJsonString(answer?.kind);
    const id = asJsonString(answer?.id);
    const decision = answer?.decision === null ? null : asJsonString(answer?.decision);
    const replaced = answer?.replaced === null ? null : asJsonString(answer?.replaced);
    if (sender === undefined || requestId === undefined || hash === undefined || at === undefined || id === undefined || decision === undefined || replaced === undefined) continue;
    if ((kind === "proposal" || kind === "version") && decision !== null) state.rids.push({ sender, requestId, hash, at, answer: { ok: true, kind, id, hash, decision, replaced } });
  }
  return state;
}

/** A folder that is a real folder (never a link), made 0700 when missing. False when it is anything else. */
async function realFolder(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  if (st === null) {
    await mkdir(path, { mode: 0o700 });
    return (await lstat(path)).isDirectory();
  }
  return st.isDirectory() && !st.isSymbolicLink();
}

/**
 * Read a stored proposal back: every regular file under `dir`, never through a link, within the
 * proposal caps. Null when the folder holds anything else, or more.
 */
export async function readStored(dir: string, exec: ReadonlySet<string>): Promise<ProposedFile[] | null> {
  const files: ProposedFile[] = [];
  let bytes = 0;
  const walk = async (rel: string, depth: number): Promise<boolean> => {
    if (depth > PROPOSE_LIMITS.depth + 1) return false;
    const here = rel === "" ? dir : join(dir, rel);
    const entries = await readdir(here, { withFileTypes: true }).catch(() => null);
    if (entries === null) return false;
    for (const entry of entries) {
      const sub = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!(await walk(sub, depth + 1))) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      const body = await readFile(join(dir, sub), { flag: "r" }).catch(() => null);
      const st = await lstat(join(dir, sub)).catch(() => null);
      if (body === null || st === null || !st.isFile()) return false;
      bytes += body.length;
      if (files.length >= PROPOSE_LIMITS.files || bytes > PROPOSE_LIMITS.bytes) return false;
      files.push({ rel: sub, bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), executable: exec.has(sub) });
    }
    return true;
  };
  return (await walk("", 0)) ? files.toSorted((a, b) => (a.rel === b.rel ? 0 : a.rel < b.rel ? -1 : 1)) : null;
}

export class TrickProposals {
  private readonly deps: TrickProposalsDeps;
  private readonly now: () => number;
  private readonly warn: (line: string) => void;
  private readonly diff: (base: string | null, next: string) => Promise<VersionDiff>;
  private state: ProposalsState | null = null;
  /** Every change runs one at a time: a propose, an answer, a sweep. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: TrickProposalsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? ((line) => console.warn(`[tricks] ${line}`));
    this.diff = deps.diff ?? ((base, next) => versionDiff({ base, next }));
  }

  /** `<configDir>/tricks/.collie-proposed`. */
  root(): string {
    return join(tricksConfigDir(this.deps.configDir), PROPOSED_DIR);
  }

  /** Where one proposal is stored. */
  storeDir(id: string, hash: string): string {
    return join(this.root(), id, hash16(hash));
  }

  private statePath(): string {
    return join(tricksStateDir(this.deps.stateDir), PROPOSALS_FILE);
  }

  private turn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => {});
    return next;
  }

  private async load(): Promise<ProposalsState> {
    if (this.state !== null) return this.state;
    const text = await readFile(this.statePath(), "utf8").catch(() => null);
    this.state = parseProposalsState(text);
    return this.state;
  }

  private async save(state: ProposalsState): Promise<void> {
    const path = this.statePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ v: 1, ...state })}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  }

  /** Read the state once, then sweep. */
  async start(): Promise<void> {
    await this.turn(() => this.load());
    await this.sweep();
  }

  /** Take one proposal, checked on the wire already (propose-wire.ts `readProposal`). Never throws. */
  propose(proposal: ProposalRead, proposer: Proposer): Promise<ProposeAnswer> {
    return this.turn(async () => {
      try {
        return await this.take(proposal, proposer);
      } catch (err) {
        this.warn(`a proposal failed: ${err instanceof Error ? err.message : String(err)}`);
        return refused("failed", "The proposal could not be kept on this machine, so nothing was proposed.");
      }
    });
  }

  private async take(proposal: ProposalRead, proposer: Proposer): Promise<ProposeAnswer> {
    if (!this.deps.hill.isOn()) return refused("hill_off", HILL_OFF);
    const tricks = this.deps.tricks();
    if (tricks === null) return refused("no_tricks", PROPOSAL_NO_TRICKS);
    const state = await this.load();
    const now = this.now();
    this.forget(state, now);
    const sender = senderKey(proposer);
    const id = proposal.manifest.id;
    const { hash } = proposal;
    // A request id answers as it did; with other files it is refused.
    const rid = state.rids.find((row) => row.sender === sender && row.requestId === proposal.requestId);
    if (rid !== undefined) return rid.hash === hash ? rid.answer : refused("request_id_reused", "This request id already proposed other files. Propose with a new request id.");
    // The open proposals that are still open on the Hill.
    const live = this.liveOpen(state);
    const same = live.find((row) => row.id === id);
    if (same !== undefined && same.sender !== sender) return refused("open_elsewhere", `Somebody else already proposed a trick named ${id}. It waits for your person's answer.`);
    if (same !== undefined && same.hash === hash) return { ok: true, kind: same.kind === "version" ? "version" : "proposal", id, hash, decision: same.decision, replaced: null };
    if (same !== undefined && this.deps.hill.isAnswering(same.decision)) return refused("answering", "Your person is answering your last proposal of this trick right now. Try again in a moment.");
    const target = await tricks.proposalTarget(id);
    if (target.kind === "refused") return refused("exists", target.reason);
    const others = live.filter((row) => row !== same);
    const self = proposer.by === "agent" ? "This session" : "This terminal";
    if (others.filter((row) => row.sender === sender).length >= PROPOSALS_SENDER_OPEN_MAX) return refused("too_many_open", `${self} has ${String(PROPOSALS_SENDER_OPEN_MAX)} proposals waiting. Wait for your person's answers.`);
    if (state.recent.filter((row) => row.sender === sender).length >= PROPOSALS_SENDER_HOUR_MAX) return refused("rate", `${self} proposed ${String(PROPOSALS_SENDER_HOUR_MAX)} tricks in the last hour. Try again later.`);
    if (others.filter((row) => row.memberId === proposer.memberId).length >= PROPOSALS_MEMBER_OPEN_MAX) return refused("too_many_open", `This machine has ${String(PROPOSALS_MEMBER_OPEN_MAX)} proposals waiting. Wait for your person's answers.`);
    if (others.length >= PROPOSALS_OPEN_MAX) return refused("too_many_open", `${String(PROPOSALS_OPEN_MAX)} proposals wait already on this Collie. Wait for your person's answers.`);
    if (others.reduce((sum, row) => sum + row.bytes, 0) + proposal.bytes > PROPOSED_BYTES_MAX) return refused("too_many_bytes", "The proposals waiting on this Collie hold too much already. Wait for your person's answers.");
    return await this.newProposal(state, proposal, proposer, same ?? null, target.kind === "version" ? target : null, now);
  }

  /** The warning kinds a text search of `dir` finds. A search that failed counts as everything it could find. */
  private async warningKinds(dir: string, manifest: TrickManifest | undefined): Promise<(keyof typeof WARN_PLAIN)[]> {
    if (manifest === undefined) return [...ALL_WARNINGS];
    const found = await trickWarnings(dir, manifest).catch(() => null);
    return found === null ? [...ALL_WARNINGS] : [...new Set(found.map((w) => w.kind))];
  }

  /** The card for a stored proposal: a new trick, or a new version shown against the approved copy. */
  private async cardOf(dir: string, proposal: ProposalRead, proposer: Proposer, base: Extract<ProposalTarget, { kind: "version" }> | null): Promise<Omit<HillPostInput, "requestId">> {
    const id = proposal.manifest.id;
    const crew = this.deps.crew?.() ?? false;
    const kinds = await this.warningKinds(dir, proposal.manifest);
    if (base === null) {
      const diff = await this.diff(null, dir).catch((): VersionDiff => ({ files: [], counted: false }));
      return proposalCard({ id, manifest: proposal.manifest, proposer: facts(proposer), diff, warnings: kinds, crew });
    }
    const diff = await this.diff(base.baseDir, dir).catch((): VersionDiff => ({ files: [], counted: false }));
    const had = new Set(base.baseManifest === undefined ? [] : await this.warningKinds(base.baseDir, base.baseManifest));
    return proposalVersionCard({ id, manifest: proposal.manifest, baseManifest: base.baseManifest, proposer: facts(proposer), diff, warnings: kinds.filter((kind) => !had.has(kind)), crew });
  }

  private async newProposal(state: ProposalsState, proposal: ProposalRead, proposer: Proposer, old: OpenProposal | null, base: Extract<ProposalTarget, { kind: "version" }> | null, now: number): Promise<ProposeAnswer> {
    const id = proposal.manifest.id;
    const { hash } = proposal;
    const dir = await this.store(id, hash, proposal.files);
    if (dir === null) return refused("failed", "The proposal could not be kept on this machine, so nothing was proposed.");
    const card = await this.cardOf(dir, proposal, proposer, base);
    const input: HillPostInput = { ...card, requestId: proposalRequestId(id, hash, proposal.requestId), expiresAt: now + PROPOSAL_EXPIRY_MS };
    if (old !== null) input.supersedes = old.decision;
    const posted = this.deps.hill.postCollie(senderOf(id, hash), input, proposer.address === null ? {} : { tellOf: proposer.address });
    if (!posted.ok) {
      await rm(dir, { recursive: true, force: true });
      if (posted.code === "hill_off") return refused("hill_off", HILL_OFF);
      if (posted.code === "bad_supersedes") return refused("answering", "Your person is answering your last proposal of this trick right now. Try again in a moment.");
      return refused("failed", `The Hill did not take the card, so nothing was proposed: ${posted.error}`);
    }
    if (old !== null) {
      state.open = state.open.filter((row) => row !== old);
      if (old.hash !== hash) await rm(this.storeDir(old.id, old.hash), { recursive: true, force: true });
    }
    state.open.push({ kind: base === null ? "new" : "version", base: base?.baseHash ?? null, id, hash, decision: posted.decision.id, sender: senderKey(proposer), memberId: proposer.memberId, address: proposer.address, proposer: facts(proposer), exec: proposal.files.filter((file) => file.executable).map((file) => file.rel), bytes: proposal.bytes, at: now });
    const answer: ProposeAnswer & { ok: true } = { ok: true, kind: base === null ? "proposal" : "version", id, hash, decision: posted.decision.id, replaced: old?.decision ?? null };
    this.remember(state, senderKey(proposer), proposal.requestId, hash, answer, now);
    await this.save(state);
    this.deps.audit?.({ action: "trick.proposal", detail: { trick: id, hash: hash.slice(0, 16), kind: base === null ? "proposal" : "version", decisionId: posted.decision.id, from: proposer.memberId } });
    return answer;
  }

  /** Note a proposal for the hour's count and its request id. */
  private remember(state: ProposalsState, sender: string, requestId: string, hash: string, answer: ProposeAnswer & { ok: true }, now: number): void {
    state.recent.push({ sender, at: now });
    state.rids = [...state.rids, { sender, requestId, hash, answer, at: now }].slice(-PROPOSAL_RIDS_MAX);
  }

  /** Drop what is past its time: the hour's count and the request ids. */
  private forget(state: ProposalsState, now: number): void {
    state.recent = state.recent.filter((row) => now - row.at < 60 * 60_000);
    state.rids = state.rids.filter((row) => now - row.at < PROPOSAL_RID_KEEP_MS);
  }

  /** The open proposals whose card is still open on the Hill. */
  private liveOpen(state: ProposalsState): OpenProposal[] {
    const open = new Set(
      this.deps.hill
        .collieDecisions("proposal")
        .filter((decision) => decision.state === "open")
        .map((decision) => decision.id),
    );
    return state.open.filter((row) => open.has(row.decision));
  }

  /**
   * Write a proposal into its store: a staged folder under `<id>/`, renamed to `<hash16>`. Every folder
   * on the way must be a real folder, never a link. Null when it could not be written.
   */
  private async store(id: string, hash: string, files: readonly ProposedFile[]): Promise<string | null> {
    const tricksRoot = tricksConfigDir(this.deps.configDir);
    await mkdir(tricksRoot, { recursive: true, mode: 0o700 });
    if (!(await realFolder(this.root())) || !(await realFolder(join(this.root(), id)))) return null;
    const final = this.storeDir(id, hash);
    // A copy of this very hash, left from a proposal that went: written again, never trusted.
    await rm(final, { recursive: true, force: true });
    const stage = join(this.root(), id, `.stage-${randomBytes(6).toString("hex")}`);
    try {
      await mkdir(stage, { mode: 0o700 });
      for (const file of files) {
        const path = join(stage, file.rel);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
      }
      await rename(stage, final);
      return final;
    } catch (err) {
      this.warn(`${id}: the proposal could not be stored: ${err instanceof Error ? err.message : String(err)}`);
      await rm(stage, { recursive: true, force: true });
      return null;
    }
  }

  /**
   * The answer to a proposal card, from the Hill's claim (`onCollieAnswer`). "on" installs exactly the
   * stored bytes whose hash is the card's (a new trick, or a new version of the trick the card was made
   * against); "later" removes the stored copy and changes nothing else. A refusal keeps the card open.
   */
  answer(ref: HillCollieRef, intent: string): Promise<HillCollieVerdict> {
    return this.turn(async () => {
      const state = await this.load();
      const entry = state.open.find((row) => row.id === ref.id && row.hash === ref.hash);
      if (intent !== PROPOSAL_ON.intent && intent !== PROPOSAL_LATER.intent) return { ok: false, reason: PROPOSAL_NOT_OPTION };
      if (entry === undefined) return intent === PROPOSAL_LATER.intent ? { ok: true } : { ok: false, reason: PROPOSAL_GONE };
      if (intent === PROPOSAL_LATER.intent) {
        await this.drop(state, entry);
        return { ok: true };
      }
      const tricks = this.deps.tricks();
      if (tricks === null) return { ok: false, reason: "Tricks are not running on this bridge." };
      const files = await readStored(this.storeDir(entry.id, entry.hash), new Set(entry.exec));
      // TOCTOU: the bytes installed are the bytes read here, and they must hash to the card's hash.
      if (files === null || proposalHash(files) !== ref.hash || !checkProposedFiles(files).ok) return { ok: false, reason: PROPOSAL_CHANGED };
      const origin: ProposalOrigin = { by: entry.proposer.by, host: entry.proposer.host, label: entry.proposer.label, at: new Date(this.now()).toISOString() };
      const placed = entry.kind === "version" && entry.base !== null ? await tricks.installProposedVersion(entry.id, files, origin, entry.base) : await tricks.installProposed(entry.id, files, origin);
      if (!placed.ok) return { ok: false, reason: placed.message };
      await this.drop(state, entry);
      this.deps.audit?.({ action: "trick.proposal.on", detail: { trick: entry.id, hash: entry.hash.slice(0, 16) } });
      return { ok: true };
    });
  }

  private async drop(state: ProposalsState, entry: OpenProposal): Promise<void> {
    state.open = state.open.filter((row) => row !== entry);
    await rm(this.storeDir(entry.id, entry.hash), { recursive: true, force: true });
    await this.save(state);
  }

  /**
   * Remove every stored proposal whose card is no longer open (answered, dismissed, expired, withdrawn,
   * replaced, cleared), and every copy no open proposal names once it is {@link PROPOSAL_ORPHAN_MS} old.
   * At start and on the bridge's slow timer. Never throws.
   */
  sweep(): Promise<void> {
    return this.turn(async () => {
      try {
        const state = await this.load();
        const before = JSON.stringify(state);
        const now = this.now();
        this.forget(state, now);
        const live = new Set(this.liveOpen(state));
        const gone = state.open.filter((row) => !live.has(row));
        for (const row of gone) await rm(this.storeDir(row.id, row.hash), { recursive: true, force: true });
        state.open = state.open.filter((row) => live.has(row));
        await this.sweepDisk(state, now);
        // The slow timer sweeps often: the file is written only when something went.
        if (JSON.stringify(state) !== before) await this.save(state);
      } catch (err) {
        this.warn(`the proposals could not be swept: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private async sweepDisk(state: ProposalsState, now: number): Promise<void> {
    const named = new Set(state.open.map((row) => `${row.id}/${hash16(row.hash)}`));
    const root = this.root();
    const st = await lstat(root).catch(() => null);
    if (st === null) return;
    // A link where the folder should be is removed, never followed.
    if (!st.isDirectory()) {
      await rm(root, { force: true });
      return;
    }
    for (const id of await readdir(root)) {
      const idDir = join(root, id);
      const idSt = await lstat(idDir).catch(() => null);
      if (idSt === null) continue;
      if (!idSt.isDirectory()) {
        await rm(idDir, { force: true });
        continue;
      }
      const copies = await readdir(idDir);
      let left = copies.length;
      for (const copy of copies) {
        if (named.has(`${id}/${copy}`)) continue;
        const copySt = await lstat(join(idDir, copy)).catch(() => null);
        if (copySt === null || now - copySt.mtimeMs < PROPOSAL_ORPHAN_MS) continue;
        await rm(join(idDir, copy), { recursive: true, force: true });
        left -= 1;
      }
      if (left === 0) await rm(idDir, { recursive: true, force: true });
    }
  }
}

/** One display word, cleaned: a character a card could misread becomes `?`, at most 80. */
function clean(raw: string): string {
  return [...raw]
    .map((ch) => (unsafeText(ch) ? "?" : ch))
    .slice(0, 80)
    .join("");
}

/** The proposer's facts for a card and a record: display words, cleaned. */
function facts(proposer: Proposer): ProposerFacts {
  return { by: proposer.by, host: clean(proposer.host), label: proposer.label === null ? null : clean(proposer.label) };
}

/** The sender of a proposal card. */
function senderOf(id: string, hash: string): HillCollieSender {
  return { kind: "collie", ref: { type: "proposal", id, hash }, label: PROPOSAL_CARD_SENDER };
}
