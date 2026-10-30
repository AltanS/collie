// The last ten sends the bridge ran for a pane, on the session page (M56 spec 09). Each row is one
// receipt: the outcome, the reason when there is one (as the composer's sentence for it, the raw code
// in the title), how long ago, and under them the text, as the one line the bridge kept of it when
// Sent's rule would keep it (`SendReceiptRow.line`), cut to the row's width by CSS. A tap opens the
// row: the whole line, then the keys the bridge sent by name and the gaps it measured between steps.
// A row with no line (a secret-looking text, a text over several lines) reads as it did before. A
// receipt holds no screen row, so nothing here can show one, and nothing here asks for one.
//
// Read once when the sheet opens. A list that polled would be a second poller on a page that has one,
// and a receipt does not change after it is written.

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

import { useLocale } from "@/hooks/use-locale";
import { getSendReceipts } from "@/lib/api";
import { receiptLabelKey, receiptSentence } from "@/lib/send-protocol";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { SendReceiptRow, SendStep } from "@/lib/surface/send";
import { cn } from "@/lib/utils";

interface SendReceiptsProps {
  paneId: string | undefined;
  scope?: Scope;
}

/** The pane's recent sends, or nothing at all while the list is empty or cannot be read. */
export function SendReceipts({ paneId, scope }: SendReceiptsProps) {
  useLocale();
  const [rows, setRows] = useState<readonly SendReceiptRow[] | null>(null);
  useEffect(() => {
    if (paneId === undefined) return;
    let live = true;
    void (async () => {
      try {
        const got = await getSendReceipts(paneId, scope);
        if (live) setRows(got);
      } catch {
        // A bridge that does not have the route (an older build, the protocol off) has no list to show.
        if (live) setRows([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [paneId, scope]);
  if (rows === null) return null;
  return <SendReceiptsView rows={rows} />;
}

/** The rows with every value handed in, so a test or a playground card needs no fetch. */
export function SendReceiptsView({ rows, now = Date.now() }: { rows: readonly SendReceiptRow[]; now?: number }) {
  useLocale();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section data-slot="send-receipts" className="flex flex-col gap-1.5 px-4" aria-label={t("sendReceipts.title")}>
      <h3 className="text-sm font-medium">{t("sendReceipts.title")}</h3>
      <p className="text-xs leading-snug text-muted-foreground">{t("sendReceipts.kept")}</p>
      {rows.length === 0 ? (
        <p className="text-xs leading-snug text-muted-foreground">{t("sendReceipts.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => {
            const expanded = open === row.requestId;
            return (
              <li key={row.requestId} data-slot="send-receipt" className="rounded-md bg-muted/40">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : row.requestId)}
                  className="flex min-h-9 w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left text-xs"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="font-medium">{t(receiptLabelKey(row.outcome))}</span>
                    {sentence(row) !== null && (
                      <span className="min-w-0 text-muted-foreground" title={row.reason}>
                        {sentence(row)}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-muted-foreground">{timeAgo(row.at, now)}</span>
                    <ChevronDown className={cn("size-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden />
                  </span>
                  {row.line !== undefined && (
                    // Closed: one line, cut at the row's edge. Open: the whole line, wrapped.
                    <span data-slot="send-receipt-line" className={cn("block w-full min-w-0", expanded ? "break-words whitespace-pre-wrap" : "truncate")}>
                      {row.line}
                    </span>
                  )}
                </button>
                {expanded && (
                  <div className="flex flex-col gap-0.5 px-2.5 pb-2 text-xs leading-snug text-muted-foreground">
                    <p>{row.keys.length === 0 ? t("sendReceipts.noKeys") : t("sendReceipts.keys", { keys: row.keys.join(", ") })}</p>
                    {gapsText(row) !== "" && <p>{t("sendReceipts.gaps", { gaps: gapsText(row) })}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The words under a row's label, in the phone's language. */
function sentence(row: SendReceiptRow): string | null {
  return receiptSentence(row, t);
}

const STEP_ORDER: readonly SendStep[] = ["profile", "settle", "s0", "proof", "clear", "probe", "probeWrite", "write", "s1", "commandSettle", "commit", "s2"];

/** The measured gaps in step order, as `s0 120 ms, probe 160 ms`. */
function gapsText(row: SendReceiptRow): string {
  return STEP_ORDER.flatMap((step) => {
    const gap = row.gapsMs[step];
    return gap === undefined ? [] : [`${step} ${String(gap)} ms`];
  }).join(", ");
}
