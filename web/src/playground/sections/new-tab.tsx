// New tab sheet section of the states playground (M91 spec 03, ADR 0131): the sheet the "+" of a workspace's tab
// row and of a dashboard heading opens. Every card mounts the REAL `NewTabSheet` with the props its hook hands it;
// there is no bridge behind this page, so each card holds its own launcher list and its own `start`, and the two
// cards that show a start in flight or refused take the tap themselves once they have mounted.
//
// Cards are numbered 1 to 4.

import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { NewTabSheet } from "@/components/new-tab-sheet";
import type { StartOutcome } from "@/hooks/use-spaces";
import { launchersKey, type LaunchersState } from "@/lib/launchers";
import type { LauncherItem } from "@/lib/types";

import { Card, CardControls, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "new-tab",
  title: "New tab sheet",
  intent:
    "The \"+\" at the end of a workspace's tab row, and on a dashboard heading, opens a sheet of the machine's " +
    "launcher rows: agents, then commands, then Just a shell and More options. Every card mounts the real " +
    "sheet with a list of its own; nothing is sent.",
};

const HOME = "/home/you";
const BESIDE = { paneId: "w1:p1", workspaceId: "w1", cwd: `${HOME}/code/moonward` };

function item(over: Partial<LauncherItem> & Pick<LauncherItem, "key" | "start" | "group" | "label">): LauncherItem {
  return { source: "builtin", noPrompts: false, branch: true, available: true, ...over };
}

const SHELL = item({ key: "shell", start: { shell: true }, group: "commands", label: "Shell" });
const agent = (id: string, label: string, over: Partial<LauncherItem> = {}) =>
  item({ key: `harness:${id}`, start: { harness: id }, group: "agents", label, harness: id, ...over });
const command = (line: string, label: string, over: Partial<LauncherItem> = {}) =>
  item({ key: `row:${line}`, start: { command: line }, group: "commands", label, command: line, source: "operator", branch: false, ...over });

/** Card 1: three agents and two commands, all of them ready. */
const READY: LauncherItem[] = [
  agent("claude", "Claude Code"),
  agent("codex", "Codex"),
  agent("pi", "pi"),
  SHELL,
  command("htop", "htop"),
  command("make logs", "Logs"),
];

/** Card 2: an agent not installed, an agent row that skips prompts, and a lead's row with a pinned folder. */
const MIXED: LauncherItem[] = [
  agent("claude", "Claude Code"),
  agent("codex", "Codex", { available: false, reason: "not_found" }),
  item({
    key: "row:claude --dangerously-skip-permissions",
    start: { command: "claude --dangerously-skip-permissions" },
    group: "agents",
    label: "Claude, no prompts",
    harness: "claude",
    command: "claude --dangerously-skip-permissions",
    source: "operator",
    noPrompts: true,
  }),
  SHELL,
  command("make logs", "Logs", { cwd: `${HOME}/infra`, from: "lead" }),
];

function listOf(items: LauncherItem[]): LaunchersState {
  return { launchers: [], home: HOME, harnesses: [], items, adding: null, recentRuns: null, loadedFor: launchersKey(undefined) };
}

/** A phone-wide box that is a containing block for the sheet it holds, so the sheet opens inside the card. */
function Phone({ children }: { children: ReactNode }) {
  const box: CSSProperties & { "--app-h"?: string } = { width: 390, height: "640px", transform: "translate(0)", "--app-h": "640px" };
  return (
    <div data-pg-frame="" className="relative isolate max-w-full overflow-hidden rounded-xl border border-border bg-background" style={box}>
      {children}
    </div>
  );
}

function CardHead({ n, title }: { n: number; title: string }) {
  return (
    <CardControls className="flex items-center gap-3">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-lg font-bold leading-none text-background">
        {n}
      </span>
      <p className="text-sm font-semibold text-foreground">
        {n}: {title}
      </p>
    </CardControls>
  );
}

/**
 * The sheet, open, inside a router of its own (More options navigates). `start` answers what the card shows;
 * `tap` is a row label the card taps once mounted, the real tap on the real button.
 */
function SheetCard({ items, start, tap }: { items: LauncherItem[]; start: () => Promise<StartOutcome>; tap?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const launchers = useMemo(() => listOf(items), [items]);
  const router = useMemo(
    () =>
      createMemoryRouter([
        {
          path: "*",
          element: <NewTabSheet open onClose={() => {}} label="moonward" beside={BESIDE} scope={undefined} launchers={launchers} start={start} />,
        },
      ]),
    [launchers, start],
  );
  useEffect(() => {
    if (tap === undefined) return;
    const button = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-slot="new-tab-sheet"] button') ?? [])].find((b) =>
      b.textContent?.startsWith(tap),
    );
    button?.click();
  }, [tap]);
  return (
    <div ref={root}>
      <Phone>
        <RouterProvider router={router} />
      </Phone>
    </div>
  );
}

const done = (): Promise<StartOutcome> => Promise.resolve({ kind: "done" });
const never = (): Promise<StartOutcome> => new Promise<StartOutcome>(() => {});
const refused = (): Promise<StartOutcome> =>
  Promise.resolve({ kind: "refused", message: "workshop is not taking writes now. Try again when it answers." });

export function NewTabSection() {
  return (
    <Section def={DEF}>
      <Group title="The sheet">
        <Card
          state="new-tab-ready"
          label="1: three agents, two commands"
          reach="Configure agents on a machine, then tap the + at the end of a workspace's tab row, or on its heading on the dashboard. The sheet is titled with the workspace and shows its folder."
          note="A tap here closes nothing and sends nothing: the card's start answers done."
        >
          <CardHead n={1} title="Three agents, two commands" />
          <SheetCard items={READY} start={done} />
        </Card>

        <Card
          state="new-tab-mixed"
          label="2: dimmed, lead and pinned"
          reach="A machine where Codex is not installed, with an agent row that skips prompts and one of the lead's rows that always runs in its own folder."
          note="Codex is listed, dimmed, with its reason. The lead's row says Lead and where it runs."
        >
          <CardHead n={2} title="Dimmed, lead and pinned" />
          <SheetCard items={MIXED} start={done} />
        </Card>
      </Group>

      <Group title="A start">
        <Card
          state="new-tab-busy"
          label="3: a start in flight"
          reach="Tap a row. Until the bridge answers, the row spins and every row is inert, so a second tap starts nothing."
          note="The card taps htop once mounted, and its start never answers."
        >
          <CardHead n={3} title="A start in flight" />
          <SheetCard items={READY} start={never} tap="htop" />
        </Card>

        <Card
          state="new-tab-refused"
          label="4: a refusal notice"
          reach="Tap a row on a machine that refuses the start. The sheet stays open and says why, in the New page's words."
          note="The card taps Claude Code once mounted, and its start answers a refusal."
        >
          <CardHead n={4} title="A refusal notice" />
          <SheetCard items={READY} start={refused} tap="Claude Code" />
        </Card>
      </Group>
    </Section>
  );
}
