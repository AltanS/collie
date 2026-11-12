// The Trick settings section of the states playground (M94 slice 04): the card behind Settings → Tricks in
// each state a list can be in. Every card mounts the REAL card at 390 px over a store of its own, and
// the switches talk to a stand-in that answers after a moment, so a flip shows the held position and
// stays. The provenance times read against a fixed clock.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { HillAboutSheet } from "@/components/hill-entry";
import { StatusArea } from "@/components/status-area";
import { OfficialTrickAboutSheet, TrickAboutSheet } from "@/components/trick-about-sheet";
import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { addOfficialTrick } from "@/lib/api";
import { clearStatus } from "@/lib/status";
import { homeSolo } from "../fixtures";
import { VIEW_TRICK } from "../fixtures/agent-view";
import { ABOUT_MAX, type OfficialState, type OfficialTricksReply, type TricksGate, type TricksReply, type WireOfficialTrick, type WireTrickInfo } from "@/lib/tricks/schema";
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
  return { host: "lodge", id, name, icon: "plug", on: true, state: "ok", places: ["belt", "session"], provenance: { via: "folder" }, ...extra };
}

const HEALTHY: WireTrickInfo[] = [
  trick("legs", "Browser leg", { provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }),
  trick("tracker", "Tracker", { places: ["session"], provenance: { via: "repo", at: "2026-11-07T21:10:00Z", repo: "owner/tracker-trick", sha: "3f2a91c0d4e5" } }),
  trick("clock", "Clock", { places: ["belt"], provenance: { via: "cli", at: "2026-11-08T09:38:00Z" } }),
];

/** A store that takes one reply listing `tricks`, as the phone does when the snapshot carries `tricksRev`. */
function useListStore(tricks: WireTrickInfo[], gate?: TricksGate): TricksStore {
  const [store] = useState(() => {
    const reply: TricksReply = { rev: 1, tricks, parts: [], present: [] };
    if (gate !== undefined) reply.gate = gate;
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

function ListCard({ n, state, label, tricks, readOnly, hillOff, gate }: { n: number; state: string; label: string; tricks: WireTrickInfo[]; readOnly?: boolean; hillOff?: boolean; gate?: TricksGate }) {
  const store = useListStore(tricks, gate);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div className="w-[390px] max-w-full bg-background p-4">
        <RootRouter data={homeSolo}>
          <TricksSettingsCard
            store={store}
            onSwitch={standIn(tricks)}
            onAuto={autoStandIn(tricks)}
            onUndo={undoStandIn(tricks)}
            onOfficialList={NO_OFFICIAL}
            now={NOW}
            readOnly={readOnly}
            hillOff={hillOff}
          />
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

// The Hill's About sheet (2026-11-11): the built-in entry's sheet, in a phone-sized box as the trick's. It holds the
// switch's value itself and writes after a moment, as the bridge would; the first tap on a switch with Collie's own
// question waiting arms it (tap the switch once), the second goes off.

function HillSheetBox({ n, state, label, on: initial, count }: { n: number; state: string; label: string; on: boolean; count: number }) {
  const [open, setOpen] = useState(true);
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const style: CSSProperties & { "--app-h"?: string } = { width: 390, height: 844, transform: "translate(0)", "--app-h": "844px" };
  const set = (next: boolean) => {
    setBusy(true);
    setTimeout(() => {
      setOn(next);
      setBusy(false);
    }, 400);
  };
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div data-pg-frame="" className="relative isolate overflow-hidden rounded-xl border border-border bg-background" style={style}>
        <button type="button" className="m-4 min-h-11 text-sm underline" onClick={() => setOpen(true)}>
          About Hill
        </button>
        <HillAboutSheet open={open} onClose={() => setOpen(false)} on={on} canSet={!busy} waiting={count} onSet={set} />
      </div>
    </Card>
  );
}

// Official tricks (M94): the official tricks this release can add, under the installed ones. Each card has a list
// of its own and a stand-in for the add route; the one that shows a failure goes through the real api.ts call
// and a stand-in for the bridge's refusal (`useRefusedAdd`), so the status line reads the bridge's own word.

/** The cards above show no official section: an empty list, read without the network. */
const NO_OFFICIAL = async (): Promise<OfficialTricksReply> => ({ tricks: [] });

const OFFICIAL_COMMIT = "0d8039936aef44961a5641f4bfdc4583ed0c3e60";

function official(id: string, name: string, description: string, state: OfficialState = "absent"): WireOfficialTrick {
  return { id, name, description, repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: OFFICIAL_COMMIT, state };
}

const REVIEW = official("design-review", "Design Review", "Turns an agent's UI notes into Decisions you approve by name.");
const INBOX = official("pr-inbox", "PR Inbox", "Open pull requests and issues that wait for you.");
const BUILDS = official("running-builds", "Running Builds", "Builds and long commands running in your sessions now.");

/** A trick installed from an entry of the list: off, with the repository as its provenance. */
function fromList(entry: WireOfficialTrick, extra: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return trick(entry.id, entry.name, { on: false, state: "off", places: ["belt", "session"], description: entry.description, provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: entry.repoName, sha: "9c41d07e2b6a" }, ...extra });
}

/** How the card's add stand-in answers: it lands, it never answers, or the bridge refuses it (`mismatch`, or `changed` for an update). */
type AddAnswer = "lands" | "hangs" | "refused" | "changed";

/**
 * While mounted, `POST /api/tricks/official/<id>/add` answers what a bridge says when the code does not match
 * the list (422 `mismatch`), and `/update` what it says when the person changed the trick's files (409
 * `changed`). Only the cards that show a refusal post through the real call.
 */
function useRefusedAdd(on: boolean): void {
  useEffect(() => {
    if (!on) return undefined;
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (!/^\/api\/tricks\/official\/[^/]+\/(add|update)$/u.test(url.pathname)) return real(input, init);
      // An add is refused as a mismatch; an update as files the person changed. Both cards answer the same way.
      const refused =
        url.pathname.endsWith("/update")
          ? { status: 409, body: { error: "changed", message: "You edited its files. Update it on the machine." } }
          : { status: 422, body: { error: "mismatch", message: "The code did not match. Nothing was added." } };
      return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(refused.body), { status: refused.status, headers: { "content-type": "application/json" } })), 500));
    };
    return () => {
      window.fetch = real;
      clearStatus();
    };
  }, [on]);
}

function OfficialCard({ n, state, label, tricks, entries, answer = "lands" }: { n: number; state: string; label: string; tricks: WireTrickInfo[]; entries: WireOfficialTrick[]; answer?: AddAnswer }) {
  // The list and the installed tricks move together, as on a bridge: an add that lands puts the trick among
  // the installed ones, off, and the entry says added.
  const [held] = useState(() => ({ tricks: [...tricks], entries: [...entries], rev: 1 }));
  const [store] = useState(() =>
    createTricksStore({
      fetchTricks: async (): Promise<TricksReply> => ({ rev: held.rev, tricks: held.tricks, parts: [], present: [] }),
      tapTrick: () => Promise.reject(new Error("no taps here")),
      mintRequestId: () => "playground",
    }),
  );
  useEffect(() => {
    void store.syncTricks(held.rev);
  }, [store, held]);
  useRefusedAdd(answer === "refused" || answer === "changed");
  const onOfficialAdd = async (id: string, mode: "add" | "update"): Promise<{ id: string; state: OfficialState }> => {
    if (answer === "refused" || answer === "changed") return await addOfficialTrick(id, mode);
    if (answer === "hangs") return await new Promise<never>(() => {});
    await new Promise((resolve) => setTimeout(resolve, 900));
    const entry = held.entries.find((e) => e.id === id) ?? REVIEW;
    held.entries = held.entries.map((e) => (e.id === id ? { ...e, state: "added" } : e));
    held.tricks = mode === "add" ? [...held.tricks, fromList(entry)] : held.tricks;
    held.rev += 1;
    // The phone's list catches up a moment later, on the snapshot's cadence.
    setTimeout(() => void store.syncTricks(held.rev), 700);
    return { id, state: "added" };
  };
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div className="w-[390px] max-w-full bg-background p-4">
        <RootRouter data={homeSolo}>
          <TricksSettingsCard
            store={store}
            onSwitch={standIn(held.tricks)}
            onOfficialList={async () => ({ tricks: held.entries })}
            onOfficialAdd={onOfficialAdd}
            now={NOW}
          />
        </RootRouter>
        {(answer === "refused" || answer === "changed") && <StatusArea className="mt-4" />}
      </div>
    </Card>
  );
}

function OfficialSheetBox({ n, state, label, entry }: { n: number; state: string; label: string; entry: WireOfficialTrick }) {
  const [open, setOpen] = useState(true);
  const style: CSSProperties & { "--app-h"?: string } = { width: 390, height: 844, transform: "translate(0)", "--app-h": "844px" };
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div data-pg-frame="" className="relative isolate overflow-hidden rounded-xl border border-border bg-background" style={style}>
        <button type="button" className="m-4 min-h-11 text-sm underline" onClick={() => setOpen(true)}>
          About {entry.name}
        </button>
        <OfficialTrickAboutSheet entry={entry} open={open} onClose={() => setOpen(false)} busy={false} canWrite onAdd={() => setOpen(false)} />
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
          label="neither a description nor an about"
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
      <Group title="The Hill, built in">
        <ListCard n={31} state="trick-settings-hill-entry-row" label="the Hill is the first row, with no switch: tap it" tricks={HEALTHY.slice(0, 2)} />
        <HillSheetBox n={32} state="trick-settings-hill-entry-on" label="the sheet with the switch on, nothing waiting" on count={0} />
        <HillSheetBox n={33} state="trick-settings-hill-entry-armed" label="3 waiting: tap the switch once, it arms; tap again inside four seconds, it goes off" on count={3} />
        <HillSheetBox n={34} state="trick-settings-hill-entry-off" label="the switch off" on={false} count={3} />
      </Group>
      <Group title="An agent view (contract 2)">
        <ListCard n={26} state="trick-settings-agent-view" label="a view-only trick: agent view as its place, a switch" tricks={[VIEW_TRICK, HEALTHY[2] ?? trick("x", "x")]} />
        <SheetBox n={27} state="trick-settings-agent-view-about" label="its About sheet: the rights, the rules line, the fold (tap it to open)" trick={VIEW_TRICK} />
        <SheetBox n={28} state="trick-settings-agent-view-about-on" label="switched on: still no Updates switch" updates trick={{ ...VIEW_TRICK, on: true, state: "ok" }} />
        <ListCard n={29} state="trick-settings-agent-view-unshown" label="rules this phone cannot show: the row says so, the switch cannot go on" tricks={[{ ...VIEW_TRICK, rules: undefined, rulesUnshown: true }]} />
        <OfficialSheetBox n={30} state="trick-settings-agent-view-official" label="an official agent view before the add: read the instructions after the add" entry={{ ...official("morph", "Morph", "Your agent answers by drawing one screen."), givesRules: true }} />
      </Group>
      <Group title="Official tricks">
        <OfficialCard n={25} state="trick-settings-official-fresh" label="a fresh install: no trick yet, the list alone; tap Add, the trick lands, off" tricks={[]} entries={[REVIEW, INBOX, BUILDS]} />
        <OfficialCard n={17} state="trick-settings-official" label="two not added: tap Add, the trick lands among yours, off" tricks={HEALTHY.slice(0, 2)} entries={[REVIEW, INBOX, { ...BUILDS, state: "added" }]} />
        <OfficialCard n={18} state="trick-settings-official-adding" label="adding: tap Add, the spinner stays" tricks={HEALTHY.slice(0, 1)} entries={[REVIEW, INBOX]} answer="hangs" />
        <OfficialCard n={19} state="trick-settings-official-failed" label="a failed add: tap Add, the status line says why" tricks={HEALTHY.slice(0, 1)} entries={[REVIEW]} answer="refused" />
        <OfficialCard n={20} state="trick-settings-official-update" label="this release names a newer version" tricks={[HEALTHY[0] ?? trick("x", "x"), fromList(BUILDS, { on: true, state: "ok" })]} entries={[{ ...BUILDS, state: "update" }, REVIEW]} />
        <OfficialCard n={21} state="trick-settings-official-taken" label="an id another trick holds" tricks={[trick("pr-inbox", "My PR list", { places: ["session"], provenance: { via: "cli", at: "2026-11-08T09:38:00Z" } })]} entries={[REVIEW, { ...INBOX, state: "taken" }]} />
        <OfficialSheetBox n={22} state="trick-settings-official-about" label="the About sheet before the add" entry={REVIEW} />
        <OfficialCard
          n={23}
          state="trick-settings-official-unlisted"
          label="from the repository, not from the list: a pull request's commit"
          tricks={[trick("pr-inbox", "PR Inbox", { on: false, state: "off", places: ["session"], provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "AltanS/collie-tricks", sha: "5e1f00d3a9b2", unlisted: true } })]}
          entries={[REVIEW, { ...INBOX, state: "taken", unlisted: true }]}
        />
        <OfficialCard
          n={24}
          state="trick-settings-official-changed"
          label="files the person changed: tap Update, it is refused; a changed one is taken"
          tricks={[fromList(BUILDS, { on: true, state: "ok" }), trick("pr-inbox", "PR Inbox", { on: false, state: "off", places: ["session"], provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "AltanS/collie-tricks", sha: "9c41d07e2b6a", unlisted: true } })]}
          entries={[{ ...BUILDS, state: "update" }, { ...INBOX, state: "taken", changed: true }]}
          answer="changed"
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
      {/* A Windows bridge runs no trick (bridge/tricks/service.ts `gated`): one line and the Hill, no rows, no switches. */}
      <Group title="A Windows bridge">
        <ListCard n={36} state="trick-settings-windows-gate" label="a Windows bridge: tricks are gated, one line" tricks={[]} gate="windows" />
      </Group>
      {/* Fault B: a trick whose approval did not hold a right its copy asks for stops; its switch shows off and its row says so. */}
      <Group title="A trick stopped because its rights changed">
        <ListCard
          n={35}
          state="trick-settings-rights-moved"
          label="stopped because its rights changed, beside a healthy one"
          tricks={[trick("legs", "Browser leg", { on: false, state: "stopped", error: "Its rights changed. Switch it on again.", rightsMoved: true, approves: "b".repeat(64), warnings: [{ kind: "network", text: "This trick reaches the network." }], provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } }), HEALTHY[1] ?? trick("x", "x")]}
        />
      </Group>
    </Section>
  );
}
