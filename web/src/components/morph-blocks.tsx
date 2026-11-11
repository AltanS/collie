import { useId, useState, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FoldPanel } from "@/components/ui/fold-toggle";
import { OneOf } from "@/components/ui/one-of";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { MorphReceipt, MorphSendPhase } from "@/lib/morph/reader";
import type { ViewPictures } from "@/lib/tricks/render";
import { cn } from "@/lib/utils";

// THE PARTS OF THE MORPH BODY that are its own (components/morph-view.tsx composes them): a pending
// block's placeholder, the "Earlier screen" fold that holds the blocks drawn for an earlier request,
// and the receipt that stands in for the request bubble when the request was a pick or a tap.

/**
 * A block the agent said is in work (`morph pending`): its label and two calm bars that breathe
 * (`.count-skeleton`, which holds still under reduced motion). A pending block in the Earlier fold
 * does not breathe: nothing is in work for it any more.
 */
export function MorphPendingBlock({ label, isLive }: { label: string; isLive: boolean }) {
  return (
    <div data-slot="morph-pending" aria-busy={isLive || undefined} className="flex min-w-0 flex-col gap-2 py-1">
      <p className="truncate text-sm text-muted-foreground">{label}</p>
      <span aria-hidden className={cn("h-2.5 w-4/5 rounded-full bg-muted", isLive && "count-skeleton")} />
      <span aria-hidden className={cn("h-2.5 w-3/5 rounded-full bg-muted", isLive && "count-skeleton")} />
    </div>
  );
}

export interface MorphEarlierProps {
  /** The screen's title, when the fresh part does not show it. */
  title: string | undefined;
  /** How long ago the newest stale block was drawn, in words, or null. */
  age: string | null;
  /** The stale blocks, and the stale choice, as drawn: full contrast, out of reach. */
  children: ReactNode;
}

/**
 * The blocks the agent drew for an earlier request, folded under one quiet row: "Earlier screen", the
 * title and the age. Folded when it appears (the caller keys it by the request, so a new request folds
 * it again). Open, it shows a small "Earlier" label and the blocks at full contrast; every control in
 * them is out of reach (`inert`), and looks as it did, never disabled.
 */
export function MorphEarlier({ title, age, children }: MorphEarlierProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <section data-slot="morph-earlier" className="mt-4 min-w-0 border-t border-rule pt-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={() => setOpen((was) => !was)}
        className="h-11 w-full min-w-0 justify-start gap-2 px-0 text-muted-foreground"
      >
        <Icon name="expand" aria-hidden className={cn("shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        <span className="shrink-0 font-medium">{t("view.earlier.row")}</span>
        {title !== undefined && <span className="min-w-0 truncate font-normal">{title}</span>}
        {age !== null && <span className="ml-auto shrink-0 font-normal tabular-nums">{age}</span>}
      </Button>
      <FoldPanel id={panel} open={open} data-slot="morph-earlier-panel" className="min-w-0 pb-2">
        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">{t("view.earlier.label")}</p>
        <div inert className="min-w-0">
          {children}
        </div>
      </FoldPanel>
    </section>
  );
}

export interface MorphReceiptCardProps {
  receipt: MorphReceipt;
  phase: MorphSendPhase;
  /** The composer's words for a send that failed, or null. */
  reason: string | null;
  pictures: ViewPictures | undefined;
}

/**
 * The receipt of a pick or a tap, in place of the request bubble: what it answered (muted), the label
 * picked (the main line), the option's preview at the end, and one fixed slot under them that says
 * "Sending…", then shows the "Answered" badge once the bridge confirmed, or "Not sent: <reason>". The
 * slot holds the widest of the three, so nothing moves when it changes (DESIGN.md §2).
 */
export function MorphReceiptCard({ receipt, phase, reason, pictures }: MorphReceiptCardProps) {
  useLocale();
  const failed = reason === null ? t("view.request.notSent") : t("view.request.notSentWhy", { reason });
  return (
    <div data-slot="morph-receipt" data-phase={phase} className="flex min-w-0 items-start gap-3 rounded-lg border border-rule bg-card p-3">
      <div className="min-w-0 flex-1">
        {receipt.context !== null && <p className="truncate text-xs text-muted-foreground">{receipt.context}</p>}
        <p data-slot="morph-receipt-label" className="text-sm font-medium break-words">
          {receipt.label}
        </p>
        <div data-slot="morph-receipt-state" role="status" className="mt-1.5 flex h-5 min-w-0 items-center text-xs text-muted-foreground">
          <OneOf
            active={phase}
            className="min-w-0 justify-items-start"
            options={[
              { key: "sending", node: <span className="truncate">{t("view.request.sending")}</span> },
              {
                key: "sent",
                node: (
                  <Badge variant="ok" data-slot="morph-answered-badge">
                    <Icon name="answered" aria-hidden />
                    {t("view.receipt.answered")}
                  </Badge>
                ),
              },
              { key: "failed", node: <span className="truncate">{failed}</span> },
            ]}
          />
        </div>
      </div>
      {receipt.preview !== null && pictures !== undefined && (
        <span data-slot="morph-receipt-preview" className="size-12 shrink-0 overflow-hidden rounded-md">
          {pictures.draw({ refs: [receipt.preview], index: 0, fit: "cover", ratio: "1 / 1", maxHeight: "48px" })}
        </span>
      )}
    </div>
  );
}
