import { TriangleAlert } from "lucide-react";

import { DismissButton, FLOATING_CARD } from "@/components/terminal-draft-preview";
import { Button } from "@/components/ui/button";
import { NOTICE_ACTION } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";

// The offer after failed sends (ADR 0123): "Sending failed 3 times. This may be a bug." (the count is
// the streak so far) with Report and a cross. It floats in the composer's floating column with the held
// and draft cards (ADR 0061), so it takes no space and moves nothing when it comes or goes. It never
// acts: Report only opens the sheet, where nothing leaves the phone without the person's own taps. The
// cross keeps it quiet on this pane until the streak ends. It sits beside the send's own notice, which
// still says why this send failed.
export function ReportCard({ count, onReport, onClose }: { count: number; onReport: () => void; onClose: () => void }) {
  useLocale();
  return (
    <div data-slot="report-card" className={FLOATING_CARD}>
      <TriangleAlert className="mt-0.5 size-3 shrink-0 text-status-working" />
      <div className="min-w-0 flex-1 self-center leading-snug">
        {tn("report.card.failed", count)} {t("report.card.bug")}
      </div>
      <Button
        variant="ghost"
        size="sm"
        data-slot="report-card-report"
        className={`${NOTICE_ACTION} shrink-0 self-center font-medium`}
        aria-label={t("report.card.reportAria")}
        onClick={onReport}
      >
        {t("report.card.report")}
      </Button>
      <DismissButton onDismiss={onClose} label={t("report.card.closeAria")} />
    </div>
  );
}
