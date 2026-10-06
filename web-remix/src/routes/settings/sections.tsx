// The Settings section pages. Port of web/src/routes/settings-sections.tsx, read there for why the
// split is Appearance / Device / Alerts / System / Experiments.
//
// What this build carries, per section:
//   Appearance   the theme and the language
//   Device       the paired-devices card (the phase B3 contract puts pairing here; web/ files it under
//                System, so System carries the same card too and the read-only strip's
//                `/settings/system#paired-devices` link and the QR's forward both land on it)
//   System       the Updates row and the paired-devices card; crew and connection are not in this build
//   Experiments  the section's contract notice, as web/ (nothing is filed there)
//   Alerts       not in this build
import { navigate, on, type Handle } from "remix/component";
import { ChevronRight, FlaskConical, Info, RefreshCw } from "lucide";

import { t, type MessageKey } from "@web/lib/i18n";
import { settingsPath, updatesPath } from "@web/lib/nav";

import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Notice } from "../../ui/notice";
import { LanguageControl, ThemeControl } from "./appearance";
import { SettingsPage } from "./page";
import { PairedDevices } from "./paired-devices";

export type SettingsSection = "appearance" | "device" | "alerts" | "system" | "experiments";

const TITLES = {
  appearance: "settings.section.appearance.title",
  device: "settings.section.device.title",
  alerts: "settings.section.alerts.title",
  system: "settings.section.system.title",
  experiments: "settings.section.experiments.title",
} as const satisfies Record<SettingsSection, MessageKey>;

export function isSettingsSection(value: string): value is SettingsSection {
  return Object.hasOwn(TITLES, value);
}

/**
 * The one sentence with no dictionary key: the dictionary is web/'s and read-only from here, and no
 * existing string says "this part is not built yet". It names a gap of this shell, not of Collie, so
 * it goes away with the gap rather than into the seven translations.
 */
const NOT_IN_THIS_BUILD = "Not in this build yet.";

function NotInThisBuild() {
  return () => (
    <Notice variant="box" tone="neutral" icon={<Icon icon={Info} />}>
      {NOT_IN_THIS_BUILD}
    </Notice>
  );
}

/** The System page's row into /settings/updates (web/'s UpdatesSettingsCard, as a plain row). */
function UpdatesRow(handle: Handle) {
  const where = useStore(handle, address);
  useLocale(handle);
  return () => (
    <Card class="gap-0 py-0">
      <button
        type="button"
        class="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"
        mix={on("click", () => void navigate(href(updatesPath(where().scope))))}
      >
        <Icon icon={RefreshCw} class="size-5 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1 font-medium">{t("updates.title")}</div>
        <Icon icon={ChevronRight} class="size-5 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}

export function SettingsSectionRoute(handle: Handle<{ section: SettingsSection }>) {
  const where = useStore(handle, address);
  useLocale(handle);
  return () => {
    const { section } = handle.props;
    const up = settingsPath(where().scope);
    return (
      <SettingsPage title={TITLES[section]} up={up}>
        {section === "appearance" ? (
          <>
            <ThemeControl />
            <LanguageControl />
          </>
        ) : null}
        {section === "device" ? <PairedDevices /> : null}
        {section === "system" ? (
          <>
            <UpdatesRow />
            <PairedDevices />
            <NotInThisBuild />
          </>
        ) : null}
        {section === "experiments" ? (
          <Notice variant="box" tone="caution" icon={<Icon icon={FlaskConical} />}>
            {t("settings.experiments.contract")}
          </Notice>
        ) : null}
        {section === "alerts" ? <NotInThisBuild /> : null}
      </SettingsPage>
    );
  };
}
