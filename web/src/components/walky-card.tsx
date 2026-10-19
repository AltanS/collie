import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useWalkyOpen, useWalkySelf } from "@/components/walky-log";
import { WalkyIcon } from "@/components/walky-icon";
import { useLocale } from "@/hooks/use-locale";
import { clockTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { remoteMachineOf, signerOf, verifiedWord, type WalkyKind, type WalkyRow } from "@/lib/walky";
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
// ── THE HEAD NAMES A MACHINE THAT IS NOT THE PANE'S OWN ───────────────────────
// Two sessions can carry one label on two machines, and "Message from walky-live" then reads as a
// message from itself. When an agent's address names another machine than this pane's (`remoteMachineOf`),
// the head says "Message from <label> on <machine>". The footer keeps its "signed by" word.
//
// ── TWO KINDS, TWO TONES ──────────────────────────────────────────────────────
// `agent` is a peer's words and takes the cool info tone. `operator` is the reader's own side of the
// conversation and takes the working orange the reader's own turns wear (chat-cards.tsx, UserTurn).
// The badge says the kind in words, so colour is never the only carrier.
//
// ── THE BODY SHOWS ITS FIRST THREE LINES ──────────────────────────────────────
// A brief between agents can run to a thousand characters, and the card sits in the flow of Chat. The
// body takes `line-clamp-3` (display -webkit-box, overflow hidden) and keeps `whitespace-pre-wrap`, so
// the author's line breaks still count as lines under the clamp. A body of one to three lines draws as
// it always did; a longer one is cut at the third line. The cut is paint only: the whole text stays in
// the DOM for a screen reader and for find, and the Messages sheet (walky-sheet.tsx) draws it in full.
// The tap that opens the sheet is the way to the rest, so no "more" control is added.
//
// ── NOTHING MOVES ─────────────────────────────────────────────────────────────
// The footer is always present (a `receipt` is always there), so a later receipt state changes a
// word and not a height. A uniform border and no accent edge (DESIGN.md §2).
//
// ── THE WHOLE CARD IS THE TAP TARGET ──────────────────────────────────────────
// Where the pane has a Messages sheet to open (`useWalkyOpen`), the card is ONE button: a tap anywhere
// on it opens the sheet scrolled to this message, with its Reply in reach. The card is far taller
// than 44px, so the floor is met by its box. It holds no control of its own (the reply link is words),
// which is what lets the root be a button; the same markup is a plain box where there is nowhere to
// go, so a card in History, or on a member's pane, promises nothing. The chevron is in the header only
// when it is a button, and takes the badge's right edge: the badge keeps its place either way.

const TONE = {
  agent: { box: "border-status-info/25 bg-status-info/8", head: "text-status-info" },
  operator: { box: "border-status-working/25 bg-status-working/8", head: "text-status-working" },
} satisfies Record<WalkyKind, { box: string; head: string }>;

export function WalkyCard({ row }: { row: WalkyRow }) {
  useLocale();
  const open = useWalkyOpen();
  const machine = remoteMachineOf(row, useWalkySelf());
  const tone = TONE[row.kind];
  const body = (
    <>
      <span className={cn("mb-1 flex items-center gap-1.5 text-[11px] font-semibold", tone.head)}>
        <WalkyIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{machine === null ? t("walky.card.title", { label: row.from.label }) : t("walky.card.titleRemote", { label: row.from.label, machine })}</span>
        <Badge variant="outline" className="ml-auto px-1.5 py-0 text-[10px] font-medium">
          {t(row.kind === "agent" ? "walky.kind.agent" : "walky.kind.operator")}
        </Badge>
        {open !== null && <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
      </span>
      <span className="font-content line-clamp-3 whitespace-pre-wrap break-words text-sm" data-slot="walky-body">
        {row.body}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{clockTime(row.at)}</span>
        {row.replyTo !== null && <span>{`· ${t("walky.card.replyTo", { id: row.replyTo })}`}</span>}
        <span data-slot="walky-verified">{`· ${verifiedWord(row.receipt, signerOf(row))}`}</span>
      </span>
      {open !== null && <span className="sr-only">{t("walky.card.open", { sheet: t("walky.sheet.title") })}</span>}
    </>
  );
  const common = {
    "data-slot": "walky-card",
    "data-kind": row.kind,
    "data-verified": row.receipt.verified,
    "data-id": row.id,
  };
  if (open === null) {
    return (
      <div {...common} className={cn("rounded-md border px-3 py-2", tone.box)}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      {...common}
      onClick={() => open(row.id)}
      className={cn(
        "block min-h-11 w-full rounded-md border px-3 py-2 text-left transition-colors active:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        tone.box,
      )}
    >
      {body}
    </button>
  );
}
