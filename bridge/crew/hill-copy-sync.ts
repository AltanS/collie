import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import type { HillDecision, HillMedia } from "../../web/src/lib/hill/wire.ts";
import type { HillCarryView } from "../hill/service.ts";
import { CARRY_READ_TTL_MS, CARRY_RETRY_MS, type CarryCall, type CarrySyncResult } from "./carry-sync.ts";
import type { CrewLink } from "./peer-client.ts";
import { HILL_CLOSED_IDS_MAX, hillCopyDigest, mediaKey, parseHillReport } from "./standby-hill.ts";

// THE LEAD KEEPS ITS DEPUTY'S COPY OF THE HILL CURRENT (CREW_PROTOCOL §25), with the tricks copy's rules:
// a list when the digest differs, the missing pictures again at most once a minute while it is the same,
// and a picture the lead can no longer read is said to be gone, so the deputy settles it and stops asking.

/** What the lead reads of its own Hill (hill/service.ts `carryView`, `carryMedia`; tricks/hill.ts). */
export interface HillCopySource {
  view(closedMax: number): HillCarryView;
  media(decisionId: string, media: Pick<HillMedia, "id" | "mime" | "bytes">): Uint8Array | null;
  /** The trick map's raw records of these tricks. */
  tricks(ids: ReadonlySet<string>): JsonObject;
}

export interface HillCopyClient {
  list(link: CrewLink, body: JsonObject): Promise<CarryCall>;
  media(link: CrewLink, body: JsonObject): Promise<CarryCall>;
}

/** What the lead knows of its deputy's copy of the Hill. */
export interface DeputyHillFact {
  readonly member: string;
  readonly state: "current" | "behind" | "older";
  /** How many open Decisions this lead carries. */
  readonly open: number;
}

export interface HillCopySyncDeps {
  readonly source: HillCopySource;
  readonly client: HillCopyClient;
  readonly now?: () => number;
}

interface Built {
  readonly body: JsonObject;
  readonly digest: string;
  readonly open: readonly HillDecision[];
}

function needOfAnswer(body: JsonValue | null): string[] {
  const media = asJsonObject(asJsonObject(body ?? undefined)?.need)?.media;
  return Array.isArray(media) ? media.flatMap((v) => asJsonString(v) ?? []) : [];
}

export class HillCopySync {
  private readonly now: () => number;
  private cache: { at: number; built: Built } | null = null;
  private lastRound = -Infinity;
  private fact: DeputyHillFact | null = null;

  constructor(private readonly deps: HillCopySyncDeps) {
    this.now = deps.now ?? Date.now;
  }

  deputyFact(): DeputyHillFact | null {
    return this.fact;
  }

  private build(): Built {
    const now = this.now();
    if (this.cache !== null && now - this.cache.at < CARRY_READ_TTL_MS) return this.cache.built;
    const view = this.deps.source.view(HILL_CLOSED_IDS_MAX);
    const trickIds = new Set(view.open.flatMap((d) => (d.from.kind === "trick" && d.from.trickId !== null ? [d.from.trickId] : [])));
    const tricks = this.deps.source.tricks(trickIds);
    // The records as the wire carries them: the deputy digests what it parsed, so the lead digests the same.
    // SAFETY: `JSON.parse` of `JSON.stringify` output is a JsonValue by construction.
    const decisions = JSON.parse(JSON.stringify(view.open)) as JsonValue[];
    // The crew state rides only once the person set one, so a lead that never did sends the body it always sent.
    const crewState = view.crewState ?? null;
    const digest = hillCopyDigest(view.on, decisions, view.closed, tricks, crewState);
    const base: JsonObject = { on: view.on, decisions, closed: view.closed, tricks };
    const built: Built = { body: crewState === null ? base : { ...base, crewState: { state: crewState.state, at: crewState.at, by: crewState.by } }, digest, open: view.open };
    this.cache = { at: now, built };
    return built;
  }

  /** One sync to the deputy at `link`, given the report off its snapshot answer. */
  async run(link: CrewLink, body: JsonValue | undefined): Promise<CarrySyncResult> {
    const reported = parseHillReport(body);
    const built = this.build();
    const same = reported !== null && reported.digest === built.digest;
    if (same && reported.need === 0) {
      this.fact = { member: link.memberId, state: "current", open: built.open.length };
      return "idle";
    }
    this.fact = { member: link.memberId, state: "behind", open: built.open.length };
    if (same && this.now() - this.lastRound < CARRY_RETRY_MS) return "idle";
    this.lastRound = this.now();
    const seq = Math.max(this.now(), (reported?.seq ?? 0) + 1);
    const answer = await this.deps.client.list(link, { ...built.body, seq });
    if (answer.kind === "failed") return "failed";
    if (answer.status === 404) {
      this.fact = { member: link.memberId, state: "older", open: built.open.length };
      return "no_route";
    }
    if (answer.status < 200 || answer.status >= 300) return "failed";
    for (const key of needOfAnswer(answer.body)) {
      const decision = built.open.find((d) => key.startsWith(`${d.id}/`));
      const media = decision?.media.find((m) => mediaKey(decision.id, m.id) === key);
      if (decision === undefined || media === undefined) continue;
      const bytes = this.deps.source.media(decision.id, media);
      const part = bytes === null ? { decisionId: decision.id, mediaId: media.id, gone: true } : { decisionId: decision.id, mediaId: media.id, b64: Buffer.from(bytes).toString("base64") };
      const sent = await this.deps.client.media(link, part);
      if (sent.kind === "failed") return "failed";
    }
    return "done";
  }
}
