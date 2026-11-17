import { Progress } from "@/components/ui/progress";
import { useLocale } from "@/hooks/use-locale";
import { isHot, listSeenLine, seenLine, windowDetail, windowFigure, windowName, type AccountRow, type AccountWindow } from "@/lib/accounts";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The usage rows of the Accounts pages and of the New page's pick (M101). One window is one full-width
// row: its name, a bar and a figure, with the same label width and bar width in every account so two
// rows read as one column. The bars show how much is USED, hot from 80, as the dots above the belt do.
// The windows are the harness's own: none, one or several, never a fixed pair.

/** The columns of every usage row, in every account. */
const WIN_COLS = "grid grid-cols-[6.75rem_minmax(0,1fr)_3.5rem] items-center gap-x-3";

/** One window: label, bar, figure; with `long` the reset time under the label. */
export function WinRow({ win, long = false }: { win: AccountWindow; long?: boolean }) {
  useLocale();
  const known = win.usedPct !== null;
  const hot = isHot(win);
  const name = windowName(win);
  const detail = long ? windowDetail(win) : "";
  return (
    <div data-slot="account-window" className={WIN_COLS}>
      <div className="min-w-0 text-[11px] leading-4">
        <p className="truncate font-medium text-muted-foreground">{name}</p>
        {detail !== "" && <p className="truncate text-muted-foreground">{detail}</p>}
      </div>
      <Progress
        value={win.usedPct ?? 0}
        label={name}
        className={cn(hot && "[&>[data-slot=progress-fill]]:bg-status-blocked", !known && "opacity-50")}
      />
      <span
        className={cn(
          "text-right text-[11px] leading-4 tabular-nums",
          hot ? "text-status-blocked" : known ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {windowFigure(win)}
      </span>
    </div>
  );
}

/** The windows a harness reports, stacked, one row each; with none, one quiet line. */
export function Bars({ windows, long = false }: { windows: readonly AccountWindow[]; long?: boolean }) {
  useLocale();
  if (windows.length === 0) {
    return <p className="text-[11px] leading-4 text-muted-foreground">{t("accounts.window.none")}</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {windows.map((w) => (
        <WinRow key={w.window} win={w} long={long} />
      ))}
    </div>
  );
}

/** What a pick in New tells the person: the lead window of that account and when it was read. */
export function PickCaption({ row }: { row: AccountRow }) {
  useLocale();
  const lead = row.windows[0];
  const seen = seenLine(row);
  return (
    <div data-slot="account-caption" className="flex flex-col gap-1.5 rounded-md border border-border p-3">
      {lead === undefined ? <Bars windows={[]} /> : <WinRow win={lead} />}
      {seen !== null && <p className="text-[11px] leading-4 text-muted-foreground">{seen}</p>}
    </div>
  );
}

/** The session count or the last seen, and the folder, in one mono line. */
export function Foot({ row }: { row: AccountRow }) {
  useLocale();
  const seen = listSeenLine(row);
  const folder = row.kind === "default" ? t("accounts.folder.noVariable", { folder: row.folder }) : row.folder;
  const bits = [seen, folder].filter((x): x is string => x !== null);
  return <p className="truncate font-mono text-[11px] leading-4 text-muted-foreground">{bits.join(" · ")}</p>;
}
