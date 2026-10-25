// ── THE LAUNCH WINDOW: A PANE THE BRIDGE STARTED AN AGENT IN, BEFORE THE AGENT HAS DRAWN ─────────
//
// `POST /api/launch` with a `harness` creates a pane and types the agent's line into its fresh shell.
// For the first seconds after that the multiplexer still reports a plain shell (it names an agent by
// its process, and omp takes about twenty seconds to boot), the screen shows the shell's banner, and
// the Send Protocol sees a pane with no profile. Such a pane takes a send blind: the text, then Enter.
// A person who sent in that window (a walky talky delivery, a quick first message) got `sent` for a
// line the shell took, and the agent later showed the text as an unsent draft (omp gang, tester 15).
//
// The bridge knows what it started, so it says so here: the pane, the harness id and the time. The
// protocol (`SendDeps.launching`) asks for a pane it would otherwise send blind. While the mark holds,
// it reads the screen with that harness's profile and presses no key until the harness's input box is
// on screen; it never types into the shell. The mark ends when the multiplexer names the agent
// ({@link LaunchWindow.seen}) or when {@link LAUNCH_WINDOW_MS} has passed.
//
// Memory only, per bridge: a restart forgets it, and a send in the window then goes blind as before.
// A pane the bridge did not launch (an operator's own shell, a rig's `pane run`) is never marked.

/** How long a launched pane may take to show its agent's input box: omp 18.12.6 takes about 20 s. */
export const LAUNCH_WINDOW_MS = 120_000;

/** The most panes marked at once. A bridge launches by hand, so this is a safety bound. */
const MARKS_MAX = 64;

interface Mark {
  readonly harness: string;
  readonly until: number;
}

export class LaunchWindow {
  private readonly marks = new Map<string, Mark>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private static keyOf(session: string, paneId: string): string {
    return `${session}\u0000${paneId}`;
  }

  /** A launch typed `harness`'s line into `paneId`: sends to that pane wait for its input box. */
  mark(session: string, paneId: string, harness: string): void {
    const at = this.now();
    for (const [key, mark] of this.marks) if (mark.until <= at) this.marks.delete(key);
    if (this.marks.size >= MARKS_MAX) {
      const oldest = this.marks.keys().next().value;
      if (oldest !== undefined) this.marks.delete(oldest);
    }
    this.marks.set(LaunchWindow.keyOf(session, paneId), { harness, until: at + LAUNCH_WINDOW_MS });
  }

  /** The harness id the pane was started for while the window is open, else null. */
  expecting(session: string, paneId: string): string | null {
    const key = LaunchWindow.keyOf(session, paneId);
    const mark = this.marks.get(key);
    if (mark === undefined) return null;
    if (mark.until <= this.now()) {
      this.marks.delete(key);
      return null;
    }
    return mark.harness;
  }

  /** The multiplexer names the pane's agent now: once it is the harness the window was for, the window is over. */
  seen(session: string, paneId: string, agent: string): void {
    const key = LaunchWindow.keyOf(session, paneId);
    if (this.marks.get(key)?.harness === agent) this.marks.delete(key);
  }
}
