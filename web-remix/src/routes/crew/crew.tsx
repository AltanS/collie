// PLACEHOLDER, replaced by the Crew port (the frame and the header claim are already in place).
import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import { settingsSectionPath } from "@web/lib/nav";

import { address } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Frame } from "../frame/frame";

export function CrewRoute(handle: Handle) {
  const where = useStore(handle, address);
  return () => (
    <Frame title={t("crew.title")} backLabel={t("crew.nav.back")} up={settingsSectionPath("system", where().scope)}>
      <p class="text-sm text-muted-foreground">{t("crew.title")}</p>
    </Frame>
  );
}
