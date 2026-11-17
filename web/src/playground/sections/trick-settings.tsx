// The Trick settings section of the states playground (M94 slice 04): the card behind Settings → Tricks in
// each state a list can be in. Every card mounts the REAL card at 390 px over a store of its own, and
// the switches talk to a stand-in that answers after a moment, so a flip shows the held position and
// stays. The provenance times read against a fixed clock.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/design.html.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { AppHeaderHost } from "@/components/app-header";
import { DecisionCard } from "@/components/decision-card";
import { SettingsPage } from "@/components/settings-page";
import { StatusArea } from "@/components/status-area";
import { TrickCardsLineView, TrickCardsWaitingList } from "@/components/trick-cards";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { OfficialTrickAboutSheet, TrickAboutSheet } from "@/components/trick-about-sheet";
import { RepoAddSheet } from "@/components/tricks-repo-sheet";
import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { HillSwitchCard } from "@/components/hill-switch-card";
import { TricksSwitchCard } from "@/components/tricks-switch-card";
import { addOfficialTrick, addRepoTrick, listRepoTricks } from "@/lib/api";
import { syncHill } from "@/lib/hill/store";
import { asJsonString, parseJsonObject, type JsonValue } from "@/lib/json";
import { clearStatus } from "@/lib/status";
import { homeSolo } from "../fixtures";
import { VIEW_TRICK } from "../fixtures/agent-view";
import { proposalGroup, rightsMoved, versionGroup } from "../fixtures/hill/decisions";
import { ABOUT_MAX, type FieldValue, type OfficialState, type OfficialTricksReply, type TricksGate, type TricksReply, type WireOfficialTrick, type WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { CodeFailure, type TrickCodeReader } from "@/components/trick-code-folds";

import { CODE_INDEX, CODE_INDEX_LONG, CODE_INDEX_NEXT, codeFileOf } from "../fixtures/trick-code";

import { ExperimentsContract } from "@/routes/settings-sections";
import { RootRouter } from "../harness";
import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "trick-settings",
  title: "Trick settings",
  intent: "The Tricks list on Settings, and its switch card in Settings, Experiments, in each state a list of tricks can be in, at 390 px.",
};

const NOW = Date.parse("2026-11-08T09:41:00Z");

const noop = (): void => undefined;
/** Two cards that wait (spec 14): a proposed trick and a new version of one. */
const WAITING_CARDS = [proposalGroup(), versionGroup];
const PAGE_CARD = proposalGroup();

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

/** The card of a new version of the trick `waits`, as the bridge lists it (spec 14): the row's line opens it. */
const VERSION_CARD = { ...versionGroup, from: { ...versionGroup.from, ref: { type: "version" as const, id: "waits", hash: "6e".repeat(32) } } };

/**
 * While mounted, the Hill's list answers with one open version card of the trick `waits`, so that trick's row
 * holds the line that opens it (`onCard` set). The list is the app's one store, so only this card holds it.
 */
function useVersionCard(): void {
  useEffect(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname !== "/api/hill") return real(input, init);
      return Promise.resolve(new Response(JSON.stringify({ v: 1, rev: 1, open: [VERSION_CARD], closed: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    };
    syncHill(1, "tricks");
    return () => {
      window.fetch = real;
      syncHill(undefined, "tricks");
    };
  }, []);
}

/** A list whose trick `waits` is on with a new version waiting and its card held: the slot line is a button. */
function WaitingRowCard({ n, state, label, tricks }: { n: number; state: string; label: string; tricks: WireTrickInfo[] }) {
  useVersionCard();
  return <ListCard n={n} state={state} label={label} tricks={tricks} />;
}

function ListCard({ n, state, label, tricks, readOnly, hillOff, tricksOff, gate }: { n: number; state: string; label: string; tricks: WireTrickInfo[]; readOnly?: boolean; hillOff?: boolean; tricksOff?: boolean; gate?: TricksGate }) {
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
            onSetValue={valueStandIn(tricks)}
            onOfficialList={NO_OFFICIAL}
            now={NOW}
            readOnly={readOnly}
            hillOff={hillOff}
            tricksOff={tricksOff}
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

/** The settings write's stand-in (contract 3): answers after a moment with the row and the value set. */
function valueStandIn(tricks: WireTrickInfo[]) {
  return async (host: string, id: string, body: { key: string; value: FieldValue | null }): Promise<WireTrickInfo> => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const row = tricks.find((one) => one.host === host && one.id === id) ?? trick(id, id);
    const values = { ...row.values };
    if (body.value === null) delete values[body.key];
    else values[body.key] = body.value;
    return { ...row, values };
  };
}

/** The About sheet's settings write in the playground: takes after a moment. */
async function valueSaver(): Promise<string | null> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return null;
}

/** A trick with one field of each kind (contract 3), its required repository still empty. */
const FIELDS_TRICK: WireTrickInfo = trick("gates", "Release Gates", {
  places: ["belt"],
  description: "Which release checks are green for this branch.",
  fields: [
    { key: "repo", kind: "text", label: "Repository", hint: "owner/name, as on GitHub", required: true },
    { key: "branch", kind: "choice", label: "Branch", options: ["main", "edge", "release"], default: "main" },
    { key: "notify", kind: "switch", label: "Notify me when one turns red" },
    { key: "rows", kind: "number", label: "Rows", min: 1, max: 50, default: 10 },
  ],
  needsSetup: true,
});

function SheetBox({ n, state, label, trick: info, updates = false, values = false, readCode }: { n: number; state: string; label: string; trick: WireTrickInfo; updates?: boolean; values?: boolean; readCode?: TrickCodeReader }) {
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
        <TrickAboutSheet trick={info} open={open} onClose={() => setOpen(false)} auto={auto} onAuto={updates ? setAuto : undefined} onValue={values ? valueSaver : undefined} readCode={readCode} />
      </div>
    </Card>
  );
}

const wait = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 300));

/** The reads of the folds for the playground: the fixtures, after a moment, as a bridge answers. */
function codeReader(index = CODE_INDEX, long = false): TrickCodeReader {
  return {
    index: async () => {
      await wait();
      return index;
    },
    file: async (file) => {
      await wait();
      return codeFileOf(file, long);
    },
  };
}

/** A trick with a program on a timer, the rows "What it does" gains with package F. */
const LEGS_RUNS: WireTrickInfo = trick("legs", "Browser leg", {
  places: ["belt"],
  description: "How many release checks are green for this branch.",
  run: "bun legs.ts",
  everyMs: 5 * 60_000,
  env: ["CHECKS_TOKEN"],
  approves: "c3a91f0d7e42b8561a09d4e7f23c85b1a6d0e94f7c21b83a5d60e19f4a7c2b85",
  provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "AltanS/collie-tricks", sha: "9c41d07e2b6a" },
});

// Official tricks (M94; one list since 2026-11-12): the official tricks this release can add and the installed ones
// as one list, official first in the list's order, then the community's by name. Each card has a list
// of its own and a stand-in for the add route; the one that shows a failure goes through the real api.ts call
// and a stand-in for the bridge's refusal (`useRefusedAdd`), so the status line reads the bridge's own word.

/** The cards above show no official section: an empty list, read without the network. */
const NO_OFFICIAL = async (): Promise<OfficialTricksReply> => ({ tricks: [] });

const OFFICIAL_COMMIT = "0d8039936aef44961a5641f4bfdc4583ed0c3e60";

function official(id: string, name: string, description: string, state: OfficialState = "absent"): WireOfficialTrick {
  return { id, name, description, repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: OFFICIAL_COMMIT, state };
}

const REVIEW: WireOfficialTrick = { ...official("design-review", "Design Review", "Turns an agent's UI notes into Decisions you approve by name."), places: ["belt", "session"] };
const INBOX: WireOfficialTrick = { ...official("pr-inbox", "PR Inbox", "Open pull requests and issues that wait for you."), places: ["session"] };
const BUILDS: WireOfficialTrick = { ...official("running-builds", "Running Builds", "Builds and long commands running in your sessions now."), places: ["belt", "session"] };

/** What the bridge read of the official repository (bridge/tricks/repo-facts.ts): the phone never reads GitHub. */
const FACTS = { stars: 128, pushedAt: "2026-11-10T16:20:00Z" };
const MORPH: WireOfficialTrick = { ...official("morph", "Morph", "Your agent answers with one screen you can tap, not a wall of text."), givesRules: true, agentView: true, repoFacts: FACTS };

/** A trick installed from an entry of the list: off, with the repository as its provenance. */
function fromList(entry: WireOfficialTrick, extra: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return trick(entry.id, entry.name, { on: false, state: "off", places: ["belt", "session"], description: entry.description, provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: entry.repoName, sha: "9c41d07e2b6a", url: entry.repo }, ...extra });
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

// "Add from a repository" (2026-11-17): the sheet behind the last row of the list. The real api calls run, over a
// stand-in for the two routes that answers by the pasted link: one link has no index file, the others list three
// tricks, one of them already here. An Add answers after a moment and lands the trick off.

const REPO_COMMIT = "5c3e9a17d02b48e6a1f7c9b0d4e8a2f61b7c3d90";
const REPO_NO_INDEX_URL = "https://github.com/lodge/empty-shelf";
const REPO_LIST_URL = "https://github.com/lodge/workshop";

const REPO_TRICKS = [
  { folder: "idle-watch", name: "Idle Watch", about: "Marks a session that waits for you.", here: false },
  { folder: "build-bell", name: "Build Bell", about: "Tells you when a long build in one of your sessions finishes, with the last line it printed and how long it ran.", here: false },
  { folder: "clock", name: "Clock", about: "A small clock in the belt.", here: true },
];

function jsonAnswer(status: number, body: JsonValue, after: number): Promise<Response> {
  return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })), after));
}

/** While the section is mounted, the two repository routes answer from the stand-in; every other request goes on. */
function useRepoRoutes(): void {
  useEffect(() => {
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname !== "/api/tricks/repo/list" && url.pathname !== "/api/tricks/repo/add") return real(input, init);
      const body = parseJsonObject(String(init?.body ?? "{}"));
      const rid = asJsonString(body?.rid);
      const link = asJsonString(body?.url);
      if (url.pathname === "/api/tricks/repo/add") return jsonAnswer(200, { rid, code: "ok", id: asJsonString(body?.folder), hash: "a".repeat(64) }, 900);
      if (link === REPO_NO_INDEX_URL) return jsonAnswer(422, { error: "no-index", message: "The repository has no collie-tricks.json." }, 500);
      return jsonAnswer(200, { rid, code: "ok", url: link, host: "github.com", repo: "lodge/workshop", commit: REPO_COMMIT, tricks: REPO_TRICKS }, 500);
    };
    return () => {
      window.fetch = real;
    };
  }, []);
}

function RepoSheetBox({ n, state, label, initialUrl, readOnMount = false }: { n: number; state: string; label: string; initialUrl?: string; readOnMount?: boolean }) {
  const [open, setOpen] = useState(true);
  const style: CSSProperties & { "--app-h"?: string } = { width: 390, height: 844, transform: "translate(0)", "--app-h": "844px" };
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div data-pg-frame="" className="relative isolate overflow-hidden rounded-xl border border-border bg-background" style={style}>
        <button type="button" className="m-4 min-h-11 text-sm underline" onClick={() => setOpen(true)}>
          Add from a repository
        </button>
        <RepoAddSheet open={open} onClose={() => setOpen(false)} onList={listRepoTricks} onAdd={addRepoTrick} initialUrl={initialUrl} readOnMount={readOnMount} />
      </div>
    </Card>
  );
}

/** The tricks switch card as Settings, Experiments draws it (under the Hill's), in a 390px column, with a switch that flips in place. */
function SwitchCardCase({ n, state, label, initial, waiting = 0, windows = false, startAgain }: { n: number; state: string; label: string; initial: boolean; waiting?: number; windows?: boolean; startAgain?: readonly string[] }) {
  const [on, setOn] = useState(initial);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div className="w-[390px] max-w-full bg-background p-4">
        <TricksSwitchCard on={on} disabled={false} waiting={waiting} windows={windows} startAgain={startAgain} onToggle={setOn} />
      </div>
    </Card>
  );
}

/** Settings, Experiments with both cards, the Hill's and the one for tricks as a whole, each switch flipping in place. */
function ExperimentsCase({ n, state, label, hillOn, tricksOn }: { n: number; state: string; label: string; hillOn: boolean; tricksOn: boolean }) {
  const [hill, setHill] = useState(hillOn);
  const [tricks, setTricks] = useState(tricksOn);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <div className="flex h-[844px] w-[390px] max-w-full flex-col bg-background">
        <RootRouter data={homeSolo}>
          <AppHeaderHost bridge="connected" error={false}>
            <SettingsPage title="settings.section.experiments.title">
              <ExperimentsContract />
              <HillSwitchCard on={hill} disabled={false} onToggle={setHill} />
              <TricksSwitchCard on={tricks} disabled={false} onToggle={setTricks} />
            </SettingsPage>
          </AppHeaderHost>
        </RootRouter>
      </div>
    </Card>
  );
}

export function TrickSettingsSection(): ReactNode {
  useRepoRoutes();
  return (
    <Section def={DEF}>
      {/* The switch for tricks as a whole (bridge/tricks/feature-switch.ts), a card in Settings, Experiments since 2026-11-18. Off by default. While it is on, the Settings index shows the Tricks row; off, the row and a deep link to Settings, Tricks are gone. */}
      <Group title="The switch for tricks as a whole">
        <ExperimentsCase n={66} state="settings-experiments-off" label="Settings, Experiments with both cards, both off (the default)" hillOn={false} tricksOn={false} />
        <ExperimentsCase n={67} state="settings-experiments-on" label="Settings, Experiments with both cards, both on: the Settings index now shows the Tricks row" hillOn tricksOn />
        <SwitchCardCase n={47} state="tricks-switch-on" label="tricks on" initial />
        <SwitchCardCase n={48} state="tricks-switch-off" label="tricks off (the default)" initial={false} />
        <SwitchCardCase n={49} state="tricks-switch-armed" label="3 questions from tricks wait: tap once, it arms; tap again inside four seconds, it goes off" initial waiting={3} />
        <SwitchCardCase n={50} state="tricks-switch-windows" label="a Windows bridge: the line, and the switch cannot move" initial={false} windows />
        <SwitchCardCase n={64} state="tricks-switch-off-starts" label="tricks off, three tricks on: the line names them; switch on and it goes" initial={false} startAgain={["Release Gates", "Tracker", "Browser leg"]} />
        <SwitchCardCase n={65} state="tricks-switch-off-starts-many" label="tricks off, seven tricks on: five names, then 'and 2 more'" initial={false} startAgain={["Release Gates", "Tracker", "Browser leg", "Todo list", "Usage line", "Morph", "Notes"]} />
        <ListCard n={51} state="trick-settings-tricks-off" label="a moment after tricks go off, before the page leaves for Settings, Experiments: the list stays readable, every switch is disabled, one line says why" tricks={[HEALTHY[0] ?? trick("x", "x"), { ...(HEALTHY[2] ?? trick("y", "y")), on: false, state: "off" }]} tricksOff />
      </Group>
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
          label="cannot run"
          tricks={[trick("bad", "Bad manifest", { on: false, state: "skipped", places: [], refusals: [{ code: "place", path: "/places/0", reason: '"nowhere" is not a place this Collie knows.' }] })]}
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
        <ListCard
          n={6}
          state="trick-settings-part-refused"
          label="on, a part refused"
          tricks={[trick("todos", "Open todos", { state: "ok", places: ["status"], refusals: [{ code: "text", path: "/parts/0/chip/text", reason: "\"text\" is 19 characters. At most 12.", part: "todo" }] })]}
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
      <Group title="A new version waits (spec 14)">
        <WaitingRowCard
          n={46}
          state="trick-settings-version-row"
          label="on, a new version waits and its card is held: the slot line opens the card (tap it), the row opens About"
          tricks={[
            trick("waits", "Status clock", { places: ["status"], provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "owner/status-clock", sha: "3f2a91c0d4e5" }, pending: { hash: "b7e1d0a4c2f9".repeat(5).slice(0, 64), files: { added: 0, changed: 1, removed: 0 }, powersChanged: false, warnings: [] } }),
            HEALTHY[1] ?? trick("x", "x"),
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
        <SheetBox n={66} state="trick-settings-about-keeps-running" label="a trick that runs on a file change: the last row says it keeps running with no phone open" trick={{ ...GATES, run: "bun run gates.ts", watch: ["~/notes/todo.md"] }} />
        <SheetBox
          n={67}
          state="trick-settings-about-values"
          label="the values stand on chips: the timer, the run line, where it shows, a file path and a version in the facts, and the settings the person set (labels stay muted)"
          values
          trick={{
            ...FIELDS_TRICK,
            needsSetup: undefined,
            values: { repo: "lodge/workshop", branch: "edge", notify: true, rows: 20 },
            places: ["belt", "status", "dashboard"],
            version: "1.2.0",
            run: "bun run ~/projects/collie-workspace/tricks/release-gates/check-all-branches.ts --repo lodge/workshop --json",
            everyMs: 300_000,
            watch: ["~/projects/collie-workspace/collie/CHANGELOG.md"],
            env: ["GH_TOKEN"],
            inputs: { globs: ["RELEASE.md"], crew: false },
          }}
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
      <Group title="Settings of a trick (contract 3)">
        <ListCard n={56} state="trick-settings-fields-needs-setup" label="a required setting is empty: the row says Needs setup (tap the name)" tricks={[FIELDS_TRICK, HEALTHY[2] ?? trick("x", "x")]} />
        <SheetBox n={57} state="trick-settings-fields" label="the Settings group: one row per field, text, choice, switch, number" values trick={FIELDS_TRICK} />
        <SheetBox n={58} state="trick-settings-fields-set" label="every setting set" values trick={{ ...FIELDS_TRICK, needsSetup: undefined, values: { repo: "lodge/workshop", branch: "edge", notify: true, rows: 20 } }} />
        <SheetBox n={59} state="trick-settings-fields-unread" label="the saved settings do not read" values trick={{ ...FIELDS_TRICK, valuesUnread: true }} />
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
      <Group title="One list (2026-11-12)">
        <OfficialCard
          n={37}
          state="trick-settings-one-list"
          label="each trick once with its label: official first, Morph first, then the community's by name; tap Add or a switch, no row moves"
          tricks={[...HEALTHY, fromList(REVIEW, { on: true, state: "ok" })]}
          entries={[MORPH, { ...REVIEW, state: "added" }, INBOX, BUILDS]}
        />
        <OfficialCard
          n={38}
          state="trick-settings-one-list-taken"
          label="an official id another trick holds: that trick is the community's, and says why"
          tricks={[trick("pr-inbox", "My PR list", { places: ["session"], provenance: { via: "cli", at: "2026-11-08T09:38:00Z" } }), HEALTHY[2] ?? trick("x", "x")]}
          entries={[MORPH, REVIEW, { ...INBOX, state: "taken" }]}
        />
        <SheetBox
          n={39}
          state="trick-settings-about-facts"
          label="the About sheet with the facts: the link, stars and last commit in its row, the version"
          trick={{ ...GATES, version: "1.2.0", repoFacts: FACTS, provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "AltanS/collie-tricks", sha: "9c41d07e2b6a", url: "https://github.com/AltanS/collie-tricks" } }}
        />
        <SheetBox
          n={40}
          state="trick-settings-about-no-facts"
          label="no facts yet, or a failed read: the link alone, the row the same height"
          trick={{ ...GATES, provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "AltanS/collie-tricks", sha: "9c41d07e2b6a", url: "https://github.com/AltanS/collie-tricks" } }}
        />
        <SheetBox
          n={41}
          state="trick-settings-about-other-host"
          label="another host: the link with the host whole, no facts"
          trick={{ ...GATES, provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "owner/gates-trick", sha: "9c41d07e2b6a", url: "https://git.workshop.example/owner/gates-trick" } }}
        />
        <OfficialSheetBox n={42} state="trick-settings-official-about-facts" label="before the add, with the facts" entry={MORPH} />
      </Group>
      <Group title="Read the code (2026-11-17)">
        <SheetBox
          n={52}
          state="trick-settings-code-approved"
          label="a trick that is on: the run line and the timer, then a fold for each file (scroll down; tap legs.ts, three lines are marked)"
          updates
          trick={LEGS_RUNS}
          readCode={codeReader()}
        />
        <SheetBox
          n={53}
          state="trick-settings-code-next"
          label="a trick that is off and was never approved: the folder as it is now, the copy a switch on approves"
          trick={{ ...LEGS_RUNS, on: false, state: "off", warnings: [{ kind: "network", text: "This trick reaches the network." }] }}
          readCode={codeReader(CODE_INDEX_NEXT)}
        />
        <SheetBox
          n={54}
          state="trick-settings-code-long"
          label="a long file: its first part, how much is left out, and the flags in the part not shown (tap legs.ts)"
          trick={LEGS_RUNS}
          readCode={codeReader(CODE_INDEX_LONG, true)}
        />
        <SheetBox
          n={55}
          state="trick-settings-code-no-timer"
          label="no timer, and a trick of another machine: the line says it runs once and on a tap; the code is not shown"
          trick={{ ...LEGS_RUNS, everyMs: undefined, id: "remote", name: "Remote leg" }}
          readCode={{ index: async () => await Promise.reject(new CodeFailure("otherMachine")), file: async () => await Promise.reject(new CodeFailure("otherMachine")) }}
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
        <ListCard
          n={11}
          state="trick-settings-hill-off-pending"
          label="Hill off, a new version waits: the row says so, as with the Hill on (spec 14)"
          tricks={[trick("legs", "Browser leg", { on: true, pending: { hash: "b7e1d0a4c2f9".repeat(5).slice(0, 64), files: { added: 0, changed: 1, removed: 0 }, powersChanged: false, warnings: [] }, provenance: { via: "agent", at: "2026-11-08T07:41:00Z" } })]}
          hillOff
        />
      </Group>
      {/* M96 spec 14: a card of Collie's own about a trick needs no Hill. With the Hill off the phone reaches it from
          Settings, Tricks (the group, and a waiting version's row) and from the Dashboard's line. */}
      <Group title="Waiting for your yes (spec 14)">
        <Card state="trick-settings-waiting" label="43 · the first group of Settings, Tricks: one row per open card, oldest first (Hill on or off)">
          <div className="w-[390px] max-w-full bg-background p-4">
            <TrickCardsWaitingList cards={WAITING_CARDS} onOpen={noop} />
          </div>
        </Card>
        <Card state="trick-settings-waiting-line" label="44 · the Dashboard's line, only while the Hill is off and a proposal waits: it names the trick">
          <div className="w-[390px] max-w-full bg-background p-4">
            <TrickCardsLineView cards={[proposalGroup()]} onOpen={noop} />
          </div>
        </Card>
        <Card state="trick-settings-waiting-line-look" label="44b · the same line for a card that is no proposal (rights moved): it needs a look">
          <div className="w-[390px] max-w-full bg-background p-4">
            <TrickCardsLineView cards={[rightsMoved]} onOpen={noop} />
          </div>
        </Card>
        <Card state="trick-settings-card-page" label="45 · the card's page: the Hill's card, Settings' shell, no Hill words">
          <div className="flex h-[844px] w-[390px] max-w-full flex-col bg-background">
            <RootRouter data={homeSolo}>
              <AppHeaderHost bridge="connected" error={false}>
                <SettingsPage title="settings.section.tricks.title">
                  <DecisionCard decision={PAGE_CARD} answer={HILL_IDLE} onSend={noop} />
                </SettingsPage>
              </AppHeaderHost>
            </RootRouter>
          </div>
        </Card>
      </Group>
      {/* A Windows bridge runs no trick (bridge/tricks/service.ts `gated`): the list card draws nothing; the switch card (case 50) says the line once. */}
      <Group title="A Windows bridge">
        <ListCard n={36} state="trick-settings-windows-gate" label="a Windows bridge: no list card, the switch card (50) in Settings, Experiments says the line once" tricks={[]} gate="windows" />
      </Group>
      {/* Add from a repository (2026-11-17): the row is the last of every list above; here is its sheet, and the row with tricks off. */}
      <Group title="Add from a repository">
        <RepoSheetBox n={60} state="trick-settings-repo-empty" label="the sheet, the link field empty" />
        <RepoSheetBox n={61} state="trick-settings-repo-list" label="three tricks, one already here: tap Add" initialUrl={REPO_LIST_URL} readOnMount />
        <RepoSheetBox n={62} state="trick-settings-repo-no-index" label="a repository with no list" initialUrl={REPO_NO_INDEX_URL} readOnMount />
        <ListCard n={63} state="trick-settings-repo-tricks-off" label="tricks off: the row is disabled, the card says why" tricks={[HEALTHY[0] ?? trick("x", "x")]} tricksOff />
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
