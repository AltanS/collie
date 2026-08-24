// ── THE PHONE'S HALF OF THE ERROR CATALOGUE — one refusal, said in the operator's language ───────
//
// The bridge sends English prose and, beside it, a stable code (`bridge/error-codes.ts`). This module
// is the only place that turns the second into a sentence: `describeApiError` for a refusal that came
// back as a VALUE (`{ ok: false, … }`), `describeThrownError` for one that came back as a THROW.
//
// THE FALLBACK LADDER, in order, and it never ends in a raw key or an empty string:
//   1. A code this build knows          → `t("apiError.<code>", detail)` — the translated sentence.
//   2. Any other code, or no code       → the body's own `error` string, which is true English prose.
//   3. A throw that is not an ApiError  → its `message` (a transport failure, an aborted fetch).
//   4. Nothing usable at all            → `t("apiError.unknown")`.
//
// Step 2 is the whole reason the bridge still ships a sentence, and it is what makes a NEWER bridge
// safe: a code invented after this build shipped is not a bug and must never render as `apiError.x`.
//
// WHAT THIS DOES NOT TOUCH: any branch that MATCHES on a code (`res.code === "prompt_changed"` in
// lib/dialog-guard.ts and friends) is control flow, not display. Those keep matching on the code
// exactly as before; only the words that reach the screen come from here.

import { isApiErrorCode, type ApiErrorFields } from "./api-error-codes";
import { apiErrorFields } from "./api";
import { t } from "./i18n";

/**
 * The sentence for a refusal the bridge answered with — an `{ ok: false }` body, or the fields parsed
 * off a non-2xx one.
 *
 * Every `ok: false` shape in lib/types.ts is structurally an {@link ApiErrorFields}, so a caller
 * passes the narrowed body itself and nothing has to be picked apart at the call site.
 */
export function describeApiError(fields: ApiErrorFields, fallback?: string): string {
  const { code, detail } = fields;
  // The template-literal key is what makes the catalogue complete by construction: if `en.ts` were
  // missing `apiError.<code>` for any member of the union, this line would not compile.
  if (isApiErrorCode(code)) return t(`apiError.${code}`, detail);
  const sentence = fields.error?.trim() ?? "";
  if (sentence !== "") return sentence;
  // `fallback` is the CALLER'S surface-specific line ("Rename failed") for a body that carried no
  // words at all. It sits below the bridge's own sentence deliberately: an unrecognised code still
  // ships true English prose, and "Rename failed" says strictly less than that.
  return fallback ?? t("apiError.unknown");
}

/**
 * The sentence for a caught throw — the same ladder, plus the two rungs only a throw can land on.
 *
 * Generic rather than `unknown` so it can be handed a `catch` binding directly (the house style, as
 * in lib/reply-action.ts's `message`). A thrown `ApiError` carries the fields it parsed off the
 * refusal body; anything else is a transport failure whose own message is the most honest thing
 * there is to say.
 */
export function describeThrownError<TThrown>(thrown: TThrown): string {
  const fields = apiErrorFields(thrown);
  if (fields !== undefined) return describeApiError(fields);
  if (thrown instanceof Error) {
    const message = thrown.message.trim();
    if (message !== "") return message;
  }
  return t("apiError.unknown");
}
