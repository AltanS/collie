import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { apiErrorStatus, fetchThemeRegistry, refreshThemeRegistry } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { fileUrl, shortSha, type ThemeOrigin } from "@/lib/theme/origin";
import { repoUrl, reportUrl, type RegistryTheme } from "@/lib/theme/registry";
import type { Theme } from "@/lib/theme/schema";
import { matchRegistryOrigin } from "@/lib/theme/registry-match";
import type { UpdateExpected } from "@/lib/theme/store";
import { checkForUpdate } from "@/lib/theme/update-check";
import type { ThemeRegistryStatus } from "@/lib/types";

// About (theme sources): where an imported theme came from, and for a theme from the community list,
// whether the host's copy of that list holds a newer commit of its file.
//
// Every link is built here from the parts the store checked on read (origin.ts): the repo slug, the
// path and the full sha. Nothing stored is a URL, and the sheet draws every stored word as a text node.
//
// A FILE OR A PASTE THAT IS A LISTED THEME gets the same rows (registry-match.ts). A theme with no list
// origin is compared with the host's copy on content; exactly one matching entry gives the repository,
// the file at its commit, Report and Update. That source is derived each time the sheet opens and never
// stored, so no false install date appears: the line that said how the theme arrived stays.
//
// FETCHES NOTHING BY ITSELF. Opening the sheet reads the host's copy (`GET`, which fetches nothing on
// the host either). Check for updates is the one tap that asks the host to fetch the list, the same
// `POST` as Refresh in Browse. A tap is the consent.

type RegistryOrigin = Extract<ThemeOrigin, { kind: "registry" }>;

type CopyState =
  | { kind: "loading" }
  | { kind: "ready"; status: ThemeRegistryStatus }
  | { kind: "older" }
  | { kind: "failed" };

const LINK = "break-all text-foreground underline underline-offset-2";

/** The line that says how the theme reached this device, for a file, a paste or no record. */
function localSource(origin: ThemeOrigin | undefined): string {
  if (origin === undefined) return t("theme.about.device");
  if (origin.kind === "file") return t("theme.about.file", { date: dateTime(origin.at) });
  return t("theme.about.paste", { date: dateTime(origin.at) });
}

/** The commit a list theme is at: a stored origin's parts, or a source derived from the host's copy. */
type ListedAt = Pick<RegistryOrigin, "repo" | "path" | "sha">;

interface UpdatePartProps {
  origin: ListedAt;
  copy: CopyState;
  setCopy: (copy: CopyState) => void;
  onUpdate: (item: RegistryTheme) => void;
}

/** The update half of a registry theme's sheet: the answer from the host's copy, and the one tap. */
function UpdatePart({ origin, copy, setCopy, onUpdate }: UpdatePartProps) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<MessageKey | null>(null);

  async function check() {
    setChecking(true);
    setNote(null);
    try {
      setCopy({ kind: "ready", status: await refreshThemeRegistry() });
    } catch (err) {
      const code = apiErrorStatus(err);
      if (code === 404) setCopy({ kind: "older" });
      else if (code === 401 || code === 403) setNote("theme.browse.error.write");
      else setNote("theme.browse.error.fetch-failed");
    } finally {
      setChecking(false);
    }
  }

  if (copy.kind === "loading") return <p className="text-sm text-muted-foreground">{t("theme.browse.loading")}</p>;
  if (copy.kind === "older") {
    return (
      <Notice tone="info" variant="box" wrap>
        {t("theme.browse.older")}
      </Notice>
    );
  }
  const answer = copy.kind === "ready" ? checkForUpdate(origin, copy.status) : { kind: "unknown" as const };
  return (
    <div className="flex flex-col gap-2">
      {copy.kind === "failed" && (
        <Notice tone="danger" variant="box" wrap>
          {t("theme.browse.error.read")}
        </Notice>
      )}
      {note !== null && (
        <Notice tone="danger" variant="box" wrap>
          {t(note)}
        </Notice>
      )}
      {answer.kind === "newer" && (
        <>
          <Notice tone="info" variant="box" wrap>
            {t("theme.about.newer")}
          </Notice>
          <Button type="button" className="h-11" onClick={() => onUpdate(answer.item)}>
            {t("theme.about.update")}
          </Button>
        </>
      )}
      {answer.kind === "current" && <p className="text-sm text-muted-foreground">{t("theme.about.current")}</p>}
      {answer.kind === "unlisted" && <p className="text-sm text-muted-foreground">{t("theme.about.unlisted")}</p>}
      {answer.kind === "needs-newer" && <p className="text-sm text-muted-foreground">{t("theme.about.needsNewer")}</p>}
      {answer.kind === "unknown" && (
        <>
          <Button type="button" variant="outline" className="h-11" disabled={checking} onClick={() => void check()}>
            {checking ? t("theme.browse.refreshing") : t("theme.about.check")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("theme.about.checkNote")}</p>
        </>
      )}
    </div>
  );
}

interface AboutSheetProps {
  /** The imported theme to describe. `null` keeps the sheet shut. */
  theme: Theme | null;
  /** Where it came from, as the store holds it. Undefined: kept before origins, or a bad record. */
  origin: ThemeOrigin | undefined;
  onClose: () => void;
  /**
   * Update: the card opens its preview over the listed file, to replace this theme in its slot.
   * `expected` is what the slot held when the sheet compared (store.ts `replaceImported`).
   */
  onUpdate: (item: RegistryTheme, expected: UpdateExpected) => void;
}

/** The host's copy of the list, read once each time the sheet opens on a theme (`GET`, which fetches nothing). */
function useHostCopy(themeId: string | null): [CopyState, (copy: CopyState) => void] {
  const [copy, setCopy] = useState<CopyState>({ kind: "loading" });
  useEffect(() => {
    if (themeId === null) return;
    setCopy({ kind: "loading" });
    const controller = new AbortController();
    fetchThemeRegistry(controller.signal).then(
      (status) => setCopy({ kind: "ready", status }),
      (err: Error) => {
        if (controller.signal.aborted) return;
        setCopy(apiErrorStatus(err) === 404 ? { kind: "older" } : { kind: "failed" });
      },
    );
    return () => controller.abort();
  }, [themeId]);
  return [copy, setCopy];
}

/** The About sheet of one imported theme: its name and author, where it came from, and Update. */
export function ThemeAboutSheet({ theme, origin, onClose, onUpdate }: AboutSheetProps) {
  useLocale();
  const [copy, setCopy] = useHostCopy(theme === null ? null : theme.id);
  const stored = origin?.kind === "registry" ? origin : undefined;
  // A theme with no list origin: the one listed entry with the same content, if the copy has one.
  const derived = stored !== undefined || theme === null || copy.kind !== "ready" ? undefined : matchRegistryOrigin(theme, copy.status.themes);
  const listed: ListedAt | undefined = stored ?? derived;
  return (
    <BottomSheet open={theme !== null} onClose={onClose} title={t("theme.about.title")}>
      {theme !== null && (
        <div className="flex flex-col gap-3">
          <div>
            <div className="font-medium">{theme.name}</div>
            {theme.author !== undefined && (
              <div className="text-sm text-muted-foreground">{t("theme.preview.by", { author: theme.author })}</div>
            )}
          </div>

          {listed !== undefined ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t("theme.about.repo")}</dt>
                <dd className="min-w-0">
                  <a href={repoUrl(listed.repo)} target="_blank" rel="noopener noreferrer" className={LINK}>
                    {t("theme.about.repoLink", { repo: listed.repo })}
                  </a>
                </dd>
                <dt className="text-muted-foreground">{t("theme.about.path")}</dt>
                <dd className="min-w-0">
                  <a href={fileUrl(listed)} target="_blank" rel="noopener noreferrer" className={`${LINK} font-mono text-xs`}>
                    {listed.path}
                  </a>
                </dd>
                <dt className="text-muted-foreground">{t("theme.about.commit")}</dt>
                <dd className="font-mono text-xs leading-5">{shortSha(listed.sha)}</dd>
                {stored !== undefined && (
                  <>
                    <dt className="text-muted-foreground">{t("theme.about.installed")}</dt>
                    <dd>{dateTime(stored.at)}</dd>
                  </>
                )}
              </dl>
              {/* A derived source has no install date: the line that says how the theme arrived stays. */}
              {stored === undefined && <p className="text-sm text-muted-foreground">{localSource(origin)}</p>}
              <a
                href={reportUrl(listed)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("theme.browse.reportAria", { name: theme.name })}
                className="inline-flex min-h-11 items-center self-start text-xs text-muted-foreground underline underline-offset-2"
              >
                {t("theme.browse.report")}
              </a>
              {/* Keyed on the commit: after an update the sheet answers again for the new one. */}
              <UpdatePart
                key={listed.sha}
                origin={listed}
                copy={copy}
                setCopy={setCopy}
                onUpdate={(item) => onUpdate(item, stored !== undefined ? { sha: stored.sha } : { content: theme })}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{localSource(origin)}</p>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
