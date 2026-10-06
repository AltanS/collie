import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";

import { href } from "../../routes";

// Placeholder: Settings and its Device section are a later task.
export function SettingsRoute(handle: Handle<{ section: "device" | null }>) {
  return () => (
    <main class="flex flex-col gap-3 p-4 text-sm">
      <h1 class="text-base font-semibold">{t("settings.title")}</h1>
      {handle.props.section === null ? <a href={href("/settings/device")}>{t("settings.section.device.title")}</a> : null}
      <a href={href("/")}>{t("nav.home.aria.default")}</a>
    </main>
  );
}
