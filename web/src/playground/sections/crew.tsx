// Crew section of the states playground. Split out of app.tsx; see that file's header comment for
// the whole page's rules.

import { HostChip } from "@/components/host-chip";
import { HostStaleBanner } from "@/components/host-stale-banner";
import { ServerSwitcher } from "@/components/server-switcher";
import {
  censusConflicted,
  censusFive,
  censusNine,
  censusTrio,
  homeCrew,
  homeNine,
  homeSolo,
  homeTrio,
  hostIncompatible,
  hostNeverSeen,
  hostUnreachable,
  paneHostIncompatible,
  paneHostNeverSeen,
  paneHostUnreachable,
  rosterFive,
  rosterPalette,
} from "../fixtures";
import { Card, CrewRouter, Group, PackedRootRouter, PaneRouter, Section, Stage, type SectionDef } from "../harness";
import { PhoneFrameCard } from "./shared";

export const DEF: SectionDef = {
  id: "crew",
  title: "Crew",
  intent:
    "More than one machine. The formation drawing at four sizes, the cards for a crew that isn't one, the host switcher, and the tier-2 banners that name a machine, not a link, as the thing that broke.",
};

export function CrewSection() {
  return (
    <Section def={DEF}>
      <Group title="Formation">
        <Card
          state="formation-trio"
          label="formation, solo (lead, deputy, one)"
          reach="Settings → Crew on a collie that leads a small crew. Lead at the apex, deputy beneath it on the thick connector, everyone else fanned into a V."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <CrewRouter home={homeTrio} crew={{ status: censusTrio, error: false }} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="formation-five-three-problems"
          label="formation, five machines, three problems"
          reach="a real crew that has been running a while: one peer gone quiet, one enrolled and never once reached, one speaking a protocol this lead cannot. Tap a machine for its paperwork."
          note="The incompatible member's reason is the peer's own words, printed verbatim — the fix follows from the wording, so it is never paraphrased."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <CrewRouter home={homeCrew} crew={{ status: censusFive, error: false }} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="formation-nine"
          label="formation, nine machines (the V wraps)"
          reach="keep adding peers. Past about six the fan cannot stay on one row and the layout wraps it — this is the card that says whether it still reads as a formation."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <CrewRouter home={homeNine} crew={{ status: censusNine, error: false }} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="formation-conflicted-member"
          label="formation, a conflicted member"
          reach="two collies both believe they lead this crew. Not a transient the next poll clears, so the page names it rather than folding it into “unreachable”."
          span={2}
        >
          <PhoneFrameCard height={640}>
            <CrewRouter home={homeTrio} crew={{ status: censusConflicted, error: false }} />
          </PhoneFrameCard>
        </Card>
      </Group>

      <Group title="No crew">
        <Card
          state="crew-solo-no-census"
          label="crew, solo (a 404 is an answer)"
          reach="open Settings → Crew on a collie that leads no crew. The bridge answers 404, which the loader turns into `null` — “there is no crew here” is an answer, not a failure."
        >
          <Stage height={300}>
            <CrewRouter home={homeSolo} crew={{ status: null, error: false }} />
          </Stage>
        </Card>

        <Card
          state="crew-census-failed"
          label="crew, the census could not be fetched"
          reach="open the same page with the bridge down. This one IS a failure, and it says so differently from the solo card above."
        >
          <Stage height={300}>
            <CrewRouter home={homeSolo} crew={{ status: null, error: true }} />
          </Stage>
        </Card>
      </Group>

      <Group title="Host colours and switcher">
        <Card
          state="host-colours-palette"
          label="host colours, the whole palette, and a real crew"
          reach="be on a crew. Every surface that names a machine tints it, so the dashboard reads as several machines before the eye reads a name."
          note="Ten hues, assigned by lib/hosts.ts `hostSlot` and defined in index.css, chosen to avoid every status hue. The top row is a made-up ten-machine roster whose ids land one per slot; below it is the five-machine crew, whose names hash to 0, 2, 4, 8 and 9 — which is the honest spread, not an even one. A solo collie gets NO host colour at all."
          span={2}
        >
          <Stage>
            <div className="flex flex-col gap-3 p-3">
              <PackedRootRouter data={{ ...homeCrew, servers: rosterPalette }}>
                <div className="flex flex-wrap items-center gap-1.5">
                  {rosterPalette.map((s) => (
                    <HostChip key={s.id} host={s.id} />
                  ))}
                </div>
              </PackedRootRouter>
              <PackedRootRouter data={homeCrew}>
                <div className="flex flex-wrap items-center gap-3">
                  {rosterFive.map((s) => (
                    <HostChip key={s.id} host={s.id} />
                  ))}
                  <ServerSwitcher servers={rosterFive} scope={{}} agents={homeCrew.agents} />
                </div>
              </PackedRootRouter>
            </div>
          </Stage>
        </Card>

        <Card
          state="host-switcher"
          label="host switcher"
          reach="be on a crew with more than one reachable machine. The chip names where you are; tap it for the sheet."
          note="The sheet's open/closed state is the component's OWN — there is no `open` prop to force, and inventing one would be a fork. Tap the chip; the sheet is portalled to <body>, so it takes the whole window."
        >
          <Stage height={120}>
            <PackedRootRouter data={homeCrew}>
              <div className="flex items-center gap-2 p-3">
                <ServerSwitcher servers={rosterFive} scope={{}} agents={homeCrew.agents} />
              </div>
            </PackedRootRouter>
          </Stage>
        </Card>
      </Group>

      <Group title="Host-stale banner">
        <Card
          state="host-stale-unreachable"
          label="host-stale banner, unreachable"
          reach="on a crew: your link is fine but this pane's MACHINE is not. It appears inside the pane frame, over the last screen that machine did send."
          note="Hand-built HostHealth values — the banner's table is keyed on `state` and `writable` TOGETHER, so a row of it can only be shown by stating both."
        >
          <Stage>
            <HostStaleBanner health={hostUnreachable} />
          </Stage>
        </Card>

        <Card
          state="host-stale-never-seen"
          label="host-stale banner, never seen"
          reach="`collie crew add` a machine that has not come up yet. There is no cached screen behind this one, which is what makes it a different sentence."
        >
          <Stage>
            <HostStaleBanner health={hostNeverSeen} />
          </Stage>
        </Card>

        <Card
          state="host-stale-incompatible"
          label="host-stale banner, protocol incompatible"
          reach="run a peer on a Collie whose crew protocol this lead cannot speak. `collie crew update` levels it to the lead's own commit."
        >
          <Stage>
            <HostStaleBanner health={hostIncompatible} />
          </Stage>
        </Card>
      </Group>

      <Group title="Host-stale in a pane">
        <Card
          state="host-stale-in-pane-unreachable"
          label="host-stale banner, inside a real pane (unreachable)"
          reach="open a pane on a peer that has gone quiet. It sits above the tab strip and the mirror, inside the pane frame — never the standalone box the three cards above show it in."
          note="Real <PaneRouter/> on homeCrew (rosterFive), the pane re-hosted onto `attic` — the SAME
            real AgentChat mount the Pane tab uses, run through the real hostHealth() derivation
            instead of a hand-built HostHealth. Every homeSolo pane fixture on the Pane tab uses
            rosterSolo (empty), which is why this banner could never appear there."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <PaneRouter home={homeCrew} fixture={paneHostUnreachable} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="host-stale-in-pane-never-seen"
          label="host-stale banner, inside a real pane (never seen)"
          reach="`collie crew add` a machine, open a pane tagged to it before it has ever come up."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <PaneRouter home={homeCrew} fixture={paneHostNeverSeen} />
          </PhoneFrameCard>
        </Card>

        <Card
          state="host-stale-in-pane-incompatible"
          label="host-stale banner, inside a real pane (incompatible)"
          reach="open a pane on a peer running a crew protocol this lead cannot speak."
          span={2}
        >
          <PhoneFrameCard height={760}>
            <PaneRouter home={homeCrew} fixture={paneHostIncompatible} />
          </PhoneFrameCard>
        </Card>
      </Group>
    </Section>
  );
}
