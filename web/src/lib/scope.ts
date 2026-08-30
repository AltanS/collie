// The addressing scope: WHICH machine, and WHICH named session on it. Every read and every write in
// the app is scoped by this pair, and it is the one place the two params are composed into a string.
//
// Two dimensions, same shape, one level apart:
//   - session — Herdr can run several named sessions on one machine (each its own server/socket).
//     Travels as `?s=<name>` in the browser URL, `session=<name>` on the wire.
//   - host    — a pack can span several machines; the phone talks only to the lead, which merges its
//     peers. Travels as `?h=<member-id>` in the browser URL, `host=<member-id>` on the wire.
//
// **Absent means "today".** A blank/absent `s` is the primary session; a blank/absent `h` is the lead
// — the collie the phone is actually connected to. So a pack of one machine (solo, i.e. every install
// that exists today) emits NO `?h=` anywhere: every bookmark, deep link, notification payload and
// service-worker-cached navigation keeps resolving byte-identically. That is the whole
// backward-compatibility story, and it is achieved by normalisation, not by branching.
//
// **This module is deliberately react-free.** lib/session.ts owns the hooks (and therefore the
// react-router import) and re-exports everything here; the service worker (src/sw.ts) cannot import
// anything that pulls in react, and it needs to build these exact strings — see its hand-inlined
// sessionSearchParam(), which this module exists to eventually replace.
//
// A client-supplied host is only ever a REGISTRY KEY on the lead — it selects among members the
// trust store already holds. It never becomes a path, and never an address the lead dials. Same rule
// the session name has always carried, for the same reason.

/** The browser URL query key that carries the current session (short form). */
export const SESSION_PARAM = "s";

/** The browser URL query key that carries the current host (short form). Absent = the lead. */
export const HOST_PARAM = "h";

/**
 * The browser URL query key that WIDENS the home view to every session on the addressed host
 * (`?all=1`). Absent, and anything other than `1`, means "no".
 *
 * IT IS DELIBERATELY NOT PART OF {@link Scope}, and that is the load-bearing decision in this
 * feature. A scope is an ADDRESS — it says which pane a read or a write lands on, and it is threaded
 * into every pane URL and every cache key. Widening is a statement about how much of one machine the
 * HOME list shows. Folding it into the address would carry it onto pane URLs, into `paneScopeKey`,
 * and into the interning table, where it would mean nothing and split every cache entry in two.
 *
 * So it travels beside a scope and never inside one: {@link scopeSearch} appends it when asked, and
 * `paneScope` (lib/hosts.ts) never sees it, which is what guarantees a row opened from the widened
 * list produces the same URL it would have produced from the narrow one.
 */
export const ALL_PARAM = "all";

/**
 * Where a read or write is addressed. Both fields absent = the lead's primary session, i.e. exactly
 * today's behaviour and today's bytes.
 */
export interface Scope {
  /** The pack member id, or undefined for the lead (the collie the phone is connected to). */
  host?: string;
  /** The named Herdr session, or undefined for that host's primary session. */
  session?: string;
}

/** Normalise a raw `s` value to a session name, or `undefined` for the primary session. */
export function normalizeSession(raw: string | null | undefined): string | undefined {
  const s = raw?.trim();
  return s ? s : undefined;
}

/**
 * Normalise a raw `h` value to a host (pack member) id, or `undefined` for the lead. Blank and
 * whitespace-only normalise to the lead, mirroring {@link normalizeSession}.
 *
 * Deliberately NOT grammar-validated here. The lead is the authority on which member ids exist — an
 * unknown one is its 404 to give, and a departed host must render as unreachable rather than be
 * silently rewritten to the lead. Quietly redirecting a write to a different machine is the exact
 * failure this dimension exists to prevent.
 */
export function normalizeHost(raw: string | null | undefined): string | undefined {
  const h = raw?.trim();
  return h ? h : undefined;
}

/** A scope with both fields normalised (blank → undefined). */
export function normalizeScope(scope?: Scope): Scope {
  return { host: normalizeHost(scope?.host), session: normalizeSession(scope?.session) };
}

/** True when this scope addresses the lead itself (no host param) — the solo case, always. */
export function isLead(scope?: Scope): boolean {
  return normalizeHost(scope?.host) === undefined;
}

/**
 * The browser query string that carries a scope across a navigation: `""`, `?s=x`, `?h=b` or
 * `?h=b&s=x`.
 *
 * **The param order is canonical and fixed: `h`, then `s`, then `all`.** These strings are built independently
 * by more than one consumer and then COMPARED AS STRINGS — the service worker's focus-existing-client
 * check (`client.url !== url`) and the loaders' nav-vs-revalidate discriminator both do a full-URL
 * equality test. A differently-ordered but semantically identical string would open a spurious second
 * window and mis-classify a poll as a navigation. Pinned by a test.
 *
 * Lead + primary emits nothing at all, so a solo install never produces either param.
 */
export function scopeSearch(scope?: Scope, opts?: { all?: boolean }): string {
  const { host, session } = normalizeScope(scope);
  const parts: string[] = [];
  if (host) parts.push(`${HOST_PARAM}=${encodeURIComponent(host)}`);
  if (session) parts.push(`${SESSION_PARAM}=${encodeURIComponent(session)}`);
  // LAST, always — see the canonical-order note above. `all` is not part of the address, so it sorts
  // after both halves of it, and a caller that does not ask emits nothing new.
  if (opts?.all) parts.push(`${ALL_PARAM}=1`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Whether a URL's params ask for the widened view. Only the exact `1` counts — see {@link ALL_PARAM}. */
export function viewAllFromSearchParams(params: ParamsLike): boolean {
  return params.get(ALL_PARAM) === "1";
}

/** {@link viewAllFromSearchParams} against a full URL string. Unparseable → not widened. */
export function viewAllFromUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return viewAllFromSearchParams(new URL(url).searchParams);
  } catch {
    return false;
  }
}

/**
 * The query string for a session alone — kept as the narrow, session-only spelling of
 * {@link scopeSearch} for the places that genuinely have no host to carry (and for the solo
 * baseline, which pins that a session-only client puts nothing but `session=` on the wire).
 */
export function sessionSearch(session?: string): string {
  return scopeSearch({ session });
}

/** Anything URLSearchParams-shaped — so this stays react-free and testable with a plain object. */
interface ParamsLike {
  get(name: string): string | null;
}

/** Read a scope out of a URL's query params (`?h=` / `?s=`), normalised. */
export function scopeFromSearchParams(params: ParamsLike): Scope {
  return {
    host: normalizeHost(params.get(HOST_PARAM)),
    session: normalizeSession(params.get(SESSION_PARAM)),
  };
}

/** Read a scope out of a full URL string. Unparseable → the lead's primary session. */
export function scopeFromUrl(url: string | undefined): Scope {
  if (!url) return {};
  try {
    return scopeFromSearchParams(new URL(url).searchParams);
  } catch {
    return {};
  }
}

// ── Cache keys ───────────────────────────────────────────────────────────────
//
// A pane id (`w1:p1`) is unique only within one session on one machine: every session is a separate
// Herdr server, and every pack member is a separate machine again. So every composite client-side
// cache key carries the full (host, session, paneId) triple, NUL-joined so the fields stay
// unambiguous. Without the host component, the same `w1:p1` on two machines would 304 one host's
// mirror into the other's — the identical bug the session component was added to prevent, one
// dimension deeper.
//
// Host-first, and "" for absent, so a lead/primary key is `"\0"` + paneId — a pure prefix extension
// of what shipped, and byte-stable for every existing solo install.

const KEY_SEP = "\u0000";

/** Cache key for anything scoped to a (host, session) pair — snapshots, per-session flags. */
export function scopeKey(scope?: Scope): string {
  const { host, session } = normalizeScope(scope);
  return `${host ?? ""}${KEY_SEP}${session ?? ""}`;
}

/**
 * Cache key for a SNAPSHOT, which is a scope plus how much of it was asked for.
 *
 * The narrow key is byte-identical to {@link scopeKey}, so every entry a client already holds — in
 * this page's module cache and in the sessionStorage mirror that survives a PWA restart — keeps
 * resolving. Widening appends a suffix instead of re-keying, which is the same "a new state gets a
 * new key, the old state keeps its own" discipline the whole `all` param follows.
 *
 * The two breadths MUST NOT share an entry. They are different bodies for the same address, and a
 * shared key would let an offline fallback answer a narrow view with a widened herd — rows from
 * sessions the view does not claim to show, with no fetch to correct them.
 */
export function snapshotKey(scope: Scope | undefined, all = false): string {
  return all ? `${scopeKey(scope)}${KEY_SEP}${ALL_PARAM}` : scopeKey(scope);
}

/** Cache key for anything scoped to a single pane: the full (host, session, paneId) triple. */
export function paneScopeKey(scope: Scope | undefined, paneId: string): string {
  return `${scopeKey(scope)}${KEY_SEP}${paneId}`;
}

// ── Referential stability ────────────────────────────────────────────────────
//
// A scope is a VALUE, but it is passed as an object — and it lands in React dependency arrays and in
// `===` comparisons that used to hold a plain string (the composer's "did the pane I'm drafting for
// change?" check, and every useCallback in the pane view). A fresh object per loader run would make
// all of those churn on every poll, which is a behaviour change, not a style one.
//
// So scopes read off a URL are INTERNED: one frozen instance per distinct (host, session) pair, for
// the life of the page. Identity is then exactly as stable as the string it replaced. The table is
// bounded by the number of scopes the user actually visits — a handful, forever.
const interned = new Map<string, Scope>();

/** The canonical, frozen instance for a scope value — stable identity across loader runs. */
export function internScope(scope?: Scope): Scope {
  const { host, session } = normalizeScope(scope);
  const key = scopeKey({ host, session });
  const hit = interned.get(key);
  if (hit) return hit;
  const value = Object.freeze({ host, session });
  interned.set(key, value);
  return value;
}
