import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/** The themes page on the site, at its opening section: what a theme is, and how to write one. The
 *  page keeps its name (`docs/themes.md`); a rename would break the site's sync. */
export const APPEARANCE_DOCS_URL = "https://colliepwa.dev/docs/themes#make-collie-your-own";

/**
 * The opening of Settings → Appearance: one heading, one sentence and a link to the docs. Not a
 * card, because it sets nothing: it names what the two cards under it are for (Theme, and
 * System/Light/Dark) and points at the page that explains them. Plain text on the page
 * background, so it reads as the page's own lead and never as a third control.
 */
export function AppearanceIntro() {
  useLocale();
  return (
    <section aria-labelledby="appearance-intro-title" className="space-y-1 px-1">
      <h2 id="appearance-intro-title" className="text-base font-semibold tracking-tight">
        {t("settings.appearance.intro.title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("settings.appearance.intro.body")}{" "}
        <a
          href={APPEARANCE_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("settings.appearance.intro.docs")}
        </a>
      </p>
    </section>
  );
}
