// PLACEHOLDER, replaced by the Machines port (the frame and the header claim are already in place).
import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import { settingsPath } from "@web/lib/nav";

import { address } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Frame } from "../frame/frame";

export function MachinesRoute(handle: Handle) {
  const where = useStore(handle, address);
  return () => (
    <Frame title={t("machines.title")} backLabel={t("machines.nav.back")} up={settingsPath(where().scope)}>
      <p class="text-sm text-muted-foreground">{t("machines.title")}</p>
    </Frame>
  );
}
