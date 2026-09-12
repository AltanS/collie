import { BellRing, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useCacheWatchList } from "@/hooks/use-cache-watch-list";
import { useNotifyPrefs } from "@/hooks/use-notify-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import type { NotifyPrefs } from "@/lib/api";
import type { CacheWatchListEntry } from "@/lib/types";

// Which lifecycle events are worth a push. Bridge-wide (fans out to every device, like the snooze),
// so the copy says so. Four switches: "Needs input" (blocked, default on), "Finished" (done,
// default off), "App updates" (updates, default on), and "Cache about to go cold" (cache, default off).
// Optimistic toggle with revert on failure — see useNotifyPrefs.
//
// The fourth switch brings a section with it: the panes watched one by one from their own settings
// sheet, listed under it so the two-state rule is visible rather than implicit (ADR 0042).

const ROWS: ReadonlyArray<{ key: keyof NotifyPrefs; labelKey: MessageKey; hintKey: MessageKey }> = [
  { key: "blocked", labelKey: "settings.notify.blocked.label", hintKey: "settings.notify.blocked.hint" },
  { key: "done", labelKey: "settings.notify.done.label", hintKey: "settings.notify.done.hint" },
  {
    key: "updates",
    labelKey: "settings.notify.updates.label",
    hintKey: "settings.notify.updates.hint",
  },
  // The fourth, and the only one that is ALSO switchable per pane. Its hint says so, because the rule
  // is global OR per-pane with no per-pane off — a watched list keeps working under this switch, and an
  // operator who cannot see that would read a silent list as a list that stopped (ADR 0042).
  { key: "cache", labelKey: "settings.notify.cache.label", hintKey: "settings.notify.cache.hint" },
];

export function NotifyPrefsControl() {
  useLocale();
  const { prefs, busy, toggle } = useNotifyPrefs();
  const watched = useCacheWatchList();

  return (
    <NotifyPrefsCard
      prefs={prefs}
      busy={busy}
      onToggle={(key, next) => void toggle(key, next)}
      entries={watched.entries}
      entriesBusy={watched.busy}
      onForget={(id) => void watched.forget(id)}
    />
  );
}

/**
 * The card itself, with every value and every callback handed in.
 *
 * Split from the controller above for the reason the playground exists: this page is how Altan reviews
 * UI, and the states worth reviewing — four switches with real values, two watched panes, one of them on
 * a peer — are states no fetch can reach there (the playground stubs nothing, by rule). A presentational
 * component takes a fixture and renders the REAL markup; a stubbed hook would render a lie.
 */
export function NotifyPrefsCard({
  prefs,
  busy,
  onToggle,
  entries,
  entriesBusy,
  onForget,
}: {
  /** Null until the bridge answers. The switches stay disabled, the card's shape does not move. */
  prefs: NotifyPrefs | null;
  busy: boolean;
  onToggle: (key: keyof NotifyPrefs, next: boolean) => void;
  /** Null until the list answers, which renders as the empty line rather than as a gap. */
  entries: CacheWatchListEntry[] | null;
  entriesBusy: boolean;
  onForget: (id: string) => void;
}) {
  useLocale();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <BellRing className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.notify.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.notify.description")}</p>
          </div>
        </div>
        {!prefs && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {/* Rendered before `prefs` lands, not after. ROWS is static, so the card's SHAPE is known from
          the first frame — only the switch values are pending. Gating the whole list on `prefs` grew
          this card by ~180px a moment after paint and pushed the rest of the page down with it. The
          switches stay disabled until the real values arrive, so nothing can be toggled from a
          placeholder state. */}
      {ROWS.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between gap-4 border-t border-border px-4 py-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{t(row.labelKey)}</div>
              <p className="text-xs text-muted-foreground">{t(row.hintKey)}</p>
            </div>
            <Switch
              checked={prefs?.[row.key] ?? false}
              disabled={busy || !prefs}
              onCheckedChange={(next) => onToggle(row.key, next)}
              aria-label={t(row.labelKey)}
            />
          </div>
      ))}

      <WatchedPanes entries={entries} busy={entriesBusy} onForget={onForget} />
    </Card>
  );
}

/**
 * The panes watched one by one, under the four switches and inside the same card.
 *
 * ITS HEADING RENDERS FROM THE FIRST FRAME, which is the card's own rule two comments up: a section
 * that only appears once data lands pushes the rest of the page down a moment after paint. Only the
 * rows are pending.
 *
 * The markup is `paired-devices.tsx`'s, not a second answer to the same picture: one `ul` with
 * `divide-y` under a `border-t`, one row per entry, and a small outline button carrying an `aria-label`
 * that names what it removes.
 */
function WatchedPanes({
  entries,
  busy,
  onForget,
}: {
  entries: CacheWatchListEntry[] | null;
  busy: boolean;
  onForget: (id: string) => void;
}) {
  const count = entries?.length ?? 0;

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3">
        <div className="text-sm font-medium">{t("settings.notify.watched.title")}</div>
        {entries !== null && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
      </div>
      {/* Empty is ONE muted line, never an empty `ul`: a bordered list with nothing in it reads as a
          list that failed to load. */}
      {count === 0 ? (
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t("settings.notify.watched.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {entries?.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm">{entry.label}</div>
                {entry.host !== undefined && (
                  <p className="truncate text-xs text-muted-foreground">{entry.host}</p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={busy}
                onClick={() => onForget(entry.id)}
                aria-label={t("settings.notify.watched.removeAria", { label: entry.label })}
              >
                {t("settings.notify.watched.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
