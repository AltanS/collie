import { compareSemver } from "../update.ts";

// A DURABLE PEER WHOSE LEAD IS TOO OLD (M50 spec 14). The question card for a durable pane and the
// chat-only Terminal tab both live on the phone the LEAD serves. A lead below 1.21.0 merges the peer's
// durable panes into its list like any other pane, so the phone shows them without the card, and its
// Terminal tab polls a pane that has no terminal. Nothing on the peer can fix that, so the peer says
// it: one log line per lead release it hears, and a `collie doctor` row (`durable-lead`) read from the
// runtime marker.
//
// The lead's release is the `X-Crew-Lead-Release` header its sweep already sends (crew/follow.ts). It
// is absent while the lead runs a dev or prerelease build, or is mid-update; absent means nothing is
// said, because there is no version to compare.

/** The first release whose phone shows a durable pane's question card. */
export const DURABLE_LEAD_MINIMUM = "1.21.0";

/** The `durable-lead` sentence, shared by the log line and the doctor row so the two never drift. */
export function oldLeadSentence(leadRelease: string): string {
  return `the lead is ${leadRelease}; it shows durable panes without the question card and its Terminal tab polls; update the lead`;
}

/** Whether a lead release is below {@link DURABLE_LEAD_MINIMUM}. Null (no header) is never old. */
export function leadIsOld(leadRelease: string | null): leadRelease is string {
  return leadRelease !== null && compareSemver(leadRelease, DURABLE_LEAD_MINIMUM) < 0;
}

/**
 * Hears the lead's release on every sweep, remembers the last one for the runtime marker, and logs
 * {@link oldLeadSentence} once per release that is too old: once after boot, and once more only if
 * the lead moves to another old release.
 */
export class OldLeadNotice {
  private last: string | null = null;
  private said: string | null = null;

  constructor(private readonly log: (line: string) => void = (line) => console.warn(line)) {}

  observe(leadRelease: string | null): void {
    if (leadRelease === null) return;
    this.last = leadRelease;
    if (!leadIsOld(leadRelease) || this.said === leadRelease) return;
    this.said = leadRelease;
    this.log(`[durable] ${oldLeadSentence(leadRelease)}`);
  }

  /** The last release the lead stated, or null when it has stated none since this process started. */
  leadRelease(): string | null {
    return this.last;
  }
}
