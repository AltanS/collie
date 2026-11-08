// The Mod settings section of the states playground (M94 slice 04): the card behind Settings → Mods in
// each state a list can be in. Every card mounts the REAL card at 390 px over a store of its own, and
// the switches talk to a stand-in that answers after a moment, so a flip shows the held position and
// stays. The provenance times read against a fixed clock.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useState, type ReactNode } from "react";

import { ModsSettingsCard } from "@/components/mods-settings-card";
import { homeSolo } from "../fixtures";
import type { ModsReply, WireModInfo } from "@/lib/mods/schema";
import { createModsStore, type ModsStore } from "@/lib/mods/store";

import { RootRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "mod-settings",
  title: "Mod settings",
  intent: "The Mods card on Settings, in each state a list of mods can be in, at 390 px.",
};

const NOW = Date.parse("2026-11-08T09:41:00Z");

function mod(id: string, name: string, extra: Partial<WireModInfo> = {}): WireModInfo {
  return { host: "bluefin", id, name, icon: "plug", on: true, state: "ok", places: ["belt", "session"], provenance: { via: "folder" }, ...extra };
}

const HEALTHY: WireModInfo[] = [
  mod("legs", "Browser leg", { provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }),
  mod("tracker", "Tracker", { places: ["session"], provenance: { via: "repo", at: "2026-11-07T21:10:00Z", repo: "owner/tracker-mod", sha: "3f2a91c0d4e5" } }),
  mod("clock", "Clock", { places: ["belt"], provenance: { via: "cli", at: "2026-11-08T09:38:00Z" } }),
];

/** A store that takes one reply listing `mods`, as the phone does when the snapshot carries `modsRev`. */
function useListStore(mods: WireModInfo[]): ModsStore {
  const [store] = useState(() => {
    const reply: ModsReply = { rev: 1, mods, parts: [], present: [] };
    return createModsStore({ fetchMods: async () => reply, tapMod: () => Promise.reject(new Error("no taps here")), mintRequestId: () => "playground" });
  });
  useEffect(() => {
    void store.syncMods(1);
  }, [store]);
  return store;
}

/** The stand-in for the switch route: answers after a moment with the position asked for. */
function standIn(mods: WireModInfo[]) {
  return async (_host: string, id: string, on: boolean): Promise<WireModInfo> => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const found = mods.find((m) => m.id === id) ?? mod(id, id);
    return { ...found, on, state: on ? "ok" : "off" };
  };
}

function ListCard({ n, state, label, mods, readOnly }: { n: number; state: string; label: string; mods: WireModInfo[]; readOnly?: boolean }) {
  const store = useListStore(mods);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div className="w-[390px] max-w-full bg-background p-4">
        <RootRouter data={homeSolo}>
          <ModsSettingsCard store={store} onSwitch={standIn(mods)} now={NOW} readOnly={readOnly} />
        </RootRouter>
      </div>
    </Card>
  );
}

export function ModSettingsSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The list">
        <ListCard n={1} state="mod-settings-healthy" label="three mods, three origins" mods={HEALTHY} />
        <ListCard
          n={2}
          state="mod-settings-off"
          label="one switched off"
          mods={[mod("legs", "Browser leg", { on: false, state: "off", provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }), HEALTHY[1] ?? mod("x", "x")]}
        />
        <ListCard
          n={3}
          state="mod-settings-failing"
          label="failing and stopped"
          mods={[
            mod("legs", "Browser leg", { state: "failing", error: "legs.sh: exit 2: no such file ~/.cache/collie-lab/browser-leg/last.json" }),
            mod("tracker", "Tracker", { state: "stopped", places: ["session"], error: "exit 1, five times in a row, backed off 1, 5 and 30 minutes" }),
            HEALTHY[2] ?? mod("x", "x"),
          ]}
        />
        <ListCard
          n={4}
          state="mod-settings-refused"
          label="manifest refused"
          mods={[mod("bad", "Bad manifest", { on: false, state: "skipped", places: [], refusals: [{ code: "place", path: "/places/0", reason: 'places[0]: "nowhere" is not a place' }] })]}
        />
        <ListCard
          n={5}
          state="mod-settings-long"
          label="long names, no parts"
          mods={[
            mod("long", "A mod with a name as long as the field allows it", { places: ["belt", "session", "tab-mark", "tab", "view", "dashboard"] }),
            mod("none", "No parts", { places: [], provenance: { via: "repo", repo: "someone-with-a-long-name/a-repository-with-a-long-name", sha: "0123456789abcdef" } }),
          ]}
        />
      </Group>
      <Group title="Nothing to list">
        <ListCard n={6} state="mod-settings-empty" label="folder, no mod" mods={[]} />
        <ListCard n={7} state="mod-settings-read-only" label="a device that may only read" mods={HEALTHY.slice(0, 2)} readOnly />
      </Group>
    </Section>
  );
}
