import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { OneOf } from "@/components/ui/one-of";
import { ROW_OPEN_CONTROL } from "@/components/ui/row-open";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { addRepoTrick, apiErrorFields, listRepoTricks, repoRefusalReason } from "@/lib/api";
import { t } from "@/lib/i18n";
import { readPhoneSource, shownIndexText, type RepoAddReply, type RepoListEntry, type RepoListReply } from "@/lib/tricks/repo-index";
import { cn } from "@/lib/utils";
import { mintRequestId } from "@/lib/worktree-name";

// Settings, Tricks: "Add from a repository" (2026-11-17, package J). One row at the foot of the list opens this
// sheet. A person pastes the https link of a repository, the bridge reads its `collie-tricks.json` (a list of
// folders, and nothing more) and the sheet shows one row per trick with its own Add. An Add fetches that one
// folder, checks it as any trick is checked, and lands it OFF: the trick appears in the main list, and its own
// switch asks, as for every trick.
//
// THE WORDS OF A REPOSITORY ARE THE REPOSITORY'S. A trick's name, its one line and its folder come from a file
// anyone can write. They are drawn as plain text nodes (never markup, never a link), cut by CSS when long, and
// the line under the name says "The repository says", so the row is plainly the repository's claim and not
// Collie's. The reader (lib/tricks/repo-index.ts `readRepoListReply`) already cleaned them. The trick's own
// `trick.toml` wins once it is added.
//
// THE PHONE'S HOSTS. A link on any host but github.com, gitlab.com and codeberg.org is refused here, before a
// request, with the sentence that names the terminal verb. The bridge refuses it again (409 `host`).
//
// ONE SLOT PER STATE. The Read button and each Add hold their word and their spinner in one `OneOf`, so a
// tap moves nothing. The sheet scrolls and has no bar at the bottom, so the soft keyboard hides nothing.

export type RepoListCall = (url: string, rid: string) => Promise<RepoListReply>;
export type RepoAddCall = (body: { rid: string; url: string; folder: string; commit: string }) => Promise<RepoAddReply>;

/** The words for a refused or failed repository call, from the bridge's `error` word. The reason rides only where the repository gave one. */
export function repoFailureLine<TThrown>(thrown: TThrown, mode: "list" | "add", name?: string): string {
  const code = apiErrorFields(thrown)?.error;
  const reason = shownIndexText(repoRefusalReason(thrown) ?? "", 200);
  if (code === "repo-invalid" || code === "invalid") return t("settings.tricks.repo.err.invalid");
  if (code === "host") return t("settings.tricks.repo.err.host");
  if (code === "tricks-off") return t("settings.tricks.repo.err.tricksOff");
  if (code === "windows") return t("settings.tricks.repo.err.windows");
  if (code === "runs-on") return t("settings.tricks.repo.err.runsOn");
  if (code === "busy") return t("settings.tricks.repo.err.busy");
  if (code === "request-id-reused") return t("settings.tricks.repo.err.reused");
  if (code === "taken") return t("settings.tricks.repo.err.taken");
  if (code === "moved") return t("settings.tricks.repo.err.moved");
  if (code === "not-listed") return t("settings.tricks.repo.err.notListed");
  if (code === "no-index") return t("settings.tricks.repo.err.noIndex");
  if (code === "too-large") return t("settings.tricks.repo.err.tooLarge");
  if (code === "unreachable") return t("settings.tricks.repo.err.unreachable");
  if (code === "index-refused") return reason === "" ? t("settings.tricks.repo.err.indexRefusedBare") : t("settings.tricks.repo.err.indexRefused", { reason });
  if (code === "refused") return reason === "" ? t("settings.tricks.repo.err.refusedBare") : t("settings.tricks.repo.err.refused", { reason });
  return mode === "add" ? t("settings.tricks.repo.err.addFailed", { name: name ?? "" }) : t("settings.tricks.repo.err.failed");
}

/** A refusal that spent its request id: the next tap of the same Add needs a new one. Anything else (a lost answer, a busy bridge) retries with the same id. */
function spendsRid<TThrown>(thrown: TThrown): boolean {
  const code = apiErrorFields(thrown)?.error;
  return code !== undefined && code !== "unreachable" && code !== "busy" && code !== "failed";
}

type ListState = { kind: "idle" } | { kind: "reading" } | { kind: "failed"; line: string } | { kind: "list"; reply: RepoListReply };

type RowState = { kind: "busy" } | { kind: "added" } | { kind: "failed"; line: string };

export interface RepoAddRowProps {
  /** The list read. The real route by default. */
  onList?: RepoListCall;
  /** The add of one listed trick. The real route by default. */
  onAdd?: RepoAddCall;
  /** Tricks are switched off as a whole: the row is disabled. The card says why, once, at its top. */
  tricksOff?: boolean;
  /** This device may only read: the row is disabled. */
  readOnly?: boolean;
}

/** The last row of the Tricks list: one 44 px row that opens the sheet. */
export function RepoAddRow({ onList = listRepoTricks, onAdd = addRepoTrick, tricksOff = false, readOnly = false }: RepoAddRowProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const disabled = tricksOff || readOnly;
  return (
    <div data-slot="repo-add-row" className="px-4 py-1">
      <Button
        type="button"
        variant="ghost"
        data-slot="repo-add-open"
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="-mx-3 h-11 w-[calc(100%+1.5rem)] justify-start gap-2 px-3 font-medium"
      >
        <Icon name="add" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{t("settings.tricks.repo.row")}</span>
      </Button>
      {/* In the page body, outside the list group: the group's rules style every child, and a fixed sheet is none of its rows. */}
      {open && createPortal(<RepoAddSheet open onClose={() => setOpen(false)} onList={onList} onAdd={onAdd} />, document.body)}
    </div>
  );
}

export interface RepoAddSheetProps {
  open: boolean;
  onClose: () => void;
  onList: RepoListCall;
  onAdd: RepoAddCall;
  /** The link the field starts with. For a test or the playground; the app starts empty. */
  initialUrl?: string;
  /** Read the list once when the sheet mounts, as a tap on Read would. For the playground. */
  readOnMount?: boolean;
}

/** The sheet: the link field, the list it read, and one Add per trick. */
export function RepoAddSheet({ open, onClose, onList, onAdd, initialUrl = "", readOnMount = false }: RepoAddSheetProps) {
  useLocale();
  const [url, setUrl] = useState(initialUrl);
  const [problem, setProblem] = useState<string | null>(null);
  const [list, setList] = useState<ListState>({ kind: "idle" });
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  // The request id of each folder's Add: minted at the first tap, kept for a retry, dropped when a refusal spent it.
  const rids = useRef(new Map<string, string>());
  // A read answers only if it is still the latest one.
  const reads = useRef(0);
  const reading = list.kind === "reading";

  function setRow(folder: string, state: RowState | null): void {
    setRows((was) => {
      const next = new Map(was);
      if (state === null) next.delete(folder);
      if (state !== null) next.set(folder, state);
      return next;
    });
  }

  async function read(): Promise<void> {
    if (reading) return;
    const source = readPhoneSource(url);
    // No request for a link the phone flow does not take.
    if ("message" in source) {
      // The phone's own words: the parser's English sentence stays the bridge's.
      setProblem(t(source.code === "host" ? "settings.tricks.repo.err.host" : "settings.tricks.repo.err.invalid"));
      return;
    }
    setProblem(null);
    const mine = (reads.current += 1);
    setList({ kind: "reading" });
    setRows(new Map());
    rids.current.clear();
    try {
      const reply = await onList(source.url, mintRequestId());
      if (mine === reads.current) setList({ kind: "list", reply });
    } catch (thrown) {
      if (mine === reads.current) setList({ kind: "failed", line: repoFailureLine(thrown, "list") });
    }
  }

  async function add(reply: RepoListReply, entry: RepoListEntry): Promise<void> {
    if (rows.get(entry.folder)?.kind === "busy") return;
    const rid = rids.current.get(entry.folder) ?? mintRequestId();
    rids.current.set(entry.folder, rid);
    setRow(entry.folder, { kind: "busy" });
    try {
      await onAdd({ rid, url: reply.url, folder: entry.folder, commit: reply.commit });
      rids.current.delete(entry.folder);
      setRow(entry.folder, { kind: "added" });
    } catch (thrown) {
      if (spendsRid(thrown)) rids.current.delete(entry.folder);
      setRow(entry.folder, { kind: "failed", line: repoFailureLine(thrown, "add", entry.name) });
    }
  }

  // Once, on mount: a later change of the link waits for a tap.
  const started = useRef(false);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    if (!readOnMount || started.current) return;
    started.current = true;
    void reader.current();
  }, [readOnMount]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    void read();
  }

  const failure = list.kind === "failed" ? list.line : problem;
  return (
    <BottomSheet open={open} onClose={onClose} title={t("settings.tricks.repo.title")}>
      <div data-slot="trick-repo-body" className="space-y-4">
        <form onSubmit={submit} noValidate className="space-y-3">
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            value={url}
            aria-label={t("settings.tricks.repo.linkLabel")}
            placeholder={t("settings.tricks.repo.placeholder")}
            onChange={(e) => {
              setUrl(e.target.value);
              setProblem(null);
            }}
            className="h-11 w-full rounded-md border border-border bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <Button type="submit" data-slot="repo-read" className="h-11 w-full" disabled={reading} aria-busy={reading || undefined}>
            <OneOf
              active={reading ? "busy" : "rest"}
              className="inline-grid place-items-center"
              options={[
                { key: "rest", node: t("settings.tricks.repo.read") },
                { key: "busy", node: <Icon name="busy" className="size-4 animate-spin" aria-hidden /> },
              ]}
            />
          </Button>
        </form>
        {failure !== null && (
          <p data-line="repo-error" role="alert" className="text-sm break-words text-destructive">
            {failure}
          </p>
        )}
        {list.kind === "list" && <RepoList reply={list.reply} rows={rows} onAdd={(entry) => void add(list.reply, entry)} />}
      </div>
    </BottomSheet>
  );
}

function RepoList({ reply, rows, onAdd }: { reply: RepoListReply; rows: ReadonlyMap<string, RowState>; onAdd: (entry: RepoListEntry) => void }) {
  return (
    <div data-slot="repo-list">
      <p data-line="repo-from" className="text-xs break-words text-muted-foreground">
        {t("settings.tricks.repo.from", { source: `${reply.host}/${reply.repo}`, commit: reply.commit.slice(0, 7) })}
      </p>
      {reply.tricks.length === 0 && (
        <p data-line="repo-empty" className="pt-3 text-sm text-muted-foreground">
          {t("settings.tricks.repo.empty")}
        </p>
      )}
      <ul className="divide-y divide-border">
        {reply.tricks.map((entry) => (
          <RepoEntryRow key={entry.folder} entry={entry} state={rows.get(entry.folder)} onAdd={() => onAdd(entry)} />
        ))}
      </ul>
    </div>
  );
}

/** One trick of the list. Every text in it is the repository's, as a text node. */
function RepoEntryRow({ entry, state, onAdd }: { entry: RepoListEntry; state: RowState | undefined; onAdd: () => void }) {
  const busy = state?.kind === "busy";
  const added = state?.kind === "added";
  return (
    <li data-folder={entry.folder} className="py-3">
      <div className="flex min-h-11 items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p data-line="name" className="font-medium break-words">
            {entry.name}
          </p>
          <div data-line="about">
            <p className="text-[11px] leading-4 text-muted-foreground">{t("settings.tricks.repo.says")}</p>
            <p className="line-clamp-2 text-sm break-words text-muted-foreground">{entry.about}</p>
          </div>
          <p data-line="folder" className="truncate font-mono text-xs text-muted-foreground">
            {entry.folder}
          </p>
        </div>
        <div data-slot="repo-entry-state" className="flex min-h-11 shrink-0 items-center">
          {entry.here ? (
            <span data-line="here" className="text-sm text-muted-foreground">
              {t("settings.tricks.repo.here")}
            </span>
          ) : added ? (
            <span data-line="added" className="text-sm text-muted-foreground">
              {t("settings.tricks.repo.added")}
            </span>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-slot="repo-add"
              aria-label={t("settings.tricks.repo.addAria", { name: entry.name })}
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={onAdd}
              // The `::before` reaches the 44px floor above and below the 32px button (DESIGN.md §6).
              className={cn(ROW_OPEN_CONTROL, "shrink-0 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']")}
            >
              <OneOf
                active={busy ? "busy" : "rest"}
                className="inline-grid place-items-center"
                options={[
                  { key: "rest", node: t("settings.tricks.repo.add") },
                  { key: "busy", node: <Icon name="busy" className="size-4 animate-spin" aria-hidden /> },
                ]}
              />
            </Button>
          )}
        </div>
      </div>
      {added && (
        <p data-line="added-hint" className="text-xs text-muted-foreground">
          {t("settings.tricks.repo.addedHint")}
        </p>
      )}
      {state?.kind === "failed" && (
        <p data-line="row-error" role="alert" className="pt-1 text-xs break-words text-destructive">
          {state.line}
        </p>
      )}
    </li>
  );
}
