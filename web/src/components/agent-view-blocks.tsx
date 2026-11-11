import { useId, useState, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FoldPanel } from "@/components/ui/fold-toggle";
import { OneOf } from "@/components/ui/one-of";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { ViewReceipt, ViewSendPhase } from "@/lib/agent-view/reader";
import type { ViewPictures } from "@/lib/tricks/render";
import { cn } from "@/lib/utils";

// THE PARTS OF AN AGENT VIEW that are Collie's own (components/agent-view-screen.tsx composes them): a
// pending block's placeholder, the "Earlier screen" fold that holds the blocks drawn for an earlier
// request, the receipt that stands in for the request bubble when the request was a pick or a tap, and
// the exact line the bridge typed, under "Sent to this session" (agent views SECURITY rule 4).

/**
 * A block the agent said is in work (`trick view <id> pending`): its label and two calm bars that breathe
 * (`.count-skeleton`, which holds still under reduced motion). A pending block in the Earlier fold
 * does not breathe: nothing is in work for it any more.
 */
export function ViewPendingBlock({ label, isLive }: { label: string; isLive: boolean }) {
  return (
    <div data-slot="view-pending" aria-busy={isLive || undefined} className="flex min-w-0 flex-col gap-2 py-1">
      <p className="truncate text-sm text-muted-foreground">{label}</p>
      <span aria-hidden className={cn("h-2.5 w-4/5 rounded-full bg-muted", isLive && "count-skeleton")} />
      <span aria-hidden className={cn("h-2.5 w-3/5 rounded-full bg-muted", isLive && "count-skeleton")} />
    </div>
  );
}

export interface ViewEarlierProps {
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
export function ViewEarlier({ title, age, children }: ViewEarlierProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <section data-slot="view-earlier" className="mt-4 min-w-0 border-t border-rule pt-1">
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
      <FoldPanel id={panel} open={open} data-slot="view-earlier-panel" className="min-w-0 pb-2">
        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">{t("view.earlier.label")}</p>
        <div inert className="min-w-0">
          {children}
        </div>
      </FoldPanel>
    </section>
  );
}

export interface ViewReceiptCardProps {
  receipt: ViewReceipt;
  phase: ViewSendPhase;
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
export function ViewReceiptCard({ receipt, phase, reason, pictures }: ViewReceiptCardProps) {
  useLocale();
  const failed = reason === null ? t("view.request.notSent") : t("view.request.notSentWhy", { reason });
  return (
    <div data-slot="view-receipt" data-phase={phase} className="flex min-w-0 items-start gap-3 rounded-lg border border-rule bg-card p-3">
      <div className="min-w-0 flex-1">
        {receipt.context !== null && <p className="truncate text-xs text-muted-foreground">{receipt.context}</p>}
        <p data-slot="view-receipt-label" className="text-sm font-medium break-words">
          {receipt.label}
        </p>
        <div data-slot="view-receipt-state" role="status" className="mt-1.5 flex h-5 min-w-0 items-center text-xs text-muted-foreground">
          <OneOf
            active={phase}
            className="min-w-0 justify-items-start"
            options={[
              { key: "sending", node: <span className="truncate">{t("view.request.sending")}</span> },
              {
                key: "sent",
                node: (
                  <Badge variant="ok" data-slot="view-answered-badge">
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
        <span data-slot="view-receipt-preview" className="size-12 shrink-0 overflow-hidden rounded-md">
          {pictures.draw({ refs: [receipt.preview], index: 0, fit: "cover", ratio: "1 / 1", maxHeight: "48px" })}
        </span>
      )}
    </div>
  );
}

/**
 * The exact line the bridge typed into the session for the person's last tap or typed request (agent
 * views SECURITY rule 4, lead condition 6): Collie's words "Sent to this session" over the line, whole, in
 * monospace, wrapped, never cut and never drawn as markdown. Its look is Collie's: a uniform rule edge on
 * the page colour, which no node an agent draws takes.
 */
export function ViewSentLine({ line }: { line: string }) {
  useLocale();
  return (
    <figure data-slot="view-sent" className="mt-2 min-w-0 rounded-sm border border-rule px-3 py-2">
      <figcaption className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon name="answered" aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{t("view.sent.label")}</span>
      </figcaption>
      <pre data-slot="view-sent-line" className="mt-1 min-w-0 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground">
        {line}
      </pre>
    </figure>
  );
}
