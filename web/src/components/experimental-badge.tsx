import { Badge } from "@/components/ui/badge";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "Experimental", in words: this session is a durable program, and what it shows may change shape in a
 * patch release (M55). The badge primitive's outline look in the muted ink, set to a 16px box so it
 * sits on a 20px line beside a name and never makes the line taller. One component for the two places
 * that wear it, the Spaces list's program row and the pane header, so the two cannot drift apart.
 */
export function ExperimentalBadge({ className }: { className?: string }) {
  useLocale();
  return (
    <Badge
      variant="outline"
      data-slot="experimental-badge"
      className={cn("h-4 px-1 py-0 text-[11px] leading-none text-muted-foreground", className)}
    >
      {t("session.experimental")}
    </Badge>
  );
}
