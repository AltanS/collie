import { Activity, ArrowLeft, ArrowUpCircle, Bell, Bot, FlaskConical, Mic, Palette, Plug, Server, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { BuildStamp } from "@/components/build-stamp";
import { Card } from "@/components/ui/card";
import { SettingsNavRow } from "@/components/settings-nav-row";
import { InstallControl } from "@/components/install-control";
import { useModsPresent } from "@/components/mods-settings-card";
import { useUpdatesStatus } from "@/components/updates-settings-card";
import { hasExperiments } from "@/lib/experiments";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t, type MessageKey } from "@/lib/i18n";
import { homePath, machinesPath, settingsSectionPath, updatesPath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";
import { useScope } from "@/lib/session";
import { BandMain } from "@/components/ui/strip-host";

// ── THE SETTINGS INDEX ──────────────────────────────────────────────────────────────────────────
//
// Updates first, then five rows, each opening a section (routes/settings-sections.tsx, which explains the split), then
// Machines (a page, not a section) and, while Experiments holds anything, Experiments.
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
  /** The row's own key, and for a section the word in its path. */
  id: string;
  /** Where the row opens. A section is `/settings/<section>`; Machines is a page of its own. */
  to: (scope: Scope | undefined) => string;
  icon: LucideIcon;
  title: MessageKey;
  blurb: MessageKey;
}

// The order is the order of how standing a choice is. Appearance is changed most and changed first;
// System is the page you open when something is wrong, which is rarely and deliberately. Voice sits
// between Device and Alerts and, unlike Experiments, is never hidden: a host that offers no speech
// gets a page that says so, because a row that comes and goes teaches nobody where dictation lives.
//
// Experiments trails all four, and it is the only row that can be absent: it renders while
// `lib/experiments.ts` holds something, because a row that opens an empty page is noise. It is last
// rather than beside Appearance because its members are not a subject, they are a CONTRACT — read
// `routes/settings-sections.tsx` for the whole argument, including why Chat's switch is not a card
// on Appearance.
//
// Machines sits between System and Experiments and is the one row that is not a section: it opens
// `/machines`, a page with a list and a detail of its own, and it is always offered, solo included
// (a solo collie is one machine with a load worth watching).
const ROWS: Row[] = [
  {
    id: "appearance",
    to: (scope) => settingsSectionPath("appearance", scope),
    icon: Palette,
    title: "settings.section.appearance.title",
    blurb: "settings.section.appearance.blurb",
  },
  {
    id: "harnesses",
    to: (scope) => settingsSectionPath("harnesses", scope),
    icon: Bot,
    title: "settings.section.harnesses.title",
    blurb: "settings.section.harnesses.blurb",
  },
  {
    id: "device",
    to: (scope) => settingsSectionPath("device", scope),
    icon: SlidersHorizontal,
    title: "settings.section.device.title",
    blurb: "settings.section.device.blurb",
  },
  {
    id: "voice",
    to: (scope) => settingsSectionPath("voice", scope),
    icon: Mic,
    title: "settings.section.voice.title",
    blurb: "settings.section.voice.blurb",
  },
  {
    id: "alerts",
    to: (scope) => settingsSectionPath("alerts", scope),
    icon: Bell,
    title: "settings.section.alerts.title",
    blurb: "settings.section.alerts.blurb",
  },
  {
    id: "system",
    to: (scope) => settingsSectionPath("system", scope),
    icon: Server,
    title: "settings.section.system.title",
    blurb: "settings.section.system.blurb",
  },
  {
    id: "machines",
    to: (scope) => machinesPath(scope),
    icon: Activity,
    title: "settings.section.machines.title",
    blurb: "settings.section.machines.blurb",
  },
  ...(hasExperiments()
    ? [
        {
          id: "experiments",
          to: (scope) => settingsSectionPath("experiments", scope),
          icon: FlaskConical,
          title: "settings.section.experiments.title",
          blurb: "settings.section.experiments.blurb",
        } satisfies Row,
      ]
    : []),
];

// Mods sits after Machines and before Experiments: it is a standing list like the others, and, like
// Experiments, it is offered only when it has something to say.
const MODS_ROW: Row = {
  id: "mods",
  to: (scope) => settingsSectionPath("mods", scope),
  icon: Plug,
  title: "settings.section.mods.title",
  blurb: "settings.section.mods.blurb",
};

function rows(withMods: boolean): Row[] {
  if (!withMods) return ROWS;
  const at = ROWS.findIndex((row) => row.id === "experiments");
  return at === -1 ? [...ROWS, MODS_ROW] : [...ROWS.slice(0, at), MODS_ROW, ...ROWS.slice(at)];
}

export function SettingsRoute() {
  const nav = useNav();
  const scope = useScope();
  const updates = useUpdatesStatus();
  // Mods (M94): a row only while the phone holds a mods reply, so an install without mods is unchanged.
  const mods = useModsPresent();
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

      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        <InstallControl />

        {/* ONE card holding the rows, not one card per row. They are a single list of siblings, and
            separated cards would say they are unrelated subjects. The rows are a list group (M57 spec
            17): index.css draws the line between two rows, so the last has none, and a theme's
            `rows: cards` makes them cards inside this one card, like every other list. */}
        <Card className="gap-0 py-0">
          <div data-slot="list-group">
            {/* FIRST, because it is the one row whose answer changes without you touching anything: a
                release lands, a peer falls behind. The caption is the live status (the same words the
                Updates page opens with); a release waiting leads it with a 6px dot in the primary
                colour. The row is not in `ROWS`, whose captions are fixed strings. */}
            <SettingsNavRow
              icon={ArrowUpCircle}
              title={t("updates.entry.title")}
              caption={
                <>
                  {updates.available && (
                    <span
                      aria-hidden="true"
                      data-slot="update-dot"
                      className="mr-1.5 inline-block size-1.5 rounded-full bg-primary align-middle"
                    />
                  )}
                  {updates.line}
                </>
              }
              onOpen={() => nav.down(updatesPath(scope))}
            />
            {rows(mods).map((row) => (
              <SettingsNavRow
                key={row.id}
                icon={row.icon}
                title={t(row.title)}
                caption={t(row.blurb)}
                onOpen={() => nav.down(row.to(scope))}
              />
            ))}
          </div>
        </Card>

        {/* Pinned to the bottom with `mt-auto`, exactly where it was before the split. */}
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <BuildStamp />
        </div>
      </BandMain>
    </div>
  );
}
