// The Motion tab of the states playground: everything that MOVES without announcing anything —
// collapses, swaps, loading bars, sheets, menus, and pending/pulse indicators. The page already
// shows every END STATE somewhere else; this tab shows the transitions between them and the
// primitives DESIGN.md §11 names, in isolation. See ../app.tsx's header for the page's own two
// rules (mount REAL components with REAL props; drive a module store through its own mutators).
// This file follows both, and every card still carries its own "reach it for real" line.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Collapse, CollapseSwap, COLLAPSE_MS } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { ConnectionBanner } from "@/components/connection-banner";
import { BusyBar } from "@/components/busy-bar";
import { trackBusy } from "@/lib/busy";
import { StatusDot, StatusBadge, StatusWord, StatusWordSlot } from "@/components/status-badge";
import { BottomSheet } from "@/components/ui/sheet";
import { AnchoredMenu } from "@/components/ui/anchored-menu";
import { UpdateCheckControl } from "@/components/update-check-control";
import { SnoozeControl } from "@/components/snooze-control";
import { NotifyPrefsControl } from "@/components/notify-prefs-control";
import { RecordingStrip } from "@/components/recording-strip";
import { CrewFormation } from "@/components/crew-formation";
import { useCrew } from "@/components/crew-provider";
import { useOptionalRootData } from "@/lib/route-data";
import { hostCounts } from "@/lib/hosts";
import type { AgentStatus } from "@/lib/types";

import {
  Card,
  Group,
  PackedRootRouter,
  PhoneFrame,
  RootRouter,
  Section,
  Segmented,
  Stage,
  type SectionDef,
} from "../harness";
import { censusTrio, homeSolo, homeTrio, updateRelease } from "../fixtures";
import { Replay, SlowStage } from "./motion-harness";
import { AppWalkthroughCard } from "./app-walkthrough-card";
import "./motion.css";

export const DEF: SectionDef = {
  id: "motion",
  title: "Motion",
  intent:
    "Everything that moves without announcing anything: the real app walked from screen to " +
    "screen, collapse and swap primitives, loading bars, sheets, menus, and pending " +
    "or pulsing controls. A per-card Slow toggle (where one appears) flattens every transition " +
    "under it to one duration so a fast swap can be watched frame by frame, and Replay remounts a " +
    "card so a once-on-mount entrance can be watched again.",
};

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

export function MotionSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="Screen moves">
        <AppWalkthroughCard />
      </Group>
      <Group title="Collapse and swap">
        <CollapsePrimitiveCard />
        <OneOfSwapCard />
      </Group>
      <Group title="Loading">
        <BusyBarCard />
        <StatusIndicatorsCard />
      </Group>
      <Group title="Sheets and menus">
        <BottomSheetMotionCard />
        <AnchoredMenuCard />
      </Group>
      <Group title="Pending and pulses">
        <PendingControlsCard />
        <PulseIndicatorsCard />
      </Group>
    </Section>
  );
}

// ── 1. Collapse & CollapseSwap ───────────────────────────────────────────────

function CollapsePrimitiveCard() {
  const [open, setOpen] = useState(true);
  return (
    <Card
      state="collapse-primitive"
      label="collapse and swap primitives"
      reach="every scope notice on the page (DESIGN.md §11's second row) mounts through Collapse: a
        read-only banner, a host-stale message. The pane screen's tab/pane-row fold uses
        CollapseSwap."
      note={`COLLAPSE_MS = ${COLLAPSE_MS}ms is the curve both primitives share. Collapse's root
        carries data-state='open'/'closed', which is the exact toggle a browser case reads.
        CollapseSwap needs its stand-in to be the SHORTER surface. The summary bar below holds the
        band's floor while the full surface is closed.`}
      span={2}
    >
      <div className="mb-2">
        <Segmented
          name="open"
          value={open ? "on" : "off"}
          options={ON_OFF}
          onChange={(next) => setOpen(next === "on")}
        />
      </div>
      <SlowStage>
        <Stage>
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Collapse
              </p>
              <Collapse open={open}>
                <div className="rounded-md border border-border bg-muted p-3 text-xs">
                  the collapsible content, {open ? "open" : "closing"}
                </div>
              </Collapse>
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                CollapseSwap
              </p>
              <CollapseSwap
                open={open}
                standIn={
                  <div className="rounded-md border border-border bg-muted p-2 text-[11px]">
                    closed, the stand-in
                  </div>
                }
              >
                <div className="rounded-md border border-border bg-muted p-3 text-xs">
                  the full surface, open
                </div>
              </CollapseSwap>
            </div>
          </div>
        </Stage>
      </SlowStage>
    </Card>
  );
}

// ── 2. OneOf, a reserved slot, never a resize ──────────────────────────────

const ONE_OF_OPTIONS = [
  { key: "short", node: <span className="text-xs">short</span> },
  { key: "medium", node: <span className="text-sm font-medium">a medium line of text</span> },
  {
    key: "tall",
    node: (
      <div className="flex flex-col gap-1 text-xs">
        <span>line one</span>
        <span>line two</span>
        <span>line three</span>
      </div>
    ),
  },
] as const;

const ONE_OF_TABS = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "tall", label: "Tall" },
] as const;

function OneOfSwapCard() {
  const [active, setActive] = useState<"short" | "medium" | "tall">("short");
  return (
    <Card
      state="one-of-swap"
      label="OneOf, the box never resizes"
      reach="the strip band on the Notices tab (which slot wins), a status word slot
        (status-badge.tsx), any run of translated text whose glyph width changes per locale."
      note="All three alternatives are always rendered, stacked in one grid cell; the box is sized by
        the widest and tallest of them and a change of `active` repaints the cell rather than
        resizing it. Watch the dashed border: it never moves."
      span={1}
    >
      <div className="mb-2">
        <Segmented name="one-of option" value={active} options={ONE_OF_TABS} onChange={setActive} />
      </div>
      <SlowStage>
        <Stage>
          <div className="p-4">
            <OneOf
              active={active}
              options={ONE_OF_OPTIONS}
              className="rounded-md border border-dashed border-border p-2"
              layerClassName="transition-opacity duration-200"
            />
          </div>
        </Stage>
      </SlowStage>
    </Card>
  );
}

// ── 3. BusyBar ───────────────────────────────────────────────────────────────

function BusyBarCard() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    void trackBusy(pending);
    return () => release();
  }, [on]);

  return (
    <Card
      state="busy-bar"
      label="BusyBar, the top-of-viewport progress line"
      reach="any WRITE in flight: a reply send, a key press, an upload, a tab/space create, a pane
        close. Rare to catch as a screenshot: it holds itself invisible for its own first ~120ms (see
        index.css's busy-bar-appear), so a fast mutation never flashes it at all."
      note="Driven through lib/busy's own trackBusy(): the toggle opens a promise that stays pending
        until it flips off, which is the same shape every real mutation's in-flight promise has.
        Cleans up on toggle-off and on unmount alike, so no work is left counted if the tab is
        switched mid-demo."
      span={1}
    >
      <div className="mb-2">
        <Segmented
          name="busy"
          value={on ? "on" : "off"}
          options={ON_OFF}
          onChange={(next) => setOn(next === "on")}
        />
      </div>
      <Stage height={64}>
        <BusyBar />
      </Stage>
    </Card>
  );
}

// ── 4. Status dot, badge & word ──────────────────────────────────────────────

const STATUSES: readonly AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function StatusIndicatorsCard() {
  return (
    <Card
      state="status-indicators"
      label="StatusDot, StatusBadge, StatusWord & StatusWordSlot"
      reach="any agent row (dashboard, tab strip, pane strip, pane header) for the dot; the pane
        header's line 1 for the word."
      note="Every dot below has `live` breathing ON so the animation can be judged. In the real app
        exactly ONE dot per pane ever breathes (the pane chip and the pane header's own badge); every
        other mount shows a solid, still dot for the same working state. Stale examples show the
        frozen-last-snapshot dim (opacity-40) the three primitives share."
      span={2}
    >
      <Stage>
        <div className="flex flex-col gap-4 p-4">
          <Row label="StatusDot, live">
            {STATUSES.map((s) => (
              <StatusDot key={s} status={s} label={s} live />
            ))}
          </Row>
          <Row label="StatusDot, live, stale">
            {STATUSES.map((s) => (
              <StatusDot key={s} status={s} label={s} live stale />
            ))}
          </Row>
          <Row label="StatusBadge">
            {STATUSES.map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </Row>
          <Row label="StatusWord">
            {STATUSES.map((s) => (
              <StatusWord key={s} status={s} />
            ))}
          </Row>
          <Row label="StatusWordSlot, reserves the widest word">
            {STATUSES.map((s) => (
              <StatusWordSlot key={s} status={s} />
            ))}
          </Row>
        </div>
      </Stage>
    </Card>
  );
}

// ── 5. Sheets ────────────────────────────────────────────────────────────────

function PhoneFrameStage({ height, children }: { height?: number; children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <PhoneFrame height={height}>{children}</PhoneFrame>
    </div>
  );
}

function BottomSheetDemo() {
  const [open, setOpen] = useState(true);
  return (
    <PhoneFrameStage height={280}>
      <div className="flex flex-1 items-center justify-center p-4">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Open sheet
        </Button>
      </div>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Sheet title">
        <div className="flex flex-col gap-2">
          <div className="h-10 rounded-md bg-muted" />
          <div className="h-10 rounded-md bg-muted" />
          <div className="h-10 rounded-md bg-muted" />
        </div>
      </BottomSheet>
    </PhoneFrameStage>
  );
}

function BottomSheetMotionCard() {
  return (
    <Card
      state="bottom-sheet-motion"
      label="BottomSheet, entrance, exit and drag-to-dismiss"
      reach="any sheet in the app: pane actions, the new-space sheet, a device's paperwork. Pull down
        from the handle to dismiss by drag; tap the backdrop or Escape for the ordinary dismiss."
      note="Mounted inside a PhoneFrame, whose `transform` is the containing block for the sheet's
        `position: fixed` root (harness.tsx's own PhoneFrame doc, the same composition the Settings
        tab's 'new-space-worktree-tab' card already uses). Drag-to-dismiss needs real touch events,
        which this environment cannot synthesize. Only the tap/Escape/backdrop dismiss and the slide
        animation are checkable here; the drag is stated, not shown."
      span={2}
    >
      <Replay>
        <BottomSheetDemo />
      </Replay>
    </Card>
  );
}

// ── 6. AnchoredMenu ─────────────────────────────────────────────────────────

function AnchoredMenuCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card
      state="anchored-menu"
      label="AnchoredMenu, opens above its trigger"
      reach="the composer's attach button, or any control at the bottom of the screen that needs a
        menu rather than a full sheet. The component's own header measured a bottom sheet covering
        that button 42ms after the tap; this is the fix."
      note="No entrance animation is correct here, not a gap: the panel is absolutely positioned and
        out of flow, so nothing around it moves when it arrives. A slide-in would only delay the
        answer to a tap already made (the component's own header makes this argument in full)."
      span={1}
    >
      <Stage height={160}>
        <div className="relative flex h-full items-end justify-end p-4">
          <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
            Trigger
          </Button>
          <AnchoredMenu open={open} onClose={() => setOpen(false)} label="Demo menu">
            <button
              type="button"
              className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => setOpen(false)}
            >
              Action one
            </button>
            <button
              type="button"
              className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => setOpen(false)}
            >
              Action two
            </button>
          </AnchoredMenu>
        </div>
      </Stage>
    </Card>
  );
}

// ── 7. Pending / retry controls ─────────────────────────────────────────────

function PendingControlsCard() {
  return (
    <Card
      state="pending-controls"
      label="pending and retry controls"
      reach="the connection banner's Retry button, the Updates page's check control, the Settings
        snooze card, and the Settings notification-prefs card."
      note="Four real controls, each honest about what 'pending' looks like with no bridge behind the
        dev proxy. The connection Retry genuinely spins (its fetch fails fast against nothing, then
        settles); it paints through RootRouter's own StripHost, the same real band the Notices tab's
        strip-band card shows, with only this one slot registered. UpdateCheckControl's check button
        spins the same way. SnoozeControl shows a real optimistic pending flash on tap. And
        NotifyPrefsControl's own spinner never resolves: its one mount-time fetch never lands, so it
        sits pending permanently rather than reaching its loaded state, which is itself an honest
        picture of 'pending forever'."
      span={2}
    >
      <Stage>
        <div className="flex flex-col gap-4 p-4">
          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              connection retry (ConnectionBanner)
            </p>
            <RootRouter data={homeSolo}>
              <ConnectionBanner
                bridge={undefined}
                error
                authError={false}
                lastSeenAt={homeSolo.ts - 3_600_000}
              />
            </RootRouter>
          </div>
          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              UpdateCheckControl
            </p>
            <RootRouter data={{ ...homeSolo, update: updateRelease }}>
              <UpdateCheckControl />
            </RootRouter>
          </div>
          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              SnoozeControl
            </p>
            <RootRouter data={homeSolo}>
              <SnoozeControl snoozedUntil={null} />
            </RootRouter>
          </div>
          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              NotifyPrefsControl
            </p>
            <NotifyPrefsControl />
          </div>
        </div>
      </Stage>
    </Card>
  );
}

// ── 8. Pulse indicators ─────────────────────────────────────────────────────

function CrewFormationPulseInner() {
  const { health, servers } = useCrew();
  const root = useOptionalRootData();
  const counts = hostCounts(root?.agents ?? []);
  return (
    <CrewFormation status={censusTrio} health={health} counts={counts} servers={servers} onSelect={() => {}} />
  );
}

function PulseIndicatorsCard() {
  const [transcribing, setTranscribing] = useState(false);
  return (
    <Card
      state="pulse-indicators"
      label="mic pulse and the crew's blocked-count pulse"
      reach="RecordingStrip: hold the composer's mic button to arm a recording. CrewFormation's
        blocked pill: Settings → Crew, while at least one member's herd holds a blocked pane."
      note="RecordingStrip needs only its own props. CrewFormation's pulse needs the SAME per-host
        health and counts the real crew route derives (routes/crew.tsx), built here from
        CrewProvider's `useCrew()` and lib/hosts's `hostCounts` over the trio fixture (which carries
        blocked panes), the same derivation the route uses, not a copy of its output."
      span={2}
    >
      <Stage>
        <div className="flex flex-col gap-4 p-4">
          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              RecordingStrip
            </p>
            <div className="mb-1.5">
              <Segmented
                name="recording"
                value={transcribing ? "on" : "off"}
                options={[
                  { value: "off", label: "Recording" },
                  { value: "on", label: "Transcribing" },
                ]}
                onChange={(next) => setTranscribing(next === "on")}
              />
            </div>
            <div className="rounded-md border border-border bg-card">
              <RecordingStrip
                elapsed="0:12"
                transcribing={transcribing}
                handsFree={false}
                onStop={() => {}}
                onDiscard={() => {}}
              />
            </div>
          </div>
          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              CrewFormation, blocked pill
            </p>
            <PackedRootRouter data={homeTrio}>
              <CrewFormationPulseInner />
            </PackedRootRouter>
          </div>
        </div>
      </Stage>
    </Card>
  );
}
