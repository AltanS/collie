import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import type { CrewLink } from "./peer-client.ts";
import type { DeputyTricksFact } from "./staleness.ts";
import { codeParts, readStateFiles, type LeadTrick } from "./standby-tricks-lead.ts";
import { parseTricksReport, tricksDigest, type CarryNeed, type TricksReport } from "./standby-tricks.ts";

// THE LEAD KEEPS ITS DEPUTY'S COPY OF THE TRICKS CURRENT (CREW_PROTOCOL §25). One sync per sweep at most,
// off the tick, and only when the deputy's own report says it is behind: the launchers copy's rule.
//
// THE LOOP CANNOT SPIN. A list goes when the digest differs. When the digest is the same and the deputy
// still lacks parts, the lead asks again at most once a minute ({@link CARRY_RETRY_MS}). Every such round
// either lands a part, or the deputy settles it for good (a hash that does not match, code or state too
// large to keep), so it is not owed any more. A part the deputy refused as malformed is not sent again for
// the same list. A deputy without the route (404) is not asked again until it reconnects (`lead.ts`).

/** How often the lead asks again for parts a deputy still lacks, while the list is the same. */
export const CARRY_RETRY_MS = 60_000;
/** How long one read of the lead's own tricks is used before it is read again. */
export const CARRY_READ_TTL_MS = 30_000;

/** One call to the deputy: its answer, or nothing at all. */
export type CarryCall = { readonly kind: "answer"; readonly status: number; readonly body: JsonValue | null } | { readonly kind: "failed" };

/** The three calls of the tricks copy, lead → deputy, on the crew link. */
export interface TricksCopyClient {
  list(link: CrewLink, body: JsonObject): Promise<CarryCall>;
  code(link: CrewLink, body: JsonObject): Promise<CarryCall>;
  state(link: CrewLink, body: JsonObject): Promise<CarryCall>;
}

/** How a sync ended: nothing to do, done, a deputy without the route, or a failure the next sweep retries. */
export type CarrySyncResult = "idle" | "done" | "no_route" | "failed";


export interface TricksCopySyncDeps {
  /** The tricks this lead runs, as the list would carry them (`leadTricks`). */
  read(): Promise<LeadTrick[]>;
  readonly client: TricksCopyClient;
  readonly now?: () => number;
}

function idsOf(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.flatMap((v) => asJsonString(v) ?? []) : [];
}

function needOfAnswer(body: JsonValue | null): CarryNeed {
  const need = asJsonObject(asJsonObject(body ?? undefined)?.need);
  return { code: idsOf(need?.code), state: idsOf(need?.state) };
}

export class TricksCopySync {
  private readonly now: () => number;
  private cache: { at: number; tricks: LeadTrick[] } | null = null;
  private lastRound = -Infinity;
  /** `<id>:<digest>` of state the deputy refused as malformed, not sent again for that digest. */
  private readonly gaveUp = new Set<string>();
  private fact: DeputyTricksFact | null = null;

  constructor(private readonly deps: TricksCopySyncDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The last fact about the deputy's copy, or null before the first sweep that reached it. */
  deputyFact(): DeputyTricksFact | null {
    return this.fact;
  }

  /** Forget the fact, when there is no deputy any more. */
  forget(): void {
    this.fact = null;
  }

  private async tricks(): Promise<LeadTrick[]> {
    const now = this.now();
    if (this.cache !== null && now - this.cache.at < CARRY_READ_TTL_MS) return this.cache.tricks;
    const tricks = await this.deps.read();
    this.cache = { at: now, tricks };
    return tricks;
  }

  /** Read the next sweep's list afresh, after a switch changed here. */
  invalidate(): void {
    this.cache = null;
  }

  private setFact(member: string, state: DeputyTricksFact["state"], tricks: number): void {
    this.fact = { member, state, tricks, at: this.now() };
  }

  /**
   * One sync to the deputy at `link`, given the report off its snapshot answer (`body`). Sends nothing
   * when the deputy holds the same list and lacks nothing.
   */
  async run(link: CrewLink, body: JsonValue | undefined): Promise<CarrySyncResult> {
    const reported: TricksReport | null = parseTricksReport(body);
    const tricks = await this.tricks();
    const digest = tricksDigest(tricks.map((t) => t.trick));
    const same = reported !== null && reported.digest === digest;
    if (same && reported.need === 0) {
      this.setFact(link.memberId, "current", tricks.length);
      return "idle";
    }
    // A lead with nothing to carry and a deputy that holds nothing: there is nothing to say.
    if (reported === null && tricks.length === 0) {
      this.setFact(link.memberId, "current", 0);
      return "idle";
    }
    this.setFact(link.memberId, "behind", tricks.length);
    if (same && this.now() - this.lastRound < CARRY_RETRY_MS) return "idle";
    this.lastRound = this.now();
    if (!same) this.gaveUp.clear();
    // `seq` only rises at the deputy, so the lead takes its clock or one past what the deputy holds.
    const seq = Math.max(this.now(), (reported?.seq ?? 0) + 1);
    const answer = await this.deps.client.list(link, { seq, tricks: tricks.map((t) => t.trick) });
    if (answer.kind === "failed") return "failed";
    if (answer.status === 404) {
      this.setFact(link.memberId, "older", tricks.length);
      return "no_route";
    }
    if (answer.status < 200 || answer.status >= 300) return "failed";
    const need = needOfAnswer(answer.body);
    for (const id of need.code) {
      const lead = tricks.find((t) => t.trick.id === id);
      if (lead === undefined) continue;
      if (!(await this.sendCode(link, lead))) return "failed";
    }
    for (const id of need.state) {
      const lead = tricks.find((t) => t.trick.id === id);
      if (lead === undefined || lead.trick.state === null || this.gaveUp.has(`${id}:${lead.trick.state}`)) continue;
      const files = await readStateFiles(lead.state);
      const sent = await this.deps.client.state(link, { id, digest: lead.trick.state, files: files.map((f) => ({ rel: f.rel, b64: Buffer.from(f.bytes).toString("base64") })) });
      if (sent.kind === "failed") return "failed";
      if (sent.status === 400) this.gaveUp.add(`${id}:${lead.trick.state}`);
    }
    return "done";
  }

  /** Every part of one trick's code, in order. False when the link failed; a refusal is the deputy's answer. */
  private async sendCode(link: CrewLink, lead: LeadTrick): Promise<boolean> {
    const parts = await codeParts(lead.copyDir, lead.trick.files);
    if (parts === null) return true;
    for (let part = 0; part < parts.length; part += 1) {
      const chunks = (parts[part] ?? []).map((c) => ({ rel: c.rel, at: c.at, b64: Buffer.from(c.bytes).toString("base64") }));
      const sent = await this.deps.client.code(link, { id: lead.trick.id, hash: lead.trick.hash, part, parts: parts.length, chunks });
      if (sent.kind === "failed") return false;
      if (sent.status < 200 || sent.status >= 300) return true;
    }
    return true;
  }
}
