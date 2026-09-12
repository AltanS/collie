// Tour section of the states playground. Split per file like every other section; see app.tsx's
// header comment for the whole page's rules.
//
// THE CARDS TOUCH NO STORAGE AND NO BROWSER PUSH API. `TourSheet` is controlled — `index`,
// `readOnly` and `pushState` are all props — so every slide here is a prop combination and nothing
// on this page can mark the real tour seen or raise a real permission prompt. That is the whole
// reason the gate (`TourHost`) lives in the same file but is not mounted here.

import { useState } from "react";

import { TourSheet } from "@/components/tour-sheet";
import { TourControl } from "@/components/tour-control";
import type { PushState } from "@/lib/push";

import { Card, Group, RootRouter, Section, Stage, type SectionDef } from "../harness";
import { homeSolo } from "../fixtures";

export const DEF: SectionDef = {
  id: "tour",
  title: "Tour",
  intent:
    "The first-launch sheet, slide by slide: what Collie mirrors, how a pane is answered, and how to be told when one needs you. Then the two states slide 3 can be in before it offers anything, and the Settings row that shows the whole thing again.",
};

/** How tall a full-height sheet gets to be in a card. `dvh` pulls the sheet's `h-[100dvh]` down to
 *  the box instead of the page (see playground.css), so the slide is shown at its real proportions. */
const SHEET_HEIGHT = 680;

function push(overrides: Partial<PushState> = {}): PushState {
  return { availability: "ready", subscribed: false, userDisabled: false, ...overrides };
}

/**
 * One mounted sheet. The index starts where the card says and then follows the real controls, so the
 * dots, the arrows and a swipe are all live inside a card. The close reason is printed rather than
 * acted on: nothing in the app branches on it, and seeing which button produced which word is the
 * only way to judge that from outside.
 */
function SheetStage({
  start,
  readOnly = false,
  pushState,
}: {
  start: number;
  readOnly?: boolean;
  pushState?: PushState | null;
}) {
  const [index, setIndex] = useState(start);
  const [closed, setClosed] = useState<string | null>(null);

  return (
    <Stage height={SHEET_HEIGHT} dvh>
      <TourSheet
        open={closed === null}
        index={index}
        onIndex={setIndex}
        onClose={setClosed}
        readOnly={readOnly}
        pushState={pushState}
      />
      {closed !== null && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
          <p>closed with reason: {closed}</p>
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
      <Group title="The three slides">
        <Card
          state="slide-1"
          label="slide 1, what Collie mirrors"
          reach="open Collie on a device that has never run it, after the first snapshot lands"
          note="The mark is the boot splash's own drawing, not a new asset. The dots and the arrows are live: this card is the whole sheet, not a picture of one slide."
        >
          <SheetStage start={0} pushState={push({ subscribed: true })} />
        </Card>

        <Card
          state="slide-2"
          label="slide 2, answering a pane"
          reach="tap Next on slide 1, swipe left, or tap the second dot"
          note="'Tap Type' is the real control's real name — a named tap beside Keys in the composer row, never a hold."
        >
          <SheetStage start={1} pushState={push({ subscribed: true })} />
        </Card>

        <Card
          state="slide-2-read-only"
          label="slide 2, a device that cannot type"
          reach="the same device, with pairing enforced and this device not paired"
          note="Same first two sentences: reading the mirror and tapping a card both still work. Only the instruction this device cannot honour is swapped."
        >
          <SheetStage start={1} readOnly pushState={push({ subscribed: true })} />
        </Card>

        <Card
          state="slide-3"
          label="slide 3, the live notification offer"
          reach="tap Next on slide 2 on a device where push is available and nothing has been decided yet"
          note="The button here is wired to a literal push state, so tapping it confirms without asking the browser for anything."
        >
          <SheetStage start={2} pushState={push()} />
        </Card>
      </Group>

      <Group title="Slide 3 with nothing to offer">
        <Card
          state="push-unavailable"
          label="slide 3, push cannot run here"
          reach="reach slide 3 on a bridge with no VAPID keys, over plain HTTP, or in a browser without the Push API"
          note="No button at all — the sentence comes from lib/push-copy.ts, the same table the Settings row prints under its blocked toggle."
        >
          <SheetStage start={2} pushState={push({ availability: "server-off" })} />
        </Card>

        <Card
          state="push-decided"
          label="slide 3, the answer is already in"
          reach="reach slide 3 on a device that is already subscribed, or that turned notifications off"
          note="Shown here in the subscribed case. The other half of this state reads 'You turned notifications off. Settings can turn them back on.'"
        >
          <SheetStage start={2} pushState={push({ subscribed: true })} />
        </Card>
      </Group>

      <Group title="Showing it again">
        <Card
          state="settings-row"
          label="the Settings row that replays the tour"
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
