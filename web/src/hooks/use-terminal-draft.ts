import { useEffect, useRef, useState } from "react";

// A terminal draft must sit on the input line for at least this long before we surface it. One
// snapshot flash is never actionable — and the flash that bit us is the composer's OWN in-flight
// reply: the bridge types the text, waits ~350ms (REPLY_SETTLE_MS), then presses Enter, so for a poll
// or two the just-typed text sits alone on the "❯" line, shape-identical to a stranded draft. At the
// hot poll cadence (≤1.5s) this span means the same text was seen across at least two consecutive
// polls before it can chip; a genuinely stranded draft persists across turns, so it still surfaces —
// just a beat later.
const STABLE_MIN_AGE_MS = 1_500;

/**
 * Debounce the raw per-snapshot terminal draft (extractInputDraft) into one that only becomes
 * non-null once the SAME text has stayed on the input line continuously for STABLE_MIN_AGE_MS.
 *
 * extractInputDraft is stateless per snapshot (by design — it must stay that way; it's the XSS
 * boundary's neighbour and a pure parse), so it can't tell a genuinely stranded draft from a
 * transient one. This is the cross-poll memory that does: a changed draft resets the clock, and a
 * cleared line (null) drops it immediately.
 *
 * Stability is keyed on the NORMALISED draft (trim + collapse whitespace runs), NOT the raw string:
 * the mirror can re-flow spacing, pad a trailing space, or blink a cursor on the "❯" line between
 * polls, and if every such cosmetic wobble reset the 1.5s clock the chip would never promote for a
 * draft the user is actually staring at. Only a real edit (different text once normalised) restarts
 * the timer. The value we ultimately surface is the LATEST raw text, so the chip shows exactly what's
 * on the line — the normalisation governs the *timer*, not what's displayed.
 */
export function useStableTerminalDraft(raw: string | null): string | null {
  const [stable, setStable] = useState<string | null>(null);
  // The stabilisation key: what the timer keys on. Cosmetic-only changes leave it untouched.
  const key = raw === null ? null : normalizeDraft(raw);
  // Latest raw text, so a promotion surfaces the current line even if only whitespace shifted since.
  const latest = useRef(raw);
  latest.current = raw;

  useEffect(() => {
    if (key === null) {
      setStable(null);
      return;
    }
    // A draft that just appeared or changed isn't actionable yet: keep it only if what we already
    // promoted still normalises to the same key, otherwise blank it until it proves it's still there
    // after the delay. When `key` is unchanged across polls this effect doesn't re-run, so the
    // original timer keeps ticking and fires once the text has genuinely persisted.
    setStable((prev) => (prev !== null && normalizeDraft(prev) === key ? prev : null));
    const id = window.setTimeout(() => setStable(latest.current), STABLE_MIN_AGE_MS);
    return () => clearTimeout(id);
  }, [key]);

  return stable;
}

// Normalise a draft/reply for the "is this my own in-flight reply?" comparison AND the cross-poll
// stability key above: trim, and collapse internal whitespace runs, since the mirror can pad or
// re-flow spacing on the "❯" line (and a wrapped draft is folded to one space-joined line upstream).
function normalizeDraft(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * True when a terminal draft is (robustly) the same text the composer just sent — i.e. our own reply
 * still echoing on the "❯" line before the bridge's pending Enter lands, not a stranded draft. Matches
 * exactly after whitespace-normalisation, or when the mirror's copy is a truncated head of what we
 * sent (a long reply gets an "…" ellipsis on the input line) — guarded by a minimum length so a stray
 * short prefix can't false-match an unrelated draft.
 */
export function isSelfEcho(draft: string, sent: string): boolean {
  const d = normalizeDraft(draft);
  const s = normalizeDraft(sent);
  if (d === s) return true;
  const [shorter, longer] = d.length <= s.length ? [d, s] : [s, d];
  const head = shorter.replace(/[….]+$/, "").trimEnd();
  return head.length >= 8 && longer.startsWith(head);
}
