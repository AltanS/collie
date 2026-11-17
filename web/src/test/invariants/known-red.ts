// The tests of the invariant suites that are red on the base (M102 spec 15, decision 2). Each one stays
// in its suite as an expected failure (bun `test.failing`, vitest `it.fails`), named here with the spec
// that fixes it. When the fix lands the test passes, the runner reports an unexpected pass, and the lead
// removes its entry here and its expected-failure mark there. The release gate is an empty list:
// `bun scripts/invariant-red.ts --gate` exits 1 while any entry is left.
//
// `NONE` names a break that no spec of M102 covers. It is listed so the suite stays green, and the
// report says it loudly.
//
// Pure data: no DOM, no Bun API.

export type Invariant = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7";

/** The spec that fixes a red test. `M102-03` is the phone's "Type it anyway" (rule 3), not on the candidate. */
export type FixingSpec = "M102-03" | "M102-10" | "M102-11" | "M102-12" | "M102-13" | "M102-14" | "NONE";

export interface KnownRed {
  readonly invariant: Invariant;
  readonly fixedBy: FixingSpec;
  /** The product code that breaks the invariant, file and line at stage 85caf9742. */
  readonly where: string;
  /** One sentence: what the person meets. */
  readonly what: string;
}

export const KNOWN_RED = {
  // ── I4, the phone: a tap on a dialog ──
  "i4-tap-tick-unframed": {
    invariant: "I4",
    fixedBy: "M102-10",
    where: "web/src/lib/harness/prompt-model.ts:306-309 (sameDialogRows: with no bindRegion it compares the lookback signature), web/src/lib/harness/guard.ts entryGuard (refuses `changed`)",
    what: "A tap on a dialog with no frame of its own (a Claude ask, the first-run menu, agy and muse asks) is refused `changed` while a row above it ticks: the person cannot answer until the timer stops.",
  },
  // ── I4, the phone: the composer offers the override ──
  "i4-phone-slot": {
    invariant: "I4",
    fixedBy: "M102-03",
    where: "web/src/lib/send-slot.ts:62-69 (sendSlot), web/src/lib/surface/send.ts:106-111 (takesManualSend)",
    what: "On a stale, torn or contested read, a box out of reach or a draft-less unknown box, the composer's Send slot is wait or unreachable: the phone offers no override at all.",
  },
  "i4-phone-commit": {
    invariant: "I4",
    fixedBy: "M102-03",
    where: "web/src/components/composer.tsx:1948-1949 (the notice draws only the bridge's offers; a not_free refusal offers keys alone), web/src/lib/surface/send.ts:504 (offersFor gives a refusal only keys)",
    what: "A not_free refusal that carries the rows hash shows no Type it anyway button, so the person cannot send the override from the phone.",
  },
  // ── I2, a tap ends in a request, a change or words ──
  "i2-hold-guard": {
    invariant: "I2",
    fixedBy: "M102-11",
    where: "web/src/components/hook-hold-card.tsx:89 (the 400 ms guard returns with nothing)",
    what: "A tap on a hook hold card in its first 400 ms makes no request, no change and no words.",
  },
  "i2-hold-reject": {
    invariant: "I2",
    fixedBy: "M102-11",
    where: "web/src/components/hook-hold-card.tsx:90 (void Promise.resolve(onAnswer(index)).finally(...): no catch, no words)",
    what: "When the hold card's answer handler rejects, the rejection is unhandled and the card shows no words; only the busy mark clears.",
  },
  "i2-words-raw": {
    invariant: "I2",
    fixedBy: "M102-11",
    where: "web/src/lib/api.ts:1601-1606 (plainFailureMessage: `HTTP <status>: <first body line>`), api.ts:560 (ApiError message `<path> → <status> <body>`), web/src/lib/api-error-message.ts:66 (describeThrownError falls back to it)",
    what: "A 4xx or 5xx whose body is a proxy's HTML page reaches the thumb as `HTTP 502: <html><head><title>...`, on send, ask, hold card, keys, Stop and Clear.",
  },
  // ── I1, an enabled control or words ──
  "i1-hold-disabled": {
    invariant: "I1",
    fixedBy: "M102-11",
    where: "web/src/components/agent-chat.tsx:3229 (disabled={readOnly || gone || !holdsAnswered}), web/src/components/hook-hold-card.tsx:82-86 (no reason drawn)",
    what: "A hook hold card on a crew member that does not mark the Send Protocol greys every option and says nothing.",
  },
} as const satisfies Record<string, KnownRed>;

export type KnownRedId = keyof typeof KNOWN_RED;

/** One entry by its id. The id is the tag a red test carries. */
export function knownRed(id: KnownRedId): KnownRed & { readonly id: KnownRedId } {
  return { id, ...KNOWN_RED[id] };
}

/** The title suffix of a red test: the spec that fixes it, so a runner's list shows it. */
export function redTitle(id: KnownRedId): string {
  const entry = KNOWN_RED[id];
  return `[RED ${entry.invariant} FIXED_BY ${entry.fixedBy}: ${id}]`;
}

/** The entries per fixing spec. */
export function countBySpec() {
  const counts = { "M102-03": 0, "M102-10": 0, "M102-11": 0, "M102-12": 0, "M102-13": 0, "M102-14": 0, NONE: 0 } satisfies Record<FixingSpec, number>;
  for (const entry of Object.values(KNOWN_RED)) counts[entry.fixedBy] += 1;
  return counts;
}
