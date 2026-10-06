import { navigate, on, ref, type Handle } from "remix/component";
import { Server, Star } from "lucide";

import { createWorktree, fetchFolders, listWorktrees, openWorktree, starFolder } from "@web/lib/api";
import { describeApiError, describeThrownError } from "@web/lib/api-error-message";
import { writeRefusal as hostRefusal } from "@web/lib/host-health";
import { HOST_TEXT_CLASSES, ambientSpaces, hostSlot, isMultiHost, leadHost } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import { panePath } from "@web/lib/nav";
import { scopeKey, type Scope } from "@web/lib/scope";
import { shortenHome } from "@web/lib/shorten-home";
import type { WorktreeOpenResponse, WorktreeView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { SPACE_CREATE_KEY, creating, newSpace } from "../../chips/space-actions";
import { bridgeWrite, writeRefusal } from "../../chips/writes";
import { address, config, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { kick, noteTopology } from "../../lib/polling";
import { setStatus } from "../../lib/status";
import { scheduleUpdate, useStore } from "../../lib/store";
import { href } from "../../routes";
import { holdReload, releaseReload } from "../../update/reload-hold";
import { Button } from "../../ui/button";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { ListGroup } from "../../ui/list-group";
import { SectionLabel } from "../../ui/section-label";
import { BottomSheet } from "../../ui/sheet";
import { crewHealthFor } from "./crew-health";
import { defaultHost, memberHealth } from "./crew-model";
import {
  NO_FOLDERS,
  folderName,
  hasFolders,
  visibleFolders,
  worktreeRepos,
  type FolderList,
  type WorktreeRepo,
} from "./new-space-model";

// Port of web/src/components/new-space-sheet.tsx (+ new-space-folders.tsx): create a new space.
// Both fields are optional and dictation-friendly: leave the directory blank to open the shell in the
// home dir (it is a shell, cd from there), or set a path for a specific project. The new space opens
// a fresh shell you launch your own agent in.
//
// The sheet owns no props beyond `open` and `onClose`. It reads what web/'s route handed it from the
// stores: the roster and its health from `snapshot`, the addressed machine's spaces (for the
// worktree tab's repos), the ambient scope from `address`, the multiplexer's declaration from `config`.
// The creates go through `newSpace()` (chips/space-actions.ts); the worktree verbs go through
// `bridgeWrite`, behind the same refusal check.
//
// WHERE this lands, above WHAT it is. A crew's "+" must never create silently on whichever machine
// the list happened to be pointed at, so a crew gets a host picker; solo renders none of it (the
// predicate is `isMultiHost`, the same data-not-mode rule every host surface keeps). The lead carries
// no `?h=` on the way out (absent means the lead), so a lead create keeps the bare URL.
//
// Worktree tab: only where there is a choice to make. It is offered when the multiplexer can create
// worktrees and some open space sits in a repo. Not ported: nothing of the web/ sheet is left out.
// The sheet holds the self-update reload while it is open, so a half-typed directory survives.

const RELOAD_HOLD = "new-space";

const FIELD =
  "h-11 rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const FIELD_LABEL = "text-xs font-medium text-muted-foreground";

export interface NewSpaceSheetProps {
  open: boolean;
  onClose: () => void;
}

type Mode = "space" | "worktree";

/** What the worktree verbs answer: a created pane, as a Space create does. */
function openedWorktree(res: WorktreeOpenResponse, scope: Scope): void {
  if (!res.ok) {
    setStatus(describeApiError(res), "error");
    return;
  }
  setStatus(t("space.create.ready", { what: t("space.noun.space") }), "success");
  noteTopology();
  kick();
  void navigate(href(panePath(res.pane.paneId, scope)));
}

/** Hold the one global "a space is being created" mark, as web/'s `creatingSpaceRef` does. */
function holdSpace(): boolean {
  if (creating.get().has(SPACE_CREATE_KEY)) return false;
  creating.update((s) => new Set([...s, SPACE_CREATE_KEY]));
  return true;
}

function releaseSpace(): void {
  creating.update((s) => {
    const next = new Set(s);
    next.delete(SPACE_CREATE_KEY);
    return next;
  });
}

async function worktreeVerb(scope: Scope, op: () => Promise<WorktreeOpenResponse>, holds: boolean): Promise<void> {
  const refused = writeRefusal();
  if (refused !== undefined) {
    setStatus(refused, "error");
    return;
  }
  if (holds && !holdSpace()) return;
  try {
    openedWorktree(await bridgeWrite(op), scope);
  } catch (error) {
    setStatus(describeThrownError(error), "error");
  } finally {
    if (holds) releaseSpace();
  }
}

export function NewSpaceSheet(handle: Handle<NewSpaceSheetProps>) {
  useLocale(handle);
  const snap = useStore(handle, snapshot);
  const where = useStore(handle, address);
  const cfg = useStore(handle, config);

  let label = "";
  let cwd = "";
  // Which kind of space this will be. Two tabs rather than two entry points: from the spaces list
  // there is no "current space" to carry a repo, so the worktree side has to ask which repo anyway.
  let mode: Mode = "space";
  let branch = "";
  let repo = "";
  /** The member id, never `?h=`'s spelling: the lead has a real id here and only becomes an absent
   *  `host` on the way out, which is what keeps a solo/lead URL bare. */
  let host: string | undefined;
  /** Worktrees of the chosen repo that NOTHING is showing: the only ones the phone has no other route to. */
  let unopened: readonly WorktreeView[] = [];
  let createButton: HTMLButtonElement | null = null;

  // The folder list is that machine's own (#289), read when the sheet opens and when the picker
  // moves, never polled. `read` keeps what was read with the key it was read for, so a list read for
  // one machine can never be drawn for another.
  let read: { key: string; list: FolderList } | null = null;
  let foldersAsked: string | undefined;
  /** What the list shows NOW, for a tap on a row the Collapse is still fading out. */
  let shownFolders: FolderList = NO_FOLDERS;
  let worktreesAsked: string | undefined;
  let wasOpen = false;

  handle.signal.addEventListener("abort", () => releaseReload(RELOAD_HOLD), { once: true });

  const close = (): void => handle.props.onClose();

  const loadFolders = (at: Scope, key: string): void => {
    void (async () => {
      let list: FolderList;
      try {
        list = await fetchFolders(at);
      } catch {
        // A machine on an older version answers 404 and a machine that is down answers nothing; both
        // mean no list for that machine, and the sheet renders as it did before the list existed.
        list = NO_FOLDERS;
      }
      if (handle.signal.aborted || foldersAsked !== key) return;
      read = { key, list };
      scheduleUpdate(handle);
    })();
  };

  const loadWorktrees = (workspaceId: string, scope: Scope, key: string): void => {
    void (async () => {
      let rows: readonly WorktreeView[] = [];
      try {
        // A read the operator asked for by opening this tab, not a poll.
        const res = await listWorktrees(workspaceId, scope);
        if (res.ok) rows = res.worktrees.filter((w) => w.linked && w.openWorkspaceId === null);
      } catch {
        // No list; the form still works.
      }
      if (handle.signal.aborted || worktreesAsked !== key) return;
      unopened = rows;
      scheduleUpdate(handle);
    })();
  };

  const star = (folder: string, starred: boolean, at: Scope, key: string): void => {
    void (async () => {
      const refused = writeRefusal();
      if (refused !== undefined) {
        setStatus(refused, "error");
        return;
      }
      try {
        const list = await bridgeWrite(() => starFolder(folder, starred, at));
        if (handle.signal.aborted || foldersAsked !== key) return;
        read = { key, list };
      } catch (error) {
        setStatus(describeThrownError(error), "error");
        // What is drawn must be what the machine holds: read it again.
        if (!handle.signal.aborted && foldersAsked === key) loadFolders(at, key);
        return;
      }
      scheduleUpdate(handle);
    })();
  };

  return () => {
    const { open } = handle.props;
    const body = snap().data;
    const servers = body?.servers ?? [];
    const ambient = where().scope;
    const multiHost = isMultiHost(servers);
    const health = open ? crewHealthFor(body) : crewHealthFor(undefined);

    if (open && !wasOpen) {
      label = "";
      cwd = "";
      branch = "";
      mode = "space";
      repo = "";
      read = null;
      foldersAsked = undefined;
      worktreesAsked = undefined;
      unopened = [];
      host = defaultHost(servers, health, ambient.host);
      handle.queueTask(() => holdReload(RELOAD_HOLD));
    }
    if (!open && wasOpen) {
      foldersAsked = undefined;
      worktreesAsked = undefined;
      handle.queueTask(() => releaseReload(RELOAD_HOLD));
    }
    wasOpen = open;

    if (!open) return <BottomSheet open={false} onClose={close} title={t("space.new.title")} />;

    // The worktree tab: the multiplexer must be able to create one (asked of the machine this view
    // shows; absent data reads as capable, like lib/mux-capability.ts), and some open space must sit
    // in a repo. An empty list hides the tab: a tab whose only content is "no repos" is noise.
    const canWorktree = cfg().data?.mux?.capabilities?.createWorktree !== false;
    const repos: readonly WorktreeRepo[] = canWorktree ? worktreeRepos(ambientSpaces(body?.workspaces ?? [], ambient, servers)) : [];
    // A repo that is not on the list (never chosen, or its space closed) falls to the first one. A poll
    // that reorders the list keeps the chosen repo, so a half-typed branch name survives it.
    if (!repos.some((r) => r.workspaceId === repo)) repo = repos[0]?.workspaceId ?? "";
    const worktreesOffered = repos.length > 0;
    if (mode === "worktree" && !worktreesOffered) mode = "space";

    const chosen = multiHost ? host : undefined;
    const chosenServer = servers.find((s) => s.id === chosen);
    // The refusal for the machine actually selected. A solo install has no host dimension, so there
    // is nothing to refuse and the button behaves as it always did.
    const refusal = chosenServer ? hostRefusal(memberHealth(health, chosenServer)) : undefined;
    // The scope a create is ADDRESSED to. The lead carries no `?h=`. Solo keeps the ambient scope.
    const target: Scope = multiHost ? { ...ambient, host: chosen === leadHost(servers) ? undefined : chosen } : ambient;
    const targetKey = scopeKey(target);

    if (foldersAsked !== targetKey) {
      foldersAsked = targetKey;
      handle.queueTask(() => loadFolders(target, targetKey));
    }
    const folders = read !== null && read.key === targetKey ? visibleFolders(read.list) : NO_FOLDERS;
    shownFolders = folders;

    const wtKey = mode === "worktree" && repo !== "" ? `${scopeKey(ambient)}\u0000${repo}` : undefined;
    if (wtKey === undefined) {
      if (worktreesAsked !== undefined) {
        worktreesAsked = undefined;
        unopened = [];
      }
    } else if (worktreesAsked !== wtKey) {
      worktreesAsked = wtKey;
      const askedRepo = repo;
      handle.queueTask(() => loadWorktrees(askedRepo, ambient, wtKey));
    }

    const create = (): void => {
      if (refusal !== undefined) return;
      // Solo passes nothing and keeps the ambient scope, exactly as before the picker existed.
      void newSpace({ label: label.trim() || undefined, cwd: cwd.trim() || undefined }, multiHost ? target : undefined);
      close();
    };

    /** A folder row's tap: fill the field and move to Create. Never a create by itself. */
    const fillFolder = (folder: string): void => {
      if (!isShown(shownFolders, folder)) return;
      cwd = folder;
      void handle.update();
      createButton?.focus();
    };

    const toggleStar = (folder: string, starred: boolean): void => {
      if (!isShown(shownFolders, folder)) return;
      star(folder, starred, target, targetKey);
    };

    const createWorktreeHere = (): void => {
      const name = branch.trim();
      if (name === "" || repo === "") return;
      // Addressed to the ambient scope, as web/'s `newWorktree` is.
      void worktreeVerb(ambient, () => createWorktree(repo, name, ambient), true);
      close();
    };

    const openExisting = (path: string): void => {
      void worktreeVerb(ambient, () => openWorktree(repo, path, ambient), false);
      close();
    };

    return (
      <BottomSheet open onClose={close} title={t("space.new.title")}>
        <div class="flex flex-col gap-3" data-testid="new-space-sheet">
          {/* WHERE this lands, above WHAT it is. */}
          {multiHost && (
            <div class="flex flex-col gap-1" data-testid="new-space-host">
              <span id="new-space-host" class={FIELD_LABEL}>
                {t("space.new.host.label")}
              </span>
              <div
                role="radiogroup"
                aria-labelledby="new-space-host"
                // Same ground and selected mark as the tab strip below, because it is the same
                // question shape; scrolls sideways rather than wrapping, so a nine-machine crew keeps
                // one row. `min-h-11` per D §6, a floor rather than a height.
                class="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1"
              >
                {servers.map((s) => {
                  const reason = hostRefusal(memberHealth(health, s));
                  const slot = hostSlot(servers, s.id);
                  const selected = chosen === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      data-host={s.id}
                      aria-checked={selected ? "true" : "false"}
                      // `aria-disabled`, not `disabled`: a member that cannot take writes is still
                      // LISTED (CREW_PROTOCOL.md §10.2) and reachable by a screen reader, which is how
                      // the reason gets read out at all.
                      aria-disabled={reason !== undefined ? "true" : undefined}
                      aria-label={reason}
                      title={reason}
                      class={cn(
                        "flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
                        selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                        reason !== undefined && "opacity-50",
                      )}
                      mix={on("click", () => {
                        if (reason !== undefined) return;
                        host = s.id;
                        void handle.update();
                      })}
                    >
                      {/* The tint lands on the GLYPH ONLY (D §4), and the name is always drawn beside
                          it: the chip is never colour alone. */}
                      <Icon icon={Server} class={cn("size-3.5 shrink-0", slot === null ? "text-muted-foreground" : HOST_TEXT_CLASSES[slot])} />
                      <span class="truncate">{s.name || s.id}</span>
                    </button>
                  );
                })}
              </div>
              {/* Only reachable when NO member is taking writes: every other machine is selectable,
                  so the default already moved off a refusing one. In flow, hence Collapse. */}
              <Collapse open={refusal !== undefined}>
                {refusal !== undefined ? <p class="pt-1 text-[11px] leading-tight text-status-blocked">{refusal}</p> : null}
              </Collapse>
            </div>
          )}

          {/* Only where there is a choice to make: one tab is not a tab strip, it is noise. */}
          {worktreesOffered && (
            <div role="tablist" class="flex gap-1 rounded-lg bg-muted p-1">
              {(["space", "worktree"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  data-mode={option}
                  aria-selected={mode === option ? "true" : "false"}
                  class={cn(
                    // min-h, never h: the floor stands above whatever the label needs, so a longer
                    // translation grows the strip rather than being clipped (D §6).
                    "min-h-11 flex-1 rounded-md px-3 text-sm font-medium transition-colors",
                    mode === option ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                  mix={on("click", () => {
                    mode = option;
                    void handle.update();
                  })}
                >
                  {option === "space" ? t("space.new.tab.plain") : t("space.new.tab.worktree")}
                </button>
              ))}
            </div>
          )}

          {mode === "worktree" && worktreesOffered ? (
            <>
              <label class="flex flex-col gap-1">
                <span class={FIELD_LABEL}>{t("space.new.repo.label")}</span>
                <select
                  data-testid="new-space-repo"
                  class={FIELD}
                  mix={on("change", (event) => {
                    repo = event.currentTarget.value;
                    void handle.update();
                  })}
                >
                  {repos.map((candidate) => (
                    <option key={candidate.workspaceId} value={candidate.workspaceId} selected={candidate.workspaceId === repo}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </label>
              <label class="flex flex-col gap-1">
                <span class={FIELD_LABEL}>{t("worktree.branchLabel")}</span>
                <input
                  value={branch}
                  placeholder={t("worktree.branchPlaceholder")}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  class={cn(FIELD, "font-mono")}
                  mix={on("input", (event) => {
                    branch = event.currentTarget.value;
                    void handle.update();
                  })}
                />
              </label>
              <Button class="mt-1 h-11" disabled={branch.trim() === ""} mix={on("click", createWorktreeHere)}>
                {t("worktree.create")}
              </Button>
              {/* This list arrives from a read that runs when the repo is chosen, so it appears in
                  flow under the button: Collapse only (D §1). */}
              <Collapse open={unopened.length > 0}>
                <div class="flex flex-col gap-1 border-t border-border pt-3">
                  <span class={FIELD_LABEL}>{t("worktree.orOpenExisting")}</span>
                  {unopened.map((worktree) => (
                    <button
                      key={worktree.path}
                      type="button"
                      class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-accent"
                      mix={on("click", () => openExisting(worktree.path))}
                    >
                      <span class="min-w-0 flex-1 truncate font-medium">{worktree.branch ?? t("worktree.detached")}</span>
                      <span class="shrink-0 text-xs text-muted-foreground">{t("worktree.open")}</span>
                    </button>
                  ))}
                </div>
              </Collapse>
            </>
          ) : (
            <>
              <label class="flex flex-col gap-1">
                <span class={FIELD_LABEL}>{t("space.new.dir.label")}</span>
                <input
                  value={cwd}
                  placeholder={t("space.new.dir.placeholder")}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-testid="new-space-dir"
                  class={cn(FIELD, "font-mono")}
                  mix={on("input", (event) => {
                    cwd = event.currentTarget.value;
                    void handle.update();
                  })}
                />
              </label>
              <FolderSections folders={folders} onUse={fillFolder} onStar={toggleStar} />
              <label class="flex flex-col gap-1">
                <span class={FIELD_LABEL}>{t("space.new.label.label")}</span>
                <input
                  value={label}
                  placeholder={t("space.new.label.placeholder")}
                  data-testid="new-space-label"
                  class={FIELD}
                  mix={on("input", (event) => {
                    label = event.currentTarget.value;
                    void handle.update();
                  })}
                />
              </label>
              <Button
                class="mt-1 h-11"
                data-testid="new-space-create"
                disabled={refusal !== undefined}
                mix={[
                  ref((node: HTMLButtonElement) => {
                    createButton = node;
                  }),
                  on("click", create),
                ]}
              >
                {t("space.new.create")}
              </Button>
            </>
          )}
        </div>
      </BottomSheet>
    );
  };
}

/** Whether a folder is on the list drawn right now (a tap on a row mid-fade must not reach another machine's field). */
function isShown(list: FolderList, folder: string): boolean {
  return list.recent.includes(folder) || list.favourites.includes(folder);
}

// ── Favourites and Recent (web/src/components/new-space-folders.tsx) ──────────────────────────────
//
// Directly under the Directory field, for the machine the host picker chose. A row FILLS the field
// and creates nothing, so the operator can still set a label, and a folder that has since gone is one
// more tap from being noticed rather than a surprise create. The star beside it moves the folder
// between the two lists.
//
// Both lines of a row are mono: a folder is a machine-authored identifier (D §5). The name is the last
// segment; the path under it, shortened against THAT machine's home, tells two `web` folders apart.
//
// EVERY APPEARANCE IS A COLLAPSE (D §11 rule 1): the block arrives from a read the operator caused by
// opening the sheet or picking a machine, and one section can appear or leave on a star. With nothing
// stored for the chosen machine the block renders nothing.
interface FolderSectionsProps {
  folders: FolderList;
  /** Fill the Directory field with this folder. Never a create. */
  onUse: (folder: string) => void;
  /** Star (`true`) or unstar (`false`) one folder of this machine. */
  onStar: (folder: string, starred: boolean) => void;
}

function FolderSections(handle: Handle<FolderSectionsProps>) {
  useLocale(handle);
  return () => {
    const { folders, onUse, onStar } = handle.props;
    return (
      <Collapse open={hasFolders(folders)}>
        <div class="flex flex-col gap-3" data-testid="new-space-folders">
          <FolderSection
            title={t("space.new.folders.favourites")}
            rows={folders.favourites}
            starred
            home={folders.home}
            onUse={onUse}
            onStar={onStar}
          />
          <FolderSection
            title={t("space.new.folders.recent")}
            rows={folders.recent}
            starred={false}
            home={folders.home}
            onUse={onUse}
            onStar={onStar}
          />
        </div>
      </Collapse>
    );
  };
}

interface FolderSectionProps {
  title: string;
  rows: readonly string[];
  /** Whether every row here is a favourite, which is what the star says. */
  starred: boolean;
  home: string;
  onUse: (folder: string) => void;
  onStar: (folder: string, starred: boolean) => void;
}

/** One labelled list: "Favourites, list, 3 items" to a screen reader. Absent when it has no rows. */
function FolderSection(handle: Handle<FolderSectionProps>) {
  const id = `folders-${String(handle.id)}`;
  return () => {
    const { title, rows, starred, home, onUse, onStar } = handle.props;
    return (
      <Collapse open={rows.length > 0}>
        <div>
          <SectionLabel id={id} placement="above">
            {title}
          </SectionLabel>
          <ListGroup as="ul" aria-labelledby={id}>
            {rows.map((folder) => {
              const shown = shortenHome(folder, home);
              return (
                <li key={folder} class="flex items-stretch">
                  <button
                    type="button"
                    aria-label={t("space.new.folders.use", { path: shown })}
                    class="flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1.5 pl-3.5 text-left font-mono transition-colors active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    mix={on("click", () => onUse(folder))}
                  >
                    <span class="truncate text-sm">{folderName(folder)}</span>
                    <span class="truncate text-xs text-muted-foreground">{shown}</span>
                  </button>
                  {/* 44px square, the star 16px inside it: a pressed star FILLS, it never grows, so
                      the row's text holds its x whichever list it is in (D §2). */}
                  <button
                    type="button"
                    aria-pressed={starred ? "true" : "false"}
                    aria-label={starred ? t("space.new.folders.unstar", { folder: shown }) : t("space.new.folders.star", { folder: shown })}
                    class="flex size-11 shrink-0 items-center justify-center text-muted-foreground transition-colors active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    mix={on("click", () => onStar(folder, !starred))}
                  >
                    <Icon icon={Star} class={cn("size-4", starred && "fill-current text-foreground")} />
                  </button>
                </li>
              );
            })}
          </ListGroup>
        </div>
      </Collapse>
    );
  };
}
