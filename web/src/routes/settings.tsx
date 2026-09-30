import { ArrowLeft, Bell, ChevronRight, FlaskConical, Palette, Server, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { BuildStamp } from "@/components/build-stamp";
import { Card } from "@/components/ui/card";
import { InstallControl } from "@/components/install-control";
import { hasExperiments } from "@/lib/experiments";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t, type MessageKey } from "@/lib/i18n";
import { homePath, settingsSectionPath, type SettingsSection } from "@/lib/nav";
import { useScope } from "@/lib/session";

// ── THE SETTINGS INDEX ──────────────────────────────────────────────────────────────────────────
//
// Four rows, each opening a section (routes/settings-sections.tsx, which explains the split), plus
// a fifth while Experiments holds anything.
//
// This page used to BE the settings: seventeen cards in one column, over a thousand pixels of
// scroll on a phone, with no headings to skim by — the file argued for that, on the grounds that
// the first heading would imply four more. It implied four more. The cost was that finding one
// switch meant reading every card on the way to it, and the page grew every time anything shipped.
//
// The index does not remove a setting or move one between devices. It changes how many you are
// asked to read at once, and that is the whole of it.
//
// ── WHAT STAYS ON THIS PAGE, AND WHY ─────────────────────────────────────────
// `InstallControl` is not a setting: it is a one-shot offer the browser makes and then stops
// making, and it renders NOTHING unless that offer is actually on the table (lib/install.ts). On a
// phone that can install, it must not be filed under a heading nobody opens.
//
// `BuildStamp` stays because it is the answer to "what am I running", which is the question you ask
// before you go looking for anything else. It costs one line and it is also on the System page,
// where it sits with the rest of the diagnostics.

interface Row {
  section: SettingsSection;
  icon: LucideIcon;
  title: MessageKey;
  blurb: MessageKey;
}

// The order is the order of how standing a choice is. Appearance is changed most and changed first;
// System is the page you open when something is wrong, which is rarely and deliberately.
//
// Experiments trails all four, and it is the only row that can be absent: it renders while
// `lib/experiments.ts` holds something, because a row that opens an empty page is noise. It is last
// rather than beside Appearance because its members are not a subject, they are a CONTRACT — read
// `routes/settings-sections.tsx` for the whole argument, including why Chat's switch is not a card
// on Appearance.
const ROWS: Row[] = [
  {
    section: "appearance",
    icon: Palette,
    title: "settings.section.appearance.title",
    blurb: "settings.section.appearance.blurb",
  },
  {
    section: "device",
    icon: SlidersHorizontal,
    title: "settings.section.device.title",
    blurb: "settings.section.device.blurb",
  },
  { section: "alerts", icon: Bell, title: "settings.section.alerts.title", blurb: "settings.section.alerts.blurb" },
  { section: "system", icon: Server, title: "settings.section.system.title", blurb: "settings.section.system.blurb" },
  ...(hasExperiments()
    ? [
        {
          section: "experiments",
          icon: FlaskConical,
          title: "settings.section.experiments.title",
          blurb: "settings.section.experiments.blurb",
        } satisfies Row,
      ]
    : []),
];

export function SettingsRoute() {
  const nav = useNav();
  const scope = useScope();
  useLocale();

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* One header treatment app-wide, and it is a FACT rather than a claim: this route does not
          mount a header at all, it fills the one that is already there (RootLayout's
          <AppHeaderHost/>). The back button is `size-11` sitting at the row's `pl-4`, so its icon
          centre lands on the same 38px as the Collie mark it stands in for. */}
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px — the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => nav.up(homePath(scope))}
              aria-label={t("settings.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("settings.title")}</h1>
          </>
        }
      />

      <main className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        <InstallControl />

        {/* ONE card holding four rows, not four cards. They are a single list of siblings, and four
            separated cards would say they are four unrelated subjects. The divider is on the button
            rather than between them so the last row has none. */}
        <Card className="gap-0 py-0">
          {ROWS.map((row, i) => (
            <button
              key={row.section}
              type="button"
              onClick={() => nav.down(settingsSectionPath(row.section, scope))}
              className={`flex w-full items-center gap-3 p-4 text-left active:bg-muted/60 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <row.icon className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t(row.title)}</div>
                <p className="truncate text-sm text-muted-foreground">{t(row.blurb)}</p>
              </div>
              <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </Card>

        {/* Pinned to the bottom with `mt-auto`, exactly where it was before the split. */}
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <BuildStamp />
        </div>
      </main>
    </div>
  );
}
