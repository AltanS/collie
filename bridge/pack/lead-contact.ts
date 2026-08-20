// Gap A (RFC §10.1): **a peer knows when its lead last called it.**
//
// One number, stamped on this collie's own clock, refreshed by every admitted pack request from the
// member it pins as its lead — a poll, a proxied pane read, a forwarded write alike. That mirrors
// §10.2's "every landed call is a receipt" rule (`registry.ts` → `recordExchange`) and it exists for
// the same reason: the sweep relaxes to `COLLIE_POLL_IDLE_MS` while a phone watching a pane polls at
// 1.5 s, so a receipt that only the sweep refreshed would describe a perfectly healthy link as quiet.
//
// ── IN MEMORY, NEVER PERSISTED ───────────────────────────────────────────────
// This describes a PROCESS, and §7.1's rule for exactly this shape applies: a persisted receipt
// would survive the restart it is meant to report and would then state a falsehood with the
// authority of the trust store. {@link LeadContact.processStartedAt} covers the boot case instead —
// a collie that has just started has never been dialled by anyone, and the arming rule that reads
// this (RFC §6.3) takes the LATER of the two so a reboot cannot read as silence.
//
// It has exactly one home. A door that arms on a fact `pack status` does not print is a door nobody
// can explain, so the deputy's arming signal and the peer's status line read this same number.

/** The facts one peer holds about its lead's calls. Plain data, so every reader can be pure. */
export interface LeadContactFacts {
  /** When this process started. In the silence arithmetic on purpose — see the module header. */
  readonly processStartedAt: number;
  /** The last admitted request from the pinned lead, epoch ms, or `null` if there has been none. */
  readonly lastDialledAt: number | null;
  /**
   * The last time the pinned lead was **identified and refused on the pack secret**.
   *
   * §8.4's rotation drops a member that was offline to `unenrolled` and reissues the secret, so a
   * machine that returns after one holds generation *N-1* and fails the second factor on every dial.
   * From the returning machine's side that is otherwise indistinguishable from silence, which would
   * read as "my lead is gone" when the truth is "my lead is calling and I am no longer in the pack".
   * Recording it is what lets RFC §8.3's third outcome — *stranded by a rotation* — be **named**
   * rather than guessed at (see `deposed.ts`).
   */
  readonly leadRefusedSecretAt: number | null;
}

/**
 * How long this collie has been unheard from by its lead, in ms.
 *
 * The **later** of the last dial and this process's start, per RFC §6.3: a collie that has just
 * restarted has never been dialled by anybody, and without the boot term it would read as maximally
 * silent from its first instant. Including it gives the lead one full window to make its first call.
 */
export function silentForMs(facts: LeadContactFacts, now: number): number {
  const since = Math.max(facts.lastDialledAt ?? 0, facts.processStartedAt);
  return Math.max(0, now - since);
}

/** Has the lead ever called this process? `false` is "not since this collie started", not "never". */
export function everDialled(facts: LeadContactFacts): boolean {
  return facts.lastDialledAt !== null;
}

/**
 * The mutable holder. Deliberately tiny and free of policy: it records two instants and answers
 * with them, and every rule that reads them (arming, `pack status`, the stranded-by-rotation
 * verdict) is a pure function elsewhere.
 *
 * Monotone in both fields — a receipt never moves backwards, so a clock that stepped back cannot
 * make a link look quieter than it was.
 */
export class LeadContact {
  private lastDialledAt: number | null = null;
  private leadRefusedSecretAt: number | null = null;

  constructor(readonly processStartedAt: number) {}

  /** An admitted request from the pinned lead landed. Called from the router, after admission. */
  record(at: number): void {
    if (this.lastDialledAt === null || at > this.lastDialledAt) this.lastDialledAt = at;
  }

  /** The pinned lead was identified but presented the wrong pack secret (§8.4's rotation). */
  recordSecretRefusal(at: number): void {
    if (this.leadRefusedSecretAt === null || at > this.leadRefusedSecretAt) this.leadRefusedSecretAt = at;
  }

  facts(): LeadContactFacts {
    return {
      processStartedAt: this.processStartedAt,
      lastDialledAt: this.lastDialledAt,
      leadRefusedSecretAt: this.leadRefusedSecretAt,
    };
  }
}
