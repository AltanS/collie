// First-run section of the states playground. Split per file like every other section; see app.tsx's
// header comment for the whole page's rules.
//
// THE CARDS TOUCH NO STORAGE, NO ROUTER AND NO BROWSER PUSH API. `TourSheet` is controlled — every
// fact on the screen and every exit door is a prop — so each card here is a prop combination, and
// nothing on this page can mark the real first run seen, raise a real permission prompt or navigate.
// That is the whole reason the gate (`TourHost`) lives in the same file but is not mounted here.

import { useState } from "react";

import { TourSheet, type TourExit } from "@/components/tour-sheet";
import { TourControl } from "@/components/tour-control";
import type { PushState } from "@/lib/push";

import { Card, Group, RootRouter, Section, Stage, type SectionDef } from "../harness";
import { homeSolo } from "../fixtures";

export const DEF: SectionDef = {
  id: "tour",
  title: "First run",
  intent:
    "The one screen a device sees the first time Collie opens on it: what Collie does, what THIS install looks like, at most two things to do about it, and the six lines of what the app can do at all. Four installs, then the Settings row that shows it again.",
};

/** How tall a full-height sheet gets to be in a card. `dvh` pulls the sheet's `h-[100dvh]` down to
 *  the box instead of the page (see playground.css), so the screen is shown at its real proportions
 *  and scrolls inside the card exactly as it does on a phone. */
const SHEET_HEIGHT = 680;

/** The multiplexer's display name reaches the real screen from `/api/config`, and the frontend may
 *  not spell one anywhere (`scripts/check-mux-names.sh`) — so every card here stands one in, exactly
 *  as `playground/typeface-card.tsx` does for the header's own "on <mux>" caption. On a real phone
 *  this word is whichever multiplexer the bridge reports. */
const MUX = "the mux";

function push(overrides: Partial<PushState> = {}): PushState {
  return { availability: "ready", subscribed: false, userDisabled: false, ...overrides };
}

/** Push already decided — the quiet case, where neither the setup row nor the card appears. */
const pushDone = push({ subscribed: true });

type StageProps = Omit<
  Parameters<typeof TourSheet>[0],
  "open" | "onClose" | "onEnablePush" | "onInstall"
>;

/**
 * One mounted screen. The exit reason is printed rather than acted on: the sheet never navigates —
 * `FirstRunLive` does — and seeing which button produced which word is the only way to judge that
 * split from outside.
 */
function SheetStage(props: StageProps) {
  const [closed, setClosed] = useState<TourExit | null>(null);

  return (
    <Stage height={SHEET_HEIGHT} dvh>
      <TourSheet
        {...props}
        open={closed === null}
        onClose={setClosed}
        onEnablePush={async () => ({ ok: true })}
        onInstall={() => undefined}
      />
      {closed !== null && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
          <p>left with reason: {closed}</p>
          <button type="button" className="underline" onClick={() => setClosed(null)}>
            show it again
          </button>
        </div>
      )}
    </Stage>
  );
}

export function TourSection() {
  return (
    <Section def={DEF}>
      <Group title="Four installs">
        <Card
          state="first-run-fresh"
          label="just installed, nothing running"
          reach="open Collie on a device that has never run it, on a host with no agent panes"
          note="The mark is the boot splash's own drawing, not a new asset. Push is off at the bridge here, so neither the setup row nor the notifications card appears — an install that cannot deliver a notification is never asked about one."
        >
          <SheetStage
            mux={MUX}
            host="bluefin"
            panes={0}
            needsYou={0}
            machines={0}
            pushState={push({ availability: "server-off" })}
          />
        </Card>

        <Card
          state="first-run-panes"
          label="four panes, one blocked"
          reach="the same first open, on a host already running agents"
          note="Nothing to do next, so that whole section is absent rather than padded. The footer names the blocked pane and opens it."
        >
          <SheetStage
            mux={MUX}
            host="bluefin"
            panes={4}
            needsYou={1}
            machines={0}
            pushState={pushDone}
          />
        </Card>

        <Card
          state="first-run-unpaired"
          label="a device that cannot type"
          reach="pairing is enforced on the host and this device holds no token"
          note="The read-only device SEES this screen: a family tablet left on the dashboard is exactly the one that needs to be told what it is looking at. The row says so and the first card is the repair."
        >
          <SheetStage
            mux={MUX}
            host="bluefin"
            panes={4}
            needsYou={1}
            machines={0}
            readOnly
            pushState={pushDone}
          />
        </Card>

        <Card
          state="first-run-crew"
          label="three machines in one crew"
          reach="open Collie for the first time against a lead with two members joined"
          note="The crew row is the only row that can be absent on a working install, and it is absent below two machines — a solo snapshot carries no `servers` at all."
        >
          <SheetStage
            mux={MUX}
            host="bluefin"
            panes={9}
            needsYou={2}
            machines={3}
            pushState={pushDone}
          />
        </Card>
      </Group>

      <Group title="Two offers">
        <Card
          state="first-run-push-blocked"
          label="notifications are off on this phone"
          reach="first open on a device where push can run and nothing has been decided yet"
          note="Stated twice on purpose, and the two say different things: the setup row is the FACT, the card is the remedy. The button here is wired to a literal push state, so tapping it confirms without asking the browser for anything."
        >
          <SheetStage
            mux={MUX}
            host="bluefin"
            panes={4}
            needsYou={0}
            machines={0}
            pushState={push()}
          />
        </Card>

        <Card
          state="first-run-installed"
          label="the browser is offering the home screen"
          reach="first open in Chrome or Edge over HTTPS, on an origin not yet installed"
          note="Two cards, which is the cap. A third true offer is dropped rather than stacked — a to-do list on the first screen is what the old third slide already got wrong by leading with notifications."
        >
          <SheetStage
            mux={MUX}
            host="bluefin"
            panes={0}
            needsYou={0}
            machines={0}
            pushState={pushDone}
            installOffer
          />
        </Card>
      </Group>

      <Group title="Showing it again">
        <Card
          state="settings-row"
          label="the Settings row that shows the screen again"
          reach="Settings, under Zen mode"
          note="The real row. Its button resets the store and navigates home — inside this card the navigation lands on the harness's own memory router, so nothing leaves the page."
        >
          <RootRouter data={homeSolo}>
            <TourControl />
          </RootRouter>
        </Card>
      </Group>
    </Section>
  );
}
