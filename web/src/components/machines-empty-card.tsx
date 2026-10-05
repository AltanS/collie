import { Server } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * The one card the Machines pages show when there is no census to show: this collie serves none (a
 * peer opened directly answers 404), the fetch failed, or the id names no machine. Never a spinner,
 * never blank. A 404 and a failure are different sentences, as on the Crew page: the first says there
 * is nothing to report here, the second says we could not ask.
 */
export function MachinesEmptyCard({ reason }: { reason: "unavailable" | "error" | "unknown" }) {
  useLocale();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Server className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t(`machines.${reason}.title`)}</div>
          <p className="text-sm text-muted-foreground">{t(`machines.${reason}.description`)}</p>
        </div>
      </div>
    </Card>
  );
}
