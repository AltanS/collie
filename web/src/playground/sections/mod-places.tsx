// The Mod places section of the states playground (M94 slice 03): the two first places a mod draws in.
// The belt's end-block marks beside the pins mark, and the mod session: its row on the Dashboard and in
// Switch session, and its screen with no Composer. Then the three look fixes of the renderer. Every card
// mounts the REAL components at 390 px over a store of its own, so a tap shows the busy state and the
// receipt with no bridge.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useMemo, type ReactNode } from "react";
import { Keyboard, Monitor } from "lucide-react";

import { ActionsRow } from "@/components/actions-row";
import { beltMarksOf } from "@/components/belt-mod-mark";
import { ModSessionRow, ModSpaceSection } from "@/components/mod-session";
import { PartFrame } from "@/lib/mods/part-frame";
import { renderView, type RenderCtx } from "@/lib/mods/render";
import { partKey, type ModTapReply, type WireModInfo, type WireModPart } from "@/lib/mods/schema";
import { createModsStore, type ModsStore } from "@/lib/mods/store";
import type { AgentView } from "@/lib/types";
import { mintRequestId } from "@/lib/worktree-name";
import { ModSessionBody, ModSessionHeaderRow } from "@/routes/mod-session";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "mod-places",
  title: "Mod places",
  intent: "The belt's mod marks, the mod session, three look fixes, at 390 px.",
};

const NOW = Date.now();
const AS_OF = new Date(NOW - 20_000).toISOString();
const IGNORE = () => {};
const RUN = () => Promise.resolve(true);

const LEGS: WireModInfo = { host: "bluefin", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt", "session"] };
const TRACKER: WireModInfo = { host: "bluefin", id: "tracker", name: "Tracker", icon: "list", on: true, state: "ok", places: ["belt", "session"] };

function wire(mod: string, value: WireModPart["value"]): WireModPart {
  return { host: "bluefin", mod, part: value.id, rev: 1, value, asOf: AS_OF, fresh: "90s" };
}

const LEGS_BELT = wire("legs", { at: "belt", id: "belt", mark: { icon: "flask", face: "23/34", tone: "working", intent: "rerun" } });
const TRACKER_BELT = wire("tracker", { at: "belt", id: "belt", mark: { icon: "list", face: "M94", tone: "plain" } });
const LEGS_SESSION = wire("legs", {
  at: "session",
  id: "legs",
  name: "Browser leg",
  tone: "working",
  subtitle: "case 24 red",
  badge: { count: 1 },
  progress: { kind: "percent", value: 68 },
  actions: [
    { id: "rerun", label: "Rerun red", intent: "rerun", icon: "refresh" },
    { id: "fix", label: "Ask for a fix", intent: "fix" },
  ],
  view: {
    kind: "stack",
    children: [
      { kind: "number", value: "23/34", label: "cases green", tone: "working" },
      { kind: "progress", value: 68 },
      { kind: "list", rows: 4, items: [{ text: "Case 24: send a long draft", tone: "error" }, { text: "Case 31: stop mid-turn", tone: "warn" }] },
    ],
  },
});
const TRACKER_SESSION = wire("tracker", { at: "session", id: "due", name: "Tracker", tone: "ok", subtitle: "M94 slice 03 next", view: { kind: "text", text: "Two specs due this week.", lines: 2 } });

/** A store over a stand-in bridge that answers a tap after a moment, so the busy state is seen. */
function placesStore(): ModsStore {
  const parts = [LEGS_BELT, TRACKER_BELT, LEGS_SESSION, TRACKER_SESSION];
  return createModsStore({
    fetchMods: () => Promise.resolve({ rev: 1, mods: [LEGS, TRACKER], parts, present: parts.map(partKey) }),
    tapMod: (_host, _mod, body) => new Promise<ModTapReply>((resolve) => setTimeout(() => resolve({ requestId: body.requestId, outcome: "applied" }), 1500)),
    mintRequestId,
  });
}

function useStore(): ModsStore {
  const store = useMemo(placesStore, []);
  useEffect(() => {
    void store.syncMods(1);
  }, [store]);
  return store;
}

function modPane(id: string, part: WireModPart, over: Partial<AgentView>): AgentView {
  return {
    paneId: `mod:bluefin:${id}:${part.part}`,
    workspaceId: "mod:bluefin",
    workspaceLabel: "Mods",
    workspaceNumber: 4,
    tabId: `mod:bluefin:${id}`,
    agent: id,
    status: "idle",
    cwd: "",
    focused: false,
    kind: "mod",
    view: partKey(part),
    ...over,
  };
}

const LEGS_PANE = modPane("legs", LEGS_SESSION, { status: "working", paneLabel: "Browser leg", subtitle: "case 24 red", badge: { count: 1 }, progress: { kind: "percent", value: 68 } });
const LEGS_RED = { ...LEGS_PANE, status: "idle" as const, subtitle: "11 red, run done", progress: { kind: "steps" as const, steps: [{ label: "solo", state: "done" as const }, { label: "crew", state: "done" as const }] } };
const TRACKER_PANE = modPane("tracker", TRACKER_SESSION, { paneLabel: "Tracker", subtitle: "M94 slice 03 next" });

function Glass({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`w-[390px] max-w-full rounded-sm border border-border bg-background ${className ?? "px-4 py-3"}`}>{children}</div>;
}

function Belt({ marks }: { marks: boolean }) {
  const store = useStore();
  const shown = marks ? beltMarksOf({ parts: [LEGS_BELT, TRACKER_BELT], handlersFor: () => ({}), sessions: [TRACKER_PANE], onOpenSession: IGNORE, store }) : undefined;
  return (
    <ActionsRow
      general={[
        { id: "keys", icon: Keyboard, label: "Keys", onSelect: IGNORE },
        { id: "screen", icon: Monitor, label: "Screen", onSelect: IGNORE },
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

function Screen() {
  const store = useStore();
  return (
    <div className="flex h-[560px] flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2">
        <ModSessionHeaderRow pane={LEGS_PANE} onBack={IGNORE} />
      </div>
      <ModSessionBody pane={LEGS_PANE} onDraft={IGNORE} onOpen={IGNORE} store={store} />
    </div>
  );
}

function ctx(tap?: RenderCtx["tap"]): RenderCtx {
  return { partKey: partKey(LEGS_SESSION), modName: "Browser leg", stale: false, tap, onTap: IGNORE, onDraft: IGNORE, onOpen: IGNORE, now: NOW };
}

export function ModPlacesSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The belt">
        <Card state="mod-belt-marks" label="1 · two mod marks">
          <Glass className="py-2">
            <Belt marks />
          </Glass>
        </Card>
        <Card state="mod-belt-none" label="2 · no mod, no gap">
          <Glass className="py-2">
            <Belt marks={false} />
          </Glass>
        </Card>
      </Group>
      <Group title="The mod session">
        <Card state="mod-space-dashboard" label="3 · Dashboard, Mods">
          <Glass className="py-0">
            <ModSpaceSection sessions={[LEGS_PANE, TRACKER_PANE]} onOpen={IGNORE} />
          </Glass>
        </Card>
        <Card state="mod-space-done" label="4 · run done, bar kept">
          <Glass className="py-0">
            <ModSpaceSection sessions={[LEGS_RED]} onOpen={IGNORE} />
          </Glass>
        </Card>
        <Card state="mod-space-switch" label="5 · Switch session rows">
          <Glass>
            <ModSessionRow pane={LEGS_PANE} variant="switch" active onOpen={IGNORE} />
            <ModSessionRow pane={TRACKER_PANE} variant="switch" onOpen={IGNORE} />
          </Glass>
        </Card>
        <Card state="mod-session-screen" label="6 · screen, no Composer">
          <Glass className="p-0">
            <Screen />
          </Glass>
        </Card>
      </Group>
      <Group title="Look fixes">
        <Card state="mod-fix-busy" label="7 · busy keeps label">
          <Glass>
            <div className="flex gap-2">
              {renderView({ kind: "button", label: "Rerun red", intent: "rerun" }, ctx())}
              {renderView({ kind: "button", label: "Rerun red", intent: "rerun" }, ctx({ phase: "busy", requestId: "r", control: "v", intent: "rerun" }))}
            </div>
          </Glass>
        </Card>
        <Card state="mod-fix-age" label="8 · fresh line says age">
          <Glass>
            <PartFrame part={TRACKER_SESSION} mod={TRACKER} onDraft={IGNORE} now={NOW}>
              {({ stale }) => renderView({ kind: "text", text: "Two specs due this week.", lines: 2 }, { ...ctx(), stale })}
            </PartFrame>
          </Glass>
        </Card>
        <Card state="mod-fix-rows" label="9 · empty rows, hairlines">
          <Glass>{renderView({ kind: "list", rows: 4, items: [{ text: "Case 24: send a long draft", tone: "error" }] }, ctx())}</Glass>
        </Card>
      </Group>
    </Section>
  );
}
