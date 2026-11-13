// The "Trick menu" section of the states playground: a trick's rows in a session's settings (the `menu`
// place, contract 2) and a belt mark bound to one session. Every card mounts the REAL sheet
// (components/pane-actions-sheet.tsx) or the REAL belt over a tricks store of its own, so a tap shows the
// wait and the answer with no bridge.
//
// One query word makes shots easy: `?solo=<case>` draws that one case over the whole screen, and
// `&shot=1` hides its close button.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/design.html.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import { ActionsRow } from "@/components/actions-row";
import { beltMarksOf } from "@/components/belt-trick-mark";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { partKey, type MenuRow, type TrickTapReply, type TricksReply, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { mintRequestId } from "@/lib/worktree-name";

import { Card, Group, Section, Stage, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "trick-menu",
  title: "Trick menu",
  intent: "A trick's rows in a session's settings, after Close: buttons, switches that wait, a confirm, the footer line, the cap, and a belt mark bound to one session.",
};

const CASES = ["one", "waiting", "armed", "two", "cap", "off", "view", "bound"] as const;
type CaseId = (typeof CASES)[number];

function isCaseId(word: string | null): word is CaseId {
  return CASES.some((id) => id === word);
}

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

const IGNORE = () => {};
const AS_OF = new Date(Date.now() - 20_000).toISOString();

/** The session whose sheet is open: an agent session on this machine, with its walky instance. */
const PANE: AgentView = {
  paneId: "w1:2",
  workspaceId: "w1",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w1:t2",
  agent: "claude",
  status: "idle",
  cwd: "/work/collie",
  focused: true,
  kind: "agent",
  paneLabel: "api-fix",
  instance: "ab12",
};

function info(id: string, name: string, icon: WireTrickInfo["icon"], on = true): WireTrickInfo {
  return { host: "lodge", id, name, icon, on, state: "ok", places: ["menu"] };
}

function menu(trick: string, rows: MenuRow[]): WireTrickPart {
  return { host: "lodge", trick, part: trick, rev: 1, asOf: AS_OF, fresh: "10m", value: { at: "menu", id: trick, rows } };
}

const CI_ROWS: MenuRow[] = [
  { id: "rerun", kind: "button", label: "Rerun CI", icon: "refresh", intent: "rerun" },
  { id: "watch", kind: "switch", label: "Watch branch", icon: "flag", intent: "watch", on: true },
  { id: "drop", kind: "button", label: "Drop the cache", icon: "delete", intent: "drop", confirm: true },
];
const NOTES_ROWS: MenuRow[] = [
  { id: "pin", kind: "button", label: "Pin this session", icon: "pin", intent: "pin" },
  { id: "quiet", kind: "switch", label: "Quiet hours", icon: "clock", intent: "quiet", on: false },
];
const CI = info("ci", "CI", "flask");
const NOTES = info("notes", "Notes", "note");

/** A store over a stand-in bridge. `slowTaps`: a tap is never answered, so its wait shows. */
interface MenuRig {
  readonly store: TricksStore;
  /** Answer the next poll with these tricks, and poll. */
  readonly set: (next: WireTrickInfo[]) => void;
}

function menuStore(tricks: WireTrickInfo[], parts: WireTrickPart[], opts: { slowTaps?: boolean } = {}): MenuRig {
  let reply: TricksReply = { rev: 1, tricks, parts, present: parts.map(partKey) };
  const store = createTricksStore({
    fetchTricks: () => Promise.resolve(reply),
    tapTrick: (_host, _trick, body) => (opts.slowTaps === true ? new Promise<TrickTapReply>(() => undefined) : new Promise<TrickTapReply>((resolve) => setTimeout(() => resolve({ rid: body.rid, code: "ok" }), 1500))),
    mintRequestId,
  });
  const set = (next: WireTrickInfo[]): void => {
    reply = { rev: reply.rev + 1, tricks: next, parts, present: reply.present };
    void store.syncTricks(reply.rev);
  };
  return { store, set };
}

/** Taps the control `selector` names once, after the sheet opened and its rows stood still. */
function useTapOnce(box: RefObject<HTMLDivElement | null>, selector: string | null, delay = 700): void {
  useEffect(() => {
    if (selector === null) return;
    const timer = setTimeout(() => {
      const root = box.current?.closest("[data-pg-frame]") ?? box.current?.ownerDocument ?? document;
      root.querySelector<HTMLElement>(selector)?.click();
    }, delay);
    return () => clearTimeout(timer);
  }, [box, selector, delay]);
}

/** The session's sheet over its own store, with the store synced before the sheet opens. */
function Sheet({
  tricks,
  parts,
  slowTaps = false,
  tap = null,
  offAfter = false,
  views,
}: {
  tricks: WireTrickInfo[];
  parts: WireTrickPart[];
  slowTaps?: boolean;
  tap?: string | null;
  offAfter?: boolean;
  views?: readonly { readonly trick: string; readonly label: string; readonly on: boolean }[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const rig = useMemo(() => menuStore(tricks, parts, { slowTaps }), [tricks, parts, slowTaps]);
  const synced = useSynced(rig.store);
  useTapOnce(box, synced ? tap : null);
  useEffect(() => {
    if (!synced || !offAfter) return;
    const timer = setTimeout(() => rig.set(tricks.map((trick) => ({ ...trick, on: false }))), 400);
    return () => clearTimeout(timer);
  }, [synced, offAfter, rig, tricks]);
  return (
    <div ref={box} className="h-full">
      {synced && (
        <PaneActionsSheet
          open
          onClose={IGNORE}
          pane={PANE}
          onRenamed={IGNORE}
          onClosed={IGNORE}
          paneView="chat"
          onPaneViewChange={IGNORE}
          tricksStore={rig.store}
          {...(views === undefined ? {} : { agentViews: { rows: views, label: undefined, on: views.some((row) => row.on), showing: false, onShow: IGNORE, onSwitch: () => Promise.resolve(null) } })}
        />
      )}
    </div>
  );
}

/** Whether the store holds its first reply: the sheet freezes its rows at the open, so it opens after. */
function useSynced(store: TricksStore): boolean {
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    let live = true;
    void store.syncTricks(1).then(() => {
      if (live) setSynced(true);
      return undefined;
    });
    return () => {
      live = false;
    };
  }, [store, setSynced]);
  return synced;
}

const CAP_TRICKS = ["alpha", "beta", "gamma", "delta"].map((id) => info(id, id[0]?.toUpperCase() + id.slice(1), "flask"));
const CAP_PARTS = [
  menu("alpha", CI_ROWS.slice(0, 2).concat([{ id: "a3", kind: "button", label: "Open the log", icon: "file", intent: "log" }, { id: "a4", kind: "button", label: "Copy the link", icon: "copy", intent: "link" }])),
  menu("beta", [...NOTES_ROWS, { id: "b3", kind: "button", label: "Send a summary", icon: "send", intent: "sum" }, { id: "b4", kind: "button", label: "Start a timer", icon: "clock", intent: "timer" }]),
  menu("gamma", CI_ROWS.concat([{ id: "g4", kind: "button", label: "Share the run", icon: "share", intent: "share" }])),
  menu("delta", NOTES_ROWS),
];

/** The bound belt: an unbound mark for every session, and a mark bound to this one at its instance. */
const BELT_EVERY: WireTrickPart = { host: "lodge", trick: "ci", part: "legs", rev: 1, asOf: AS_OF, fresh: "10m", value: { at: "belt", id: "legs", mark: { icon: "check", label: "23/34", tone: "ok" } } };
const BELT_HERE: WireTrickPart = {
  host: "lodge",
  trick: "ci",
  part: "legs-here",
  rev: 1,
  asOf: AS_OF,
  fresh: "10m",
  value: { at: "belt", id: "legs-here", mark: { icon: "flask", label: "2 red", tone: "danger", intent: "open" } },
  bound: [{ session: "lodge:w1:2", instance: "ab12" }],
};

function Belt({ pane }: { pane: AgentView }) {
  const rig = useMemo(() => menuStore([{ ...CI, places: ["belt"] }], [BELT_EVERY, BELT_HERE]), []);
  const synced = useSynced(rig.store);
  const marks = synced ? beltMarksOf({ parts: [BELT_EVERY, BELT_HERE], pane, handlersFor: () => ({}), sessions: [], onOpenSession: IGNORE, store: rig.store }) : undefined;
  // The marks stand at the end of the scrolling strip: scroll there once they are drawn.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!synced) return;
    const strip = box.current?.querySelector<HTMLElement>("div.overflow-x-auto");
    const id = window.setTimeout(() => strip?.scrollTo({ left: strip.scrollWidth }), 400);
    return () => window.clearTimeout(id);
  }, [synced]);
  return (
    <div ref={box}>
    <ActionsRow
      general={[
        { id: "keys", icon: "keys-drawer", label: "Keys", onSelect: IGNORE },
        { id: "screen", icon: "screen", label: "Screen", onSelect: IGNORE },
      ]}
      agent="claude"
      onRun={() => Promise.resolve(true)}
      pins={{ count: 2, onClick: IGNORE, label: "2 pinned", expanded: false }}
      marks={marks}
      changes={{ onClick: IGNORE, label: "Files" }}
      handle={{ ref: IGNORE, onClick: IGNORE, label: "Switch pane" }}
    />
    </div>
  );
}

function BoundBelts() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xs text-muted-foreground">In the session the mark is bound to:</p>
      <div className="py-2">
        <Belt pane={PANE} />
      </div>
      <p className="text-xs text-muted-foreground">In another session, and after the pane id went to a new session:</p>
      <div className="py-2">
        <Belt pane={{ ...PANE, instance: "zz99" }} />
      </div>
    </div>
  );
}

const ONE = [CI];
const ONE_PARTS = [menu("ci", CI_ROWS)];
const TWO = [CI, NOTES];
const TWO_PARTS = [menu("ci", CI_ROWS), menu("notes", NOTES_ROWS)];
const MORPH: WireTrickInfo = { ...info("morph", "Morph", "eye"), places: [], agentView: true };
const VIEW_TRICKS = [CI, MORPH];
const VIEW_ROWS = [{ trick: "morph", label: "Morph", on: false }];

function CaseBody({ id }: { id: CaseId }): ReactNode {
  switch (id) {
    case "one":
      return <Sheet tricks={ONE} parts={ONE_PARTS} />;
    case "waiting":
      return <Sheet tricks={ONE} parts={ONE_PARTS} slowTaps tap={'[data-row="watch"] [role="switch"]'} />;
    case "armed":
      return <Sheet tricks={ONE} parts={ONE_PARTS} tap={'[data-row="drop"]'} />;
    case "two":
      return <Sheet tricks={TWO} parts={TWO_PARTS} />;
    case "cap":
      return <Sheet tricks={CAP_TRICKS} parts={CAP_PARTS} />;
    case "off":
      return <Sheet tricks={ONE} parts={ONE_PARTS} offAfter />;
    case "view":
      return <Sheet tricks={VIEW_TRICKS} parts={ONE_PARTS} views={VIEW_ROWS} />;
    case "bound":
      return <BoundBelts />;
  }
}

const LABELS = {
  one: "1: one trick's group: a button, a switch on, a confirm",
  waiting: "2: a switch waits for the trick",
  armed: "3: a confirm armed",
  two: "4: two tricks",
  cap: "5: the cap, one trick left out",
  off: "6: the trick switched off while open",
  view: "7: the agent view switch in its trick's group",
  bound: "8: a belt mark bound to one session",
} as const satisfies Record<CaseId, string>;

/** One case over the whole screen, for a phone and for the shots. */
function Solo({ id }: { id: CaseId }) {
  const shot = param("shot") === "1";
  const style: CSSProperties & { "--app-h"?: string } = { "--app-h": "100dvh" };
  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background text-foreground" style={style}>
      <CaseBody id={id} />
      {!shot && (
        <a href="#trick-menu" aria-label="Close" className="fixed bottom-4 left-4 z-[61] flex h-11 min-w-11 items-center justify-center rounded-sm border border-border bg-card px-2 text-sm font-semibold shadow-md">
          ×
        </a>
      )}
    </div>
  );
}

export function TrickMenuSection() {
  const solo = param("solo");
  if (isCaseId(solo)) return <Solo id={solo} />;
  return (
    <Section def={DEF}>
      <Group title="The session's sheet">
        {(["one", "waiting", "armed", "two", "cap", "off", "view"] as const).map((id) => (
          <Card key={id} state={`trick-menu-${id}`} label={LABELS[id]}>
            <Stage height={900}>
              <CaseBody id={id} />
            </Stage>
          </Card>
        ))}
      </Group>
      <Group title="The belt">
        <Card state="trick-menu-bound" label={LABELS.bound}>
          <Stage height={260}>
            <CaseBody id="bound" />
          </Stage>
        </Card>
      </Group>
    </Section>
  );
}
