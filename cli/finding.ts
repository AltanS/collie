// One check's answer, and the four constructors that build one.
//
// Split out of `cli/doctor.ts` so a check can live in its own module without importing the verb that
// prints it — `cli/history.ts` is the first — and so the two can never disagree about what a
// finding is. Nothing here reaches the world: these are four object literals and a type.

export type DoctorStatus = "ok" | "warn" | "error" | "skipped";

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
}

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
