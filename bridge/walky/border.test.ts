import { describe, expect, test } from "bun:test";

import { borderVerdict, NO_SPACE, OUTSIDE_YOUR_SPACE, type BorderInput, type BorderParent, type BorderTarget } from "./border.ts";
import { spaceOf, type WalkySpace } from "./space.ts";
import { isPrintableAscii, RECEIPT_REASON_MAX } from "./types.ts";

// The border's rule, row by row (M98 spec 03). Two members, `desk` and `laptop`. A named space `api`
// joins across them; an unnamed space is one machine's.

const API_DESK = spaceOf({ memberId: "desk", spaceId: "w1", spaceLabel: "api" });
const API_LAPTOP = spaceOf({ memberId: "laptop", spaceId: "w7", spaceLabel: "api" });
const WEB = spaceOf({ memberId: "desk", spaceId: "w2", spaceLabel: "web" });
const UNNAMED_DESK = spaceOf({ memberId: "desk", spaceId: "w3", spaceLabel: "w3" });
const UNNAMED_LAPTOP = spaceOf({ memberId: "laptop", spaceId: "w3", spaceLabel: "w3" });

/** The target pane `desk/w1:p2`, on this bridge, in `space`. */
function target(space: WalkySpace | null, over: Partial<BorderTarget> = {}): BorderTarget {
  return { address: "desk/w1:p2", space, pane: { session: "main", paneId: "w1:p2", instance: "bbbb" }, instance: "bbbb", ...over };
}

/** An agent's message from `laptop/w7:p1` in `space`. */
function input(space: WalkySpace | null | undefined, over: Partial<BorderInput> = {}, message: Partial<BorderInput["message"]> = {}): BorderInput {
  const from = space === undefined ? { address: "laptop/w7:p1#aaaa" } : { address: "laptop/w7:p1#aaaa", space };
  return {
    message: { kind: "agent", replyTo: null, from, ...message },
    sender: "laptop/w7:p1#aaaa",
    target: target(API_DESK),
    replyParent: null,
    signerVersion: "current",
    ...over,
  };
}

/** The parent of a reply as the target's bridge logged it: sent by `desk/w1:p2`, to `laptop/w7:p1`. */
function parent(over: Partial<BorderParent> = {}): BorderParent {
  return { from: "desk/w1:p2#bbbb", sender: { session: "main", paneId: "w1:p2", instance: "bbbb" }, targets: ["laptop/w7:p1"], to: "laptop/w7:p1#aaaa", ...over };
}

describe("the rule, row by row", () => {
  test("1. the operator's message passes as `operator`, whatever its space", () => {
    expect(borderVerdict(input(null, {}, { kind: "operator", from: { address: null, space: null } }))).toEqual({ via: "operator" });
    expect(borderVerdict(input(null, { target: target(WEB) }, { kind: "operator", from: { address: null } }))).toEqual({ via: "operator" });
  });

  test("1. an agent cannot claim the operator's kind: a message that names a pane is an agent's", () => {
    // The shape check refuses this on a crew hop (an operator names no address); the border does not lean on it.
    expect(borderVerdict(input(WEB, {}, { kind: "operator" }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
  });

  test("2. the outside flag passes as `outside`, across any space", () => {
    expect(borderVerdict(input(WEB, {}, { outside: true }))).toEqual({ via: "outside" });
    expect(borderVerdict(input(UNNAMED_LAPTOP, { target: target(UNNAMED_DESK) }, { outside: true }))).toEqual({ via: "outside" });
  });

  test("3. the same space passes as `in`: a named space joins across machines", () => {
    expect(borderVerdict(input(API_LAPTOP))).toEqual({ via: "in" });
    expect(borderVerdict(input(UNNAMED_DESK, { target: target(UNNAMED_DESK) }))).toEqual({ via: "in" });
  });

  test("3. two unnamed spaces of the same id on two machines are two spaces", () => {
    expect(UNNAMED_DESK.label).toBe(UNNAMED_LAPTOP.label);
    expect(borderVerdict(input(UNNAMED_LAPTOP, { target: target(UNNAMED_DESK) }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
  });

  test("4. a reply to a message the target pane sent to the replier passes as `reply`", () => {
    expect(borderVerdict(input(WEB, { replyParent: parent() }, { replyTo: "wt_parent000001" }))).toEqual({ via: "reply" });
  });

  test("4. a reply to a message the target did NOT send is refused", () => {
    const reply = (p: BorderParent) => borderVerdict(input(WEB, { replyParent: p }, { replyTo: "wt_parent000001" }));
    // Sent by another pane of the target's machine.
    expect(reply(parent({ from: "desk/w1:p9#cccc", sender: { session: "main", paneId: "w1:p9", instance: "cccc" } }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
    // Sent by an earlier session in the same pane id (another instance).
    expect(reply(parent({ sender: { session: "main", paneId: "w1:p2", instance: "zzzz" } }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
    // Logged here with no pane it was taken from: it came from elsewhere, though it names the target.
    expect(reply(parent({ sender: null }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
    // The operator's message: no pane sent it.
    expect(reply(parent({ from: null }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
  });

  test("4. a reply to a message the target sent to someone else is refused: knowing the id is not enough", () => {
    const p = parent({ targets: ["desk/w1:p5"], to: "desk/w1:p5" });
    expect(borderVerdict(input(WEB, { replyParent: p }, { replyTo: "wt_parent000001" }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
  });

  test("4. a parent sent to every pane, or to the replier's machine, counts as sent to the replier", () => {
    for (const to of ["all", "laptop/all"]) {
      expect(borderVerdict(input(WEB, { replyParent: parent({ targets: [to], to }) }, { replyTo: "wt_parent000001" }))).toEqual({ via: "reply" });
    }
    expect(borderVerdict(input(WEB, { replyParent: parent({ targets: ["other/all"], to: "other/all" }) }, { replyTo: "wt_parent000001" }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
  });

  test("4. no parent in this bridge's log, or no `replyTo`, is no reply", () => {
    expect(borderVerdict(input(WEB, {}, { replyTo: "wt_parent000001" }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
    expect(borderVerdict(input(WEB, { replyParent: parent() }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
  });

  test("4. a lead checking a pane of an older member compares the instance tokens it knows", () => {
    const far = target(WEB, { pane: null, instance: "bbbb" });
    const p = parent({ sender: null });
    expect(borderVerdict(input(API_LAPTOP, { target: far, replyParent: p }, { replyTo: "wt_parent000001" }))).toEqual({ via: "reply" });
    expect(borderVerdict(input(API_LAPTOP, { target: { ...far, instance: "zzzz" }, replyParent: p }, { replyTo: "wt_parent000001" }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
    // A target space nobody knows: rule 3 never holds, rule 4 still can.
    expect(borderVerdict(input(API_LAPTOP, { target: { ...far, space: null } }))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
    expect(borderVerdict(input(API_LAPTOP, { target: { ...far, space: null }, replyParent: p }, { replyTo: "wt_parent000001" }))).toEqual({ via: "reply" });
  });

  test("5. no space from a signer below 1.29.0 passes as `legacy`; from any other it is a bad request", () => {
    expect(borderVerdict(input(undefined, { signerVersion: "older", target: target(WEB) }))).toEqual({ via: "legacy" });
    expect(borderVerdict(input(null, { signerVersion: "older", target: target(WEB) }))).toEqual({ via: "legacy" });
    expect(borderVerdict(input(undefined))).toEqual({ refuse: NO_SPACE });
    // The bad request holds whatever else the message says.
    expect(borderVerdict(input(undefined, {}, { outside: true }))).toEqual({ refuse: NO_SPACE });
  });

  test("6. anything else is refused `outside your space`", () => {
    expect(borderVerdict(input(WEB))).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
  });

  test("the reasons are printable ASCII of at most 120 characters", () => {
    for (const reason of [OUTSIDE_YOUR_SPACE, NO_SPACE]) {
      expect(isPrintableAscii(reason)).toBe(true);
      expect(reason.length).toBeLessThanOrEqual(RECEIPT_REASON_MAX);
    }
  });
});

describe("a reply chain across the border, four hops", () => {
  // T on desk in `web`, S on laptop in `api`. Each bridge checks the reply aimed at its own pane against
  // its own log: the message its pane sent, logged with the pane it was taken from and its target.
  const T = { address: "desk/w2:p1", token: "tttt", place: { session: "main", paneId: "w2:p1", instance: "tttt" }, space: WEB };
  const S = { address: "laptop/w7:p1", token: "ssss", place: { session: "main", paneId: "w7:p1", instance: "ssss" }, space: API_LAPTOP };
  type End = typeof T;

  /** Hop `n`: `from` answers the message `to` sent it, checked on `to`'s bridge. */
  function hop(from: End, to: End, replyTo: string | null): ReturnType<typeof borderVerdict> {
    const parentOnTo: BorderParent | null = replyTo === null ? null : { from: `${to.address}#${to.token}`, sender: to.place, targets: [from.address], to: `${from.address}#${from.token}` };
    // The first message goes by the outside flag; every hop after it is a reply.
    const outside = replyTo === null ? true : undefined;
    return borderVerdict({
      message: { kind: "agent", replyTo, outside, from: { address: `${from.address}#${from.token}`, space: from.space } },
      sender: `${from.address}#${from.token}`,
      target: { address: to.address, space: to.space, pane: to.place, instance: to.token },
      replyParent: parentOnTo,
      signerVersion: "current",
    });
  }

  test("the first message goes by the outside flag, and every reply after it goes back as `reply`, both ways", () => {
    expect(hop(T, S, null)).toEqual({ via: "outside" });
    expect(hop(S, T, "wt_hop000000001")).toEqual({ via: "reply" });
    expect(hop(T, S, "wt_hop000000002")).toEqual({ via: "reply" });
    expect(hop(S, T, "wt_hop000000003")).toEqual({ via: "reply" });
  });

  test("the same hops with no outside flag on the first: it never starts", () => {
    const first = borderVerdict({ message: { kind: "agent", replyTo: null, from: { address: "desk/w2:p1#tttt", space: WEB } }, sender: "desk/w2:p1#tttt", target: { address: S.address, space: S.space, pane: S.place, instance: S.token }, replyParent: null, signerVersion: "current" });
    expect(first).toEqual({ refuse: OUTSIDE_YOUR_SPACE });
  });
});
