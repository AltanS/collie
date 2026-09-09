// CANDIDATE SSH TARGETS — the one thing a machine-linking multiplexer contributes (ADR 0036 (c)).
//
// ── WHY THIS IS NOT ON `MuxAdapter` ──────────────────────────────────────────
// There are two axes and they must never be mixed (ADR 0036). A `MuxAdapter` answers "which panes
// are on THIS machine", and nothing in `bridge/mux/` ever sees a host — not in a parameter, not in
// a config key, not in a return shape (`./registry.ts`, ADR 0022). "Which ssh targets exist" is the
// HOST axis, which is the crew's question. So the seam is a module-level provider on
// {@link MuxAdapterFactory}, beside `beaconMatcher?` and `describeTarget?`: the factory is a value
// the registry can read without building an adapter, and the runtime interface gains nothing.
//
// ── A CANDIDATE IS A SUGGESTION, NEVER AN ACTION ─────────────────────────────
// Nothing here enrols anything, and nothing here writes. A provider reads a list the operator
// already keeps somewhere else and hands it up so `collie crew add` can offer it. The operator
// still picks, and `crew add`'s own confirm still runs. A multiplexer's machine list is NOT a crew
// (ADR 0036's consequences): the two lists will differ, and neither is derived from the other.

/**
 * One machine a provider knows about, in the SOURCE's own spelling.
 *
 * `target` is what would be handed to `collie crew add`, so it is whatever that source calls the
 * machine — a bare host, a `user@host`, a `user@host:port`, an `~/.ssh/config` alias. It is never
 * rewritten here: `bridge/crew/ops-store.ts` already stores the destination as the operator typed
 * it, and a provider that normalised names would hand the operator a string they do not recognise.
 */
export interface HostCandidate {
  readonly target: string;
  /** A human name the source carries beside the target, or `null` when it carries none. */
  readonly label: string | null;
  /** The source's own id for the machine, or `null`. Opaque — nothing above compares it to a member id. */
  readonly id: string | null;
}

/** What one bounded shell-out answered. Structurally the CLI's `ExecResult` (`cli/sys.ts`). */
export interface HostProbeResult {
  /** Exit status. Meaningless when {@link HostProbeResult.found} is false. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * False when the tool is not installed anywhere we look — a DIFFERENT answer from "ran and
   * failed". A provider whose tool is absent yields no candidates and says nothing; one whose tool
   * ran and misbehaved says exactly one line.
   */
  readonly found: boolean;
}

/**
 * How a provider reaches the machine it is running on: one bounded spawn, and one stderr line.
 *
 * Injected rather than taken from the environment so no test in this tree spawns anything. The CLI
 * satisfies it with its own `Exec` seam (`cli/sys.ts`), which is already faked everywhere.
 */
export interface HostProbe {
  /** Run `tool`, capturing both streams, killed at `timeoutMs`. Never throws. */
  run(tool: string, args: readonly string[], timeoutMs: number): HostProbeResult;
  /**
   * Say ONE line about a source that is present but broken. A provider calls this at most once per
   * run: a broken machine list must be visible without being fatal, and a picker that printed a
   * paragraph about a tool the operator did not ask about would be worse than silence.
   */
  warn(line: string): void;
}

/**
 * The per-call wall-clock budget for EVERY shell-out the candidate picker makes — the machine list
 * and each `ssh -G` alike.
 *
 * One constant rather than a value per call site, because the failure this bounds is "the picker
 * hangs", and a picker is only as bounded as its slowest call. Three seconds: every one of these
 * calls reads local configuration or a local socket, so a slower one is a hung one, and the picker
 * is a convenience that must never be the reason `crew add` stops responding.
 */
export const CANDIDATE_TIMEOUT_MS = 3_000;
