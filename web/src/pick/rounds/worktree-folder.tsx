// The Worktree folder round (ADR 0093 note, 2026-11-13): where the operator looks at the one decision, a
// default folder for new worktrees. Two frames, one case switch. Frame 1 is the Settings card, frame 2 is
// the New sheet's Branch folder. Every case reads fixed answers, never a bridge.
import { useMemo, useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { WorktreeFolderControl, type WorktreeFolderIo } from "@/components/worktree-folder-control";
import { describeApiError } from "@/lib/api-error-message";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { ServerSummary, WorktreeFolderSettingResponse } from "@/lib/types";
import { BranchBlock } from "@/routes/new";

import { BROWSE_HOME, browseFixture } from "../../playground/folder-browse-fixture";
import { homeSolo, rosterTrio } from "../../playground/fixtures";
import type { PickCase, PickRoundDef } from "../pick-page";

type CaseId = "default" | "set" | "broken" | "crew" | "editing" | "readonly";

const CASES: readonly (PickCase & { id: CaseId })[] = [
  { id: "default", label: "Default" },
  { id: "set", label: "Set" },
  { id: "broken", label: "Broken" },
  { id: "crew", label: "Crew" },
  { id: "editing", label: "Editing" },
  { id: "readonly", label: "Read-only" },
];

function isCase(id: string): id is CaseId {
  return CASES.some((c) => c.id === id);
}

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

const round: PickRoundDef = {
  title: "Worktree folder",
  cases: CASES,
  frameHeight: 760,
  options: [
    { n: 1, label: "Settings card", render: (id) => <SettingsFrame which={isCase(id) ? id : "default"} /> },
    { n: 2, label: "New sheet, Default folder", render: (id) => <SheetFrame which={isCase(id) ? id : "default"} /> },
  ],
};

export default round;
