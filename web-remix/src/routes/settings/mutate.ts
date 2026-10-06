// web/src/lib/mutate.ts for this shell: run one write whose failure has nowhere else to go, and say
// why on the status channel. A throw becomes an error status and a `{ ok: false }` outcome the caller
// cannot mistake for success, so a revert-on-failure reads `if (res.ok) … else …`.
import { ApiError } from "../../lib/api";
import { setStatus } from "../../lib/status";

import { t } from "@web/lib/i18n";

export type MutateOutcome<T> = { ok: true; value: T } | { ok: false; error: Error };

/** The sentence for a thrown error: the bridge's own words when it sent some, else the generic one. */
export function describeError(error: Error): string {
  if (error instanceof ApiError) {
    const body = error.body.trim();
    if (body !== "" && !body.startsWith("{") && !body.startsWith("<")) return body;
    return t("apiError.unknown");
  }
  const message = error.message.trim();
  return message === "" ? t("apiError.unknown") : message;
}

/** A thunk, not a promise: the request cannot start outside the guard. */
export async function mutate<T>(call: () => Promise<T>): Promise<MutateOutcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    setStatus(describeError(error), "error");
    return { ok: false, error };
  }
}
