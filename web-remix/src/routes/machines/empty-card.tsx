// The one card the Machines pages show when there is no census to show: this collie serves none (a peer
// opened directly answers 404), the fetch failed, or the id names no machine. Never a spinner, never
// blank. A 404 and a failure are different sentences, as on the Crew page.
import type { Handle } from "remix/component";
import { Server } from "lucide";

import { t } from "@web/lib/i18n";

import { useLocale } from "../../lib/i18n-store";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";

export type EmptyReason = "unavailable" | "error" | "unknown";

export function MachinesEmptyCard(handle: Handle<{ reason: EmptyReason }>) {
  useLocale(handle);
  return () => {
    const { reason } = handle.props;
    return (
      <Card class="gap-0 py-0" data-testid="machines-empty" data-reason={reason}>
        <div class="flex items-start gap-3 p-4">
          <Icon icon={Server} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <div class="font-medium">{t(`machines.${reason}.title`)}</div>
            <p class="text-sm text-muted-foreground">{t(`machines.${reason}.description`)}</p>
          </div>
        </div>
      </Card>
    );
  };
}
