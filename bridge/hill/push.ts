// A DECISION THAT NEEDS THE PERSON NOW (M96, 2026-11-10): one web push when a Decision opens with the
// priority `now`, through the bridge's one push path (bridge/push.ts) and every rule it keeps there.
//
// WHEN. The hill service (service.ts) asks at a fresh post, and at a supersede, whose SHOWN priority is
// `now` (a fourth open `now` of one sender is shown as `today`, HILL_NOW_MAX, and does not push). Never
// for `today` or `later`; never for a repeated request id (the stored decision is answered and nothing
// runs); never for a trick's re-ask of a key that closed without the person (tricks/hill.ts names it).
//
// ONCE. A decision that pushed records its slot, `pushTag`, in the same write that stores it, and a push
// is only ever decided on that first write, so no restart, retry or sweep can send it again.
//
// WHAT. The title is the decision's title and the body its summary, each one line, cut to the lengths an
// ask's push keeps (PUSH_TITLE_MAX, PUSH_LINE_MAX). Never the body, an image, an option or the view: a
// push crosses a third-party push service and shows on a lock screen. No title code (ADR 0074): the
// words are the poster's, not Collie's catalogue, as a `collie push-test` title is not.
//
// THE SLOT. The tag is `collie:hill:<id>`, on its own collapse topic (`hillTopic`). A `now` decision that
// supersedes one holding a slot keeps that slot, so its push replaces the old notification instead of
// stacking. When a decision holding a slot closes and no successor holds it, one clear closes the
// notification on the phone (service.ts `save`).
//
// THE GATES. Push live (VAPID keys), the "Decisions that need you now" switch (`decisions`, notify-prefs),
// not snoozed, and not a crew member (a member forwards its posts to the lead, CREW_PROTOCOL §22; the
// lead holds the subscriptions, as for every other push). Then the rate below. A decision past a gate still posts and shows; only the
// push is skipped, and a skip for the rate writes one `hill.push.skipped` audit line.

import { PUSH_LINE_MAX, PUSH_TITLE_MAX } from "../mux/durable/clean.ts";
import { hillTopic, type PushMessage } from "../push.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";

/**
 * How often `now` Decisions may ring the phone: at most `perSender` an hour from one sender (an agent's
 * address, or a trick), `perMember` an hour from the agents of one crew member together (posting through
 * their lead; CREW_PROTOCOL §22, 1.29.0), and `total` an hour from every sender together. Past
 * any of them, the decision posts and shows, and only its push is skipped.
 */
export const HILL_PUSH_RATE = { perSender: 3, perMember: 6, total: 10, windowMs: 60 * 60_000 } as const;

const TAG_PREFIX = "collie:hill:";

/** The notification slot of a decision that opens one: `collie:hill:<id>`. */
export function hillPushTag(id: string): string {
  return `${TAG_PREFIX}${id}`;
}

/** Whether a stored `pushTag` has the shape {@link hillPushTag} makes. */
export function isHillPushTag(tag: string): boolean {
  return /^collie:hill:dc_[a-z0-9]{12}$/u.test(tag);
}

/** One line of a push: every run of white space one space, cut to `max` characters with `…`. */
export function pushLine(text: string, max: number): string {
  const points = [...text.split(/\s+/u).filter((word) => word !== "").join(" ")];
  return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The push a `now` decision sends into its slot. Title and summary only, cut; nothing else of it. */
export function hillPushMessage(decision: Pick<HillDecision, "id" | "title" | "summary">, tag: string): PushMessage {
  return {
    title: pushLine(decision.title, PUSH_TITLE_MAX),
    body: pushLine(decision.summary, PUSH_LINE_MAX),
    tag,
    target: "hill",
    decision: decision.id,
    topic: hillTopic(tag),
  };
}

/** Whether a `now` push may go: yes, or which gate holds it. */
export type HillPushVerdict = "send" | "off" | "sender" | "member" | "total";

/** What the hill service needs of the phone push (service.ts). */
export interface HillPushPort {
  /**
   * Whether a `now` push from `sender` may go now. Spends nothing. `member` is the crew member an agent
   * sender posts from through this lead (its decision's `from.memberId`); absent or null for this
   * bridge's own sessions and for a trick, which count only as a sender and toward the total.
   */
  check(sender: string, member?: string | null): HillPushVerdict;
  /** Send a stored decision's push into its `pushTag` slot, and count it against the rate. */
  send(sender: string, decision: HillDecision): void;
  /** Close the notification in a slot. */
  clear(tag: string): void;
}

export interface HillPushDeps {
  /** Push live, the `decisions` switch on, not snoozed, not a crew member. */
  ready(): boolean;
  send(message: PushMessage): void;
  readonly now?: () => number;
}

/** The phone push of `now` decisions: the gates, the rate, the message. */
export class HillPush implements HillPushPort {
  /** The pushes sent inside the rate's window, oldest first. In memory: a restart forgives. */
  private sent: Array<{ readonly at: number; readonly sender: string; readonly member: string | null }> = [];
  private readonly now: () => number;

  constructor(private readonly deps: HillPushDeps) {
    this.now = deps.now ?? Date.now;
  }

  check(sender: string, member: string | null = null): HillPushVerdict {
    if (!this.deps.ready()) return "off";
    const now = this.now();
    this.sent = this.sent.filter((entry) => now - entry.at < HILL_PUSH_RATE.windowMs);
    if (this.sent.filter((entry) => entry.sender === sender).length >= HILL_PUSH_RATE.perSender) return "sender";
    if (member !== null && this.sent.filter((entry) => entry.member === member).length >= HILL_PUSH_RATE.perMember) return "member";
    if (this.sent.length >= HILL_PUSH_RATE.total) return "total";
    return "send";
  }

  send(sender: string, decision: HillDecision): void {
    if (decision.pushTag === undefined) return;
    this.sent.push({ at: this.now(), sender, member: decision.from.kind === "agent" ? decision.from.memberId : null });
    this.deps.send(hillPushMessage(decision, decision.pushTag));
  }

  clear(tag: string): void {
    this.deps.send({ type: "clear", tag, topic: hillTopic(tag) });
  }
}
