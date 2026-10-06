// The Settings index. Port of web/src/routes/settings.tsx: the install offer, one card of rows (four
// sections, Machines, and Experiments while it holds anything), the build stamp pinned to the bottom.
// Read web/'s header for why it is an index and why the rows run in this order.
//
// Machines is the one row that is not a section: it opens `/machines`, always offered, solo included.
// Experiments is the only row that can be absent: it renders while `@web/lib/experiments` holds
// something, because a row that opens an empty page is noise.
//
// `?pair=<code>` is the QR `collie pair` prints. web/ forwards it to System with a replace, the whole
// query intact (`pairLandingPath`), so Back does not return to the index; so does this one.
import { on, type Handle } from "remix/component";
import { Activity, Bell, ChevronRight, FlaskConical, Palette, Server, SlidersHorizontal, type IconNode } from "lucide";

import { hasExperiments } from "@web/lib/experiments";
import { t, type MessageKey } from "@web/lib/i18n";
import { homePath, machinesPath, pairLandingPath, settingsSectionPath } from "@web/lib/nav";
import type { Scope } from "@web/lib/scope";

import { navigate } from "../../lib/navigate";
import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Frame } from "../frame/frame";
import { goDown } from "../frame/up";
import { BuildStamp } from "./build-stamp";
import { InstallControl } from "./install";

interface Row {
  /** The row's own key, and for a section the word in its path. */
  id: string;
  to: (scope: Scope) => string;
  icon: IconNode;
  title: MessageKey;
  blurb: MessageKey;
}

// The order is the order of how standing a choice is: Appearance is changed most and first; System is
// the page you open when something is wrong.
const ROWS: readonly Row[] = [
  { id: "appearance", to: (s) => settingsSectionPath("appearance", s), icon: Palette, title: "settings.section.appearance.title", blurb: "settings.section.appearance.blurb" },
  { id: "device", to: (s) => settingsSectionPath("device", s), icon: SlidersHorizontal, title: "settings.section.device.title", blurb: "settings.section.device.blurb" },
  { id: "alerts", to: (s) => settingsSectionPath("alerts", s), icon: Bell, title: "settings.section.alerts.title", blurb: "settings.section.alerts.blurb" },
  { id: "system", to: (s) => settingsSectionPath("system", s), icon: Server, title: "settings.section.system.title", blurb: "settings.section.system.blurb" },
  { id: "machines", to: (s) => machinesPath(s), icon: Activity, title: "settings.section.machines.title", blurb: "settings.section.machines.blurb" },
  ...(hasExperiments()
    ? [
        {
          id: "experiments",
          to: (s: Scope) => settingsSectionPath("experiments", s),
          icon: FlaskConical,
          title: "settings.section.experiments.title",
          blurb: "settings.section.experiments.blurb",
        } satisfies Row,
      ]
    : []),
];

export function SettingsRoute(handle: Handle) {
  const where = useStore(handle, address);
  useLocale(handle);
  const landing = pairLandingPath(window.location.search);
  if (landing !== null) {
    handle.queueTask(() => void navigate(href(landing), { history: "replace" }));
  }
  return () => {
    const scope = where().scope;
    return (
      <Frame title={t("settings.title")} backLabel={t("settings.nav.back")} up={homePath(scope)}>
        <InstallControl />
        {/* ONE card of rows, not one card per row: they are siblings of one list. */}
        <Card class="gap-0 py-0">
          {ROWS.map((row, i) => (
            <button
              key={row.id}
              type="button"
              data-testid={`settings-row-${row.id}`}
              mix={on("click", () => goDown(row.to(where().scope)))}
              class={`flex w-full items-center gap-3 p-4 text-left active:bg-muted/60 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <Icon icon={row.icon} class="size-5 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <div class="font-medium">{t(row.title)}</div>
                <p class="truncate text-sm text-muted-foreground">{t(row.blurb)}</p>
              </div>
              <Icon icon={ChevronRight} class="size-5 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </Card>
        <div class="mt-auto flex flex-col gap-2 pt-4">
          <BuildStamp />
        </div>
      </Frame>
    );
  };
}
