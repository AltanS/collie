// Named-session support. Herdr can run several named sessions (each its own server/socket); one
// bridge fans them out and the web app scopes every read/write to a session. The session travels in
// the browser URL as the short `?s=<name>` param (translated to `session=` on API calls by lib/api).
// Absent / blank → the primary session, so a single-session install sees no `?s=` and behaves exactly
// as before (fully backward compatible).

import { useSearchParams } from "react-router";

/** The browser URL query key that carries the current session (short form). */
export const SESSION_PARAM = "s";

/** Normalise a raw `s` value to a session name, or `undefined` for the primary session. */
export function normalizeSession(raw: string | null | undefined): string | undefined {
  const s = raw?.trim();
  return s ? s : undefined;
}

/** The current session name from the URL (`?s=`), or `undefined` when on the primary session. */
export function useSession(): string | undefined {
  const [params] = useSearchParams();
  return normalizeSession(params.get(SESSION_PARAM));
}

/**
 * The query string (`""` or `?s=<encoded>`) that carries the session across a navigation. Pure, so
 * nav.ts can compose it into paths without pulling in a hook. Primary session → empty (no param).
 */
export function sessionSearch(session?: string): string {
  const s = normalizeSession(session);
  return s ? `?${SESSION_PARAM}=${encodeURIComponent(s)}` : "";
}
