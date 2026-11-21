// LAB SWITCH, step 1 of the wide-home round (2026-11-21). `?dw=1|2|3` on the dashboard's URL picks one of three
// proposals for the dashboard on a large screen; no switch is today's layout. Read once per page load and kept
// for the tab (sessionStorage), so a move to a pane and back keeps the proposal. Removed with the losing code
// once the lead picks.

export type WideHomeLab = 0 | 1 | 2 | 3;

const KEY = "collie:lab:dw";

const LABS = new Map<string, WideHomeLab>([
  ["0", 0],
  ["1", 1],
  ["2", 2],
  ["3", 3],
]);

function read(): WideHomeLab {
  const raw = new URLSearchParams(window.location.search).get("dw");
  const asked = raw === null ? undefined : LABS.get(raw);
  if (raw !== null && asked !== undefined) {
    try {
      window.sessionStorage.setItem(KEY, raw);
    } catch {
      // A private window may refuse storage; the URL still says it.
    }
    return asked;
  }
  try {
    const kept = window.sessionStorage.getItem(KEY);
    return kept === null ? 0 : (LABS.get(kept) ?? 0);
  } catch {
    // As above.
  }
  return 0;
}

let cached: WideHomeLab | null = null;

/** The proposal this page shows: 0 is today. */
export function wideHomeLab(): WideHomeLab {
  if (cached === null) cached = read();
  return cached;
}
