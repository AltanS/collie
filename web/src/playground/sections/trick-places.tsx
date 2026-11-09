// The Trick places section of the states playground (M94 slice 03, re-cut 2026-11-08): the places
// a trick draws in. The belt's end-block marks beside the pins mark (one with nothing to do among them),
// and the trick session: its row on the Dashboard and in Switch session, and its screen with no Composer.
// Then the `status` place, the tricks' items in the usage row above the belt, and the three look fixes
// of the renderer. Every card
// mounts the REAL components at 390 px over a store of its own, so a tap shows the busy state and the
// receipt with no bridge.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useMemo, type ReactNode } from "react";

import { ActionsRow } from "@/components/actions-row";
import { beltMarksOf } from "@/components/belt-trick-mark";
import { ModelTag } from "@/components/model-tag";
import { statusItemsOf } from "@/components/trick-status-item";
import { TrickSessionRow, TrickSpaceSection } from "@/components/trick-session";
import { PartFrame } from "@/lib/tricks/part-frame";
import { renderView, type RenderCtx } from "@/lib/tricks/render";
import { partKey, type TrickTapReply, type ListNode, type View, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { mintRequestId } from "@/lib/worktree-name";
import { TrickSessionBody, TrickSessionHeaderRow } from "@/routes/trick-session";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "trick-places",
  title: "Trick places",
  intent: "The belt's trick marks, the status line's trick items, the trick session, three look fixes, at 390 px.",
};

const NOW = Date.now();
const AS_OF = new Date(NOW - 20_000).toISOString();
const IGNORE = () => {};
const RUN = () => Promise.resolve(true);

const LEGS: WireTrickInfo = { host: "bluefin", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt", "session"] };
const TRACKER: WireTrickInfo = { host: "bluefin", id: "tracker", name: "Tracker", icon: "file", on: true, state: "ok", places: ["belt", "session"] };
const QUIET: WireTrickInfo = { host: "bluefin", id: "quiet", name: "Quiet", icon: "bell", on: true, state: "ok", places: ["belt"] };
const SPEND: WireTrickInfo = { host: "bluefin", id: "spend", name: "Spend", icon: "tag", on: true, state: "ok", places: ["status"] };

const LEGS_ROWS: ListNode = {
  kind: "list",
  kids: [
    { kind: "row", text: "Case 24: send a long draft", attrs: { end: "red", tone: "danger" } },
    { kind: "row", text: "Case 31: stop mid-turn", attrs: { end: "slow", tone: "warn" } },
  ],
};
const LEGS_VIEW: View = [
  { kind: "number", text: "23/34", attrs: { label: "cases green", tone: "accent" } },
  { kind: "meter", attrs: { role: "progress", value: "2", max: "3" } },
  LEGS_ROWS,
];
const TRACKER_VIEW: View = [{ kind: "para", text: "Two specs due this week." }];

function wire(trick: string, value: WireTrickPart["value"]): WireTrickPart {
  return { host: "bluefin", trick, part: value.id, rev: 1, value, asOf: AS_OF, fresh: "90s" };
}

const LEGS_BELT = wire("legs", { at: "belt", id: "belt", mark: { icon: "flask", label: "23/34", tone: "accent", intent: "rerun" } });
const TRACKER_BELT = wire("tracker", { at: "belt", id: "belt", mark: { icon: "file", label: "M94", tone: "plain" } });
/** No intent, and no session in the pane list: the same button control, aria-disabled. */
const QUIET_BELT = wire("quiet", { at: "belt", id: "belt", mark: { icon: "bell", label: "idle", tone: "muted" } });
/** The legs trick's status item: the legs fixture's count as a chip, tapping opens its session. */
const LEGS_STATUS = wire("legs", { at: "status", id: "status", chip: { text: "tag 5/7", icon: "flask", tone: "accent" } });
const SPEND_STATUS = wire("spend", { at: "status", id: "status", chip: { text: "$7.42", tone: "plain" } });
/** Past its fresh window: the tone goes, a tap says the age. */
const SPEND_OLD = { ...SPEND_STATUS, asOf: new Date(NOW - 20 * 60_000).toISOString() };
const LEGS_SESSION = wire("legs", {
  at: "session",
  id: "legs",
  name: "Browser leg",
  tone: "accent",
  subtitle: "case 24 red",
  badge: { count: 1 },
  progress: { value: 2, max: 3 },
  actions: [
    { id: "rerun", label: "Rerun red", intent: "rerun", icon: "refresh" },
    { id: "fix", label: "Ask for a fix", intent: "fix" },
  ],
  view: LEGS_VIEW,
});
const TRACKER_SESSION = wire("tracker", { at: "session", id: "due", name: "Tracker", tone: "ok", subtitle: "M94 slice 03 next", view: TRACKER_VIEW });

/** A store over a stand-in bridge that answers a tap after a moment, so the busy state is seen. */
function placesStore(): TricksStore {
  const parts = [LEGS_BELT, TRACKER_BELT, QUIET_BELT, LEGS_SESSION, TRACKER_SESSION, LEGS_STATUS, SPEND_STATUS];
  return createTricksStore({
    fetchTricks: () => Promise.resolve({ rev: 1, tricks: [LEGS, TRACKER, QUIET, SPEND], parts, present: parts.map(partKey) }),
    tapTrick: (_host, _trick, body) => new Promise<TrickTapReply>((resolve) => setTimeout(() => resolve({ rid: body.rid, code: "ok" }), 1500)),
    mintRequestId,
  });
}

function useStore(): TricksStore {
  const store = useMemo(placesStore, []);
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return store;
}

function trickPane(id: string, part: WireTrickPart, over: Partial<AgentView>): AgentView {
  return {
    paneId: `trick:bluefin:${id}:${part.part}`,
    workspaceId: "trick:bluefin",
    workspaceLabel: "Tricks",
    workspaceNumber: 4,
    tabId: `trick:bluefin:${id}`,
    agent: id,
    status: "idle",
    cwd: "",
    focused: false,
    kind: "trick",
    view: partKey(part),
    ...over,
  };
}

const LEGS_PANE = trickPane("legs", LEGS_SESSION, { status: "working", paneLabel: "Browser leg", subtitle: "case 24 red", badge: { count: 1 }, progress: { kind: "percent", value: 68 } });
const LEGS_RED = { ...LEGS_PANE, status: "idle" as const, subtitle: "11 red, run done", progress: { kind: "steps" as const, steps: [{ label: "solo", state: "done" as const }, { label: "crew", state: "done" as const }] } };
const TRACKER_PANE = trickPane("tracker", TRACKER_SESSION, { paneLabel: "Tracker", subtitle: "M94 slice 03 next" });

function Glass({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`w-[390px] max-w-full rounded-sm border border-border bg-background ${className ?? "px-4 py-3"}`}>{children}</div>;
}

function Belt({ marks }: { marks: readonly WireTrickPart[] }) {
  const store = useStore();
  const shown = marks.length > 0 ? beltMarksOf({ parts: marks, handlersFor: () => ({}), sessions: [TRACKER_PANE], onOpenSession: IGNORE, store }) : undefined;
  return (
    <ActionsRow
      general={[
        { id: "keys", icon: "keys-drawer", label: "Keys", onSelect: IGNORE },
        { id: "screen", icon: "screen", label: "Screen", onSelect: IGNORE },
      ]}
      agent="claude"
      onRun={RUN}
      pins={{ count: 2, onClick: IGNORE, label: "2 pinned", expanded: false }}
      marks={shown}
      changes={{ onClick: IGNORE, label: "Files" }}
      handle={{ ref: IGNORE, onClick: IGNORE, label: "Switch pane" }}
    />
  );
}

const USAGE = { context: 42, limits: [{ window: "5h" as const, used: 58 }, { window: "7d" as const, used: 81 }] };
const LEGS_PANE_FOR_STATUS = trickPane("legs", LEGS_SESSION, { paneLabel: "Browser leg" });

/** The usage row over a stand-in mirror, with the tricks' items after Collie's own. `width` is the mirror box's; `own` false leaves Collie's items out. */
function StatusLine({ parts, width = 390, own = true }: { parts: readonly WireTrickPart[]; width?: number; own?: boolean }) {
  const store = useStore();
  const trailing = useMemo(() => statusItemsOf({ parts, sessions: [LEGS_PANE_FOR_STATUS], onOpenSession: IGNORE, store }), [parts, store]);
  return (
    <div style={{ width }} className="relative h-12 max-w-full overflow-hidden rounded-sm border border-border bg-background">
      <p className="px-3 pt-2 font-mono text-xs text-muted-foreground">Case 24 is red. Rerunning it now.</p>
      <ModelTag model={own ? "claude-opus-5-5" : undefined} usage={own ? USAGE : undefined} trailing={trailing} />
    </div>
  );
}

function Screen() {
  const store = useStore();
  return (
    <div className="flex h-[560px] flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2">
        <TrickSessionHeaderRow pane={LEGS_PANE} onBack={IGNORE} />
      </div>
      <TrickSessionBody pane={LEGS_PANE} onLink={IGNORE} store={store} />
    </div>
  );
}

const RERUN_VIEW: View = [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Rerun red", intent: "rerun" } }] }];

function ctx(tap?: RenderCtx["tap"]): RenderCtx {
  return { partKey: partKey(LEGS_SESSION), trickName: "Browser leg", stale: false, tap, onTap: IGNORE, onLink: IGNORE, now: NOW };
}

export function TrickPlacesSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The belt">
        <Card state="trick-belt-marks" label="1 · two trick marks">
          <Glass className="py-2">
            <Belt marks={[LEGS_BELT, TRACKER_BELT]} />
          </Glass>
        </Card>
        <Card state="trick-belt-none" label="2 · no trick, no gap">
          <Glass className="py-2">
            <Belt marks={[]} />
          </Glass>
        </Card>
        <Card state="trick-belt-idle" label="3 · mark, nothing to do">
          <Glass className="py-2">
            <Belt marks={[QUIET_BELT]} />
          </Glass>
        </Card>
      </Group>
      <Group title="The status line">
        <Card state="trick-status-two" label="4 · two items after usage">
          <StatusLine parts={[LEGS_STATUS, SPEND_STATUS]} />
        </Card>
        <Card state="trick-status-only" label="5 · items, no usage">
          <StatusLine parts={[LEGS_STATUS, SPEND_STATUS]} own={false} />
        </Card>
        <Card state="trick-status-narrow" label="6 · narrow, tricks give way">
          <StatusLine parts={[LEGS_STATUS, SPEND_STATUS]} width={300} />
        </Card>
        <Card state="trick-status-stale" label="7 · stale, tone gone">
          <StatusLine parts={[LEGS_STATUS, SPEND_OLD]} />
        </Card>
      </Group>
      <Group title="The trick session">
        <Card state="trick-space-dashboard" label="8 · Dashboard, Tricks">
          <Glass className="py-0">
            <TrickSpaceSection sessions={[LEGS_PANE, TRACKER_PANE]} onOpen={IGNORE} />
          </Glass>
        </Card>
        <Card state="trick-space-done" label="9 · run done, bar kept">
          <Glass className="py-0">
            <TrickSpaceSection sessions={[LEGS_RED]} onOpen={IGNORE} />
          </Glass>
        </Card>
        <Card state="trick-space-switch" label="10 · Switch session rows">
          <Glass>
            <TrickSessionRow pane={LEGS_PANE} variant="switch" active onOpen={IGNORE} />
            <TrickSessionRow pane={TRACKER_PANE} variant="switch" onOpen={IGNORE} />
          </Glass>
        </Card>
        <Card state="trick-session-screen" label="11 · screen, no Composer">
          <Glass className="p-0">
            <Screen />
          </Glass>
        </Card>
      </Group>
      <Group title="Look fixes">
        <Card state="trick-fix-busy" label="12 · busy keeps label">
          <Glass>
            <div className="flex gap-2">
              {renderView(RERUN_VIEW, ctx())}
              {renderView(RERUN_VIEW, ctx({ phase: "busy", rid: "r", control: "v/0/0", intent: "rerun" }))}
            </div>
          </Glass>
        </Card>
        <Card state="trick-fix-age" label="13 · fresh line says age">
          <Glass>
            <PartFrame part={TRACKER_SESSION} trick={TRACKER} now={NOW}>
              {({ stale }) => renderView(TRACKER_VIEW, { ...ctx(), stale })}
            </PartFrame>
          </Glass>
        </Card>
        <Card state="trick-fix-rows" label="14 · list rows, hairlines">
          <Glass>{renderView([LEGS_ROWS], ctx())}</Glass>
        </Card>
      </Group>
    </Section>
  );
}
