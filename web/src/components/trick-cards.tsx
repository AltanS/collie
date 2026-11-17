import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NOTICE_ACTION, Notice } from "@/components/ui/notice";
import { ROW_OPEN_BUTTON, ROW_OPEN_ROW } from "@/components/ui/row-open";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useTrickCards } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { cardName } from "@/lib/hill/wire";
import { t, tn } from "@/lib/i18n";
import { trickCardPath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { cn } from "@/lib/utils";

// A TRICK'S CARD NEEDS NO HILL (M96 spec 14, 2026-11-16). The Hill's switch gates what agents and tricks
// ask. A card of Collie's own about a trick (a proposed trick, a new version, a trick's rights) is an
// approval, and the bridge posts, serves and answers it with the Hill on or off (bridge/hill/service.ts).
// With the Hill off the bar has no Hill item, so the phone reaches the card three ways:
//
//   1. Settings, Tricks: a first group "Waiting for your yes", one row per open card, oldest first. The
//      row is the card's own title (Collie's words, with the trick's id) and the first line of its summary
//      (who proposed it, as the bridge knows them). A tap opens the card's page. With the Hill on the
//      group is there too and opens the same page.
//   2. The Dashboard: one quiet bordered line while a card is open and the Hill is off, in the box the
//      update line wears (`Notice`, ui/notice.tsx), with one button to the oldest card. With the Hill on
//      the bar's Hill item is the signal, so the line is not drawn.
//   3. A card's notification: none rings today. Collie's cards are posted as `today`, and only a `now`
//      Decision pushes (bridge/hill/push.ts), with the Hill on as with it off.
//
// The page itself is routes/trick-card.tsx: the same card component with the same guards.

/** The group in Settings, Tricks, every value handed in, so a test and the playground draw the real markup. */
export function TrickCardsWaitingList({ cards, onOpen }: { cards: readonly HillDecision[]; onOpen: (decision: HillDecision) => void }) {
  useLocale();
  if (cards.length === 0) return null;
  return (
    <Card className="gap-0 py-0" data-slot="trick-cards-waiting">
      <h2 className="border-b border-border px-4 py-3 text-sm font-medium">{t("settings.tricks.waiting.title")}</h2>
      <div data-slot="list-group">
        {cards.map((decision) => (
          <div key={decision.id} data-card={decision.id} className={cn(ROW_OPEN_ROW, "px-4 py-3")}>
            {/* One button, its stretched layer the whole row (ui/row-open.ts): the row is at least 44px tall. */}
            <button type="button" data-row-open="" onClick={() => onOpen(decision)} className={cn(ROW_OPEN_BUTTON, "flex min-h-11 w-full items-center gap-3 text-left")}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium break-words">{decision.title}</span>
                <span data-line="who" className="line-clamp-2 break-words text-xs text-muted-foreground">
                  {firstSentence(decision.summary)}
                </span>
              </span>
              <Icon name="row-go" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * The first sentence of a card's summary: who proposed it, as the bridge's card says it ("A session on lodge
 * proposes it."). The whole summary when it has no sentence end.
 */
export function firstSentence(summary: string): string {
  const end = summary.search(/[.?!](\s|$)/u);
  return end === -1 ? summary : summary.slice(0, end + 1);
}

/** The group, from the hill's store. Nothing while no card waits. */
export function TrickCardsWaiting() {
  const cards = useTrickCards();
  const open = useOpenTrickCard();
  return <TrickCardsWaitingList cards={cards} onOpen={open} />;
}

/**
 * What the Dashboard's line says (Altan's words, 2026-11-17). It counts every open card of Collie's own about a
 * trick (the store's `useTrickCards`): a proposed new trick, a proposed new version (both a `proposal` ref, the
 * version one titled "Use the new version of ..."), a new version the runner found (`version`), a trick
 * stopped for its rights (`rights`) and a carried trick that did not start (`carried`). The first two are an
 * agent's proposal and say so. Any other card says only that it needs a look: one by name, several by count.
 */
export type TrickLine =
  | { kind: "new"; name: string }
  | { kind: "version"; name: string }
  | { kind: "many"; count: number }
  | { kind: "look"; name: string }
  | { kind: "looks"; count: number };

/** The title the bridge gives a proposed new version (bridge/tricks/version-card.ts `titleFrame`). */
const VERSION_PROPOSAL_TITLE = "Use the new version of ";

/** The line for the open cards, oldest first. Never called with none. */
export function trickLineOf(cards: readonly HillDecision[]): TrickLine {
  const [only] = cards;
  const proposals = cards.every((card) => card.from.ref?.type === "proposal");
  if (cards.length > 1) return proposals ? { kind: "many", count: cards.length } : { kind: "looks", count: cards.length };
  const name = trickNameOf(only);
  if (only?.from.ref?.type !== "proposal") return { kind: "look", name };
  return only.title.startsWith(VERSION_PROPOSAL_TITLE) ? { kind: "version", name } : { kind: "new", name };
}

/**
 * The trick's name on a card: the display name the bridge sent (`from.name`), or the id (`ref.id`) when an older
 * bridge sent none. Both are cleaned of hidden characters, and the result is only ever drawn as text.
 */
export function trickNameOf(card: HillDecision | undefined): string {
  return cardName(card?.from.name) ?? cardName(card?.from.ref?.id) ?? "";
}

/**
 * A sentence with a name in it: the words before, the name, the words after, in the language's own order. The
 * name comes from a trick's manifest, which an agent may have written, so it is drawn as its own element, a small
 * chip in medium weight, and can never read as part of Collie's sentence ("Collie says approve this now").
 */
function aroundName(key: "home.trickWaits.proposes" | "home.trickWaits.proposesVersion" | "home.trickWaits.look", name: string) {
  const slot = "\uE000";
  const [before = "", after = ""] = t(key, { name: slot }).split(slot);
  return (
    <p data-line="name" className="flex min-w-0 items-baseline">
      <span className="shrink-0 whitespace-pre">{before}</span>
      <span data-slot="trick-name" className="min-w-0 truncate rounded-sm border border-border bg-muted px-1 font-medium text-foreground" title={name}>
        {name}
      </span>
      <span className="shrink-0 whitespace-pre">{after}</span>
    </p>
  );
}

/** The Dashboard's line, every value handed in: the open cards and the one button. */
export function TrickCardsLineView({ cards, onOpen, className }: { cards: readonly HillDecision[]; onOpen: () => void; className?: string }) {
  useLocale();
  const line = trickLineOf(cards);
  const action = (
    <Button size="sm" variant="outline" className={NOTICE_ACTION} onClick={onOpen}>
      {t("home.trickWaits.open")}
    </Button>
  );
  return (
    <div data-slot="trick-waits" className={className}>
      <Notice tone="neutral" variant="box" action={action}>
        {line.kind === "new" && aroundName("home.trickWaits.proposes", line.name)}
        {line.kind === "version" && aroundName("home.trickWaits.proposesVersion", line.name)}
        {line.kind === "many" && <p>{tn("home.trickWaits.proposesMany", line.count)}</p>}
        {line.kind === "look" && aroundName("home.trickWaits.look", line.name)}
        {line.kind === "looks" && <p>{tn("home.trickWaits.looks", line.count)}</p>}
      </Notice>
    </div>
  );
}

/** The Dashboard's line: only while the Hill is off and a card waits; its button opens the oldest one. */
export function TrickCardsLine({ className }: { className?: string }) {
  const root = useOptionalRootData();
  const cards = useTrickCards();
  const open = useOpenTrickCard();
  const oldest = cards[0];
  if (root?.hillOff !== true || oldest === undefined) return null;
  return <TrickCardsLineView className={className} cards={cards} onOpen={() => open(oldest)} />;
}

/** Opening a card: one level down, so Back steps back to where the tap was made. */
export function useOpenTrickCard(): (decision: Pick<HillDecision, "id">) => void {
  const nav = useNav();
  const scope = useScope();
  return (decision) => nav.down(trickCardPath(decision.id, scope));
}
