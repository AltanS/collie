import { useEffect, useMemo, useState } from "react";

import { PageSample, ThemeMarkLine } from "@/components/theme-page-sample";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { apiErrorStatus, fetchThemeRegistry, refreshThemeRegistry } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { readRegistryEntry, repoUrl, reportUrl, type RegistryTheme } from "@/lib/theme/registry";
import type { Theme } from "@/lib/theme/schema";
import type { ThemeRegistryStatus } from "@/lib/types";

// The community Browse sheet (M59 spec 06): the themes people share with the topic
// `colliepwa-theme`, from the HOST's copy of the site's registry.
//
// WHAT THIS SHEET NEVER DOES. It never fetches from the site: it reads `/api/themes/registry` on its
// own origin, and only a tap on Refresh makes the host reach out (`connect-src 'self'`, ADR 0106).
// It never draws an entry it did not check itself: every entry goes through `readRegistryEntry`,
// which runs `parseTheme`, whatever the host checked. Names, authors and slugs are text nodes. The
// repo link and the Report link are built here from a checked slug; the registry names no URL.
// Install hands a parsed theme to the card, which opens the same preview sheet a file opens, so the
// contrast report, the eight-theme cap and the shipped-id rule all hold.

type BrowseState =
  | { kind: "loading" }
  | { kind: "ready"; status: ThemeRegistryStatus }
  /** The GET failed for a reason other than an older host. */
  | { kind: "failed" }
  /** The host answered 404: a Collie from before the route. */
  | { kind: "older" };

const ERROR_KEYS = {
  "fetch-failed": "theme.browse.error.fetch-failed",
  "too-big": "theme.browse.error.too-big",
  "bad-registry": "theme.browse.error.bad-registry",
} as const satisfies Record<NonNullable<ThemeRegistryStatus["error"]>, MessageKey>;

interface BrowseSheetProps {
  open: boolean;
  onClose: () => void;
  /** Install: the card opens its preview sheet over this theme. */
  onInstall: (theme: Theme) => void;
  /** Try: the card starts a trial of this theme (M59 spec 08). Absent draws no Try button. */
  onTry?: (theme: Theme) => void;
}

/** The entries of a status the phone accepts, in the registry's own order. */
export function acceptedThemes(status: ThemeRegistryStatus): RegistryTheme[] {
  return status.themes.flatMap((value) => {
    const read = readRegistryEntry(value);
    return read === undefined ? [] : [read];
  });
}

interface RowProps {
  item: RegistryTheme;
  onInstall: (theme: Theme) => void;
  onTry?: (theme: Theme) => void;
}

function ThemeRow({ item, onInstall, onTry }: RowProps) {
  const { entry, theme } = item;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="grid grid-cols-2 gap-2">
        <PageSample theme={theme} half="light" />
        <PageSample theme={theme} half="dark" />
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{theme.name}</div>
          {theme.author !== undefined && (
            <div className="truncate text-sm text-muted-foreground">{t("theme.preview.by", { author: theme.author })}</div>
          )}
          <ThemeMarkLine theme={theme} />
          <a
            href={repoUrl(entry.repo)}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-mono text-xs text-muted-foreground underline underline-offset-2"
          >
            {entry.repo}
          </a>
        </div>
        <a
          href={reportUrl(entry)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("theme.browse.reportAria", { name: theme.name })}
          className="inline-flex min-h-11 shrink-0 items-center text-xs text-muted-foreground underline underline-offset-2"
        >
          {t("theme.browse.report")}
        </a>
      </div>
      <div className={onTry === undefined ? "grid grid-cols-1 gap-2" : "grid grid-cols-2 gap-2"}>
        {onTry !== undefined && (
          <Button type="button" variant="outline" className="h-11" onClick={() => onTry(theme)}>
            {t("theme.trial.try")}
          </Button>
        )}
        <Button type="button" className="h-11" onClick={() => onInstall(theme)}>
          {t("theme.browse.install")}
        </Button>
      </div>
    </li>
  );
}

/** The age line under the title: when the host fetched its copy, or that it never did. */
function ageLine(status: ThemeRegistryStatus): string {
  if (status.ageMs === null) return t("theme.browse.never");
  return t("theme.browse.age", { age: timeAgo(Date.now() - status.ageMs) });
}

export function ThemeBrowseSheet({ open, onClose, onInstall, onTry }: BrowseSheetProps) {
  useLocale();
  const [state, setState] = useState<BrowseState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<MessageKey | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    setNote(null);
    fetchThemeRegistry(controller.signal).then(
      (status) => setState({ kind: "ready", status }),
      (err: Error) => {
        if (controller.signal.aborted) return;
        setState(apiErrorStatus(err) === 404 ? { kind: "older" } : { kind: "failed" });
      },
    );
    return () => controller.abort();
  }, [open]);

  async function refresh() {
    setRefreshing(true);
    setNote(null);
    try {
      setState({ kind: "ready", status: await refreshThemeRegistry() });
    } catch (err) {
      const code = apiErrorStatus(err);
      if (code === 404) setState({ kind: "older" });
      else if (code === 401 || code === 403) setNote("theme.browse.error.write");
      else {
        // A failed fetch answers 502 with the old copy and its word; read it back to show both.
        try {
          setState({ kind: "ready", status: await fetchThemeRegistry() });
        } catch {
          setNote("theme.browse.error.read");
        }
      }
    } finally {
      setRefreshing(false);
    }
  }

  const status = state.kind === "ready" ? state.status : null;
  const items = useMemo(() => (status === null ? [] : acceptedThemes(status)), [status]);
  const leftOut = status === null ? 0 : status.dropped + (status.themes.length - items.length);

  return (
    <BottomSheet open={open} onClose={onClose} title={t("theme.browse.title")}>
      {open && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("theme.browse.intro")}</p>

          {state.kind === "older" ? (
            <Notice tone="info" variant="box" wrap>
              {t("theme.browse.older")}
            </Notice>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-xs text-muted-foreground">
                <div>{status === null ? t("theme.browse.loading") : ageLine(status)}</div>
                <div>{t("theme.browse.refreshNote")}</div>
              </div>
              <Button type="button" variant="outline" className="h-11 shrink-0" disabled={refreshing || state.kind === "loading"} onClick={() => void refresh()}>
                {refreshing ? t("theme.browse.refreshing") : t("theme.browse.refresh")}
              </Button>
            </div>
          )}

          {note !== null && (
            <Notice tone="danger" variant="box" wrap>
              {t(note)}
            </Notice>
          )}
          {state.kind === "failed" && (
            <Notice tone="danger" variant="box" wrap>
              {t("theme.browse.error.read")}
            </Notice>
          )}
          {status?.error !== undefined && (
            <Notice tone="caution" variant="box" wrap>
              {t(ERROR_KEYS[status.error])}
            </Notice>
          )}
          {status !== null && items.length === 0 && (
            <Notice tone="neutral" variant="box" wrap>
              {t("theme.browse.empty")}
            </Notice>
          )}
          {leftOut > 0 && <p className="text-xs text-muted-foreground">{t("theme.browse.dropped", { count: leftOut })}</p>}

          {items.length > 0 && (
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <ThemeRow key={`${item.entry.repo}/${item.entry.path}@${item.entry.sha}`} item={item} onInstall={onInstall} onTry={onTry} />
              ))}
            </ul>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
