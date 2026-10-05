// The Changes view section of the states playground (ADR 0065): the file list and one file's diff,
// drawn by the same presentational components the route mounts, fed the fixtures the unit suite and
// the e2e stub read (`@/test/handlers`). The route itself fetches, and nothing here is stubbed, by
// rule — so the cards mount the drawings, not the route.

import { ChangesControl } from "@/components/changes-control";
import { useState } from "react";

import { FileContent, type FileLinks, type FileText, type FileView } from "@/components/file-preview";
import { ChangesOnlyToggle, FilesBreadcrumb, FilesFilterBar, FilesFolderBody, IgnoredToggle } from "@/components/files-view";
import { Segmented } from "@/components/ui/segmented";

import {
  ChangePath,
  ChangesFilterBar,
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
import { folderView } from "@/lib/files-filter";
import { previewKindFor } from "@/lib/files-view";
import { changeAt, indexChanges, markFolder } from "@/lib/files-marks";
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
    "By default the screen is the root folder, one folder at a time, with every change marked on its " +
    "row; the header's Changes-only toggle swaps it for the list of changes alone, flat or as a tree, " +
    "with a filter row that narrows it by path and status. A file opens on Diff when it changed, " +
    "beside Source and, for Markdown, JSON and HTML, a Preview.",
};

const repos = fixtureChanges.available ? fixtureChanges.repos : [];
const CHANGES = indexChanges(fixtureChanges.available ? fixtureChanges.root : "", repos);
const CHANGED = countFiles(repos);
/** The fixture's change set with one file deleted at the root, which the disk no longer lists. */
const DELETED_INDEX = indexChanges(fixtureChanges.available ? fixtureChanges.root : "", [
  { ...repos[0]!, files: [...repos[0]!.files, { path: "CHANGELOG.md", status: "D", added: 0, removed: 12, binary: false }] },
  ...repos.slice(1),
]);

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
          <ChangesOnlyToggle on count={CHANGED} onChange={() => {}} />
          <ChangesFilterOverlay open={open} onClose={() => setOpen(false)}>
            <ChangesFilterBar
              filter={filter}
              onChange={setFilter}
              onClear={clear}
              shown={countFiles(shown)}
              total={countFiles(repos)}
              focusOnMount
            />
          </ChangesFilterOverlay>
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

/**
 * A README that shows every kind of link a Markdown preview handles: a relative path, a folder, an
 * anchor, a reference link, a web address and a badge. The script line stays, to show raw HTML as text.
 */
const README_WITH_LINKS = [
  "# Webapp",
  "",
  "[![Build](https://example.com/badge.svg)](https://example.com/ci) [![Tests](badge.svg)](./docs/guide.md)",
  "",
  "A small shop. **Run it** with `bun dev`, then open the [docs](https://example.com/docs).",
  "",
  "Jump to [Install](#install), read the [guide](./docs/guide.md) or browse [the source](src/). The [API notes][api] live in a reference link.",
  "",
  "## Install",
  "",
  "- carts",
  "- checkout, see [routes](src/routes/checkout.tsx)",
  "",
  "<script>alert(1)</script>",
  "",
  "[api]: ./docs/guide.md \"The API notes\"",
  "",
].join("\n");

/** What the playground gives a link in a Markdown file: an address that goes nowhere, and a tap that does nothing. */
const PLAYGROUND_LINKS: FileLinks = { hrefFor: () => "#", onOpen: () => {} };

type CardView = "diff" | FileView;

/**
 * The file screen's sticky bar and body, live: the Diff | Source | Preview choice is a real control.
 * A file the change set names shows its letter and opens on Diff; another opens on its default.
 */
function FileCard({ file, initial, height = 380 }: { file: FileText; initial: CardView; height?: number }) {
  const [view, setView] = useState<CardView>(initial);
  const change = changeAt(CHANGES, file.path);
  const views: CardView[] = [
    ...(change ? (["diff"] as const) : []),
    "source",
    ...(previewKindFor(file.path) !== null ? (["preview"] as const) : []),
  ];
  const diff = change ? fixtureChangeDiff(change.repo, change.path) : null;
  const label = { diff: t("files.view.diff"), source: t("files.view.source"), preview: t("files.view.preview") };
  return (
    <Stage height={height}>
      <div className="h-full overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-rule bg-background px-4 py-2">
          <div className="flex min-h-7 items-center gap-3">
            {change && <StatusLetter status={change.status} />}
            <ChangePath path={file.path} className="flex-1" />
          </div>
          {views.length > 1 && (
            <Segmented
              label={t("files.view.aria")}
              value={view}
              onChange={setView}
              options={views.map((value) => ({ value, label: label[value] }))}
            />
          )}
        </div>
        <div className="py-2">
          {view === "diff" && diff?.available ? (
            <DiffView diff={diff.diff} path={file.path} />
          ) : (
            <FileContent file={file} view={view === "preview" ? "preview" : "source"} links={PLAYGROUND_LINKS} />
          )}
        </div>
      </div>
    </Stage>
  );
}

/**
 * A folder of the Changes screen's tree, live: the Show action, both Ignored toggles and the filter are
 * real, and each row wears the change marks the fixture's Changes list gives it. `showIgnored` and
 * `query` set the card's starting state; `filterOpen` draws the filter row open over the list.
 */
function FolderCard({
  dir,
  showIgnored: initialShow = false,
  query: initialQuery = "",
  filterOpen = false,
  deleted = false,
}: {
  dir: string;
  showIgnored?: boolean;
  query?: string;
  filterOpen?: boolean;
  /** Add a deleted file to the change set, so the row the disk no longer lists shows struck through. */
  deleted?: boolean;
}) {
  const [showIgnored, setShowIgnored] = useState(initialShow);
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(filterOpen);
  const listing = fixtureFilesDir(dir);
  const entries = listing?.available ? listing.entries : rootEntries;
  const index = deleted ? DELETED_INDEX : CHANGES;
  const marked = markFolder(entries, dir, index);
  const view = folderView(marked.entries, query, showIgnored);
  return (
    <Stage height={filterOpen ? 520 : 480}>
      <div className="flex h-full flex-col">
        <div className="relative flex items-center gap-2 border-b border-rule px-2 py-1">
          <span className="min-w-0 flex-1 truncate px-2 text-lg font-semibold">{t("changes.title")}</span>
          <IgnoredToggle showIgnored={showIgnored} onShowIgnored={setShowIgnored} />
          <ChangesFilterButton
            open={open}
            active={query.trim() !== ""}
            shown={view.rows.length}
            total={view.pool}
            onClick={() => setOpen((o) => !o)}
          />
          {dir === "" && <ChangesOnlyToggle on={false} count={CHANGED} onChange={() => {}} />}
          <ChangesFilterOverlay open={open} onClose={() => setOpen(false)}>
            <FilesFilterBar
              query={query}
              onQuery={setQuery}
              showIgnored={showIgnored}
              onShowIgnored={setShowIgnored}
              shown={view.rows.length}
              total={view.pool}
            />
          </ChangesFilterOverlay>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <FilesBreadcrumb dir={dir} rootName="webapp" hrefFor={() => "#"} onOpen={() => {}} />
          <FilesFolderBody
            entries={marked.entries}
            marks={marked.marks}
            truncated={false}
            query={query}
            showIgnored={showIgnored}
            onShowIgnored={setShowIgnored}
            onClearQuery={() => setQuery("")}
            onOpen={() => {}}
          />
        </div>
      </div>
    </Stage>
  );
}

export function ChangesSection() {
  return (
    <Section def={DEF}>
      <Group title="The list (Changes only)">
        <Card
          state="changes-list-two-repos"
          label="changes, a workspace and a member repo"
          reach="open a pane whose folder is a workspace repo with a member repo below it, tap the Changes
            pill in the belt, then the Changes-only toggle. Two repos have changes, so each gets its
            name and count."
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
          reach="with Changes only on, tap the tree mark beside the filter button. Folders fold; a chain
            of single folders is one row."
        >
          <Interactive initialLayout="tree" />
        </Card>

        <Card
          state="changes-tree-collapsed"
          label="changes, the tree with a folder folded"
          reach="in the Changes-only tree, tap a folder row. Its files hide; its count and line totals
            stay."
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

      <Group title="The folder tree">
        <Card
          state="files-folder-root"
          label="changes, the root folder with its marks"
          reach="open Changes from a pane's belt or the dashboard's Changes tab. The body is the root
            folder: folders first, then files by name, with a size for each file. A changed file wears
            its status letter and an icon in the same colour; a folder with changes below it shows a
            dot and how many. The Changes-only toggle, right of Filter, carries the number of changed
            files, its glyph in the Modified ink."
        >
          <FolderCard dir="" />
        </Card>

        <Card
          state="files-folder-marks"
          label="changes, a folder of changed files"
          reach="in the tree, tap packages, then api. The untracked note is marked U, and server holds the
            renamed handler, so it shows one in the Renamed colour."
        >
          <FolderCard dir="packages/api" />
        </Card>

        <Card
          state="files-folder-deleted"
          label="changes, a deleted file in its folder"
          reach="delete a file the repo tracks, then open Changes. The disk no longer lists it, so the
            row comes from the change set: its name struck through, D in the Deleted colour. It opens on
            its Diff."
        >
          <FolderCard dir="" deleted />
        </Card>

        <Card
          state="files-folder-ignored-hidden"
          label="changes, ignored entries hidden"
          reach="open Changes in a folder inside a git repository that ignores node_modules and logs.
            Those rows are left out, and one quiet line under the list says how many, with a Show
            action. The eye-off toggle in the header, left of Filter, is the same choice, unpressed."
        >
          <FolderCard dir="" />
        </Card>

        <Card
          state="files-folder-ignored-shown"
          label="changes, ignored entries shown"
          reach="in the tree, tap Show under the list, or the eye toggle in the header. The toggle takes
            the primary tint and a hairline ring, as the dashboard's needs-you switch does, and its
            glyph becomes an open eye. The ignored rows come back dimmed, unmarked and still open. The
            choice stays on this device."
        >
          <FolderCard dir="" showIgnored />
        </Card>

        <Card
          state="files-filter-open"
          label="changes, the tree's filter row"
          reach="in the tree, tap the Filter button. A name field, the labelled Ignored toggle (an eye
            and Ignored shown or Ignored hidden), and the count once a name is typed. It is the same
            choice as the eye in the header."
        >
          <FolderCard dir="" showIgnored query="o" filterOpen />
        </Card>

        <Card
          state="files-filter-empty"
          label="changes, a name that matches nothing"
          reach="in the tree, type a name no row has. The sentence and a way out, as the list says it."
        >
          <FolderCard dir="" query="nothing-here" />
        </Card>

        <Card
          state="files-folder-nested"
          label="changes, a folder two levels down"
          reach="in the tree, tap src, then routes. The path above the rows is a breadcrumb; every crumb
            but the last is a link."
        >
          <FolderCard dir="src/routes" />
        </Card>
      </Group>

      <Group title="Changes only">
        <Card
          state="changes-only"
          label="changes, the Changes-only toggle on"
          reach="on Changes, tap the toggle right of Filter. It takes the pressed look and the body
            becomes the list of changed files alone, with the layout toggle and the filter beside it.
            The choice stays on this device."
        >
          <Interactive initialLayout="list" />
        </Card>
      </Group>

      <Group title="One file of the tree">
        <Card
          state="files-diff-changed"
          label="file, a changed file on its Diff"
          reach="in the tree, tap checkout.tsx under src/routes. A changed file opens on Diff; Source is
            one tap away, and Preview too when the type has one."
        >
          <FileCard file={fileOf("src/routes/checkout.tsx")} initial="diff" />
        </Card>

        <Card
          state="files-diff-new-markdown"
          label="file, a new Markdown file: Diff, Source and Preview"
          reach="in the tree, tap notes.md under packages/api, a file the agent just wrote. Its Diff shows
            every line added; one tap on Preview draws it as a page."
        >
          <FileCard file={fileOf("packages/api/notes.md")} initial="diff" />
        </Card>

        <Card
          state="files-source"
          label="file, an unchanged source file"
          reach="in the tree, open a TypeScript file nothing changed. No Diff: numbered lines in
            monospace; colour follows once the highlighter loads."
        >
          <FileCard file={fileOf("src/cart.ts")} initial="source" />
        </Card>

        <Card
          state="files-preview-markdown"
          label="file, a Markdown preview"
          reach="in the tree, open an unchanged .md file. It opens on Preview. A relative link opens that
            file in the tree, an anchor scrolls to its heading, a web address opens in a new tab, and a
            badge is a link labelled with its alt text. Raw HTML in the file, such as a script tag,
            stays as text."
        >
          <FileCard file={fileOf("README.md", { text: README_WITH_LINKS })} initial="preview" />
        </Card>

        <Card
          state="files-preview-json"
          label="file, a JSON preview"
          reach="in the tree, open a .json file. The first two levels are open, deeper ones are folded
            with a count. Tap a row to fold or open it."
        >
          <FileCard file={fileOf("package.json")} initial="preview" />
        </Card>

        <Card
          state="files-preview-json-error"
          label="file, a JSON file that does not parse"
          reach="in the tree, open a .json file that is cut off or malformed. The error line shows, then
            the source."
        >
          <FileCard file={fileOf("package.json", { text: '{\n  "name": "webapp",\n  "version": \n' })} initial="preview" />
        </Card>

        <Card
          state="files-preview-html"
          label="file, an HTML preview"
          reach="in the tree, open an .html file. It draws in a sandboxed frame on a white ground, with a
            line saying scripts, forms and remote files are off."
        >
          <FileCard file={fileOf("index.html")} initial="preview" height={420} />
        </Card>

        <Card
          state="files-binary"
          label="file, a binary file"
          reach="in the tree, open an image or any other binary file. Its size is the whole screen."
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
