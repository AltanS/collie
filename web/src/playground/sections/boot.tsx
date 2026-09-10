// Boot & connection section of the states playground. Split out of app.tsx; see that file's header
// comment for the whole page's rules.

import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { CollieHome } from "@/components/collie-home";
import { ConnectionBanner } from "@/components/connection-banner";
import { BootSplash } from "@/routes/root";
import { homeSolo } from "../fixtures";
import { Card, Group, RootRouter, Section, Stage, type ClockMode, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "boot",
  title: "Boot & connection",
  intent:
    "Everything that answers “is this thing talking to my machine?”: the first paint before any data, the one connection banner, and the header dog that tracks the same two thresholds.",
};

export function BootSection({ clock }: { clock: ClockMode }) {
  return (
    <Section def={DEF}>
      <Group title="Boot splash">
        <Card
          state="boot-splash-connecting"
          label={`boot splash, connecting to not connected (clock: ${clock})`}
          reach="the very first load, before the snapshot resolves. It escalates to “Not connected” once that first fetch has been stuck for 15s — e.g. reopening the PWA with the tailnet down."
          note="Real <BootSplash/> from routes/root.tsx, reading the shared clock. Move the CONNECTION CLOCK control above to pick which half you see. The control is GLOBAL, not section-local, because what it drives is: one module-scoped store feeds this splash, the banner below and the header dog in the Dashboard tab, so they can never disagree — a control parked inside one section would quietly be repainting the others too."
        >
          <Stage height={340} dvh>
            <RootRouter data={homeSolo}>
              <BootSplash />
            </RootRouter>
          </Stage>
        </Card>
      </Group>

      <Group title="Connection banner">
        <Card
          state="connection-banner-lost"
          label={`connection banner, trouble to lost (clock: ${clock})`}
          reach="pull the tailnet out from under a running Collie. Amber “reconnecting…” after 4s; red with a named cause plus Retry/Reload after 15s; a green flash on recovery."
          note="Red runs the genuine /api/config probe through the dev proxy, so the cause sentence names whatever the bridge on COLLIE_DEV_TARGET actually answers."
        >
          <Stage>
            <RootRouter data={homeSolo}>
              <ConnectionBanner
                bridge="disconnected"
                error
                authError={false}
                lastSeenAt={homeSolo.ts - 3_600_000}
              />
            </RootRouter>
          </Stage>
        </Card>

        <Card
          state="connection-banner-refused"
          label="connection banner, refused (401/403)"
          reach="let the fronting proxy's identity session expire. A refusal is not an outage, and the banner says so rather than blaming the link."
        >
          <Stage>
            <RootRouter data={homeSolo}>
              <ConnectionBanner bridge={undefined} error authError />
            </RootRouter>
          </Stage>
        </Card>
      </Group>

      <Group title="Header dog">
        <Card
          state="header-dog-full-bar"
          label={`header dog, the full bar (clock: ${clock})`}
          reach="same two thresholds as the banner: the mark blooms on sustained trouble and rests muted once the outage is lost."
          note="Follows the shared clock, so this card and the banner above always agree — that is the property the single module-scoped clock exists to guarantee."
        >
          <Stage>
            <RootRouter data={homeSolo}>
              <AppHeaderHost bridge="disconnected" error>
                <RouteHeader wordmark rightTrail={<SettingsGear />} />
              </AppHeaderHost>
            </RootRouter>
          </Stage>
        </Card>

        <Card
          state="header-dog-three-states"
          label="header dog, live, troubled, lost, side by side"
          reach="you cannot reach all three at once for real; there is one clock. <CollieHome/> takes them as ordinary props, which is the one way to line them up."
        >
          <Stage>
            <div className="flex flex-col gap-1 bg-muted p-2">
              <CollieHome trouble={false} />
              <CollieHome trouble />
              <CollieHome trouble lost />
            </div>
          </Stage>
        </Card>
      </Group>
    </Section>
  );
}
