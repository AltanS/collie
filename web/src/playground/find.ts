// Finding an entry of the design reference by typing. DEV-ONLY, like the rest of `src/playground/`.
//
// An entry is found by its title, its id (the `#<id>` of its address, with or without the `#`) and its
// keywords: the component names it mounts and the feature words a person searches for ("walky",
// "worktree", "permission"). Every word of the query must be found somewhere in those, as a part of a
// word, in any case: "comp sheet" finds an entry whose keywords hold "Composer" and "PaneActionsSheet".
//
// The query lives in the address as `?q=`, beside the entry's `#<id>`, so a link carries both:
// `design.html?q=walky#walky`. It is written with `replaceState`, so typing adds no history entries.

/** What the finder needs of one entry. */
export interface Findable {
  readonly id: string;
  readonly title: string;
  readonly keywords: readonly string[];
}

/** The query's name in the address. */
export const QUERY_PARAM = "q";

/** The words of a query: lower case, a leading `#` dropped, empty words gone. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^#+/, ""))
    .filter((word) => word !== "");
}

/** Whether every word of the query is found in the entry's title, id or keywords. An empty query finds all. */
export function entryMatches(entry: Findable, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0) return true;
  const hay = [entry.title, entry.id, ...entry.keywords].join(" ").toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** The entries the query finds, in their own order. */
export function findEntries<T extends Findable>(entries: readonly T[], query: string): T[] {
  return entries.filter((entry) => entryMatches(entry, query));
}

/** The query the address carries, or the empty string. */
export function readQuery(): string {
  return new URLSearchParams(window.location.search).get(QUERY_PARAM) ?? "";
}

/** Put the query in the address, or take it out when empty. Keeps the path and the hash. */
export function writeQuery(query: string): void {
  const url = new URL(window.location.href);
  if (query === "") url.searchParams.delete(QUERY_PARAM);
  else url.searchParams.set(QUERY_PARAM, query);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, "", next);
  }
}
