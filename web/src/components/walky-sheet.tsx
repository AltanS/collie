import { MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { useWalkyLog } from "@/components/walky-log";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { t } from "@/lib/i18n";
import { signerOf, stateWord, verifiedWord, type WalkyRow } from "@/lib/walky";
import { cn } from "@/lib/utils";

// The pane's Messages sheet (M62 spec 05): every walky talky message the bridge kept for this pane,
// newest first, with where each one stands. It reads the same list the Chat card and the mirror row
// are checked against (`useWalkyLog`), so a card and a row of this sheet can never disagree.
//
// A reply is the one write here, and it is offered on an AGENT message only, because that is the
// one with an address to answer: an operator message is the reader's own. The sheet does not send;
// it hands the row to the pane's composer (`onReply`), which opens in message mode on the sender and
// sends through `POST /api/walky` with `replyTo` (hooks/use-walky-send.ts).

/** Newest first, whatever order the bridge answered in. */
function newestFirst(rows: readonly WalkyRow[]): WalkyRow[] {
  return rows.toSorted((a, b) => b.at - a.at);
}

interface WalkySheetProps {
  open: boolean;
  onClose: () => void;
  /** Called with the message being answered. The caller closes the sheet and opens the composer. */
  onReply: (row: WalkyRow) => void;
  /** False for a device that may not write, a saved copy or a quiet machine: no Reply is offered. */
  canReply: boolean;
}

export function WalkySheet({ open, onClose, onReply, canReply }: WalkySheetProps) {
  useLocale();
  const log = useWalkyLog();
  const rows = log === null ? [] : newestFirst(log.rows);
  return (
    <BottomSheet open={open} onClose={onClose} title={t("walky.sheet.title")}>
      {log === null ? (
        <p className="py-2 text-sm text-muted-foreground">{t("walky.sheet.unavailable")}</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("walky.sheet.empty")}</p>
      ) : (
        <ul data-slot="walky-list" className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <WalkyListRow row={row} canReply={canReply} onReply={() => onReply(row)} />
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}

function WalkyListRow({ row, canReply, onReply }: { row: WalkyRow; canReply: boolean; onReply: () => void }) {
  const refused = row.receipt.state === "refused" || row.receipt.state === "expired";
  // Only an agent message has an address to answer.
  const replyable = canReply && row.kind === "agent" && row.from.address !== null;
  return (
    <div data-slot="walky-list-row" data-kind={row.kind} className="rounded-md border border-border px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
          {t(row.kind === "agent" ? "walky.kind.agent" : "walky.kind.operator")}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.from.label}</span>
        <span className="shrink-0 tabular-nums">{timeAgoShort(row.at)}</span>
      </div>
      <p className="font-content line-clamp-6 whitespace-pre-wrap break-words text-sm">{row.body}</p>
      <div className="mt-1 flex items-center gap-2">
        {/* The state words are lower case (they also follow a colon in the composer's note), so the line capitalises its own first letter. */}
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground first-letter:uppercase">
          <span data-slot="walky-state" className={cn(refused && "text-status-blocked")}>
            {stateWord(row.receipt)}
          </span>
          {` · ${verifiedWord(row.receipt, signerOf(row))}`}
        </p>
        {replyable && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 shrink-0"
            onClick={onReply}
            aria-label={t("walky.sheet.replyAria", { label: row.from.label })}
          >
            {t("walky.sheet.reply")}
          </Button>
        )}
      </div>
    </div>
  );
}
