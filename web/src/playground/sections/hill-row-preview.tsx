import { useState } from "react";

import { HillRow, HillRowCard } from "@/components/hill-row";

import { homeSolo } from "../fixtures";
import { RootRouter } from "../harness";

// The Hill's row of Settings, Tricks (components/hill-row.tsx) for the playground's sections: the real row in a card of the
// list's look, with a switch that flips in place. The row's name is a link, so it needs a router: `HillRowStandalone` brings its own,
// `HillRowInCard` is for a card that stands inside one already.

const DETAILS = "/settings/tricks/hill";

/** The row with a switch that flips in place, for the `hill` prop of the trick list or a card of its own. `waiting`: open Decisions (any arms the first tap off). */
export function HillRowFlipping({ initial, waiting = 0 }: { initial: boolean; waiting?: number }) {
  const [on, setOn] = useState(initial);
  return <HillRow on={on} disabled={false} waiting={waiting} onToggle={setOn} to={DETAILS} />;
}

/** The row in its own list card, inside the router of the caller. */
export function HillRowInCard({ initial, waiting = 0 }: { initial: boolean; waiting?: number }) {
  return (
    <HillRowCard>
      <HillRowFlipping initial={initial} waiting={waiting} />
    </HillRowCard>
  );
}

/** The row in its own list card with a router of its own, in a 390px column. */
export function HillRowStandalone({ initial, waiting = 0 }: { initial: boolean; waiting?: number }) {
  return (
    <RootRouter data={homeSolo}>
      <HillRowInCard initial={initial} waiting={waiting} />
    </RootRouter>
  );
}
