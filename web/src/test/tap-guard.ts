import { waitFor } from "@testing-library/react";

import { currentStatus } from "@/lib/status";
import { recordedSends } from "@/test/handlers";

// THE GUARD OF M102 SPEC 11, "No tap vanishes": a tap on a control of the session view ends in a request,
// a visible change the person asked for, or words on screen. A tap that changes none of the three is a
// dead tap, and this helper turns it into a failing test.
//
// It records three things before the tap and again after it: the document's text, every request the fake
// bridge took (the Send Protocol log, plus any other log the test names), and the status line. The text is
// the document's `textContent`, so a notice that was already on screen and says the same words after the
// tap is NOT an answer: the tap must change something. A status that is raised again (even with the same
// words) counts, because every publish carries a new id.
//
// Roles and accessible names drive the tap, never a class or a test id (CLAUDE.md, the selector rule).

export interface TapGuardOptions {
  /** Other request logs a test keeps (an MSW handler's own `posted` array), read after the tap. */
  readonly requests?: readonly (() => readonly unknown[])[];
}

interface Snapshot {
  readonly text: string;
  readonly sends: string;
  readonly requests: string;
  readonly status: string;
}

function snapshot(options: TapGuardOptions): Snapshot {
  const status = currentStatus();
  return {
    text: document.body.textContent ?? "",
    sends: JSON.stringify(recordedSends()),
    requests: JSON.stringify((options.requests ?? []).map((read) => read())),
    status: status === null ? "" : `${String(status.id)}:${status.text}`,
  };
}

function unchanged(before: Snapshot, after: Snapshot): boolean {
  return before.text === after.text && before.sends === after.sends && before.requests === after.requests && before.status === after.status;
}

/**
 * Run `act` (a tap) and fail unless the screen text, the request log or the status line changed.
 * It waits up to a second for the change, since a request answers a moment after the tap.
 */
export async function expectTapAnswers(act: () => Promise<void>, options: TapGuardOptions = {}): Promise<void> {
  const before = snapshot(options);
  await act();
  try {
    await waitFor(
      () => {
        if (unchanged(before, snapshot(options))) throw new Error("the screen, the requests and the status are all unchanged");
      },
      { timeout: 1000 },
    );
  } catch {
    throw new Error("no tap vanishes: the tap changed no text, sent no request and raised no status");
  }
}
