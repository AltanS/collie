import { useCallback, useEffect, useState } from "react";

import { forgetCacheWatch, getCacheWatchList } from "@/lib/api";
import { mutate } from "@/lib/mutate";
import type { CacheWatchListEntry } from "@/lib/types";

// The panes watched one by one, for the Settings card under the four notify switches.
//
// READ-ONLY APART FROM REMOVAL. There is no add here: adding is the pane's own settings sheet, because
// a list in Settings cannot offer a choice the operator has to make while looking at a pane. What the
// list is for is making the second state VISIBLE — a pane keeps warning under the global switch, so the
// switch's hint says so and this list says which panes it means.
//
// The removal is optimistic with a loud revert, `use-notify-prefs.ts`'s posture: the row disappears
// under the thumb, the server's list is the last word, and a failure puts the row back WITH a sentence.
export function useCacheWatchList() {
  const [entries, setEntries] = useState<CacheWatchListEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getCacheWatchList()
      .then((body) => alive && setEntries(body.entries))
      .catch(() => {
        /* no list: the card's heading still renders, with nothing under it */
      });
    return () => {
      alive = false;
    };
  }, []);

  const forget = useCallback(async (id: string) => {
    const before = entries;
    setEntries((prev) => prev?.filter((e) => e.id !== id) ?? prev); // optimistic
    setBusy(true);
    const res = await mutate(() => forgetCacheWatch(id));
    if (res.ok) setEntries(res.value.entries);
    else setEntries(before); // revert, and `mutate` said why
    setBusy(false);
  }, [entries]);

  return { entries, busy, forget };
}
