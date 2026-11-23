import { AskHeader } from "@/components/ask-screen";
import { Button } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { BandMain } from "@/components/ui/strip-host";
import { useLocale } from "@/hooks/use-locale";
import type { ClosedAskWhy } from "@/lib/hill/asks";
import { t } from "@/lib/i18n";

// A CLOSED OR MISSING ASK (Asks build 2, 2026-11-23): the screen a link or a Send leaves behind. `/hill/ask/:id` stays a
// valid address after the ask closes (a Send answers it, the agent takes it back, the conversation is cleared), so it says
// what happened in one plain sentence and offers the way back. No answer cards: a closed ask takes no answer.

/** The one sentence for why an ask is closed. `null` is an id the board does not hold at all. */
export function closedSentence(why: ClosedAskWhy | null): string {
  if (why === null) return t("asks.closed.notFound");
  switch (why.kind) {
    case "answered":
      return why.label === null ? t("asks.closed.answeredPlain") : t("asks.closed.answered", { label: why.label });
    case "answeredHere":
      return t("asks.closed.answeredHere");
    case "cleared":
      return t("asks.closed.cleared");
    case "takenBack":
      return why.because === null ? t("asks.closed.takenBack") : t("asks.closed.takenBackBecause", { because: why.because });
    case "replaced":
      return t("asks.closed.replaced");
    case "gone":
      return t("asks.closed.gone");
    case "closed":
      return t("asks.closed.closed");
  }
}

export function AskClosed({
  name,
  line,
  title,
  why,
  newer,
  onBack,
  onNewer,
  hold = false,
}: {
  name: string;
  line: string;
  /** The question the ask held, or null for an id the board does not know. */
  title: string | null;
  why: ClosedAskWhy | null;
  /** Whether the ask that replaced this one is open. */
  newer: boolean;
  onBack: () => void;
  onNewer: () => void;
  /** The first list is still on its way: the sentence holds its place and says nothing. */
  hold?: boolean;
}) {
  useLocale();
  return (
    <div data-slot="ask-closed" className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AskHeader name={name} line={line} place={null} backLabel={t("asks.back")} onBack={onBack} />
      <BandMain base={16} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-4 pb-4">
        {title !== null && <h2 className="font-content text-xl font-semibold leading-snug text-balance">{title}</h2>}
        <p data-slot="ask-closed-why" role="status" className="text-sm text-foreground">
          {hold ? "\u00a0" : closedSentence(why)}
        </p>
        {newer && (
          <Button type="button" variant="outline" className="h-11 w-full" onClick={onNewer}>
            {t("asks.closed.openNewer")}
          </Button>
        )}
      </BandMain>
      <BottomBar>
        <Button type="button" variant="outline" className="h-11 w-full" onClick={onBack}>
          {t("asks.back")}
        </Button>
      </BottomBar>
    </div>
  );
}
