import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { leadWords, readDial, resolvesToOwn, TRICKS_CREW_FIRST_VERSION, type HillCrewAnswer } from "../hill/crew.ts";
import type { HillPlace } from "../hill/service.ts";
import type { CrewDialAnswer } from "../walky/crew.ts";
import type { ProposeAnswer, Proposer, TrickProposals } from "./proposals.ts";
import { PROPOSE_REFUSAL_CODES, readProposal, wireFiles, type ProposalRead, type ProposeRefusalCode } from "./propose-wire.ts";

// THE DOORS OF `collie trick propose` (crew slice 8, CREW_PROTOCOL §24).
//
// LOCAL: the walky socket hands a proposal from a session or a terminal on this machine (socket.ts). On a
// lead or a solo bridge it goes to the proposals (proposals.ts); the proposer is the pane the socket
// placed from its markers, named as this bridge's own session list names it, or a terminal.
//
// CREW: on a member the same call goes on to the lead, over the signed member → lead route
// `POST /crew/v1/tricks/propose`, after the member read every file by the one reader (propose-wire.ts).
// The member keeps no copy, and queues nothing: a lead that does not answer is "The lead is not
// answering, so nothing was proposed." On the lead the route takes the member from §8.6's signature,
// never from the body: an `address` that is not a pane of that member is the uniform 401. The session's
// name on the card is the lead's own word for that address (its `place()`), or none; the host is the
// lead's name for the member. The lead reads every file again, by the same reader.

/** The route under `/crew/v1/`, as the member's crew client names it. */
export const CREW_TRICKS_PROPOSE_ROUTE = "tricks/propose";
/** How long a member waits for its lead to take a proposal: the upload, the lead's read and its card. */
export const PROPOSE_FORWARD_MS = 90_000;
/** How long `collie trick propose` waits on the socket: the forward's budget, plus a margin. */
export const PROPOSE_ASK_MS = PROPOSE_FORWARD_MS + 30_000;

/** The words of a lead that did not take the proposal and may not have read it. */
export const PROPOSE_LEAD_AWAY = "The lead is not answering, so nothing was proposed.";

/** A lead that takes proposals and has no tricks set up. */
export const PROPOSE_LEAD_NO_TRICKS = "Tricks are not set up on the lead, so nothing was proposed.";

/** A lead whose release takes no proposals. */
export function proposeLeadOlder(lead: string): string {
  return `The lead (${lead}) runs a Collie older than ${TRICKS_CREW_FIRST_VERSION}, which takes no proposals. Update the lead, or propose from the lead machine.`;
}

/** A lead that may have taken the proposal: the same request id proposes once. */
export function proposeNotConfirmed(lead: string, requestId: string): string {
  return `The lead (${lead}) did not confirm the proposal. Propose again with --request-id ${requestId}: it is proposed once.`;
}

/** Who asks on this machine: a session the socket placed, or a terminal. */
export type LocalProposer = { kind: "agent"; address: string; label: string } | { kind: "terminal" };

export interface ProposeDoorDeps {
  mode: () => "solo" | "lead" | "peer";
  /** On a lead or a solo bridge; null on a bridge without tricks. */
  proposals: () => Pick<TrickProposals, "propose"> | null;
  /** This bridge's id (the crew member id, or the install id) and its machine name. */
  memberId: string;
  machine: string;
  /** On a member: one signed dial of the lead. */
  call?: (route: string, payload: string, budgetMs: number) => Promise<CrewDialAnswer>;
  leadName?: () => string | null;
  leadOlder?: () => boolean;
  leadAtFloor?: () => boolean;
  /** On a lead: its own address probe, the Hill's. */
  place?: (address: string) => HillPlace | null;
}

function refusal(code: ProposeRefusalCode, error: string): ProposeAnswer {
  return { ok: false, code, error };
}

/** A lead's answer body, read as a proposal answer. */
function answerOf(body: JsonObject, lead: string): ProposeAnswer {
  if (asJsonBoolean(body.ok) !== true) {
    const raw = asJsonString(body.code);
    const code = PROPOSE_REFUSAL_CODES.find((known) => known === raw) ?? "failed";
    return refusal(code, leadWords(asJsonString(body.error), "the lead refused the proposal"));
  }
  const kind = asJsonString(body.kind);
  const id = asJsonString(body.id);
  const hash = asJsonString(body.hash);
  const decision = asJsonString(body.decision);
  const replaced = body.replaced === null || body.replaced === undefined ? null : asJsonString(body.replaced);
  if (id === undefined || hash === undefined || decision === undefined || replaced === undefined || (kind !== "proposal" && kind !== "version")) return refusal("failed", `The lead (${lead}) answered without the proposal. Check the Hill on the phone.`);
  return { ok: true, kind, id, hash, decision, replaced };
}

export class ProposeDoor {
  constructor(private readonly deps: ProposeDoorDeps) {}

  /** A proposal from this machine's walky socket. Never throws. */
  async local(fields: JsonObject, who: LocalProposer): Promise<ProposeAnswer> {
    const read = readProposal(fields);
    if (!read.ok) return { ok: false, ...read.refusal };
    if (this.deps.mode() === "peer") return await this.forward(read.proposal, who);
    const proposals = this.deps.proposals();
    if (proposals === null) return refusal("no_tricks", "Tricks are not set up on this Collie, so nothing was proposed.");
    const proposer: Proposer =
      who.kind === "agent"
        ? { by: "agent", host: this.deps.machine, label: who.label, memberId: this.deps.memberId, address: who.address }
        : { by: "terminal", host: this.deps.machine, label: null, memberId: this.deps.memberId, address: null };
    return await proposals.propose(read.proposal, proposer);
  }

  /** On a member: the checked proposal goes to the lead. Nothing is kept here. */
  private async forward(proposal: ProposalRead, who: LocalProposer): Promise<ProposeAnswer> {
    const lead = this.deps.leadName?.() ?? "the lead";
    const { requestId } = proposal;
    if (this.deps.call === undefined) return refusal("lead_unreachable", PROPOSE_LEAD_AWAY);
    if (this.deps.leadOlder?.() === true) return refusal("not_on_lead", proposeLeadOlder(lead));
    const payload = JSON.stringify({ requestId, files: wireFiles(proposal.files), from: who.kind === "agent" ? { address: who.address } : null });
    const dial = readDial(await this.deps.call(CREW_TRICKS_PROPOSE_ROUTE, payload, PROPOSE_FORWARD_MS), this.deps.leadAtFloor?.() === true);
    if (dial.kind === "older") return refusal("not_on_lead", proposeLeadOlder(lead));
    if (dial.kind === "refused") return refusal("lead_unreachable", PROPOSE_LEAD_AWAY);
    if (dial.kind === "unknown") return refusal("lead_unreachable", proposeNotConfirmed(lead, requestId));
    if (dial.kind === "failed") return refusal("failed", dial.error);
    return answerOf(dial.body, lead);
  }

  /** `POST /crew/v1/tricks/propose` on a lead, for the member §8.6's signature named. */
  async fromMember(body: JsonValue | undefined, memberId: string): Promise<HillCrewAnswer> {
    const row = asJsonObject(body);
    if (row === undefined) return { status: 400, body: { error: "a proposal is { requestId, files, from }" } };
    const from = row.from === null || row.from === undefined ? null : asJsonObject(row.from);
    const address = from === null ? null : asJsonString(from?.address);
    if (from === undefined || address === undefined) return { status: 400, body: { error: "from is { address } or null" } };
    if (address !== null && !resolvesToOwn(address, memberId, this.deps.place)) return { status: 401, body: { error: "unauthorized" } };
    if (Object.keys(row).some((key) => key !== "requestId" && key !== "files" && key !== "from")) return { status: 400, body: { error: "a proposal is { requestId, files, from }" } };
    // A lead without tricks says so in its own words (not a 404, which the member reads as an older lead).
    const proposals = this.deps.proposals();
    if (proposals === null) return { status: 200, body: { ok: false, code: "no_tricks", error: PROPOSE_LEAD_NO_TRICKS } };
    const read = readProposal(row);
    if (!read.ok) return { status: 200, body: { ok: false, code: read.refusal.code, error: read.refusal.error } };
    // The lead's own knowledge only: its name for the member, and its own name for the session, or none.
    const placed = address === null ? null : (this.deps.place?.(address) ?? null);
    const label = placed === null || placed.label.trim() === "" ? null : placed.label;
    const proposer: Proposer = address === null ? { by: "terminal", host: memberId, label: null, memberId, address: null } : { by: "agent", host: memberId, label, memberId, address: placed?.address ?? address };
    const answer = await proposals.propose(read.proposal, proposer);
    return { status: 200, body: answer };
  }
}
