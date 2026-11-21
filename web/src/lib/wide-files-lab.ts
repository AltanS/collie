// LAB SWITCH, step 1 of the wide-files round (2026-11-21). `?fw=1|2|3` on any URL picks one of three proposals for
// Files and Changes on a large screen (and the dashboard's Files view); no switch is today's layout. Read once per page
// load and kept for the tab (sessionStorage), so a move to a file, a folder or back keeps the proposal. Removed with the
// losing code once the lead picks.

export type WideFilesLab = 0 | 1 | 2 | 3;

const KEY = "collie:lab:fw";

const LABS = new Map<string, WideFilesLab>([
  ["0", 0],
  ["1", 1],
  ["2", 2],
  ["3", 3],
]);

function read(): WideFilesLab {
  const raw = new URLSearchParams(window.location.search).get("fw");
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

let cached: WideFilesLab | null = null;

/** The proposal this page shows: 0 is today. */
export function wideFilesLab(): WideFilesLab {
  if (cached === null) cached = read();
  return cached;
}
