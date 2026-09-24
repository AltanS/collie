import { Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Notice, NOTICE_ACTION } from "@/components/ui/notice";
import type { FitPhase } from "@/hooks/use-fit-to-phone";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

interface FitNoticeProps {
  phase: FitPhase;
  onRelease: () => void;
  /** The gutter — only the caller knows what the box sits between (ui/notice.tsx, BOX). */
  className?: string;
}

/**
 * The pane view's standing word that the desktop's copy of this pane is at phone size (ADR 0049).
 *
 * A §11 SCOPE NOTICE, not a floating chip: the condition outlives the operator's next interaction by
 * minutes, and it is changing a screen somebody else may be looking at, so it holds its place in the
 * column rather than fading out from under them. `Collapse` is how it arrives and leaves.
 *
 * It is up for the whole lease, `fitting` included, and that is load-bearing rather than cosmetic:
 * the notice takes a row of the column the mirror lives in, so it has to be ON screen when the mirror
 * is measured (hooks/use-fit-to-phone.ts `settleMs`), or the lease would be a few rows taller than
 * the mirror it is read through. Release is offered in both phases — pressed mid-fit it cancels, and
 * the box never changes shape between the two, only its words.
 */
export function FitNotice({ phase, onRelease, className }: FitNoticeProps) {
  useLocale();
  const open = phase.kind !== "idle";
  return (
    <Collapse open={open}>
      {open ? (
        <Notice
          variant="box"
          tone="info"
          announce="status"
          icon={<Smartphone />}
          className={className}
          action={
            <Button size="sm" variant="outline" className={NOTICE_ACTION} onClick={onRelease}>
              {t("paneActions.fit.releaseShort")}
            </Button>
          }
        >
          {/* A count that steps (DESIGN.md §5), so its digits hold their width as the size moves. */}
          <span className="tabular-nums">
            {phase.kind === "fitted"
              ? t("paneActions.fit.fitted", { cols: phase.cols, rows: phase.rows })
              : t("paneActions.fit.fitting")}
          </span>
        </Notice>
      ) : null}
    </Collapse>
  );
}
