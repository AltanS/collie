import { useEffect } from "react";
import { useParams } from "react-router";

import { LiveDecisionCard } from "@/components/hill-view";
import { SettingsPage } from "@/components/settings-page";
import { useNav } from "@/hooks/use-nav";
import { useHillAnswerHeld, useHillClosed, useHillHeld, useHillOpen } from "@/lib/hill/store";
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
// `hillRev`, with it off from `trickCardsRev`, under which the bridge serves only these cards. An answered
// card stays on the page with what its answer did while the store holds its receipt. A card that is gone
// (answered elsewhere, expired, another phone) leaves the page, as any screen closed under the person does.

/** The card the page shows: open, or closed with this phone's receipt held. Only Collie's own about a trick. */
function cardOf(id: string | undefined, open: readonly HillDecision[], closed: readonly HillDecision[]): HillDecision | undefined {
  if (id === undefined) return undefined;
  return open.find((d) => d.id === id && isTrickCard(d.from)) ?? closed.find((d) => d.id === id && isTrickCard(d.from));
}

export function TrickCardRoute() {
  const { decisionId } = useParams();
  const nav = useNav();
  const scope = useScope();
  const root = useOptionalRootData();
  const open = useHillOpen();
  const closed = useHillClosed();
  const held = useHillHeld();
  const answer = useHillAnswerHeld(decisionId ?? "");
  const found = cardOf(decisionId, open, closed);
  // A closed card stays only while this phone holds what its own answer did.
  const decision = found !== undefined && found.state !== "open" && answer === null ? undefined : found;
  // Nothing to wait for: the store read its list and the card is not in it, or the bridge serves no list.
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
