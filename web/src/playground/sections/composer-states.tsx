// Composer states section of the states playground (M56 spec 07): the way out, one numbered card per
// state. The cards are in ../composer-states.tsx; see app.tsx's header for the page's own rules.

import { Section, type SectionDef } from "../layout";
import { wayOutGroups } from "../composer-states";

export const DEF: SectionDef = {
  id: "composer-states",
  title: "Composer states",
  intent:
    "The way out, one card per state of the pane's Surface and the three facts the phone keeps. In every state but a pane that is gone, a device that may not write and a link that is down, the Screen pill and the Keys dock are one tap away. Each card is the real composer on a Claude pane; tap Keys, tap Screen, type and tap Send to see what lands at the thumb. The last five cards (14 to 18) are the held-send card, which floats over the mirror's bottom edge: one row, three collapsed, three expanded, a mixed queue, and the card stacked over the terminal-draft notice. Cards are numbered so a worker can be briefed by number.",
};

export function ComposerStatesSection() {
  return <Section def={DEF}>{wayOutGroups()}</Section>;
}
