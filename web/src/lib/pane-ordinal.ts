import { paneName } from "@/lib/pane-name";
import type { AgentView } from "@/lib/types";

/**
 * WHICH PILLS NEED A NUMBER, AND WHAT THE NUMBER IS.
 *
 * The pane switcher used to print the multiplexer's own pane id suffix — `p3` — on every pill, and
 * the pane header appended the same suffix to its title. The man who built Collie, reading his own
 * phone: "idk what pN means". It is Herdr's coordinate, not a name, and it was on screen whether or
 * not there was anything to tell apart.
 *
 * So a pill is numbered only when it needs to be: when another pill in the same tab would otherwise
 * carry exactly the same text. Two claudes in one tab read `claude 1` and `claude 2`; a claude beside
 * a codex reads `claude` and `codex`, with no numbers anywhere, which is the common case and now
 * costs nothing.
 *
 * The number is the pane's 1-BASED POSITION IN THE ROW, not its id suffix and not a count of the
 * duplicates: the reader is looking at the row, the row is in a stable order, and "the second one" is
 * the thing they can actually see. A pane id would be true and unreadable.
 *
 * Returns the ordinals by pane id, holding an entry only for a pane that has earned one — so a tab
 * with nothing to disambiguate produces an empty map and no pill is decorated.
 */
export function paneOrdinals(panes: readonly AgentView[]): ReadonlyMap<string, number> {
  const seen = new Map<string, number>();
  for (const pane of panes) {
    const name = paneName(pane);
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  panes.forEach((pane, index) => {
    if ((seen.get(paneName(pane)) ?? 0) > 1) out.set(pane.paneId, index + 1);
  });
  return out;
}
