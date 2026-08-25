import { useEffect, useState } from "react";

import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useTopologyLatency } from "@/lib/mux-capability";

// HOW FRESH IS THIS SCREEN — and only where that question has an answer worth giving.
//
// Under a multiplexer that ANNOUNCES its structure changes there is nothing to reassure anybody
// about: the herd on screen is the herd, within a network hop, and a running counter would be a
// clock nobody needs to read. Under one that CENSUSES there is a real bound — the bridge declares
// it — and a tab the operator renamed in their own terminal genuinely can be a few seconds behind.
// That is the case this line exists for, and it is the only case it renders in.
//
// IT READS THE DECLARATION, NEVER THE NAME (ADR 0031). `useTopologyLatency()` answers `push` for a
// bridge that has not spoken, so an older bridge and a cached page both render nothing at all —
// which is exactly what they rendered before this component existed.
//
// The NUMBER is the snapshot's own `ts`, so it measures what the operator actually has: the age of
// the data on screen. Not the age of the last census, and not a timer this component started —
// either of those would keep counting reassuringly while the poll behind them was failing.
//
// IT IS CHROME, SO IT LIVES IN THE CHROME. AppHeader mounts it — no route does. It was once a row a
// route rendered under the header, which made the bar taller on the dashboard than in a space and
// jumped the layout on every navigation between them. Rendered inside the header row it cannot
// change that row's height in any state: the row is sized by the 40px Collie mark every header
// carries, and this is one 16px line beside it.

/** How often the line re-reads the clock. One second: it counts seconds, so it must move in them. */
const TICK_MS = 1000;

/**
 * The age of a snapshot, in the terse register the rest of the app uses.
 *
 * Seconds below a minute, and the shared compact form above it. Pure + exported so the boundary is
 * asserted directly: `timeAgoShort` answers "now" under a minute, which is the right answer in a
 * column of pane ages and the wrong one here — "synced now ago" is not a sentence, and the whole
 * point of this line is the seconds it is willing to name.
 */
export function syncAge(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  return seconds < 60 ? `${String(seconds)}s` : timeAgoShort(ts, now);
}

/** How old the herd on screen is — rendered only when the bridge said its freshness is bounded. */
export function SyncStamp({ ts, className }: { ts?: number; className?: string }) {
  useLocale();
  const latency = useTopologyLatency();
  const [now, setNow] = useState(() => Date.now());
  const bounded = latency.kind === "bounded";

  useEffect(() => {
    if (!bounded) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [bounded]);

  // No declaration of boundedness, or no snapshot stamp to age: render NOTHING. Not a placeholder —
  // a greyed "synced —" would be a worse header than no line, exactly as the mux name's own rule says.
  if (!bounded || ts === undefined) return null;
  return (
    <p className={className}>
      <span className="text-xs text-muted-foreground">
        {t("sync.age", { age: syncAge(ts, now) })}
      </span>
    </p>
  );
}
