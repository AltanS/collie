import { describe, expect, test } from "bun:test";

import type { JsonObject } from "../json.ts";
import { parseJsonObject } from "../../web/src/lib/json.ts";
import type { HillPlace } from "../hill/service.ts";
import type { CrewDialAnswer } from "../walky/crew.ts";
import { AUTHOR_PARAS_MAX, PROPOSAL_AUTHOR_WORDS, PROPOSAL_TOO_LARGE, proposalCard, proposalTitle, proposerSentence, PROPOSAL_LATER, PROPOSAL_ON } from "./proposal-card.ts";
import type { ProposeAnswer, Proposer, TrickProposals } from "./proposals.ts";
import { CREW_TRICKS_PROPOSE_ROUTE, PROPOSE_LEAD_AWAY, PROPOSE_LEAD_NO_TRICKS, ProposeDoor, proposeLeadOlder, proposeNotConfirmed, type ProposeDoorDeps } from "./propose-door.ts";
import { readProposal, wireFiles, type ProposalRead, type ProposedFile } from "./propose-wire.ts";
import type { VersionDiff } from "./version-diff.ts";
import { WARN_PLAIN } from "./scan.ts";
import type { ViewNode } from "../../web/src/lib/tricks/schema.ts";

// The doors of `collie trick propose` (crew slice 8) and the card the lead posts. The member forwards and
// keeps nothing; the lead names the proposer from its own knowledge only.

const RID = "11111111-2222-4333-8444-555555555555";
const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "program.ts"\nplaces = ["belt"]\n';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const FILES: ProposedFile[] = [
  { rel: "trick.toml", bytes: enc(MANIFEST), executable: false },
  { rel: "program.ts", bytes: enc("console.log(1)\n"), executable: false },
];
const fields = (): JsonObject => ({ requestId: RID, files: wireFiles(FILES) });

/** Proposals that record who proposed and answer a card. */
function recorder() {
  const seen: Proposer[] = [];
  const proposals = {
    propose: async (_read: ProposalRead, proposer: Proposer): Promise<ProposeAnswer> => {
      seen.push(proposer);
      return { ok: true, kind: "proposal", id: "legs", hash: "h", decision: "dc_k3m9x2p7q1ab", replaced: null };
    },
  } satisfies Pick<TrickProposals, "propose">;
  return { proposals, seen };
}

function place(address: string, label: string): HillPlace {
  return { address, label, host: null, unattended: false };
}

describe("the local door", () => {
  test("on a lead: an agent proposes as its session, a terminal as a terminal", async () => {
    const { proposals, seen } = recorder();
    const door = new ProposeDoor({ mode: () => "lead", proposals: () => proposals, memberId: "desk", machine: "desk" });
    expect((await door.local(fields(), { kind: "agent", address: "desk/%1#aaaa", label: "repo#one" })).ok).toBe(true);
    expect((await door.local(fields(), { kind: "terminal" })).ok).toBe(true);
    expect(seen).toEqual([
      { by: "agent", host: "desk", label: "repo#one", memberId: "desk", address: "desk/%1#aaaa" },
      { by: "terminal", host: "desk", label: null, memberId: "desk", address: null },
    ]);
  });

  test("a bad body never reaches the proposals, and a Collie without tricks says so", async () => {
    const { proposals, seen } = recorder();
    const door = new ProposeDoor({ mode: () => "solo", proposals: () => proposals, memberId: "desk", machine: "desk" });
    const bad = await door.local({ requestId: RID, files: [{ rel: "../x", b64: "eA==" }] }, { kind: "terminal" });
    expect(bad.ok).toBe(false);
    expect(seen).toEqual([]);
    const none = new ProposeDoor({ mode: () => "solo", proposals: () => null, memberId: "desk", machine: "desk" });
    expect(await none.local(fields(), { kind: "terminal" })).toEqual({ ok: false, code: "no_tricks", error: "Tricks are not set up on this Collie, so nothing was proposed." });
  });
});

describe("the member's forward", () => {
  function member(answer: CrewDialAnswer, over: Partial<ProposeDoorDeps> = {}) {
    const sent: { route: string; payload: string }[] = [];
    const door = new ProposeDoor({
      mode: () => "peer",
      proposals: () => null,
      memberId: "laptop",
      machine: "laptop",
      leadName: () => "desk",
      call: async (route, payload) => {
        sent.push({ route, payload });
        return answer;
      },
      ...over,
    });
    return { door, sent };
  }

  test("sends the checked files and the session's address, never a label", async () => {
    const { door, sent } = member({ kind: "answer", status: 200, body: { ok: true, kind: "proposal", id: "legs", hash: "h", decision: "dc_k3m9x2p7q1ab", replaced: null } });
    const answer = await door.local(fields(), { kind: "agent", address: "laptop/%3#cccc", label: "made-up label" });
    expect(answer).toEqual({ ok: true, kind: "proposal", id: "legs", hash: "h", decision: "dc_k3m9x2p7q1ab", replaced: null });
    expect(sent[0]?.route).toBe(CREW_TRICKS_PROPOSE_ROUTE);
    const body = parseJsonObject(sent[0]?.payload ?? "") ?? {};
    expect(Object.keys(body).toSorted()).toEqual(["files", "from", "requestId"]);
    expect(body.from).toEqual({ address: "laptop/%3#cccc" });
    expect(sent[0]?.payload).not.toContain("made-up label");
  });

  test("a lead away, an older lead and an unconfirmed send each have their words", async () => {
    expect(await member({ kind: "refused", reason: "connect" }).door.local(fields(), { kind: "terminal" })).toEqual({ ok: false, code: "lead_unreachable", error: PROPOSE_LEAD_AWAY });
    expect(await member({ kind: "answer", status: 404, body: null }).door.local(fields(), { kind: "terminal" })).toEqual({ ok: false, code: "not_on_lead", error: proposeLeadOlder("desk") });
    expect(await member({ kind: "unknown", reason: "timeout" }).door.local(fields(), { kind: "terminal" })).toEqual({ ok: false, code: "lead_unreachable", error: proposeNotConfirmed("desk", RID) });
    expect(PROPOSE_LEAD_AWAY).toBe("The lead is not answering, so nothing was proposed.");
    expect(proposeNotConfirmed("desk", RID)).toBe(`The lead (desk) did not confirm the proposal. Propose again with --request-id ${RID}: it is proposed once.`);
  });

  test("a lead's refusal keeps its code; a code it does not know is failed", async () => {
    expect(await member({ kind: "answer", status: 200, body: { ok: false, code: "rate", error: "slow down" } }).door.local(fields(), { kind: "terminal" })).toEqual({ ok: false, code: "rate", error: "slow down" });
    const odd = await member({ kind: "answer", status: 200, body: { ok: false, code: "nope", error: "x" } }).door.local(fields(), { kind: "terminal" });
    expect(odd.ok === false && odd.code).toBe("failed");
  });
});

describe("the lead's route", () => {
  function lead(live: HillPlace[] = []) {
    const { proposals, seen } = recorder();
    const door = new ProposeDoor({ mode: () => "lead", proposals: () => proposals, memberId: "desk", machine: "desk", place: (address) => live.find((p) => p.address.startsWith(address.split("#")[0] ?? "")) ?? null });
    return { door, seen };
  }

  test("the host is the signing member, the label is the lead's own word for the address", async () => {
    const { door, seen } = lead([place("laptop/%3#cccc", "repo#three")]);
    const res = await door.fromMember({ ...fields(), from: { address: "laptop/%3#cccc" } }, "laptop");
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ by: "agent", host: "laptop", label: "repo#three", memberId: "laptop", address: "laptop/%3#cccc" }]);
  });

  test("a session the lead does not list proposes without a label", async () => {
    const { door, seen } = lead();
    await door.fromMember({ ...fields(), from: { address: "laptop/%9#eeee" } }, "laptop");
    expect(seen[0]?.label).toBeNull();
  });

  test("an address of another machine is the uniform 401, before anything is read", async () => {
    const { door, seen } = lead([place("desk/%1#aaaa", "lead session")]);
    for (const address of ["desk/%1#aaaa", "mini/%2#bbbb", "local/%1"]) {
      expect((await door.fromMember({ ...fields(), from: { address } }, "laptop")).status).toBe(401);
    }
    expect(seen).toEqual([]);
  });

  test("a lead without tricks says so, and its member prints those words, never 'older'", async () => {
    const none = new ProposeDoor({ mode: () => "lead", proposals: () => null, memberId: "desk", machine: "desk" });
    const res = await none.fromMember({ ...fields(), from: null }, "laptop");
    expect(res).toEqual({ status: 200, body: { ok: false, code: "no_tricks", error: PROPOSE_LEAD_NO_TRICKS } });
    const member = new ProposeDoor({ mode: () => "peer", proposals: () => null, memberId: "laptop", machine: "laptop", leadName: () => "desk", call: async () => ({ kind: "answer", status: res.status, body: { ok: false, code: "no_tricks", error: PROPOSE_LEAD_NO_TRICKS } }) });
    expect(await member.local(fields(), { kind: "terminal" })).toEqual({ ok: false, code: "no_tricks", error: "Tricks are not set up on the lead, so nothing was proposed." });
  });

  test("an extra key, a bad from or a bad file is refused", async () => {
    const { door, seen } = lead();
    expect((await door.fromMember({ ...fields(), from: null, label: "x" }, "laptop")).status).toBe(400);
    expect((await door.fromMember({ ...fields(), from: "x" }, "laptop")).status).toBe(400);
    const bad = await door.fromMember({ requestId: RID, files: [{ rel: "/etc/passwd", b64: "eA==" }], from: null }, "laptop");
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, code: "bad_files" });
    expect(seen).toEqual([]);
  });
});

describe("the card", () => {
  const read = readProposal(fields());
  if (!read.ok) throw new Error(read.refusal.error);
  const input = {
    id: "legs",
    manifest: read.proposal.manifest,
    proposer: { by: "agent" as const, host: "laptop", label: "repo#one" },
    diff: {
      counted: true,
      files: [
        { rel: "program.ts", change: "added", plus: 1, minus: 0, hunk: ["+console.log(1)"] },
        { rel: "trick.toml", change: "added", plus: 4, minus: 0, hunk: MANIFEST.trim().split("\n").map((line) => `+${line}`) },
      ],
    } satisfies VersionDiff,
    warnings: [],
    crew: false,
  };

  test("names the trick by id, recommends nothing, and offers on or not now", () => {
    const card = proposalCard(input);
    if (card === null) throw new Error("no card");
    expect(card.title).toBe(proposalTitle("legs"));
    expect(card.title).toBe("Switch on the trick legs?");
    expect(card.recommends).toBeNull();
    expect(card.options).toEqual([{ ...PROPOSAL_ON }, { ...PROPOSAL_LATER }]);
    expect(card.text).toBe("none");
    expect(card.summary.startsWith("An agent session (repo#one) on laptop proposes it. It has 2 files.")).toBe(true);
    expect(JSON.stringify(card.view)).toContain(PROPOSAL_AUTHOR_WORDS);
  });

  test("a label with a control character or a direction mark cannot reshape the sentence", () => {
    expect(proposerSentence({ by: "agent", host: "lap‮top", label: "a\nb" })).toBe("An agent session (a b) on lap?top proposes it.");
    expect(proposerSentence({ by: "terminal", host: "laptop", label: null })).toBe("Someone on laptop proposes it. Collie could not confirm which session.");
    expect(proposerSentence({ by: "agent", host: "laptop", label: null })).toBe("An agent session on laptop proposes it.");
  });

  // Review F1: the facts the person decides on are never dropped for the author's words or for code.
  const texts = (view: readonly ViewNode[] | undefined): string => JSON.stringify(view ?? []);
  const ENVS = Array.from({ length: 32 }, (_, i) => `TOKEN_${String(i).padStart(2, "0")}_${"X".repeat(55)}`);
  const GLOBS = Array.from({ length: 8 }, (_, i) => `src${String(i)}/${"d".repeat(240)}/**/*.ts`);

  test("an about text of 30 paragraphs leaves the rights, the warnings and the code on the card, and is cut to 3 paragraphs", () => {
    const about = Array.from({ length: 30 }, (_, i) => `Paragraph ${String(i)} of the author's own story.`).join("\n\n");
    const card = proposalCard({ ...input, manifest: { ...input.manifest, env: ["GITHUB_TOKEN"], about }, warnings: ["network"] });
    if (card === null) throw new Error("no card");
    const words = texts(card.view);
    expect(words).toContain('"GITHUB_TOKEN"');
    expect(words).toContain(JSON.stringify(WARN_PLAIN.network));
    expect(card.view?.some((node) => node.kind === "diff")).toBe(true);
    const group = card.view?.find((node) => node.kind === "group");
    const kids = group !== undefined && "kids" in group ? (group.kids ?? []) : [];
    expect(kids.length).toBe(AUTHOR_PARAS_MAX);
    expect(JSON.stringify(kids.at(-1))).toContain('…"');
  });

  test("32 environment names of 64 characters and 8 long globs: every name and every glob shows in full", () => {
    const card = proposalCard({ ...input, manifest: { ...input.manifest, contract: 2, env: ENVS, inputs: GLOBS }, warnings: ["network", "spawn", "write", "model", "import"] });
    if (card === null) throw new Error("no card");
    const words = texts(card.view);
    for (const name of ENVS) expect(words).toContain(name);
    for (const glob of GLOBS) expect(words).toContain(glob);
    for (const text of Object.values(WARN_PLAIN)) expect(words).toContain(text);
    expect(words).toContain("It asks for: TOKEN_00_");
  });

  test("a card whose facts alone do not fit is no card: the proposal is refused in plain words", () => {
    const env = Array.from({ length: 200 }, (_, i) => `TOKEN_${String(i).padStart(3, "0")}_${"X".repeat(54)}`);
    expect(proposalCard({ ...input, manifest: { ...input.manifest, env } })).toBeNull();
    expect(PROPOSAL_TOO_LARGE).toBe("This trick asks for more than a card can show, so it was not proposed. Ask your person to add it on the machine.");
  });
});
