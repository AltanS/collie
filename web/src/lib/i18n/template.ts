// How a message's `{slot}`s are filled — the one filler `t()`/`tn()` and the service worker share.
//
// Its own module because the service worker needs it and cannot import `./index`: that module reads
// `localStorage` and stamps `<html lang>` at load, and a worker woken by a push has neither (ADR 0074).
// This file holds no state and imports nothing.

/** Values for a message's `{slot}`s. An interface (not `Record<string, …>`) so the index signature
 *  has a named owner — see ADR 0019, `no-known-value-widening`. */
export interface TemplateVars {
  readonly [slot: string]: string | number;
}

/**
 * Fill a message's `{slot}`s.
 *
 * split/join, NOT `String.replaceAll` — the replacement half of `replaceAll` interprets `$&`, `$'`
 * and `$1`, so a value containing a dollar sign would be mangled into a capture reference. Nor is a
 * `RegExp` built from the slot name, which would let a key's punctuation become syntax.
 */
export function interpolate(template: string, vars: TemplateVars | undefined): string {
  if (vars === undefined) return template;
  let out = template;
  for (const [slot, value] of Object.entries(vars)) {
    out = out.split(`{${slot}}`).join(String(value));
  }
  return out;
}
