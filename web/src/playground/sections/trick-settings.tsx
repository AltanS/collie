// The Trick settings section of the states playground (M94 slice 04): the card behind Settings → Tricks in
// each state a list can be in. Every card mounts the REAL card at 390 px over a store of its own, and
// the switches talk to a stand-in that answers after a moment, so a flip shows the held position and
// stays. The provenance times read against a fixed clock.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { TrickAboutSheet } from "@/components/trick-about-sheet";
import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { homeSolo } from "../fixtures";
import { ABOUT_MAX, type TricksReply, type WireTrickInfo } from "@/lib/tricks/schema";
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

/** The stand-ins for the auto and undo routes: they answer after a moment, as the bridge would. */
function autoStandIn(tricks: WireTrickInfo[]) {
  return async (_host: string, id: string, on: boolean): Promise<WireTrickInfo> => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const found = tricks.find((m) => m.id === id) ?? trick(id, id);
    return { ...found, auto: on };
  };
}

function undoStandIn(tricks: WireTrickInfo[]) {
  return async (_host: string, id: string): Promise<WireTrickInfo> => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const found = tricks.find((m) => m.id === id) ?? trick(id, id);
    return { ...found, autoAt: undefined };
  };
}

function ListCard({ n, state, label, tricks, readOnly, hillOff }: { n: number; state: string; label: string; tricks: WireTrickInfo[]; readOnly?: boolean; hillOff?: boolean }) {
  const store = useListStore(tricks);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div className="w-[390px] max-w-full bg-background p-4">
        <RootRouter data={homeSolo}>
          <TricksSettingsCard store={store} onSwitch={standIn(tricks)} onAuto={autoStandIn(tricks)} onUndo={undoStandIn(tricks)} now={NOW} readOnly={readOnly} hillOff={hillOff} />
        </RootRouter>
      </div>
    </Card>
  );
}

// A trick's About sheet. The sheet is a fixed overlay, so each case sits in a 390 by 844 box (a phone) that is its own
// containing block (`transform`) and its own viewport height (`--app-h`): the sheet opens inside the box.

const ABOUT_TWO_PARAGRAPHS = [
  "Release Gates shows which release checks are green for the release branch you are on, one line for each check.",
  "It reads the check results from your agent sessions' folders and never changes a file.",
].join("\n\n");

/** An `about` of exactly `ABOUT_MAX` characters: four paragraphs of plain sentences, cut at the cap. */
function aboutAtCap(): string {
  const sentence = "Running Builds lists the builds and the long commands that run in your sessions right now. ";
  const paragraph = sentence.repeat(3).trim();
  const text = Array.from({ length: 5 }, () => paragraph).join("\n\n");
  const cut = text.slice(0, ABOUT_MAX);
  return cut.length === ABOUT_MAX ? cut : cut.padEnd(ABOUT_MAX, ".");
}

const GATES: WireTrickInfo = trick("gates", "Release Gates", {
  on: false,
  state: "off",
  places: ["belt", "dashboard"],
  description: "Which release checks are green for this branch.",
  about: ABOUT_TWO_PARAGRAPHS,
  inputs: { globs: ["RELEASE.md"], crew: false },
  warnings: [{ kind: "network", text: "This trick reaches the network." }],
  provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "AltanS/collie-tricks", sha: "9c41d07e2b6a" },
});

function SheetBox({ n, state, label, trick: info, updates = false }: { n: number; state: string; label: string; trick: WireTrickInfo; updates?: boolean }) {
  const [open, setOpen] = useState(true);
  // The Updates switch of a trick that is on: flips at once, as the card holds it.
  const [auto, setAuto] = useState(info.auto === true);
  const style: CSSProperties & { "--app-h"?: string } = { width: 390, height: 844, transform: "translate(0)", "--app-h": "844px" };
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div data-pg-frame="" className="relative isolate overflow-hidden rounded-xl border border-border bg-background" style={style}>
        <button type="button" className="m-4 min-h-11 text-sm underline" onClick={() => setOpen(true)}>
          About {info.name}
        </button>
        <TrickAboutSheet trick={info} open={open} onClose={() => setOpen(false)} auto={auto} onAuto={updates ? setAuto : undefined} />
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
      <Group title="Before the switch">
        <ListCard
          n={8}
          state="trick-settings-warnings"
          label="warnings before the switch"
          tricks={[
            trick("standup", "Standup notes", {
              on: false,
              state: "off",
              places: ["session"],
              provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "AltanS/collie-tricks", sha: "9c41d07e2b6a" },
              warnings: [
                { kind: "model", text: "On a timer this trick starts an agent or calls a model. Each run can use your subscription." },
                { kind: "network", text: "This trick reaches the network." },
              ],
            }),
            trick("clock", "Clock", { on: false, state: "off", places: ["belt"], provenance: { via: "cli", at: "2026-11-08T09:38:00Z" } }),
          ]}
        />
      </Group>
      <Group title="Undo a change">
        <ListCard
          n={11}
          state="trick-settings-auto"
          label="a version was taken without asking: the card shows the Undo line"
          tricks={[
            trick("legs", "Browser leg", { auto: true, autoAt: "2026-11-08T09:38:00Z", provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }),
            trick("tracker", "Tracker", { places: ["session"], provenance: { via: "repo", at: "2026-11-07T21:10:00Z", repo: "owner/tracker-trick", sha: "3f2a91c0d4e5" } }),
          ]}
        />
      </Group>
      <Group title="The About sheet">
        <ListCard
          n={12}
          state="trick-settings-about-card"
          label="the name is a button, a description sits under it (tap a name)"
          tricks={[
            GATES,
            trick("builds", "Running Builds", { on: true, description: "Builds and long commands running in sessions now.", provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }),
            trick("clock", "Clock", { places: ["belt"], provenance: { via: "cli", at: "2026-11-08T09:38:00Z" } }),
          ]}
        />
        <SheetBox n={13} state="trick-settings-about-full" label="description, two paragraphs, inputs, one warning, origin" trick={GATES} />
        <SheetBox
          n={14}
          state="trick-settings-about-none"
          label="no about"
          trick={trick("clock", "Clock", { on: false, state: "off", places: ["belt"], provenance: { via: "cli", at: "2026-11-08T09:38:00Z" } })}
        />
        <SheetBox
          n={15}
          state="trick-settings-about-long"
          label="about at the cap (1200 characters)"
          trick={trick("builds", "Running Builds", { places: ["belt", "session", "dashboard"], description: "Builds and long commands running in sessions now.", about: aboutAtCap(), env: ["GH_TOKEN"] })}
        />
        <SheetBox
          n={16}
          state="trick-settings-about-updates"
          label="switched on: the Updates switch last"
          updates
          trick={trick("gates", "Release Gates", {
            description: "Which release checks are green for this branch.",
            about: ABOUT_TWO_PARAGRAPHS,
            provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "AltanS/collie-tricks", sha: "9c41d07e2b6a" },
          })}
        />
      </Group>
      <Group title="Nothing to list">
        <ListCard n={6} state="trick-settings-empty" label="folder, no trick" tricks={[]} />
        <ListCard n={7} state="trick-settings-read-only" label="a device that may only read" tricks={HEALTHY.slice(0, 2)} readOnly />
      </Group>
      <Group title="The Hill switched off">
        <ListCard
          n={9}
          state="trick-settings-hill-off"
          label="Hill off, one trick asks"
          tricks={[trick("legs", "Browser leg", { decides: true, provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }), HEALTHY[2] ?? trick("x", "x")]}
          hillOff
        />
        <ListCard
          n={10}
          state="trick-settings-hill-off-warnings"
          label="Hill off, changed trick with warnings"
          tricks={[
            trick("legs", "Browser leg", {
              decides: true,
              changed: true,
              provenance: { via: "agent", at: "2026-11-08T07:41:00Z" },
              warnings: [{ kind: "network", text: "This trick reaches the network." }],
            }),
          ]}
          hillOff
        />
      </Group>
    </Section>
  );
}
