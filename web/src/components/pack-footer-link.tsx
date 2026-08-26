import { ChevronRight, Network } from "lucide-react";
import { useNavigate } from "react-router";

import { usePack } from "@/components/pack-provider";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { packPath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";
import { cn } from "@/lib/utils";

/**
 * The dashboard's way into /pack — the third entry point, beside the switcher sheet's footer and the
 * Settings card.
 *
 * ── WHY IT IS HERE ───────────────────────────────────────────────────────────
 * The dashboard footer is already the screen's META zone: which bundle you're running (BuildStamp)
 * and whether a newer one exists (UpdateBanner). Both answer "how is the thing I'm looking at
 * doing", not "what should I act on" — and "how is my pack doing" is the same question one level
 * out. Putting it anywhere in `<main>` would give it a claim on the operator's attention it hasn't
 * earned: the herd list is triage, and a census is never triage.
 *
 * ── WHY A LINE AND NOT A CARD ────────────────────────────────────────────────
 * A card is a surface that says "read me". Its neighbours here are single muted lines, and the pack
 * has nothing urgent to say from the dashboard — the census page says it. A card would also outweigh
 * UpdateBanner, which genuinely can be urgent, and sitting above it would invert the two.
 * The Settings card earns its box because Settings is a list OF cards; this is a list of lines.
 *
 * The whole thing renders `null` when `!multi` — a solo install must see byte-identical chrome,
 * which is the milestone's rule and the reason the gate is `usePack()` here rather than a check on
 * any loader's answer.
 */
export function PackFooterLink({ scope, className }: { scope?: Scope; className?: string }) {
  const navigate = useNavigate();
  useLocale();
  const { servers, multi } = usePack();
  if (!multi) return null;

  // Counted off the snapshot roster the provider already holds — the same field and the same filter
  // the host switcher uses. The census page fetches pack status; a footer line must not, or every
  // dashboard poll would drag a second request behind it for a caption.
  const reachable = servers.filter((s) => s.reachable).length;
  const counts = {
    machines: tn("pack.summary.machines", servers.length),
    reachable: t("pack.summary.reachable", { count: reachable }),
  };

  return (
    <button
      type="button"
      onClick={() => navigate(packPath(scope))}
      aria-label={t("pack.footer.aria")}
      className={cn(
        "flex w-full items-center justify-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground active:text-foreground",
        className,
      )}
    >
      <Network className="size-3 shrink-0" />
      <span>{t("pack.footer.label", counts)}</span>
      <ChevronRight className="size-3 shrink-0" />
    </button>
  );
}
