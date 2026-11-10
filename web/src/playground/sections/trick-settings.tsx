// The Trick settings section of the states playground (M94 slice 04): the card behind Settings → Tricks in
// each state a list can be in. Every card mounts the REAL card at 390 px over a store of its own, and
// the switches talk to a stand-in that answers after a moment, so a flip shows the held position and
// stays. The provenance times read against a fixed clock.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useState, type ReactNode } from "react";

import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { homeSolo } from "../fixtures";
import type { TricksReply, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";

import { RootRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "trick-settings",
  title: "Trick settings",
  intent: "The Tricks card on Settings, in each state a list of tricks can be in, at 390 px.",
};

const NOW = Date.parse("2026-11-08T09:41:00Z");

function trick(id: string, name: string, extra: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return { host: "bluefin", id, name, icon: "plug", on: true, state: "ok", places: ["belt", "session"], provenance: { via: "folder" }, ...extra };
}

const HEALTHY: WireTrickInfo[] = [
  trick("legs", "Browser leg", { provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }),
  trick("tracker", "Tracker", { places: ["session"], provenance: { via: "repo", at: "2026-11-07T21:10:00Z", repo: "owner/tracker-trick", sha: "3f2a91c0d4e5" } }),
  trick("clock", "Clock", { places: ["belt"], provenance: { via: "cli", at: "2026-11-08T09:38:00Z" } }),
];

/** A store that takes one reply listing `tricks`, as the phone does when the snapshot carries `tricksRev`. */
function useListStore(tricks: WireTrickInfo[]): TricksStore {
  const [store] = useState(() => {
    const reply: TricksReply = { rev: 1, tricks, parts: [], present: [] };
    return createTricksStore({ fetchTricks: async () => reply, tapTrick: () => Promise.reject(new Error("no taps here")), mintRequestId: () => "playground" });
  });
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return store;
}

/** The stand-in for the switch route: answers after a moment with the position asked for. */
function standIn(tricks: WireTrickInfo[]) {
  return async (_host: string, id: string, on: boolean): Promise<WireTrickInfo> => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const found = tricks.find((m) => m.id === id) ?? trick(id, id);
    return { ...found, on, state: on ? "ok" : "off" };
  };
}

function ListCard({ n, state, label, tricks, readOnly, hillOff }: { n: number; state: string; label: string; tricks: WireTrickInfo[]; readOnly?: boolean; hillOff?: boolean }) {
  const store = useListStore(tricks);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div className="w-[390px] max-w-full bg-background p-4">
        <RootRouter data={homeSolo}>
          <TricksSettingsCard store={store} onSwitch={standIn(tricks)} now={NOW} readOnly={readOnly} hillOff={hillOff} />
        </RootRouter>
      </div>
    </Card>
  );
}

export function TrickSettingsSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The list">
        <ListCard n={1} state="trick-settings-healthy" label="three tricks, three origins" tricks={HEALTHY} />
        <ListCard
          n={2}
          state="trick-settings-off"
          label="one switched off"
          tricks={[trick("legs", "Browser leg", { on: false, state: "off", provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }), HEALTHY[1] ?? trick("x", "x")]}
        />
        <ListCard
          n={3}
          state="trick-settings-failing"
          label="failing and stopped"
          tricks={[
            trick("legs", "Browser leg", { state: "failing", error: "legs.sh: exit 2: no such file ~/.cache/collie-lab/browser-leg/last.json" }),
            trick("tracker", "Tracker", { state: "stopped", places: ["session"], error: "exit 1, five times in a row, backed off 1, 5 and 30 minutes" }),
            HEALTHY[2] ?? trick("x", "x"),
          ]}
        />
        <ListCard
          n={4}
          state="trick-settings-refused"
          label="manifest refused"
          tricks={[trick("bad", "Bad manifest", { on: false, state: "skipped", places: [], refusals: [{ code: "place", path: "/places/0", reason: 'places[0]: "nowhere" is not a place' }] })]}
        />
        <ListCard
          n={5}
          state="trick-settings-long"
          label="long names, no parts"
          tricks={[
            trick("long", "A trick with a name as long as the field allows it", { places: ["belt", "session", "status", "dashboard", "tabbar"] }),
            trick("none", "No parts", { places: [], provenance: { via: "repo", repo: "someone-with-a-long-name/a-repository-with-a-long-name", sha: "0123456789abcdef" } }),
          ]}
        />
      </Group>
      <Group title="Nothing to list">
        <ListCard n={6} state="trick-settings-empty" label="folder, no trick" tricks={[]} />
        <ListCard n={7} state="trick-settings-read-only" label="a device that may only read" tricks={HEALTHY.slice(0, 2)} readOnly />
      </Group>
      <Group title="The Hill switched off">
        <ListCard
          n={8}
          state="trick-settings-hill-off"
          label="Hill off, one trick asks"
          tricks={[trick("legs", "Browser leg", { decides: true, provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }), HEALTHY[2] ?? trick("x", "x")]}
          hillOff
        />
      </Group>
    </Section>
  );
}
