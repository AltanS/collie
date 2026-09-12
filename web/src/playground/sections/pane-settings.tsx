// Pane settings section of the states playground: the one-switch sheet a pane's ⋮ opens, in each of the
// states its switch can be in. Split out of app.tsx; see that file's header comment for the page's rules.
//
// Every card mounts the REAL sheet. What differs is the reading it is handed, because the three disabled
// reasons are three different sentences and the point of this page is reading them side by side.
//
// The sheet's own controller fetches `GET /api/notifications/cache-watch`, which the playground cannot
// answer (nothing here is stubbed, by rule). So the cards below mount the presentational half,
// `PaneSettingsView`, with a fixture — the same markup, the same switch, no pretend bridge.

import { PaneSettingsView } from "@/components/pane-settings-sheet";
import { cacheWatchOff } from "../fixtures";
import { Card, Group, Section, Stage, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "pane-settings",
  title: "Pane settings",
  intent:
    "The pane settings sheet and its one switch — the prompt-cache warning — off, on, and each of " +
    "the three reasons it is disabled: push off on this device, the global switch already covering " +
    "every pane, and a pane whose agent names no session.",
};

function SheetStage({
  state,
  pushOff = false,
}: {
  state: Parameters<typeof PaneSettingsView>[0]["state"];
  pushOff?: boolean;
}) {
  return (
    <Stage height={200}>
      <div className="flex h-full flex-col justify-end">
        <PaneSettingsView state={state} busy={false} pushOff={pushOff} onToggle={() => {}} />
      </div>
    </Stage>
  );
}

export function PaneSettingsSection() {
  return (
    <Section def={DEF}>
      <Group title="The switch">
        <Card
          state="pane-settings-off"
          label="pane settings, the warning off"
          reach="open a pane, tap ⋮, then Pane settings. The hint quotes the bridge's own window, and
            it says about — the deadline is read off the agent's transcript and the clock is the poll."
        >
          <SheetStage state={cacheWatchOff} />
        </Card>

        <Card
          state="pane-settings-on"
          label="pane settings, watching this pane"
          reach="tap the switch. One push goes out about five minutes before this pane's cache expires,
            once per warm cycle."
        >
          <SheetStage state={{ ...cacheWatchOff, on: true }} />
        </Card>
      </Group>

      <Group title="The three disabled reasons">
        <Card
          state="pane-settings-push-disabled"
          label="pane settings, push off on this device"
          reach="open the sheet on a phone that has not enabled notifications. The switch is dead and
            the hint points at Settings, which is where the remedy is."
          note="The only one of the three that is about this DEVICE rather than this pane."
        >
          <SheetStage state={cacheWatchOff} pushOff />
        </Card>

        <Card
          state="pane-settings-global-on"
          label="pane settings, Settings already covers every pane"
          reach="turn the fourth notify switch on in Settings, then open this sheet. It reads ON,
            because the warning IS going out — there is no per-pane off that overrides the global one."
        >
          <SheetStage state={{ ...cacheWatchOff, global: true }} />
        </Card>

        <Card
          state="pane-settings-unwatchable"
          label="pane settings, nothing to watch"
          reach="open the sheet on a pane whose agent has not taken a turn, has no journal adapter, or
            named no session. There is no deadline to warn about, so the switch says why rather than
            accepting a preference that could never fire."
        >
          <SheetStage state={{ ...cacheWatchOff, watchable: false }} />
        </Card>
      </Group>
    </Section>
  );
}
