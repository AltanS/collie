import { MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useLocale } from "@/hooks/use-locale";
import { clockTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { signerOf, verifiedWord, type WalkyKind, type WalkyRow } from "@/lib/walky";
import { cn } from "@/lib/utils";

// A walky talky message, drawn as Chat's "Message from <label>" card (M62 spec 05).
//
// ── THE CARD DRAWS THE LOG'S ROW, NEVER THE PRINTED ENVELOPE ──────────────────
// The agent that received the message sees a header line and a body, and an agent can print the
// same two lines itself. So the turn only EARNS this card when the pane's walky list holds its id
// (components/chat-cards.tsx decides), and then the card draws what the log says: its kind, its
// label, its body and its reply link. A forged header that borrows a real id still shows the real
// message, and one with no real id never gets here.
//
// ── TWO KINDS, TWO TONES ──────────────────────────────────────────────────────
// `agent` is a peer's words and takes the cool info tone. `operator` is the reader's own side of the
// conversation and takes the working orange the reader's own turns wear (chat-cards.tsx, UserTurn).
// The badge says the kind in words, so colour is never the only carrier.
//
// ── NOTHING MOVES ─────────────────────────────────────────────────────────────
// The footer is always present (a `receipt` is always there), so a later receipt state changes a
// word and not a height. A uniform border and no accent edge (DESIGN.md §2).

const TONE = {
  agent: { box: "border-status-info/25 bg-status-info/8", head: "text-status-info" },
  operator: { box: "border-status-working/25 bg-status-working/8", head: "text-status-working" },
} satisfies Record<WalkyKind, { box: string; head: string }>;

export function WalkyCard({ row }: { row: WalkyRow }) {
  useLocale();
  const tone = TONE[row.kind];
  return (
    <div
      data-slot="walky-card"
      data-kind={row.kind}
      data-verified={row.receipt.verified}
      className={cn("rounded-md border px-3 py-2", tone.box)}
    >
      <div className={cn("mb-1 flex items-center gap-1.5 text-[11px] font-semibold", tone.head)}>
        <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{t("walky.card.title", { label: row.from.label })}</span>
        <Badge variant="outline" className="ml-auto px-1.5 py-0 text-[10px] font-medium">
          {t(row.kind === "agent" ? "walky.kind.agent" : "walky.kind.operator")}
        </Badge>
      </div>
      <p className="font-content whitespace-pre-wrap break-words text-sm">{row.body}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{clockTime(row.at)}</span>
        {row.replyTo !== null && <span>{`· ${t("walky.card.replyTo", { id: row.replyTo })}`}</span>}
        <span data-slot="walky-verified">{`· ${verifiedWord(row.receipt, signerOf(row))}`}</span>
      </p>
    </div>
  );
}
