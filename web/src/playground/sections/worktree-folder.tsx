// Worktree folder section of the design reference (ADR 0093 note, 2026-11-13): the approved states of the
// machine's default folder for new worktrees. Card 1 is the Settings card in each of its cases; card 2 is the
// New sheet's Branch folder, whose first choice reads "Default folder". Both mount the REAL components
// (`WorktreeFolderControl`, `BranchBlock`) over fixed answers, never a bridge.

import { useMemo, useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { WorktreeFolderControl, type WorktreeFolderIo } from "@/components/worktree-folder-control";
import { describeApiError } from "@/lib/api-error-message";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { ServerSummary, WorktreeFolderSettingResponse } from "@/lib/types";
import { BranchBlock } from "@/routes/new";

import { homeSolo, rosterTrio } from "../fixtures";
import { BROWSE_HOME, browseFixture } from "../folder-browse-fixture";
import { Card, CardControls, Group, PhoneFrame, Section, Segmented, type SectionDef } from "../layout";

type CaseId = "default" | "set" | "broken" | "crew" | "editing" | "readonly";

const SETTINGS_CASES: readonly { value: CaseId; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "set", label: "Set" },
  { value: "broken", label: "Broken" },
  { value: "crew", label: "Crew" },
  { value: "editing", label: "Editing" },
  { value: "readonly", label: "Read-only" },
];

const SHEET_CASES = SETTINGS_CASES.filter((c) => c.value === "default" || c.value === "set" || c.value === "broken" || c.value === "crew");

const FALLBACK = `${BROWSE_HOME}/.herdr/worktrees`;
const MINE = `${BROWSE_HOME}/trees`;
/** The crew's second machine keeps a folder of its own. */
const MEMBER_HOST = "workshop";
const MEMBER_HOME = "/home/mate";
const MEMBER = `${MEMBER_HOME}/work/trees`;

/** The lead and one member: the smallest crew. */
const CREW: ServerSummary[] = rosterTrio.slice(0, 2);

const SETTLED: WorktreeFolderSettingResponse = { ok: true, dir: MINE, path: MINE, fallback: FALLBACK };

/** What one machine holds in a case. */
function answerFor(which: CaseId, host: string | undefined): WorktreeFolderSettingResponse {
  if (which === "broken") {
    return { ok: true, dir: `${BROWSE_HOME}/gone`, problem: { error: "", code: "worktree.folder_missing" }, fallback: FALLBACK };
  }
  if (which === "crew") {
    return host === MEMBER_HOST ? { ok: true, dir: MEMBER, path: MEMBER, fallback: `${MEMBER_HOME}/.herdr/worktrees` } : SETTLED;
  }
  if (which === "default") return { ok: true, dir: null, fallback: FALLBACK };
  return SETTLED;
}

/** A save: a folder outside home is the bridge's refusal, anything else is stored as typed. */
function ioFor(which: CaseId): WorktreeFolderIo {
  return {
    read: ({ host }) => Promise.resolve(answerFor(which, host)),
    write: (dir) =>
      Promise.resolve(
        dir !== null && !dir.startsWith("~") && !dir.startsWith(BROWSE_HOME)
          ? { ok: false as const, error: "", code: "worktree.folder_outside_home" as const }
          : { ok: true as const, dir: dir === null ? null : dir.replace(/^~/u, BROWSE_HOME), fallback: FALLBACK },
      ),
    folders: { recent: [`${BROWSE_HOME}/src`, `${BROWSE_HOME}/docs`], favourites: [MINE], home: BROWSE_HOME },
    browse: browseFixture,
    readOnly: which === "readonly",
    startEditing: which === "editing",
  };
}

/** A root route of its own, because the card reads the root's data like it does in the app. */
function Root({ crew, children }: { crew: boolean; children: ReactNode }) {
  const [router] = useState(() =>
    createMemoryRouter([
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeSolo,
        element: (
          <CrewProvider servers={crew ? CREW : homeSolo.servers} sessions={homeSolo.sessions} ts={homeSolo.ts} pollMs={3_000}>
            {children}
          </CrewProvider>
        ),
      },
    ]),
  );
  return <RouterProvider router={router} />;
}

function SettingsFrame({ which }: { which: CaseId }) {
  const io = useMemo(() => ioFor(which), [which]);
  return (
    <Root crew={which === "crew"}>
      <div className="flex min-h-full flex-1 flex-col">
        <h1 className="border-b border-border px-4 py-3 text-lg font-semibold tracking-tight">System</h1>
        <div className="p-4">
          <WorktreeFolderControl io={io} />
        </div>
      </div>
    </Root>
  );
}

const NO_OP = (): void => {};

/** Where the New sheet says the folder goes, by case. A member's repo reads the member's value. */
interface SheetLine {
  targetPath: string | null;
  problem: string | null;
}

function sheetLine(which: CaseId): SheetLine {
  if (which === "default") return { targetPath: "~/.herdr/worktrees/collie/fix-login", problem: null };
  if (which === "broken") return { targetPath: null, problem: describeApiError({ error: "", code: "worktree.folder_missing" }) };
  if (which === "crew") return { targetPath: "~/work/trees/collie/fix-login", problem: null };
  return { targetPath: "~/trees/collie/fix-login", problem: null };
}

function SheetFrame({ which }: { which: CaseId }) {
  const [name, setName] = useState("fix-login");
  const [kind, setKind] = useState<"default" | "parent">("default");
  const [parent, setParent] = useState("");
  const line = sheetLine(which);
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <h1 className="border-b border-border px-4 py-3 text-lg font-semibold tracking-tight">New</h1>
      <div className="flex flex-col gap-3 p-4">
        {which === "crew" ? (
          <p className="font-mono text-[11px] text-muted-foreground" data-testid="sheet-machine">
            A repo on {MEMBER_HOST}
          </p>
        ) : null}
        <BranchBlock
          on
          blocked={null}
          onToggle={NO_OP}
          name={name}
          onName={setName}
          startChoices={null}
          baseShown="default"
          onBase={NO_OP}
          folderKind={kind}
          onFolderKind={setKind}
          parent={parent}
          onParent={setParent}
          folders={{ recent: [], favourites: [], home: BROWSE_HOME }}
          onStar={NO_OP}
          checking={false}
          targetPath={kind === "parent" ? "~/src/collie/fix-login" : line.targetPath}
          problem={kind === "parent" ? null : line.problem}
        />
      </div>
    </div>
  );
}

export const DEF: SectionDef = {
  id: "worktree-folder",
  title: "Worktree folder",
  intent:
    "One folder per machine where new worktrees go by default. Card 1 is the Settings card, one row per machine, in each case: nothing set, a folder saved, a saved folder that fails the rule, a crew with a folder per machine, the editor open with the picker, and a read-only device. Card 2 is the New sheet's Branch folder, whose first choice reads Default folder on every multiplexer.",
};

export function WorktreeFolderSection() {
  const [settings, setSettings] = useState<CaseId>("default");
  const [sheet, setSheet] = useState<CaseId>("default");
  return (
    <Section def={DEF}>
      <Group title="Settings, System">
        <Card
          state="worktree-folder-setting"
          label="1 Worktree folder card"
          reach="open Settings, System. Each machine of a crew has its own row; a solo collie has one and no machine name."
          note="Change opens the New page's folder picker. Try a path outside ~ in Editing to see a refusal. Reads fixed answers, not the bridge."
        >
          <CardControls>
            <Segmented name="Worktree folder case" value={settings} options={SETTINGS_CASES} onChange={setSettings} />
          </CardControls>
          <PhoneFrame height={760}>
            <SettingsFrame key={settings} which={settings} />
          </PhoneFrame>
        </Card>
        <Card
          state="new-sheet-default-folder"
          label="2 Default folder, New sheet"
          reach="on the New page, turn on New worktree. The first choice under Branch folder is the machine's Worktree folder, or Herdr's rule while it is unset."
          note="Crew shows a repo on a member, which reads the member's own folder."
        >
          <CardControls>
            <Segmented name="New sheet case" value={sheet} options={SHEET_CASES} onChange={setSheet} />
          </CardControls>
          <PhoneFrame height={760}>
            <SheetFrame key={sheet} which={sheet} />
          </PhoneFrame>
        </Card>
      </Group>
    </Section>
  );
}
