import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { WalkyIdChip } from "@/components/walky-id-chip";
import { useWalkyLog } from "@/components/walky-log";
import { WalkyIcon } from "@/components/walky-icon";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { t } from "@/lib/i18n";
import { directionOf, isHeld, signerOf, stateWord, targetWord, verifiedWord, type WalkyRow } from "@/lib/walky";
import { cn } from "@/lib/utils";

// The pane's Messages sheet (M62 spec 05): every walky talky message the bridge kept for this pane,
// newest first, with where each one stands. It reads the same list the Chat card and the mirror row
// are checked against (`useWalkyLog`), so a card and a row of this sheet can never disagree.
//
// A reply is the one write here, and it is offered on an AGENT message only, because that is the
// one with an address to answer: an operator message is the reader's own. The sheet does not send;
// it hands the row to the pane's composer (`onReply`), which opens in message mode on the sender and
// sends through `POST /api/walky` with `replyTo` (hooks/use-walky-send.ts).
//
// ── BOTH DIRECTIONS ───────────────────────────────────────────────────────────
// The pane's list holds the messages that reached the pane AND the ones it sent, each with its receipt,
// newest first across both. A received row is drawn as it always was. A SENT row (`directionOf`, read from
// the addresses against `self`) is titled "To <target as the log names it>" and carries the receipt's state
// words: no kind badge (the sender is this pane), and no Reply, because there is nobody to answer in it.
//
// ── A HELD MESSAGE HAS TWO WAYS OUT (M62 spec 03) ─────────────────────────────
// A row whose receipt is `accepted` with a held reason (`isHeld`) waits for this pane's box to clear, up
// to an hour. The phone is the OPERATOR, so a held operator message is its own and offers Cancel: the
// sender takes it back. A held agent message offers Drop: the pane's owner ends the hold. Both are
// writes behind the same gate as Reply, and both end the way the clock does, with the message in the
// inbox, never typed. A SENT row held at the far pane is an agent's message: the phone is not its sender
// and does not own that box, so it offers nothing here (the far pane's sheet has its Drop). The sheet
// sends nothing itself: the caller's `onCancel` and `onDrop` post the routes and answer with a line to
// show under the row, or null when the row's own receipt will say it on the next read.
//
// ── A FOCUSED MESSAGE ─────────────────────────────────────────────────────────
// A tap on a Chat card, or on an id chip, opens this sheet on ONE message (`focusId`): the sheet scrolls
// to its row and the row wears the working tone's border and wash, so its Reply is in reach with no
// hunting. The row's box is the same with or without it (the border is in the base and only changes
// colour, DESIGN.md §2). A "reply to <id>" chip inside a row moves the focus to the message it answers,
// when the log holds that one. An id the log lacks is not focusable, so nothing is highlighted.

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
  /** The message to scroll to and highlight, when the sheet was opened on one. */
  focusId?: string | null;
  /** This pane's address (`paneAddress`). It tells a sent row from a received one; without it every row reads as received. */
  self?: string | undefined;
  /** The sender takes a held message of this pane back (M62 spec 03). Resolves to a line for the row, or null. Absent: no Cancel. */
  onCancel?: ((row: WalkyRow) => Promise<string | null>) | undefined;
  /** The pane's owner drops a message held for this pane (M62 spec 03). Resolves to a line for the row, or null. Absent: no Drop. */
  onDrop?: ((row: WalkyRow) => Promise<string | null>) | undefined;
}

/**
 * Bring `el` to the middle of the scroller it sits in. The sheet's own panel is that scroller, and only
 * it moves: `scrollIntoView` would also ask the page behind the scrim to scroll while the panel is
 * still sliding in (the same flaw `useDialogFocus` guards against).
 */
function centreInScroller(el: HTMLElement): void {
  let box = el.parentElement;
  while (box !== null && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) {
    box = box.parentElement;
  }
  if (box === null) return;
  const a = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  box.scrollTop += a.top - b.top - (box.clientHeight - a.height) / 2;
}

export function WalkySheet({ open, onClose, onReply, canReply, focusId = null, self, onCancel, onDrop }: WalkySheetProps) {
  useLocale();
  const log = useWalkyLog();
  const rows = log === null ? [] : newestFirst(log.rows);
  // A chip inside a row moves the focus; a new opening (or a new id from outside) starts over.
  const [moved, setMoved] = useState<{ from: string | null; id: string } | null>(null);
  if (!open && moved !== null) setMoved(null);
  const focused = moved !== null && moved.from === focusId ? moved.id : focusId;
  const wanted = open ? focused : null;
  const focusedRow = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (wanted !== null && focusedRow.current !== null) centreInScroller(focusedRow.current);
  }, [wanted, rows.length]);
  return (
    <BottomSheet open={open} onClose={onClose} title={t("walky.sheet.title")}>
      {log === null ? (
        <p className="py-2 text-sm text-muted-foreground">{t("walky.sheet.unavailable")}</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("walky.sheet.empty")}</p>
      ) : (
        <ul data-slot="walky-list" className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} ref={row.id === wanted ? focusedRow : undefined}>
              <WalkyListRow
                row={row}
                canReply={canReply}
                onReply={() => onReply(row)}
                self={self}
                focused={row.id === wanted}
                holds={(id) => log?.byId.has(id) === true}
                onFocusId={(id) => setMoved({ from: focusId, id })}
                onCancel={onCancel}
                onDrop={onDrop}
              />
            </li>
          ))}
        </ul>
      )}
    </BottomSheet>
  );
}

function WalkyListRow({
  row,
  canReply,
  onReply,
  self,
  focused,
  holds,
  onFocusId,
  onCancel,
  onDrop,
}: {
  row: WalkyRow;
  self: string | undefined;
  canReply: boolean;
  onReply: () => void;
  focused: boolean;
  holds: (id: string) => boolean;
  onFocusId: (id: string) => void;
  onCancel: ((row: WalkyRow) => Promise<string | null>) | undefined;
  onDrop: ((row: WalkyRow) => Promise<string | null>) | undefined;
}) {
  const refused = row.receipt.state === "refused" || row.receipt.state === "expired";
  const sent = directionOf(row, self) === "sent";
  // Only a message that came in from an agent has an address to answer.
  const replyable = !sent && canReply && row.kind === "agent" && row.from.address !== null;
  // A held row's way out (M62 spec 03): the operator's Cancel on its own message, the owner's Drop on an agent's.
  const held = isHeld(row.receipt) && !sent;
  const cancels = held && row.kind === "operator";
  const takeBack = held && canReply ? (cancels ? onCancel : onDrop) : undefined;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // A row that left its held state settles the question: the note it earned goes with it.
  if (!held && note !== null) setNote(null);
  const onTakeBack = async () => {
    if (takeBack === undefined || busy) return;
    setBusy(true);
    try {
      setNote(await takeBack(row));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-slot="walky-list-row"
      data-kind={row.kind}
      data-direction={sent ? "sent" : "received"}
      data-id={row.id}
      data-focused={focused ? "true" : undefined}
      className={cn("rounded-md border px-3 py-2 transition-colors", focused ? "border-status-working/60 bg-status-working/8" : "border-border")}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {sent ? <Send className="size-3.5 shrink-0" aria-hidden="true" /> : <WalkyIcon className="size-3.5 shrink-0" aria-hidden="true" />}
        {sent ? (
          <span data-slot="walky-sent-to" className="min-w-0 flex-1 truncate font-medium text-foreground">
            {t("walky.sheet.sentTo", { target: targetWord(row.receipt.target) })}
          </span>
        ) : (
          <>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
              {t(row.kind === "agent" ? "walky.kind.agent" : "walky.kind.operator")}
            </Badge>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.from.label}</span>
          </>
        )}
        <span className="shrink-0 tabular-nums">{timeAgoShort(row.at)}</span>
      </div>
      <p className="font-content line-clamp-6 whitespace-pre-wrap break-words text-sm">{row.body}</p>
      {row.replyTo !== null && (
        <p data-slot="walky-reply-to" className="mt-1 text-[11px] text-muted-foreground">
          {`${t("walky.sheet.inReplyTo")} `}
          {holds(row.replyTo) ? <WalkyIdChip id={row.replyTo} onOpen={onFocusId} /> : <span className="font-mono">{row.replyTo}</span>}
        </p>
      )}
      <div className="mt-1 flex items-center gap-2">
        {/* The state words are lower case (they also follow a colon in the composer's note), so the line capitalises its own first letter. */}
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground first-letter:uppercase">
          <span data-slot="walky-state" className={cn(refused && "text-status-blocked")}>
            {stateWord(row.receipt)}
          </span>
          {!sent && ` · ${verifiedWord(row.receipt, signerOf(row))}`}
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
        {takeBack !== undefined && (
          <Button
            variant="outline"
            size="sm"
            className="h-11 shrink-0"
            disabled={busy}
            onClick={() => void onTakeBack()}
            data-slot={cancels ? "walky-cancel" : "walky-drop"}
            aria-label={cancels ? t("walky.sheet.cancelAria", { target: targetWord(row.receipt.target) }) : t("walky.sheet.dropAria", { label: row.from.label })}
          >
            {t(cancels ? "walky.sheet.cancel" : "walky.sheet.drop")}
          </Button>
        )}
      </div>
      {note !== null && (
        <p data-slot="walky-takeback-note" role="status" className="mt-1 text-[11px] text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}
