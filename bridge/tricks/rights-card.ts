import { createHash } from "node:crypto";

import type { HillCollieRef, HillDecision, HillPostInput } from "../../web/src/lib/hill/wire.ts";
import type { HillCollieSender, HillCollieVerdict, HillOneAnswer, HillPostAnswer } from "../hill/service.ts";
import type { RightsMoved } from "./service.ts";

// A TRICK STOPPED FOR ITS RIGHTS IS SAID ON THE HILL (fault B). The runner stops a trick whose approval
// holds other rights than its approved copy asks for as this Collie reads them (service.ts
// `rightsMovedOf`); its row says so, and this module posts one Decision of Collie's own for it, so the
// stop is never silent on a phone that is not on Settings. It asks nothing: one button, OK, which closes
// it. The card is about one trick and one mismatch (the approved hash, the powers stored, the powers read
// now): its request id and its `ref.hash` derive from those, so a scan, a restart or a second sync posts
// it once, a card the person closed or cleared does not come back, and only a new mismatch posts a new
// one. A card still open closes itself when its stop ends, with the reason as its receipt: the person
// switched the trick on again (or the stored rights hold again), the trick is off or removed, or it asks
// for other rights now, which gets a card of its own.

/** The sender's name on the card, as on Collie's other cards. */
export const RIGHTS_CARD_SENDER = "Collie";
/** The card's one option. */
export const RIGHTS_OK = "ok";
/** Why an open card closes when its trick runs again: a switch on approved the rights it asks for. */
export const RIGHTS_CARD_APPROVED = "Switched on again with the rights it asks for now.";
/** Why an open card closes when its trick is off or its folder is gone. */
export const RIGHTS_CARD_OFF = "The trick is off or removed.";
/** Why an open card closes when its trick asks for other rights again: a new card says so. */
export const RIGHTS_CARD_MOVED = "It asks for other rights now; a new card says so.";

/** One trick that is on and stopped for its rights, as the runner sees it now. */
export interface TrickRightsSubject {
  id: string;
  /** The trick's name, from the approved copy's manifest. */
  name: string;
  moved: RightsMoved;
}

/**
 * What the runner tells the card: every trick stopped for its rights now, and the ids of the tricks that
 * run now (on, approved, rights holding). A trick in neither list is off or gone.
 */
export interface TrickRightsPort {
  sync(subjects: readonly TrickRightsSubject[], running: ReadonlySet<string>): void;
}

/** What the card needs of the Hill: the door no agent, crew member or trick reaches (hill/service.ts). */
export interface RightsCardHill {
  postCollie(from: HillCollieSender, input: HillPostInput): HillPostAnswer;
  withdrawCollie(from: HillCollieSender, id: string, reason: string): HillOneAnswer;
  collieDecisions(type: HillCollieRef["type"]): HillDecision[];
}

/** The SHA-256 of one mismatch, the card's `ref.hash`. */
export function rightsHash(moved: RightsMoved): string {
  return createHash("sha256").update(`collie-rights-card\0${moved.hash}\0${moved.stored ?? ""}\0${moved.now}`).digest("hex");
}

/** A stable request id per trick and mismatch, so a restart posts the same card once. */
export function rightsRequestId(id: string, moved: RightsMoved): string {
  const hex = createHash("sha256").update(`collie-rights-card-request\0${id}\0${rightsHash(moved)}`).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The card for one trick stopped for its rights. */
export function rightsCard(subject: TrickRightsSubject): HillPostInput {
  return {
    requestId: rightsRequestId(subject.id, subject.moved),
    title: `${subject.name} changed its rights`,
    summary: "Collie now reads other rights in this trick than the ones you said yes to, so the trick stopped. Read its rights in Settings → Tricks, and switch it on again if you want it.",
    options: [{ intent: RIGHTS_OK, label: "OK" }],
    text: "none",
  };
}

/** The sender of the card about one trick and mismatch. */
export function rightsSender(id: string, hash: string): HillCollieSender {
  return { kind: "collie", ref: { type: "rights", id, hash }, label: RIGHTS_CARD_SENDER };
}

/** The answer to a card: OK closes it, and nothing else is an option. */
export function answerRights(intent: string): HillCollieVerdict {
  return intent === RIGHTS_OK ? { ok: true } : { ok: false, reason: "That is not an option of this card." };
}

/** The receipt of a card whose stop ended: why it closed. */
function closeReason(id: string, stopped: ReadonlyMap<string, string>, running: ReadonlySet<string>): string {
  if (running.has(id)) return RIGHTS_CARD_APPROVED;
  return stopped.has(id) ? RIGHTS_CARD_MOVED : RIGHTS_CARD_OFF;
}

export class RightsCards implements TrickRightsPort {
  private readonly hill: RightsCardHill;
  private readonly warn: (line: string) => void;
  /** Refusals already said, `<id>@<hash>@<code>`, so a Hill that is off is not logged every scan. */
  private readonly said = new Set<string>();

  constructor(deps: { hill: RightsCardHill; warn?: (line: string) => void }) {
    this.hill = deps.hill;
    this.warn = deps.warn ?? (() => undefined);
  }

  sync(subjects: readonly TrickRightsSubject[], running: ReadonlySet<string>): void {
    const now = new Map(subjects.map((subject) => [subject.id, rightsHash(subject.moved)]));
    const mine = this.hill.collieDecisions("rights");
    for (const decision of mine) {
      const ref = decision.from.ref;
      if (decision.state !== "open" || ref === undefined || now.get(ref.id) === ref.hash) continue;
      // While its answer runs the Hill refuses; the answer closes it, so nothing is left to do.
      this.hill.withdrawCollie(rightsSender(ref.id, ref.hash), decision.id, closeReason(ref.id, now, running));
    }
    for (const subject of subjects) {
      const hash = rightsHash(subject.moved);
      // Any card for this mismatch, open or closed, is the one: never a second.
      if (mine.some((decision) => decision.from.ref?.id === subject.id && decision.from.ref.hash === hash)) continue;
      const posted = this.hill.postCollie(rightsSender(subject.id, hash), rightsCard(subject));
      if (posted.ok) continue;
      const said = `${subject.id}@${hash}@${posted.code ?? "plain"}`;
      if (this.said.has(said)) continue;
      this.said.add(said);
      this.warn(`${subject.id}: the card that says its rights changed was not posted: ${posted.error}`);
    }
  }
}
