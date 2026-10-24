import { Hand } from "lucide-react";

import { DismissButton, FLOATING_CARD } from "@/components/terminal-draft-preview";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * The Two fingers first-arm hint (ADR 0121, lib/pane-nav-hint.ts): once per device, on the first arm,
 * what the gesture is and where to turn it off. It stands on the same translucent card as the other
 * floating notices above the belt (ADR 0061, DESIGN.md §11), so it moves nothing when it comes or goes.
 * The x hides it, and the device never shows it again.
 */
export function PaneNavHint({ onDismiss }: { onDismiss: () => void }) {
  useLocale();
  return (
    <div data-slot="pane-nav-hint" role="status" className={FLOATING_CARD}>
      <Hand aria-hidden className="mt-0.5 size-3 shrink-0" />
      <div className="min-w-0 flex-1 self-center leading-snug">{t("paneNav.firstHint")}</div>
      <DismissButton onDismiss={onDismiss} label={t("paneNav.firstHint.dismissAria")} />
    </div>
  );
}
