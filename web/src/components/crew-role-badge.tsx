import { Crown, Shield } from "lucide-react";

import { t } from "@/lib/i18n";

/**
 * The small "lead" or "deputy" word with its glyph, beside a machine's or an instance's name. The
 * Machines sheet's rows and the crew page's machine cards share it.
 *
 * `rounded-md` (2px): an icon plus an uppercase word is a stadium, not a circle. Full-round is
 * reserved for shapes whose width equals their height (DESIGN.md §3).
 */
export function CrewRoleBadge({ kind }: { kind: "lead" | "deputy" }) {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium label-caps text-muted-foreground">
      {kind === "lead" ? <Crown className="size-2.5" aria-hidden /> : <Shield className="size-2.5" aria-hidden />}
      {kind === "lead" ? t("connection.host.lead") : t("crew.role.deputy")}
    </span>
  );
}
