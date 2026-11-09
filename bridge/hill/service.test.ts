import { describe, expect, test } from "bun:test";

import type { AuditEntry } from "../audit.ts";
import type { HillAnswerRequest, HillPostInput, HillDecision } from "../../web/src/lib/hill/wire.ts";
import { memoryHillReceipts, type HillReceiptSurface } from "./receipts.ts";
import {
  answerMessage,
  BY_THE_POSTER,
  HILL_WALKY_OFF,
  HillService,
  messageTitle,
  mintDecisionId,
  NOT_ON_LEAD,
  TARGET_ENDED,
  type HillAgentSender,
  type HillCrewMode,
  type HillDelivery,
  type HillPlace,
  type HillPostAnswer,
  type HillTrickSender,
  type HillTrickTap,
} from "./service.ts";
import { HillStore } from "./store.ts";

const POSTER: HillAgentSender = { kind: "agent", address: "local/%1#aaaa", memberId: null, harness: "agent-x", label: "repo#one", host: "desk" };
const OTHER: HillAgentSender = { kind: "agent", address: "local/%2#bbbb", memberId: null, harness: "agent-y", label: "repo#two", host: "desk" };

const PLACES: HillPlace[] = [
  { address: "local/%1#aaaa", label: "repo#one", host: "desk", unattended: false },
  { address: "local/%2#bbbb", label: "repo#two", host: "desk", unattended: true },
];

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

interface Sent {
  readonly to: string;
  readonly body: string;
  readonly by: string;
}

/** A trick's sender for one decision key. */
function trickSender(trickKey = "ship", trickId = "nightly-leg"): HillTrickSender {
  return { kind: "trick", trickId, trickKey, label: "Nightly leg", host: "desk" };
}

interface Tapped {
  readonly host: string;
  readonly trickId: string;
  readonly tap: HillTrickTap;
}

interface Rig {
  readonly hill: HillService;
  readonly store: HillStore;
  readonly receipts: HillReceiptSurface;
  readonly sent: Sent[];
  readonly audit: AuditEntry[];
  live: HillPlace[];
  mode: HillCrewMode;
  walky: boolean;
  clock: number;
  delivery: HillDelivery | "throw";
  onSend?: (to: string) => void;
  /** Every tap the hill handed the tricks runner, in order. */
  readonly taps: Tapped[];
  /** What the trick's program makes of a tap. */
  tapResult: boolean | "throw";
  /** What happened, in order: "receipt", "closed", "send", "tap". */
  readonly events: string[];
}

function rig(receipts: HillReceiptSurface = memoryHillReceipts()): Rig {
  let n = 0;
  const store = new HillStore(null, () => state.clock);
  const state: Omit<Rig, "hill"> = {
    store,
    receipts,
    sent: [],
    audit: [],
    live: [...PLACES],
    mode: "solo",
    walky: true,
    clock: 1000,
    delivery: "typed",
    taps: [],
    tapResult: true,
    events: [],
  };
  const hill = new HillService({
    store,
    receipts,
    place: (address) => {
      const bare = address.split("#")[0];
      const hits = state.live.filter((place) => (address.includes("#") ? place.address === address : place.address.split("#")[0] === bare));
      return hits.length === 1 ? hits[0]! : null;
    },
    send: async (to, body, by) => {
      state.events.push("send");
      state.onSend?.(to);
      state.sent.push({ to, body, by });
      if (state.delivery === "throw") throw new Error("socket closed");
      return state.delivery;
    },
    crewMode: () => state.mode,
    walkyOn: () => state.walky,
    memberId: null,
    machine: "desk",
    now: () => state.clock,
    mintId: () => {
      n += 1;
      return `dc_test${String(n).padStart(8, "0")}`;
    },
    audit: (entry) => state.audit.push(entry),
    tap: async (host, trickId, tap) => {
      state.events.push("tap");
      state.taps.push({ host, trickId, tap });
      if (state.tapResult === "throw") throw new Error("runner gone");
      return state.tapResult;
    },
  });
  return Object.assign(state, { hill });
}

function input(n: number, over: Partial<HillPostInput> = {}): HillPostInput {
  return {
    requestId: uuid(n),
    title: "Ship the zoom fix in 1.28.1?",
    summary: "The pill moves out of Chat. The leg is green.",
    options: [
      { intent: "yes", label: "Yes, Edge first" },
      { intent: "no", label: "No, wait for 1.29.0" },
    ],
    recommends: { intent: "yes", why: "Edge users find it in a day." },
    ...over,
  };
}

function posted(answer: HillPostAnswer): HillDecision {
  if (!answer.ok) throw new Error(`refused: ${answer.code ?? "-"} ${answer.error}`);
  return answer.decision;
}

function refusal(answer: HillPostAnswer): string | null {
  if (answer.ok) throw new Error("posted");
  return answer.code;
}

function answerOf(decision: HillDecision, rid: number, intent: string, text: string | null = null): HillAnswerRequest {
  return { rid: uuid(rid), node: `hill/${decision.id}`, intent, value: { text } };
}

async function receiptOf(r: Rig, request: HillAnswerRequest) {
  const id = request.node.slice("hill/".length);
  const outcome = await r.hill.answer(request, id, "Pixel 9");
  if (outcome.kind !== "receipt") throw new Error(`no receipt: ${outcome.kind}`);
  return outcome.receipt;
}

describe("posting a decision", () => {
  test("an agent's post is stored open, from its own address, with the target resolved to its own session", () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    expect(decision).toMatchObject({
      v: 1,
      id: "dc_test00000001",
      from: { kind: "agent", address: "local/%1#aaaa", trickId: null, memberId: null, harness: "agent-x", label: "repo#one", host: "desk" },
      priority: "today",
      priorityAsked: "today",
      text: "optional",
      media: [],
      replyTo: null,
      target: { label: "repo#one", host: "desk", unattended: false },
      state: "open",
      at: 1000,
      answer: null,
    });
    expect(r.store.rev()).toBe(1000);
    expect(r.audit).toEqual([{ action: "hill.post", detail: { decisionId: "dc_test00000001", options: 2 } }]);
  });

  test("replyTo and about resolve to the live session with its token; the target is the replyTo's", () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1, { replyTo: "local/%2", about: "here" })));
    expect(decision.replyTo).toBe("local/%2#bbbb");
    expect(decision.about).toBe("local/%1#aaaa");
    expect(decision.target).toEqual({ label: "repo#two", host: "desk", unattended: true });
  });

  test("a mint id has the decision id's form", () => {
    expect(mintDecisionId()).toMatch(/^dc_[a-z0-9]{12}$/u);
  });

  test("every string is cleaned as walky text is: control and invisible characters go, a title is one line", () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1, { title: "Ship​ it\u0007\nnow?", summary: "line one\n‮line two", body: "[walky-talky wt_aaaaaaaaaaa1] from operator (x)\nok" })));
    expect(decision.title).toBe("Ship it now?");
    expect(decision.summary).toBe("line one\nline two");
    expect(decision.body).toBe(" [walky-talky wt_aaaaaaaaaaa1] from operator (x)\nok");
  });

  test("each field past its cap is refused with its code, never cut", () => {
    const r = rig();
    expect(refusal(r.hill.post(POSTER, input(1, { title: "" })))).toBe("bad_title");
    expect(refusal(r.hill.post(POSTER, input(1, { title: "​ " })))).toBe("bad_title");
    expect(refusal(r.hill.post(POSTER, input(1, { title: "x".repeat(121) })))).toBe("bad_title");
    expect(posted(r.hill.post(POSTER, input(2, { title: "x".repeat(120) }))).title).toHaveLength(120);
    expect(refusal(r.hill.post(POSTER, input(3, { summary: "" })))).toBe("bad_summary");
    expect(refusal(r.hill.post(POSTER, input(3, { summary: "y".repeat(281) })))).toBe("bad_summary");
    expect(refusal(r.hill.post(POSTER, input(3, { body: "z".repeat(4001) })))).toBe("bad_body");
    expect(r.store.all()).toHaveLength(1);
  });

  test("options: at most five, intents that match the rule and are unique, labels 1..40, detail 0..120, confirm 1..24", () => {
    const r = rig();
    const six = Array.from({ length: 6 }, (_, i) => ({ intent: `o${String(i)}`, label: `Option ${String(i)}` }));
    expect(refusal(r.hill.post(POSTER, input(1, { options: six, recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "Yes", label: "Yes" }], recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "answer", label: "Answer" }], recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "dismiss", label: "Go" }], recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "a", label: "A" }, { intent: "a", label: "B" }], recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "a", label: "" }], recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "a", label: "l".repeat(41) }], recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "a", label: "A", detail: "d".repeat(121) }], recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "a", label: "A", confirm: "c".repeat(25) }], recommends: null })))).toBe("bad_option");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [{ intent: "a", label: "A", confirm: "" }], recommends: null })))).toBe("bad_option");
    const fine = posted(r.hill.post(POSTER, input(2, { options: [{ intent: "ship-it", label: "Ship", detail: "", confirm: "Tap again" }], recommends: null })));
    expect(fine.options).toEqual([{ intent: "ship-it", label: "Ship", confirm: "Tap again" }]);
  });

  test("a recommendation names an option and carries a why of 1..200", () => {
    const r = rig();
    expect(refusal(r.hill.post(POSTER, input(1, { recommends: { intent: "maybe", why: "x" } })))).toBe("bad_recommends");
    expect(refusal(r.hill.post(POSTER, input(1, { recommends: { intent: "yes", why: "" } })))).toBe("bad_recommends");
    expect(refusal(r.hill.post(POSTER, input(1, { recommends: { intent: "yes", why: "w".repeat(201) } })))).toBe("bad_recommends");
    expect(refusal(r.hill.post(POSTER, input(1, { options: [], recommends: { intent: "yes", why: "x" } })))).toBe("bad_recommends");
  });

  test("links: at most five, http or https only, an address of at most 500, a label of 1..40", () => {
    const r = rig();
    const link = (href: string, label = "Leg report") => input(1, { links: [{ label, href }] });
    expect(refusal(r.hill.post(POSTER, link("javascript:alert(1)")))).toBe("bad_link");
    expect(refusal(r.hill.post(POSTER, link("ftp://example.com/x")))).toBe("bad_link");
    expect(refusal(r.hill.post(POSTER, link("file:///etc/passwd")))).toBe("bad_link");
    expect(refusal(r.hill.post(POSTER, link("https://example.com/a b")))).toBe("bad_link");
    expect(refusal(r.hill.post(POSTER, link(`https://example.com/${"p".repeat(490)}`)))).toBe("bad_link");
    expect(refusal(r.hill.post(POSTER, link("https://example.com", "")))).toBe("bad_link");
    const six = Array.from({ length: 6 }, () => ({ label: "L", href: "https://example.com" }));
    expect(refusal(r.hill.post(POSTER, input(1, { links: six })))).toBe("bad_link");
    expect(posted(r.hill.post(POSTER, link("https://example.com/leg"))).links).toEqual([{ label: "Leg report", href: "https://example.com/leg" }]);
  });

  test("text none with zero options is refused", () => {
    const r = rig();
    expect(refusal(r.hill.post(POSTER, input(1, { options: [], recommends: null, text: "none" })))).toBe("bad_text_mode");
    expect(posted(r.hill.post(POSTER, input(2, { options: [], recommends: null, text: "required" }))).text).toBe("required");
  });

  test("replyTo or about that is not a live walky address is refused bad_target", () => {
    const r = rig();
    expect(refusal(r.hill.post(POSTER, input(1, { replyTo: "local/%9" })))).toBe("bad_target");
    expect(refusal(r.hill.post(POSTER, input(1, { replyTo: "local/%2#zzzz" })))).toBe("bad_target");
    expect(refusal(r.hill.post(POSTER, input(1, { replyTo: "all" })))).toBe("bad_target");
    expect(refusal(r.hill.post(POSTER, input(1, { about: "local/%9" })))).toBe("bad_target");
  });

  test("an expiry in the past is refused; one in the future is kept", () => {
    const r = rig();
    const past = r.hill.post(POSTER, input(1, { expiresAt: 999 }));
    expect(past).toEqual({ ok: false, code: null, error: "bad request: the expiry is in the past" });
    expect(posted(r.hill.post(POSTER, input(2, { expiresAt: 5000 }))).expiresAt).toBe(5000);
  });

  test("a crew member refuses with not_on_lead; a lead and a solo install take the post", () => {
    const r = rig();
    r.mode = "peer";
    expect(r.hill.post(POSTER, input(1))).toEqual({ ok: false, code: "not_on_lead", error: NOT_ON_LEAD });
    r.mode = "lead";
    expect(posted(r.hill.post(POSTER, input(1))).state).toBe("open");
  });

  test("WalkyTalky off refuses with walky_off", () => {
    const r = rig();
    r.walky = false;
    expect(r.hill.post(POSTER, input(1))).toEqual({ ok: false, code: "walky_off", error: HILL_WALKY_OFF });
  });

  test("a repeated request id from the same sender returns the stored decision; another sender's is its own", () => {
    const r = rig();
    const first = posted(r.hill.post(POSTER, input(1)));
    r.clock = 2000;
    expect(posted(r.hill.post(POSTER, input(1, { title: "Changed?" })))).toEqual(first);
    const theirs = posted(r.hill.post(OTHER, input(1)));
    expect(theirs.id).not.toBe(first.id);
    expect(r.store.all()).toHaveLength(2);
  });

  test("a sender's 4th open `now` is shown as `today`, asked `now`", () => {
    const r = rig();
    for (let n = 1; n <= 3; n += 1) expect(posted(r.hill.post(POSTER, input(n, { priority: "now" }))).priority).toBe("now");
    const fourth = posted(r.hill.post(POSTER, input(4, { priority: "now" })));
    expect(fourth.priority).toBe("today");
    expect(fourth.priorityAsked).toBe("now");
    // Another sender has its own three.
    expect(posted(r.hill.post(OTHER, input(5, { priority: "now" }))).priority).toBe("now");
  });

  test("the 21st open decision of one sender is refused too_many_open; a supersede at the cap is not", () => {
    const r = rig();
    const held = Array.from({ length: 20 }, (_, i) => posted(r.hill.post(POSTER, input(i + 1))));
    expect(refusal(r.hill.post(POSTER, input(21)))).toBe("too_many_open");
    expect(posted(r.hill.post(OTHER, input(22))).state).toBe("open");
    expect(posted(r.hill.post(POSTER, input(23, { supersedes: held[0]!.id }))).supersedes).toBe(held[0]!.id);
  });

  test("supersede: the sender's own open decision closes `superseded`, pointing at the new one", () => {
    const r = rig();
    const old = posted(r.hill.post(POSTER, input(1)));
    r.clock = 2000;
    const next = posted(r.hill.post(POSTER, input(2, { supersedes: old.id })));
    expect(r.store.get(old.id)).toMatchObject({ state: "superseded", supersededBy: next.id, closedAt: 2000 });
    expect(next.supersedes).toBe(old.id);
  });

  test("supersede: another sender's decision, a closed one or an unknown id is refused bad_supersedes", () => {
    const r = rig();
    const mine = posted(r.hill.post(POSTER, input(1)));
    expect(refusal(r.hill.post(OTHER, input(2, { supersedes: mine.id })))).toBe("bad_supersedes");
    expect(refusal(r.hill.post(POSTER, input(3, { supersedes: "dc_nonexistent1" })))).toBe("bad_supersedes");
    r.hill.withdraw(POSTER, mine.id);
    expect(refusal(r.hill.post(POSTER, input(4, { supersedes: mine.id })))).toBe("bad_supersedes");
  });

  test("a trick posts through postDecision with no address; with no replyTo it has no target", () => {
    const r = rig();
    const decision = posted(r.hill.postDecision(trickSender(), input(1)));
    expect(decision.from).toEqual({ kind: "trick", address: null, trickId: "nightly-leg", trickKey: "ship", memberId: null, harness: null, label: "Nightly leg", host: "desk" });
    expect(decision.target).toBeNull();
  });

  test("a trick is one sender: its keys share the 20-open cap, and the runner withdraws with its own reason", () => {
    const r = rig();
    for (let n = 1; n <= 20; n += 1) posted(r.hill.postDecision(trickSender(`k${String(n)}`), input(n)));
    expect(refusal(r.hill.postDecision(trickSender("k21"), input(21)))).toBe("too_many_open");
    const first = r.hill.mineList(trickSender("any"))[0]!;
    expect(r.hill.withdraw(trickSender(), first.id, "the trick is off")).toMatchObject({ ok: true, decision: { state: "withdrawn", closedReason: "the trick is off" } });
  });
});

describe("status, withdraw and list", () => {
  test("only the poster sees its decisions; another sender's id answers as not found", () => {
    const r = rig();
    const mine = posted(r.hill.post(POSTER, input(1)));
    expect(r.hill.status(POSTER, mine.id)).toEqual({ ok: true, decision: mine });
    expect(r.hill.status(OTHER, mine.id)).toEqual({ ok: false, missing: true, error: `no decision ${mine.id} from this session` });
    expect(r.hill.withdraw(OTHER, mine.id)).toMatchObject({ ok: false, missing: true });
    expect(r.hill.mineList(OTHER)).toEqual([]);
  });

  test("withdraw closes it `withdrawn`, by the poster, once", () => {
    const r = rig();
    const mine = posted(r.hill.post(POSTER, input(1)));
    r.clock = 3000;
    expect(r.hill.withdraw(POSTER, mine.id)).toMatchObject({ ok: true, decision: { state: "withdrawn", closedAt: 3000, closedReason: BY_THE_POSTER } });
    expect(r.hill.withdraw(POSTER, mine.id)).toEqual({ ok: false, missing: false, error: `${mine.id} is withdrawn, nothing to withdraw` });
    expect(r.audit.at(-1)).toEqual({ action: "hill.withdraw", detail: { decisionId: mine.id } });
  });

  test("list: the caller's own, open first in the phone's order, then closed newest first", () => {
    const r = rig();
    const later = posted(r.hill.post(POSTER, input(1, { priority: "later" })));
    r.clock = 1100;
    const now = posted(r.hill.post(POSTER, input(2, { priority: "now" })));
    r.clock = 1200;
    const gone = posted(r.hill.post(POSTER, input(3)));
    r.hill.withdraw(POSTER, gone.id);
    posted(r.hill.post(OTHER, input(4)));
    expect(r.hill.mineList(POSTER).map((held) => held.id)).toEqual([now.id, later.id, gone.id]);
  });
});

describe("expiry", () => {
  test("sweep closes open decisions past expiresAt as `expired`, and nothing before", () => {
    const r = rig();
    const soon = posted(r.hill.post(POSTER, input(1, { expiresAt: 2000 })));
    const never = posted(r.hill.post(POSTER, input(2)));
    expect(r.hill.sweep(1999)).toBe(0);
    const rev = r.store.rev();
    expect(r.hill.sweep(2000)).toBe(1);
    expect(r.store.get(soon.id)).toMatchObject({ state: "expired", closedAt: 2000, closedReason: "expired" });
    expect(r.store.get(never.id)?.state).toBe("open");
    expect(r.store.rev()).not.toBe(rev);
    expect(r.hill.sweep(9000)).toBe(0);
  });
});

describe("the answer message", () => {
  test("option and text, option only, text only, dismiss", () => {
    const d = { id: "dc_k3m9x2p7q1ab", title: "Ship the zoom fix in 1.28.1?" };
    expect(answerMessage(d, "yes", "Yes, Edge first", "Not before the browser leg is green.")).toBe(
      'Answer to dc_k3m9x2p7q1ab "Ship the zoom fix in 1.28.1?"\nOption: yes (Yes, Edge first)\nNot before the browser leg is green.',
    );
    expect(answerMessage(d, "yes", "Yes, Edge first", null)).toBe('Answer to dc_k3m9x2p7q1ab "Ship the zoom fix in 1.28.1?"\nOption: yes (Yes, Edge first)');
    expect(answerMessage(d, "answer", null, "Wait.")).toBe('Answer to dc_k3m9x2p7q1ab "Ship the zoom fix in 1.28.1?"\nWait.');
    expect(answerMessage(d, "dismiss", null, null)).toBe('Answer to dc_k3m9x2p7q1ab "Ship the zoom fix in 1.28.1?"\nDismissed.');
  });

  test("the title is cut to 80 characters with an ellipsis", () => {
    expect(messageTitle("t".repeat(80))).toBe("t".repeat(80));
    const cut = messageTitle("t".repeat(81));
    expect([...cut]).toHaveLength(80);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("answering a decision: the receipt rules", () => {
  test("ok: the receipt, the close and the walky message to the poster, with the contract's exact body", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    r.clock = 5000;
    const receipt = await receiptOf(r, answerOf(decision, 100, "yes", "Not before the browser leg is green."));
    expect(receipt).toEqual({ rid: uuid(100), code: "ok", reason: null, state: "answered", delivery: "typed", trick: "none", at: 5000 });
    expect(r.sent).toEqual([
      {
        to: "local/%1#aaaa",
        body: 'Answer to dc_test00000001 "Ship the zoom fix in 1.28.1?"\nOption: yes (Yes, Edge first)\nNot before the browser leg is green.',
        by: "Pixel 9",
      },
    ]);
    expect(r.store.get(decision.id)).toMatchObject({
      state: "answered",
      closedAt: 5000,
      answer: { rid: uuid(100), intent: "yes", label: "Yes, Edge first", text: "Not before the browser leg is green.", by: "Pixel 9", at: 5000, delivery: "typed", trick: "none" },
    });
    expect(r.receipts.get(uuid(100))?.receipt).toEqual(receipt);
    // The audit line names the decision, the intent and the length, never the text.
    const line = r.audit.find((entry) => entry.action === "hill.answer");
    expect(line).toEqual({ action: "hill.answer", device: "Pixel 9", detail: { decisionId: decision.id, intent: "yes", textLength: 36, receiptCode: "ok", delivery: "typed", trick: "none" } });
    expect(JSON.stringify(r.audit)).not.toContain("browser leg");
  });

  test("the answer goes to replyTo when set, never to the poster as well", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1, { replyTo: "local/%2" })));
    await receiptOf(r, answerOf(decision, 100, "no"));
    expect(r.sent.map((sent) => sent.to)).toEqual(["local/%2#bbbb"]);
  });

  test("order: the receipt is written and the decision closed before the send starts", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    const seen: unknown[] = [];
    r.onSend = () => seen.push([r.receipts.get(uuid(100))?.receipt.code, r.store.get(decision.id)?.state]);
    await receiptOf(r, answerOf(decision, 100, "yes"));
    expect(seen).toEqual([["ok", "answered"]]);
  });

  test("a send that throws still leaves the decision answered, with delivery unknown, and nothing is sent again", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    r.delivery = "throw";
    const receipt = await receiptOf(r, answerOf(decision, 100, "yes"));
    expect(receipt).toMatchObject({ code: "ok", state: "answered", delivery: "unknown" });
    expect(r.store.get(decision.id)).toMatchObject({ state: "answered", answer: { delivery: "unknown" } });
    expect(await receiptOf(r, answerOf(decision, 100, "yes"))).toEqual(receipt);
    expect(r.sent).toHaveLength(1);
  });

  test("a held send reports held", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    r.delivery = "held";
    expect(await receiptOf(r, answerOf(decision, 100, "yes"))).toMatchObject({ delivery: "held" });
    expect(r.store.get(decision.id)?.answer?.delivery).toBe("held");
  });

  test("dismiss sends the two-line message and closes `dismissed`", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    expect(await receiptOf(r, answerOf(decision, 100, "dismiss"))).toMatchObject({ code: "ok", state: "dismissed" });
    expect(r.sent[0]!.body).toBe('Answer to dc_test00000001 "Ship the zoom fix in 1.28.1?"\nDismissed.');
  });

  test("text only: `answer` with text, no Option line", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    await receiptOf(r, answerOf(decision, 100, "answer", "Neither: wait a day."));
    expect(r.sent[0]!.body).toBe('Answer to dc_test00000001 "Ship the zoom fix in 1.28.1?"\nNeither: wait a day.');
  });

  test("gone: no such decision, and a decision already answered", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    expect(await receiptOf(r, { rid: uuid(1), node: "hill/dc_nonexistent1", intent: "yes", value: { text: null } })).toMatchObject({ code: "gone", reason: "no such decision", state: null });
    await receiptOf(r, answerOf(decision, 2, "yes"));
    expect(await receiptOf(r, answerOf(decision, 3, "no"))).toMatchObject({ code: "gone", reason: "the decision is answered", state: "answered", delivery: null });
    expect(r.sent).toHaveLength(1);
  });

  test("rejected: an intent that is not an option, and each text rule", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    const required = posted(r.hill.post(POSTER, input(2, { text: "required" })));
    const none = posted(r.hill.post(POSTER, input(3, { text: "none" })));
    expect(await receiptOf(r, answerOf(decision, 10, "maybe"))).toMatchObject({ code: "rejected", reason: "not an option of this decision", state: "open" });
    expect(await receiptOf(r, answerOf(required, 11, "yes"))).toMatchObject({ code: "rejected", reason: "text is required" });
    expect(await receiptOf(r, answerOf(required, 12, "yes", "  \n "))).toMatchObject({ code: "rejected", reason: "text is required" });
    expect(await receiptOf(r, answerOf(none, 13, "yes", "why not"))).toMatchObject({ code: "rejected", reason: "this decision takes no text" });
    expect(await receiptOf(r, answerOf(none, 14, "answer", "words"))).toMatchObject({ code: "rejected", reason: "this decision takes no text" });
    expect(await receiptOf(r, answerOf(decision, 15, "answer", ""))).toMatchObject({ code: "rejected", reason: "text is required" });
    expect(await receiptOf(r, answerOf(decision, 16, "dismiss", "bye"))).toMatchObject({ code: "rejected", reason: "a dismiss carries no text" });
    expect(await receiptOf(r, answerOf(decision, 17, "yes", "x".repeat(4001)))).toMatchObject({ code: "rejected", reason: "text is longer than 4000 characters" });
    expect(r.sent).toEqual([]);
    expect(r.store.all().every((held) => held.state === "open")).toBe(true);
  });

  test("target gone: the receipt says target session ended, the decision closes undeliverable, nothing is typed", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    // A new session took the pane id: the token no longer matches.
    r.live = [{ ...PLACES[0]!, address: "local/%1#cccc" }, PLACES[1]!];
    expect(await receiptOf(r, answerOf(decision, 100, "yes", "go"))).toMatchObject({ code: "gone", reason: TARGET_ENDED, state: "undeliverable", delivery: null });
    expect(r.store.get(decision.id)).toMatchObject({ state: "undeliverable", closedReason: TARGET_ENDED, answer: null });
    expect(r.sent).toEqual([]);
  });

  test("a known rid with the same payload returns its receipt and runs nothing; with another payload it is refused", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    const first = await receiptOf(r, answerOf(decision, 100, "yes", "go"));
    r.clock = 9000;
    expect(await receiptOf(r, answerOf(decision, 100, "yes", "go"))).toEqual(first);
    expect(await r.hill.answer(answerOf(decision, 100, "no", "go"), decision.id, "Pixel 9")).toEqual({ kind: "reused" });
    expect(await r.hill.answer(answerOf(decision, 100, "yes", "other words"), decision.id, "Pixel 9")).toEqual({ kind: "reused" });
    expect(r.sent).toHaveLength(1);
  });

  test("a rejected receipt is stored too: the same rid replays it", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    const rejected = await receiptOf(r, answerOf(decision, 100, "maybe"));
    expect(await receiptOf(r, answerOf(decision, 100, "maybe"))).toEqual(rejected);
  });

  test("two taps with one rid at once send once; two rids at once on one decision answer it once", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    const [a, b] = await Promise.all([receiptOf(r, answerOf(decision, 100, "yes")), receiptOf(r, answerOf(decision, 100, "yes"))]);
    expect(a).toEqual(b);
    expect(r.sent).toHaveLength(1);
    const other = posted(r.hill.post(POSTER, input(2)));
    const [x, y] = await Promise.all([receiptOf(r, answerOf(other, 200, "yes")), receiptOf(r, answerOf(other, 201, "no"))]);
    expect([x.code, y.code]).toEqual(["ok", "gone"]);
    expect(r.sent).toHaveLength(2);
  });

  test("a first receipt that cannot be written closes nothing and types nothing", async () => {
    const base = memoryHillReceipts();
    const r = rig({ ...base, recordFirst: async () => false });
    const decision = posted(r.hill.post(POSTER, input(1)));
    expect(await r.hill.answer(answerOf(decision, 100, "yes"), decision.id, "Pixel 9")).toEqual({ kind: "unsaved" });
    expect(r.store.get(decision.id)?.state).toBe("open");
    expect(r.sent).toEqual([]);
  });

  test("a trick's decision with no target closes with delivery none, types nothing, and the dismiss reaches the trick as a tap", async () => {
    const r = rig();
    const decision = posted(r.hill.postDecision(trickSender("t1-key", "t1"), input(1)));
    expect(await receiptOf(r, answerOf(decision, 100, "dismiss"))).toMatchObject({ code: "ok", state: "dismissed", delivery: "none", trick: "ran" });
    expect(r.store.get(decision.id)?.answer).toMatchObject({ delivery: "none", trick: "ran" });
    expect(r.sent).toEqual([]);
    expect(r.taps).toEqual([{ host: "desk", trickId: "t1", tap: { rid: uuid(100), node: "hill/t1-key", intent: "dismiss", value: { text: null } } }]);
  });

  test("an agent's decision runs no tap: trick none", async () => {
    const r = rig();
    const decision = posted(r.hill.post(POSTER, input(1)));
    expect(await receiptOf(r, answerOf(decision, 100, "yes"))).toMatchObject({ code: "ok", delivery: "typed", trick: "none" });
    expect(r.taps).toEqual([]);
  });

  test("a withdrawn or expired decision answers gone with its state", async () => {
    const r = rig();
    const withdrawn = posted(r.hill.post(POSTER, input(1)));
    r.hill.withdraw(POSTER, withdrawn.id);
    expect(await receiptOf(r, answerOf(withdrawn, 100, "yes"))).toMatchObject({ code: "gone", state: "withdrawn" });
    const expiring = posted(r.hill.post(POSTER, input(2, { expiresAt: 1500 })));
    r.hill.sweep(1500);
    expect(await receiptOf(r, answerOf(expiring, 101, "yes"))).toMatchObject({ code: "gone", state: "expired" });
  });
});

describe("answering a trick's decision (M94)", () => {
  test("with replyTo: the receipt and the close first, then the walky message, then the tap, all on one rid", async () => {
    const r = rig();
    const decision = posted(r.hill.postDecision(trickSender(), input(1, { replyTo: "local/%2#bbbb" })));
    expect(decision.target).toEqual({ label: "repo#two", host: "desk", unattended: true });
    const seen: string[] = [];
    r.onSend = () => {
      seen.push(`send: receipt ${r.receipts.get(uuid(100)) === undefined ? "missing" : "written"}, ${r.store.get(decision.id)?.state ?? "-"}`);
    };
    r.clock = 5000;
    const receipt = await receiptOf(r, answerOf(decision, 100, "yes", "after the leg"));
    expect(seen).toEqual(["send: receipt written, answered"]);
    expect(r.events).toEqual(["send", "tap"]);
    expect(r.sent.map((sent) => sent.to)).toEqual(["local/%2#bbbb"]);
    expect(r.taps).toEqual([{ host: "desk", trickId: "nightly-leg", tap: { rid: uuid(100), node: "hill/ship", intent: "yes", value: { text: "after the leg" } } }]);
    expect(receipt).toEqual({ rid: uuid(100), code: "ok", reason: null, state: "answered", delivery: "typed", trick: "ran", at: 5000 });
    expect(r.store.get(decision.id)?.answer).toMatchObject({ rid: uuid(100), delivery: "typed", trick: "ran" });
    expect(r.receipts.get(uuid(100))?.receipt).toEqual(receipt);
    expect(r.audit.at(-1)).toMatchObject({ action: "hill.answer", detail: { delivery: "typed", trick: "ran" } });
  });

  test("without replyTo: no walky message, the tap alone, with the same rid", async () => {
    const r = rig();
    const decision = posted(r.hill.postDecision(trickSender(), input(1)));
    expect(await receiptOf(r, answerOf(decision, 100, "no"))).toMatchObject({ code: "ok", state: "answered", delivery: "none", trick: "ran" });
    expect(r.events).toEqual(["tap"]);
    expect(r.taps[0]?.tap).toEqual({ rid: uuid(100), node: "hill/ship", intent: "no", value: { text: null } });
  });

  test("a replyTo target that ended answers gone, closes undeliverable, and runs no tap", async () => {
    const r = rig();
    const decision = posted(r.hill.postDecision(trickSender(), input(1, { replyTo: "local/%2#bbbb" })));
    r.live = r.live.filter((place) => place.address !== "local/%2#bbbb");
    expect(await receiptOf(r, answerOf(decision, 100, "yes"))).toMatchObject({ code: "gone", reason: TARGET_ENDED, state: "undeliverable", delivery: null, trick: null });
    expect(r.store.get(decision.id)).toMatchObject({ state: "undeliverable", answer: null });
    expect(r.events).toEqual([]);
  });

  test("a tap the program fails is trick failed; the decision stays answered and nothing retries", async () => {
    const r = rig();
    r.tapResult = false;
    const decision = posted(r.hill.postDecision(trickSender(), input(1)));
    const request = answerOf(decision, 100, "yes");
    expect(await receiptOf(r, request)).toMatchObject({ code: "ok", state: "answered", trick: "failed" });
    expect(r.store.get(decision.id)).toMatchObject({ state: "answered", answer: { trick: "failed" } });
    // The same rid answers the stored receipt and runs nothing again.
    expect(await receiptOf(r, request)).toMatchObject({ trick: "failed" });
    expect(r.taps).toHaveLength(1);
  });

  test("a tap that throws is trick failed too", async () => {
    const r = rig();
    r.tapResult = "throw";
    const decision = posted(r.hill.postDecision(trickSender(), input(1)));
    expect(await receiptOf(r, answerOf(decision, 100, "yes"))).toMatchObject({ code: "ok", trick: "failed" });
  });

  test("the first receipt reads trick failed until the tap ran, so a bridge that stops in between says so", async () => {
    const r = rig();
    const decision = posted(r.hill.postDecision(trickSender(), input(1)));
    let during: string | undefined;
    r.tapResult = true;
    const original = r.taps.push.bind(r.taps);
    r.taps.push = (...items: Tapped[]) => {
      during = r.receipts.get(uuid(100))?.receipt.trick ?? "missing";
      return original(...items);
    };
    await receiptOf(r, answerOf(decision, 100, "yes"));
    expect(during).toBe("failed");
  });
});
