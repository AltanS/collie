// The react-facing half of addressing. The pure half — the params, the normalisers, the query
// builder and the cache-key helpers — lives in lib/scope.ts, which imports nothing from react so the
// service worker can share it. This module owns the HOOKS (and therefore the react-router import)
// and re-exports the pure pieces so existing importers of `lib/session` keep working unchanged.
//
// See lib/scope.ts for the addressing model: a scope is (host, session), both optional, and absent
// means "today" — the lead's primary session, no query params, byte-identical URLs.

import { useSearchParams } from "react-router";

import {
  SESSION_PARAM,
  internScope,
  normalizeSession,
  scopeFromSearchParams,
  type Scope,
} from "./scope";

export {
  HOST_PARAM,
  internScope,
  SESSION_PARAM,
  isLead,
  normalizeHost,
  normalizeScope,
  normalizeSession,
  paneScopeKey,
  scopeFromSearchParams,
  scopeFromUrl,
  scopeKey,
  scopeSearch,
  sessionSearch,
} from "./scope";
export type { Scope } from "./scope";

/** The current session name from the URL (`?s=`), or `undefined` when on the primary session. */
export function useSession(): string | undefined {
  const [params] = useSearchParams();
  return normalizeSession(params.get(SESSION_PARAM));
}

/**
 * The current addressing scope from the URL (`?h=` + `?s=`). Interned, so the returned object keeps a
 * stable identity across renders — it is threaded into effect/callback dependency arrays all over the
 * app, and a fresh object every render would churn every one of them.
 */
export function useScope(): Scope {
  const [params] = useSearchParams();
  return internScope(scopeFromSearchParams(params));
}
