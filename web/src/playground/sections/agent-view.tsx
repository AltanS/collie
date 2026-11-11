// The "Agent view" section of the states playground: a trick's view of a session that the session's own
// agent draws (components/agent-view-screen.tsx), and its switch rows in the session's sheet. Every card
// mounts the REAL component over fixture data; nothing talks to a bridge, and a tap goes nowhere. The
// fixture trick is named Morph.
//
// One query word makes shots easy: `?solo=<case>` draws that one case over the whole screen, and
// `&shot=1` hides its close button.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { AgentViewScreen, type AgentViewScreenProps } from "@/components/agent-view-screen";
import type { ViewSendResult } from "@/components/composer";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { fixtureAgents } from "@/test/handlers";

import { VIEW_NOW, VIEW_SCREEN, VIEW_SESSION, VIEW_TAP_LINE } from "../fixtures/agent-view";
import { Card, Group, Section, Stage, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "agent-view",
  title: "Agent view",
  intent: "A screen a session's agent draws for a trick, under Collie's band, and its switch in the session's sheet.",
};

const CASES = ["switch-off", "switch-on", "two-tricks", "screen", "working", "question", "old", "sent", "armed", "changed"] as const;
type CaseId = (typeof CASES)[number];

function isCaseId(word: string | null): word is CaseId {
  return CASES.some((id) => id === word);
}

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

const ROWS_OFF = [{ trick: "morph", label: "Morph", on: false }];
const ROWS_ON = [{ trick: "morph", label: "Morph", on: true }];
const TWO_ROWS = [
  { trick: "morph", label: "Morph", on: true },
  { trick: "board", label: "Release boa…", on: false },
];

const noTap = (): Promise<ViewSendResult> => Promise.resolve({ sent: false, line: null, code: null });
const noSwitch = (): Promise<string | null> => Promise.resolve(null);

/** The session's sheet with its agent view rows. */
function Sheet({ rows, label, showing }: { rows: AgentViewScreenRows; label: string | undefined; showing: boolean }) {
  const pane = fixtureAgents[0];
  if (pane === undefined) return null;
  return (
    <PaneActionsSheet
      open
      onClose={() => undefined}
      pane={pane}
      onRenamed={() => undefined}
      onClosed={() => undefined}
      paneView="chat"
      onPaneViewChange={() => undefined}
      agentViews={{ rows, label, on: rows.some((row) => row.on), showing, onShow: () => undefined, onSwitch: noSwitch }}
    />
  );
}

type AgentViewScreenRows = readonly { readonly trick: string; readonly label: string; readonly on: boolean }[];

/** The view body as the session screen draws it, over fixture data. */
function Screen(over: Partial<AgentViewScreenProps>) {
  return (
    <AgentViewScreen name="Morph" session={VIEW_SESSION} view={VIEW_SCREEN} working={false} entries={[]} canAct onTap={noTap} onLink={() => undefined} now={VIEW_NOW} {...over} />
  );
}

/** A screen with the confirm button of the bar armed: the first tap, made once on mount. */
function ArmedScreen() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const button = [...(box.current?.querySelectorAll("button") ?? [])].find((found) => found.textContent?.includes("Drop the tag") === true);
    button?.click();
  }, []);
  return (
    <div ref={box} className="h-full">
      <Screen />
    </div>
  );
}

const SENT_AT = Date.parse("2026-11-11T10:02:00.000Z");

function CaseBody({ id }: { id: CaseId }): ReactNode {
  switch (id) {
    case "switch-off":
      return <Sheet rows={ROWS_OFF} label={undefined} showing={false} />;
    case "switch-on":
      return <Sheet rows={ROWS_ON} label="Morph" showing />;
    case "two-tricks":
      return <Sheet rows={TWO_ROWS} label="Morph" showing />;
    case "screen":
      return <Screen />;
    case "working":
      return (
        <Screen
          working
          request={{ text: "Compare the two release plans", phase: "sent", reason: null, at: SENT_AT, line: null }}
          drawing={{ at: "2026-11-11T10:02:30.000Z", note: "Reading the CI runs", notes: [{ at: "2026-11-11T10:02:10.000Z", note: "Reading the changelog" }, { at: "2026-11-11T10:02:30.000Z", note: "Reading the CI runs" }] }}
        />
      );
    case "question":
      return <Screen question />;
    case "old":
      return <Screen stale />;
    case "sent":
      return <Screen view={{ ...VIEW_SCREEN, at: "2026-11-11T10:02:40.000Z" }} request={{ text: 'tapped "Ship 1.29.0" in "Release"', phase: "sent", reason: null, at: SENT_AT, line: VIEW_TAP_LINE }} />;
    case "armed":
      return <ArmedScreen />;
    case "changed":
      return <Screen changed view={{ ...VIEW_SCREEN, rev: 4 }} />;
  }
}

const LABELS = {
  "switch-off": "1: switch row, off",
  "switch-on": "2: switch row, on",
  "two-tricks": "3: two view tricks",
  screen: "4: drawn screen under the band",
  working: "5: a turn runs",
  question: "6: a question waits",
  old: "7: earlier conversation",
  sent: "8: after a tap, sent",
  armed: "9: confirm button armed",
  changed: "10: stale tap, read again",
} as const satisfies Record<CaseId, string>;

/** One case over the whole screen, for a phone and for the shots. */
function Solo({ id }: { id: CaseId }) {
  const shot = param("shot") === "1";
  const style: CSSProperties & { "--app-h"?: string } = { "--app-h": "100dvh" };
  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background text-foreground" style={style}>
      <CaseBody id={id} />
      {!shot && (
        <a
          href="#agent-view"
          aria-label="Close"
          className="fixed bottom-4 left-4 z-[61] flex h-11 min-w-11 items-center justify-center rounded-sm border border-border bg-card px-2 text-sm font-semibold shadow-md"
        >
          ×
        </a>
      )}
    </div>
  );
}

export function AgentViewSection() {
  const solo = param("solo");
  if (isCaseId(solo)) return <Solo id={solo} />;
  return (
    <Section def={DEF}>
      <Group title="The session's sheet">
        {(["switch-off", "switch-on", "two-tricks"] as const).map((id) => (
          <Card key={id} state={`agent-view-${id}`} label={LABELS[id]}>
            <Stage height={760}>
              <CaseBody id={id} />
            </Stage>
          </Card>
        ))}
      </Group>
      <Group title="The view">
        {(["screen", "working", "question", "old", "sent", "armed", "changed"] as const).map((id) => (
          <Card key={id} state={`agent-view-${id}`} label={LABELS[id]}>
            <Stage height={760}>
              <CaseBody id={id} />
            </Stage>
          </Card>
        ))}
      </Group>
    </Section>
  );
}
