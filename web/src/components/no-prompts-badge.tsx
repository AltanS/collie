import { Badge } from "@/components/ui/badge";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "No prompts", in words: this launcher starts an agent that acts without asking first (ADR 0094).
 * The caution ink the app already uses for a cautioning notice (`text-status-working`), on the
 * badge primitive's own box, so it owns no height or width of its own. `label` says the same fact in
 * the words of another place: the hill's Decision card says the session it answers "runs without
 * prompts" (M96).
 */
export function NoPromptsBadge({ className, label }: { className?: string; label?: string }) {
  useLocale();
  return (
    <Badge
      variant="outline"
      data-slot="no-prompts-badge"
      className={cn("border-status-working text-status-working", className)}
    >
      {label ?? t("newPage.noPrompts")}
    </Badge>
  );
}
