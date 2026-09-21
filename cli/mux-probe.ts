import { EXIT, type Io } from "./io.ts";
import { explicitMux, probeMuxes, type MuxProbeDeps } from "./mux.ts";

// `collie _mux-probe` — which multiplexers are running HERE, as one JSON line.
//
// ── WHO READS IT ─────────────────────────────────────────────────────────────
// `collie crew add`, leg 3 (`cli/remote.ts`). The lead's operator is the one at a terminal, so the
// lead decides which multiplexer a member should drive — and it learns what runs there by running
// the MEMBER'S OWN just-installed binary over the ssh it already holds. That is the same reasoning
// leg 4's `crew status --no-probe` rests on: after leg 2 the member runs this very build, so the
// format is known rather than guessed.
//
// ── WHY A VERB AND NOT A SHELL PROBE ─────────────────────────────────────────
// `cli/mux.ts`'s header states it: every name and every argv comes from `bridge/mux/`. A POSIX
// re-implementation of the probe inside a leg script would be a second answer to "what is running
// here", and a fourth multiplexer would leave that copy quietly stale. So the probe stays where it
// is and this verb is the only new thing — it loads the ordinary CLI context, asks the same two
// functions `collie start` asks, and prints.
//
// Read-only, exit 0, never interactive. Internal, and spelled with a leading underscore for the
// reason `_apply-update` is: it is typed by another Collie, never by an operator, so it stays out
// of the usage line.
//
// It exists because a member that runs two multiplexers could not restart itself: `collie join` on
// the far machine ends in a `collie restart`, `chooseMux` refuses a non-interactive run with two
// sightings, and the operator was left to set `COLLIE_MUX` there by hand (#248, 2026-09-21).

/** One multiplexer the member reported, reduced to what the lead has to show and write. */
export interface MuxProbeSighting {
  readonly mux: string;
  /** The adapter's own words: "a Herdr socket at /run/herdr.sock". */
  readonly evidence: string;
}

/**
 * The whole answer. `explicit` is the member's own `COLLIE_MUX` as its environment resolves it —
 * reported rather than acted on, because the lead reads the member's `.env` in leg 1 and that file
 * is what a supervised bridge there will read too.
 */
export interface MuxProbeReport {
  readonly explicit: string | null;
  readonly found: readonly MuxProbeSighting[];
}

/** The report, from the same two functions `collie start`'s first-run gate asks. */
export function muxProbeReport(deps: MuxProbeDeps): MuxProbeReport {
  return {
    explicit: explicitMux(deps.ctx.env),
    // The endpoint is deliberately dropped: the lead writes a NAME, and each adapter settles its own
    // endpoint on the member at first start (`muxVars`).
    found: probeMuxes(deps).map((sighting) => ({ mux: sighting.mux, evidence: sighting.evidence })),
  };
}

/** The verb: one JSON object on stdout, and nothing else. */
export function cmdMuxProbe(deps: MuxProbeDeps & { readonly io: Io }): number {
  deps.io.out(JSON.stringify(muxProbeReport(deps)));
  return EXIT.OK;
}

/**
 * `value` when the document really carried a non-empty string there, else null.
 *
 * `String(v) !== v` is true for a number, an object and nothing at all, and false for a string
 * alone, so the round trip IS the check — the same reader `bridge/update-run.ts` uses on its own
 * foreign document.
 */
const nonEmptyString = (value: string | null | undefined): string | null =>
  value === undefined || value === null || String(value) !== value || value === "" ? null : value;

/**
 * The report inside whatever the far side printed, or null.
 *
 * Null is the third error family — "the remote answered something this build cannot read" — and the
 * caller turns it into a refusal, never into a guess: a member whose multiplexers could not be read
 * is one nobody may pick for.
 */
export function parseMuxProbe(stdout: string): MuxProbeReport | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let doc: {
    explicit?: string | null;
    found?: ({ mux?: string; evidence?: string } | null)[];
  };
  try {
    // SAFETY: `JSON.parse` answers a JSON value, and every field read off it below is narrowed by
    // `nonEmptyString` or by `Array.isArray` before it is used. Nothing here becomes a path, a
    // command or a credential — the names are compared against this build's own registry by the
    // caller, and the evidence is only ever printed.
    doc = JSON.parse(stdout.slice(start, end + 1)) as { explicit?: string | null };
  } catch {
    return null;
  }
  if (!Array.isArray(doc.found)) return null;
  const found: MuxProbeSighting[] = [];
  for (const row of doc.found) {
    const mux = nonEmptyString(row?.mux);
    // A row with no name is not a sighting with a missing field — it is a document this build
    // cannot read, and half of it is worse than none.
    if (mux === null) return null;
    found.push({ mux, evidence: nonEmptyString(row?.evidence) ?? "" });
  }
  return { explicit: nonEmptyString(doc.explicit), found };
}
