// PLACEHOLDER, replaced by the Machine port (the frame and the header claim are already in place).
import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import { machinesPath } from "@web/lib/nav";

import { address } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Frame } from "../frame/frame";

export function MachineRoute(handle: Handle<{ machineId: string }>) {
  const where = useStore(handle, address);
  return () => (
    <Frame title={handle.props.machineId} backLabel={t("machines.nav.back")} up={machinesPath(where().scope)}>
      <p class="text-sm text-muted-foreground">{handle.props.machineId}</p>
    </Frame>
  );
}
