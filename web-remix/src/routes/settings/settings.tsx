// The Settings index. Port of web/src/routes/settings.tsx: one card of section rows, the build stamp
// pinned to the bottom. Read web/'s header for why it is an index and why the rows run in this order.
//
// Rows not offered here: Machines (a page of its own, `/machines`, not in this build) and
// Experiments while `@web/lib/experiments` holds nothing, exactly as web/ hides it.
//
// `?pair=<code>` is the QR `collie pair` prints. web/ forwards it to System with a replace, the whole
// query intact (`pairLandingPath`), so Back does not return to the index; so does this one.
import { navigate, on, type Handle } from "remix/component";
import { ArrowLeft, Bell, ChevronRight, FlaskConical, Palette, Server, SlidersHorizontal, type IconNode } from "lucide";

import { buildLabel } from "@web/lib/build";
import { hasExperiments } from "@web/lib/experiments";
import { t, type MessageKey } from "@web/lib/i18n";
import { homePath, pairLandingPath, settingsSectionPath } from "@web/lib/nav";

import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import type { SettingsSection } from "./sections";

interface Row {
  id: SettingsSection;
  icon: IconNode;
  title: MessageKey;
  blurb: MessageKey;
}

const ROWS: readonly Row[] = [
  { id: "appearance", icon: Palette, title: "settings.section.appearance.title", blurb: "settings.section.appearance.blurb" },
  { id: "device", icon: SlidersHorizontal, title: "settings.section.device.title", blurb: "settings.section.device.blurb" },
  { id: "alerts", icon: Bell, title: "settings.section.alerts.title", blurb: "settings.section.alerts.blurb" },
  { id: "system", icon: Server, title: "settings.section.system.title", blurb: "settings.section.system.blurb" },
  ...(hasExperiments()
    ? [
        {
          id: "experiments",
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
      <div class="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
        <header class="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-2 [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
          <Button
            variant="ghost"
            size="icon"
            class="-ml-2 size-11"
            aria-label={t("settings.nav.back")}
            mix={on("click", () => void navigate(href(homePath(scope))))}
          >
            <Icon icon={ArrowLeft} class="size-5" />
          </Button>
          <h1 class="min-w-0 truncate text-lg font-semibold tracking-tight">{t("settings.title")}</h1>
        </header>
        <main class="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
          {/* ONE card of rows, not one card per row: they are siblings of one list. */}
          <Card class="gap-0 py-0">
            {ROWS.map((row, i) => (
              <button
                key={row.id}
                type="button"
                mix={on("click", () => void navigate(href(settingsSectionPath(row.id, scope))))}
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
          <p class="mt-auto pt-4 text-center font-mono text-xs text-muted-foreground" data-testid="build-stamp">
            {buildLabel()}
          </p>
        </main>
      </div>
    );
  };
}
