import { Network } from "lucide-react";
import type { JSX } from "react";

import { Card } from "@/components/ui/card";
import { t } from "@/lib/i18n";

// STUB. The dashboard's Crew tab body (ADR 0085). The real one, the machine cards with their spark
// charts, is built on another branch and replaces this file at merge. It only keeps this branch typechecking.
export function CrewTab(): JSX.Element {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Network className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="font-medium">{t("crew.title")}</div>
      </div>
    </Card>
  );
}
