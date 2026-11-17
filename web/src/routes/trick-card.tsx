import { useEffect } from "react";
import { useParams } from "react-router";

import { LiveDecisionCard } from "@/components/hill-view";
import { SettingsPage } from "@/components/settings-page";
import { useNav } from "@/hooks/use-nav";
import { useHillHeld, useHillOpen } from "@/lib/hill/store";
import { isTrickCard, type HillDecision } from "@/lib/hill/wire";
import { homePath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";

// ONE CARD OF COLLIE'S OWN ABOUT A TRICK (M96 spec 14), `/trick-card/<decision id>`: a proposed trick, a new
// version, a trick's rights. The SAME card the Hill draws (`LiveDecisionCard`, components/decision-card.tsx)
// with the same state and every guard (the code pages, the yes that waits until every card was on screen,
// the confirm tap), on a page with no Hill list and no Hill words around it, so it works with the Hill off.
// The page wears the Settings section shell with the Tricks title; Back steps back to Settings, Tricks or
// to the Dashboard, whichever opened it, else lands on the Dashboard (lib/nav.ts `ancestorsOf`).
//
// The card comes from the hill's store, which the root loader keeps current: with the Hill on from
// `hillRev`, with it off from `trickCardsRev`, under which the bridge serves only these cards. The page
// shows the card only while the store serves it OPEN. An answer that closed it (a yes, the decline, a
// dismiss) shows its receipt on the card until the list read that follows the tap (`readHillNow`, at
// HILL_LIST_READ_AFTER_MS) serves the card closed; then the page leaves, as the card leaves the Hill's open
// list at that moment. It never holds a closed card: the bridge keeps an answered or dismissed card in its
// closed list for good, and the store keeps this phone's receipt for as long as it serves it, so a page that
// held such a card kept it, its pager and its Dismiss on screen until the person left (Altan's phone,
// 2026-11-17). A card that is gone for another reason (answered elsewhere, expired, another phone) leaves
// the same way.

/** The card the page shows: open, and only Collie's own about a trick. */
function cardOf(id: string | undefined, open: readonly HillDecision[]): HillDecision | undefined {
  if (id === undefined) return undefined;
  return open.find((d) => d.id === id && isTrickCard(d.from));
}

export function TrickCardRoute() {
  const { decisionId } = useParams();
  const nav = useNav();
  const scope = useScope();
  const root = useOptionalRootData();
  const open = useHillOpen();
  const held = useHillHeld();
  const decision = cardOf(decisionId, open);
  // Nothing to wait for: the store read its list and the card is not open in it, or the bridge serves no list.
  const gone = decision === undefined && (held || root?.trickCards === false);
  useEffect(() => {
    if (gone) nav.up(homePath(scope));
  }, [gone, nav, scope]);
  return (
    <SettingsPage title="settings.section.tricks.title" parent={homePath(scope)}>
      {decision !== undefined && <LiveDecisionCard key={decision.id} decision={decision} />}
    </SettingsPage>
  );
}
