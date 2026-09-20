// One check's answer, and the four constructors that build one.
//
// Split out of `cli/doctor.ts` so a check can live in its own module without importing the verb that
// prints it — `cli/history.ts` is the first — and so the two can never disagree about what a
// finding is. Nothing here reaches the world: these are four object literals and a type.

export type DoctorStatus = "ok" | "warn" | "error" | "skipped";

/** Which machine a finding is ABOUT. See {@link Finding.scope}. */
export type FindingScope = "local" | "crew";

/**
 * One check's answer. `check` is a **stable identifier** — it is what a script branches on, so it
 * does not move when the prose does — and `remedy` is null **exactly** when `status` is `ok`, which
 * includes `skipped`: a check that could not run still says what would let it.
 */
export interface Finding {
  readonly check: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly remedy: string | null;
  /**
   * Which machine this finding is about. **Absent means `local`** — this machine — which is what
   * every check answered before the field existed and what a reader that does not know it assumes.
   *
   * The renderer was the first consumer: `collie doctor` has always drawn this machine's findings and
   * the crew's as two sections. The field is what lets a READER make the same split, `--json` first,
   * and `collie update --check`, which asks whether THIS machine can take a new version and must not
   * read a fault on another machine as an answer to it (ADR 0050).
   *
   * **The render section is not the scope.** `store-drift` prints with the crew and is local; `clock`
   * prints with this machine and is a crew fact. Each is stamped at its own line in `cli/doctor.ts`,
   * never by the array it sits in.
   */
  readonly scope?: FindingScope;
}

/** Stamp a finding as being about the crew rather than about this machine (ADR 0050). */
export const aboutCrew = (finding: Finding): Finding => ({ ...finding, scope: "crew" });

/** Whether this finding is about the machine it was produced on. Absent scope is local. */
export const isLocal = (finding: Finding): boolean => finding.scope !== "crew";

export const ok = (check: string, detail: string): Finding => ({ check, status: "ok", detail, remedy: null });
export const warn = (check: string, detail: string, remedy: string): Finding => ({
  check,
  status: "warn",
  detail,
  remedy,
});
export const bad = (check: string, detail: string, remedy: string): Finding => ({
  check,
  status: "error",
  detail,
  remedy,
});
export const skipped = (check: string, detail: string, remedy: string): Finding => ({
  check,
  status: "skipped",
  detail,
  remedy,
});
