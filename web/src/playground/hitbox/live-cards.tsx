// The live overlays: the app's own components, drawn by the app's own routes over fixtures, with the
// measured box and hit area of every tap target outlined on top (`overlay.tsx`). DEV-ONLY.

import { useEffect, useState } from "react";

import { DecisionCard } from "@/components/decision-card";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { __resetReloadGuard } from "@/lib/reload-guard";
import { __resetSelfUpdate } from "@/lib/self-update";
import { clearStatus } from "@/lib/status";
import { markTourSeen } from "@/lib/tour";
import { clearUpdateStarted } from "@/lib/update-ribbon";

import { censusTrio, devicesPaired, homeSolo, paneBlocked } from "../fixtures";
import { playgroundMedia, quietOpen } from "../fixtures/hill/decisions";
import { FullAppRouter, PaneRouter, RootRouter, SettingsRouter, createFullAppRouter } from "../harness";
import { PhoneFrame } from "../layout";
import { walkthroughHistory, walkthroughHome, walkthroughScreen } from "../sections/walkthrough-fixtures";
import { HitOverlay } from "./overlay";

const noop = () => {};

/** The whole app's route table over fixture loaders, opened on the Dashboard. */
export function DashboardOverlay() {
  const [router] = useState(() => {
    // The first-launch tour's gate sits in the root layout; spend it so a sheet does not cover the frame.
    markTourSeen();
    return createFullAppRouter({ home: walkthroughHome, screenFor: walkthroughScreen, crew: { status: censusTrio, error: false }, devices: devicesPaired, history: walkthroughHistory });
  });
  // The routes leave a status line, an update stamp and reload holds behind them; take them off the page's other cards.
  // The floating New button is portalled to the page body, so it would float over every card of this section
  // instead of sitting in the frame. Hide it while this card is mounted; card 2 measured it on the real screen.
  useEffect(() => {
    const hide = document.createElement("style");
    hide.textContent = '[data-slot="fab"] { display: none !important; }';
    document.head.append(hide);
    return () => hide.remove();
  }, []);
  useEffect(
    () => () => {
      clearStatus();
      clearUpdateStarted();
      __resetReloadGuard();
      __resetSelfUpdate();
    },
    [],
  );
  return (
    <HitOverlay id="dashboard">
      <PhoneFrame height={720}>
        <FullAppRouter router={router} />
      </PhoneFrame>
    </HitOverlay>
  );
}

/** A pane blocked on a permission prompt: header, mirror, belt, composer. */
export function PaneOverlay() {
  return (
    <HitOverlay id="pane">
      <PhoneFrame height={760}>
        <PaneRouter home={homeSolo} fixture={paneBlocked} />
      </PhoneFrame>
    </HitOverlay>
  );
}

export function SettingsOverlay() {
  return (
    <HitOverlay id="settings">
      <PhoneFrame height={720}>
        <SettingsRouter home={homeSolo} devices={devicesPaired} />
      </PhoneFrame>
    </HitOverlay>
  );
}

/** A Hill decision card with its answer buttons. */
export function DecisionOverlay() {
  const decision = quietOpen[0];
  if (decision === undefined) return null;
  return (
    <HitOverlay id="decision">
      <PhoneFrame height={420}>
        <RootRouter data={homeSolo}>
          <div className="p-3">
            <DecisionCard decision={decision} answer={HILL_IDLE} onSend={noop} mediaSource={playgroundMedia} />
          </div>
        </RootRouter>
      </PhoneFrame>
    </HitOverlay>
  );
}
