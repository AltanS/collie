// The Changes view section of the states playground (ADR 0065): the file list and one file's diff,
// drawn by the same presentational components the route mounts, fed the fixtures the unit suite and
// the e2e stub read (`@/test/handlers`). The route itself fetches, and nothing here is stubbed, by
// rule — so the cards mount the drawings, not the route.

import { ChangesControl } from "@/components/changes-control";
import { useState } from "react";

import { FileContent, type FileText, type FileView } from "@/components/file-preview";
import { ChangesTabs, FileRows, FilesBreadcrumb, type ChangesTab } from "@/components/files-view";
import { Segmented } from "@/components/ui/segmented";

import {
  ChangePath,
  ChangesFilterButton,
  ChangesFilterOverlay,
  ChangesLayoutToggle,
  ChangesList,
  ChangesNoMatch,
  ChangesTree,
  DiffView,
  folderKey,
  StatusLetter,
} from "@/components/changes-view";
import { t } from "@/lib/i18n";
import { countFiles, filterRepos, type ChangesFilter, type ChangesLayout } from "@/lib/changes-tree";
import { fixtureChangeDiff, fixtureChanges, fixtureFileRead, fixtureFilesDir } from "@/test/handlers";
import { Card, Group, Section, Stage, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "changes",
  title: "Changes",
  intent:
    "The pane's Changes view: the list of files changed since the last commit, grouped by repo, " +
    "one file's diff with both line gutters and syntax colour, and the Settings card that decides " +
    "where it looks. " +
    "The list draws flat or as a folder tree, and a filter row narrows it by path and status. " +
    "The Files tab beside it browses the same root folder by folder and opens a file as source or, " +
    "for Markdown, JSON and HTML, as a Preview.",
};

const repos = fixtureChanges.available ? fixtureChanges.repos : [];

/** The list screen's top controls and body, live: the layout toggle, the filter button and row. */
function Interactive({ initialLayout, initialFilter }: { initialLayout: ChangesLayout; initialFilter?: ChangesFilter }) {
  const [layout, setLayout] = useState<ChangesLayout>(initialLayout);
  const [filter, setFilter] = useState<ChangesFilter>(initialFilter ?? { query: "", statuses: [] });
  const [open, setOpen] = useState(initialFilter !== undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const shown = filterRepos(repos, filter);
  const clear = () => setFilter({ query: "", statuses: [] });
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <Stage height={520}>
      <div className="flex h-full flex-col">
        <div className="relative flex items-center gap-2 border-b border-rule px-2 py-1">
          <span className="min-w-0 flex-1 truncate px-2 text-lg font-semibold">{t("changes.title")}</span>
          <ChangesLayoutToggle layout={layout} onChange={setLayout} />
          <ChangesFilterButton
            open={open}
            active={filter.query.trim() !== "" || filter.statuses.length > 0}
            shown={countFiles(shown)}
            total={countFiles(repos)}
            onClick={() => setOpen((o) => !o)}
          />
          <ChangesFilterOverlay
            open={open}
            onClose={() => setOpen(false)}
            filter={filter}
            onChange={setFilter}
            onClear={clear}
            shown={countFiles(shown)}
            total={countFiles(repos)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {shown.length === 0 ? (
            <ChangesNoMatch onClear={clear} />
          ) : layout === "tree" ? (
            <ChangesTree repos={shown} collapsed={collapsed} onToggle={toggle} onOpen={() => {}} />
          ) : (
            <ChangesList repos={shown} onOpen={() => {}} />
          )}
        </div>
      </div>
    </Stage>
  );
}

/**
 * A diff no fixture file carries: a block comment whose opener was deleted runs on into a context
 * line, so that line is coloured as a comment from the old side, not as code.
 */
const HIGHLIGHT_DIFF = [
  "diff --git a/src/lib/price.ts b/src/lib/price.ts",
  "--- a/src/lib/price.ts",
  "+++ b/src/lib/price.ts",
  "@@ -1,9 +1,10 @@",
  "-/* Prices are in cents.",
  "   Never format them twice. */",
  " import { currency } from \"./locale\";",
  " ",
  "-export function formatPrice(cents: number) {",
  "-  return (cents / 100).toFixed(2) + \" \" + currency;",
  "+export function formatPrice(cents: number, withCode = true): string {",
  "+  const amount = (cents / 100).toFixed(2);",
  "+  // The code follows the amount, as the receipt prints it.",
  "+  return withCode ? `${amount} ${currency}` : amount;",
  " }",
  "",
].join("\n");

function Diff({ repo, path, diff }: { repo: string; path: string; diff?: string }) {
  const answer = fixtureChangeDiff(repo, path);
  const file = repos.find((r) => r.relPath === repo)?.files.find((f) => f.path === path);
  return (
    <Stage height={360}>
      <div className="h-full overflow-y-auto">
        <div className="sticky top-0 z-10 flex min-h-11 items-center gap-3 border-b border-rule bg-background px-4 py-2">
          {file && <StatusLetter status={file.status} />}
          <ChangePath path={path} className="flex-1" />
        </div>
        <div className="py-2">
          {diff !== undefined ? (
            <DiffView diff={diff} path={path} />
          ) : (
            answer.available && <DiffView diff={answer.diff} path={path} />
          )}
        </div>
      </div>
    </Stage>
  );
}


const rootListing = fixtureFilesDir("");
const rootEntries = rootListing?.available ? rootListing.entries : [];

/** One text file of the fixture tree, as the file screen holds it. */
function fileOf(path: string, over: Partial<FileText> = {}): FileText {
  const read = fixtureFileRead(path);
  if (read === null || !read.available) throw new Error(`no fixture file ${path}`);
  return { ...read, ...over };
}

/** The file screen's sticky bar and body, live: Source | Preview is a real control. */
function FileCard({ file, initial, height = 380 }: { file: FileText; initial: FileView; height?: number }) {
  const [view, setView] = useState<FileView>(initial);
  const hasChoice = initial === "preview";
  return (
    <Stage height={height}>
      <div className="h-full overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-rule bg-background px-4 py-2">
          <ChangePath path={file.path} className="min-h-7 items-center" />
          {hasChoice && (
            <Segmented
              label={t("files.view.aria")}
              value={view}
              onChange={setView}
              options={[
                { value: "source", label: t("files.view.source") },
                { value: "preview", label: t("files.view.preview") },
              ]}
            />
          )}
        </div>
        <div className="py-2">
          <FileContent file={file} view={view} />
        </div>
      </div>
    </Stage>
  );
}

function FolderCard({ dir, tab = "files" }: { dir: string; tab?: ChangesTab }) {
  const [active, setActive] = useState<ChangesTab>(tab);
  const listing = fixtureFilesDir(dir);
  const entries = listing?.available ? listing.entries : rootEntries;
  return (
    <Stage height={440}>
      <div className="flex flex-col gap-3 overflow-y-auto p-4">
        <ChangesTabs active={active} onChange={setActive} />
        <FilesBreadcrumb dir={dir} rootName="webapp" hrefFor={() => "#"} onOpen={() => {}} />
        <FileRows entries={entries} onOpen={() => {}} />
      </div>
    </Stage>
  );
}

export function ChangesSection() {
  return (
    <Section def={DEF}>
      <Group title="The list">
        <Card
          state="changes-list-two-repos"
          label="changes, a workspace and a member repo"
          reach="open a pane whose folder is a workspace repo with a member repo below it, tap ⋮, then
            Changes. Two repos have changes, so each gets its name and count."
        >
          <Stage height={360}>
            <div className="p-4">
              <ChangesList repos={repos} onOpen={() => {}} />
            </div>
          </Stage>
        </Card>

        <Card
          state="changes-list-one-repo"
          label="changes, one repo"
          reach="the same, in a plain repo. One repo needs no heading: the header names the folder."
        >
          <Stage height={220}>
            <div className="p-4">
              <ChangesList repos={repos.slice(0, 1)} onOpen={() => {}} />
            </div>
          </Stage>
        </Card>
      </Group>

      <Group title="Layout and filter">
        <Card
          state="changes-tree"
          label="changes, the tree layout"
          reach="on the Changes list, tap the tree mark beside the filter button. Folders fold; a chain of
            single folders is one row."
        >
          <Interactive initialLayout="tree" />
        </Card>

        <Card
          state="changes-tree-collapsed"
          label="changes, the tree with a folder folded"
          reach="in the tree, tap a folder row. Its files hide; its count and line totals stay."
        >
          <Stage height={300}>
            <div className="p-4">
              <ChangesTree
                repos={repos}
                collapsed={new Set([folderKey(".", "src/")])}
                onToggle={() => {}}
                onOpen={() => {}}
              />
            </div>
          </Stage>
        </Card>

        <Card
          state="changes-filtered"
          label="changes, filtered by path and status"
          reach="tap the filter button, type part of a path, or tap a status letter. The button shows how
            many files are left."
        >
          <Interactive initialLayout="list" initialFilter={{ query: "s", statuses: ["M", "R"] }} />
        </Card>

        <Card
          state="changes-filter-empty"
          label="changes, a filter that matches nothing"
          reach="type a path no changed file has."
        >
          <Interactive initialLayout="list" initialFilter={{ query: "nothing-here", statuses: [] }} />
        </Card>
      </Group>

      <Group title="One file">
        <Card
          state="changes-diff-modified"
          label="diff, a modified file with a long line"
          reach="tap a modified file. The long line wraps rather than scrolling the page sideways."
        >
          <Diff repo="." path="src/routes/checkout.tsx" />
        </Card>

        <Card state="changes-diff-added" label="diff, a new file" reach="tap a file staged as new.">
          <Diff repo="." path="src/lib/cart.ts" />
        </Card>

        <Card
          state="changes-diff-highlighted"
          label="diff, syntax colour across a block comment"
          reach="tap a TypeScript file whose change deletes the first line of a block comment. The
            plain rows draw first; colour follows once the highlighter loads, and no row moves. The
            comment's second line keeps its comment colour, read from the old side."
        >
          <Diff repo="." path="src/lib/price.ts" diff={HIGHLIGHT_DIFF} />
        </Card>
      </Group>

      <Group title="Files">
        <Card
          state="files-folder-root"
          label="files, the root folder"
          reach="open Changes, then tap the Files tab. Folders come first, then files by name, with a size
            for each file. A symlink shows as a link row and opens like a file."
        >
          <FolderCard dir="" />
        </Card>

        <Card
          state="files-folder-nested"
          label="files, a folder two levels down"
          reach="in Files, tap src, then routes. The path above the rows is a breadcrumb; every crumb but
            the last is a link."
        >
          <FolderCard dir="src/routes" />
        </Card>

        <Card
          state="files-source"
          label="files, a source file"
          reach="in Files, open a TypeScript file. Numbered lines in monospace; colour follows once the
            highlighter loads."
        >
          <FileCard file={fileOf("src/cart.ts")} initial="source" />
        </Card>

        <Card
          state="files-preview-markdown"
          label="files, a Markdown preview"
          reach="in Files, open a .md file. It opens on Preview. Raw HTML in the file, such as a script
            tag, stays as text."
        >
          <FileCard file={fileOf("README.md")} initial="preview" />
        </Card>

        <Card
          state="files-preview-json"
          label="files, a JSON preview"
          reach="in Files, open a .json file. The first two levels are open, deeper ones are folded with a
            count. Tap a row to fold or open it."
        >
          <FileCard file={fileOf("package.json")} initial="preview" />
        </Card>

        <Card
          state="files-preview-json-error"
          label="files, a JSON file that does not parse"
          reach="in Files, open a .json file that is cut off or malformed. The error line shows, then the source."
        >
          <FileCard file={fileOf("package.json", { text: '{\n  "name": "webapp",\n  "version": \n' })} initial="preview" />
        </Card>

        <Card
          state="files-preview-html"
          label="files, an HTML preview"
          reach="in Files, open an .html file. It draws in a sandboxed frame on a white ground, with a line
            saying scripts, forms and remote files are off."
        >
          <FileCard file={fileOf("index.html")} initial="preview" height={420} />
        </Card>

        <Card
          state="files-binary"
          label="files, a binary file"
          reach="in Files, open an image or any other binary file. Its size is the whole screen."
        >
          <FileCard file={fileOf("logo.png")} initial="source" height={260} />
        </Card>
      </Group>

      <Group title="Settings">
        <Card
          state="changes-settings"
          label="Settings, the Changes card"
          reach="open Settings. The depth choice greys out while the switch is off, and keeps its value."
        >
          <ChangesControl />
        </Card>
      </Group>
    </Section>
  );
}
