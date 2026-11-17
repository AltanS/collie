import { useEffect, useId, useState } from "react";

import { FolderBrowse } from "@/components/new-space-browse";
import { FolderSections } from "@/components/new-space-folders";
import { useCrew } from "@/components/crew-provider";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { useLocale } from "@/hooks/use-locale";
import { fetchWorktreeFolder, setWorktreeFolder } from "@/lib/api";
import { describeApiError } from "@/lib/api-error-message";
import { useFolders, type FolderList } from "@/lib/folders";
import { t } from "@/lib/i18n";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import type { Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
import { isReadOnly, type WorktreeFolderSettingResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// The "Worktree folder" card (ADR 0093 note, 2026-11-13): one folder per MACHINE where new worktrees go
// by default. Unset is Herdr's rule and shows as "Default" with the folder it resolves to; set, every
// new worktree is made in `<folder>/<repo>/<branch>`, whatever the multiplexer, and the New sheet's
// "Other folder" still picks another place for one worktree.
//
// ONE ROW PER MACHINE. The setting lives on the machine's disk, so in a crew each machine has its own
// row, read and written through that machine's scope (`?h=`); a solo install has one row and no
// machine name. Each row reads once when it mounts and redraws from the machine's answer to a save.
//
// EDITED WITH THE NEW SHEET'S FOLDER PICKER: the typed field, Favourites and Recent, and the browser.
// The bridge runs the same folder rule it runs on a parent folder (ADR 0093, points 1 to 5) when the
// folder is saved and again every time it is used, so a folder that broke since is shown here with the
// rule it breaks, and the New sheet refuses it with the same words.
//
// A SAVE'S REFUSAL IS SAID IN THE EDITOR, beside the field the person is typing in. A failed read, an
// older machine and a read-only device each have one line and no control that would fail.

type SaveAnswer = Awaited<ReturnType<typeof setWorktreeFolder>>;

/**
 * Where the card reads, writes and lists folders. The app passes nothing and the card talks to the
 * bridge; the playground passes fixed answers, so a case shows each state without a bridge behind it.
 */
export interface WorktreeFolderIo {
  read: (scope: Scope) => Promise<WorktreeFolderSettingResponse>;
  write: (dir: string | null, scope: Scope) => Promise<SaveAnswer>;
  /** The folder lists and the Browse read the editor draws. */
  folders: FolderList;
  browse: Parameters<typeof FolderBrowse>[0]["read"];
  /** A device the host would refuse a write from: the card shows the folder and no way to change it. */
  readOnly?: boolean;
  /** Open the editor at first paint, for a state that is about the editor. */
  startEditing?: boolean;
}

/** One machine the card has a row for: `scope` addresses it, `name` is shown only in a crew. */
interface MachineTarget {
  id: string;
  name: string;
  scope: Scope;
}

/** Settings card: where this machine's new worktrees go by default. */
export function WorktreeFolderControl({ io }: { io?: WorktreeFolderIo }) {
  useLocale();
  const { servers, multi } = useCrew();
  const targets: MachineTarget[] = multi
    ? servers.map((server) => ({ id: server.id, name: server.name, scope: server.isLead ? {} : { host: server.id } }))
    : [{ id: "", name: "", scope: {} }];
  return (
    <Card className="gap-0 py-0" data-testid="worktree-folder">
      <div className="flex items-start gap-3 p-4">
        <Icon name="folder" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("settings.worktreeFolder.title")}</div>
          <p className="text-sm text-muted-foreground">{t("settings.worktreeFolder.description")}</p>
        </div>
      </div>
      {targets.map((target) => (
        <MachineRow key={target.id} target={target} showName={multi} io={io} />
      ))}
    </Card>
  );
}

type Reading = { state: "loading" } | { state: "failed" } | { state: "read"; answer: WorktreeFolderSettingResponse };

function MachineRow({ target, showName, io }: { target: MachineTarget; showName: boolean; io: WorktreeFolderIo | undefined }) {
  const { scope } = target;
  const host = scope.host;
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const canWrite = io?.readOnly !== true && !isReadOnly(root?.device) && !refused;
  const [reading, setReading] = useState<Reading>({ state: "loading" });
  const [editing, setEditing] = useState(io?.startEditing === true);
  const [draft, setDraft] = useState(io?.startEditing === true ? (io.folders.favourites[0] ?? "") : "");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldId = useId();
  const listed = useFolders(scope, editing && io === undefined);
  const folders = io?.folders ?? listed.folders;
  const { star } = listed;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const answer = await (io?.read ?? fetchWorktreeFolder)({ host });
        if (live) setReading({ state: "read", answer });
      } catch {
        // An older machine answers 404 and a machine that is down answers nothing: one line says so.
        if (live) setReading({ state: "failed" });
      }
    })();
    return () => {
      live = false;
    };
  }, [host, io]);

  const answer = reading.state === "read" ? reading.answer : null;

  function open(): void {
    setDraft(answer?.dir ?? "");
    setRefusal(null);
    setEditing(true);
  }

  async function save(next: string | null): Promise<void> {
    setBusy(true);
    setRefusal(null);
    try {
      const res = await (io?.write ?? setWorktreeFolder)(next, { host });
      if (res.ok) {
        setReading({ state: "read", answer: res });
        setEditing(false);
      } else {
        setRefusal(describeApiError(res));
      }
    } catch {
      setRefusal(t("settings.worktreeFolder.failed"));
    } finally {
      setBusy(false);
    }
  }

  const shownFolder = answer?.dir ?? null;
  const home = folders.home;
  return (
    <div className="border-t border-border p-4" data-testid="worktree-folder-row" data-host={host ?? ""}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {showName ? <div className="truncate text-sm font-medium">{target.name}</div> : null}
          {reading.state === "loading" ? (
            <>
              <p className="text-sm text-muted-foreground">{t("settings.worktreeFolder.loading")}</p>
              {/* CALM LOAD: the answered row's path line, empty and unseen, so the row does not grow by it
                  when the read lands. One line of the path's own size; a long path that wraps still grows. */}
              <p aria-hidden="true" data-slot="worktree-folder-hold" className="invisible break-all font-mono text-xs">
                {"\u00a0"}
              </p>
            </>
          ) : null}
          {reading.state === "failed" ? <p className="text-sm text-muted-foreground">{t("settings.worktreeFolder.unavailable")}</p> : null}
          {answer !== null ? (
            <>
              <p className="text-sm text-muted-foreground">
                {shownFolder === null ? t("settings.worktreeFolder.default") : t("settings.worktreeFolder.set")}
              </p>
              <p className="break-all font-mono text-xs" data-testid="worktree-folder-value">
                {shownFolder ?? shortenHome(answer.fallback, home)}
              </p>
              {answer.problem !== undefined ? (
                <p role="status" className="pt-1 text-xs text-status-blocked">
                  {describeApiError(answer.problem)}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
        {answer !== null ? (
          <Button variant="outline" className="h-11 shrink-0" disabled={!canWrite || editing} onClick={open}>
            {t("settings.worktreeFolder.change")}
          </Button>
        ) : null}
        {/* The button's own height, unseen, while the read runs: the row is at least as tall as it will be. */}
        {reading.state === "loading" ? <div aria-hidden="true" data-slot="worktree-folder-hold-button" className="h-11 shrink-0" /> : null}
      </div>
      {answer !== null && !canWrite ? <p className="pt-2 text-xs text-muted-foreground">{t("settings.worktreeFolder.readOnly")}</p> : null}
      <Collapse open={editing}>
        {editing ? (
          <div className="flex flex-col gap-3 pt-3">
            <label htmlFor={fieldId} className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings.worktreeFolder.field")}</span>
              <input
                id={fieldId}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="~/trees"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </label>
            <FolderSections folders={folders} onUse={setDraft} onStar={(folder, starred) => void star(folder, starred)} />
            <FolderBrowse value={draft} home={home} scope={scope} onNavigate={setDraft} onUse={setDraft} read={io?.browse} />
            <p className={cn("min-h-4 text-xs", refusal === null ? "text-muted-foreground" : "text-status-blocked")} role="status">
              {refusal ?? t("settings.worktreeFolder.shape")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button className="h-11" disabled={busy || draft.trim() === ""} onClick={() => void save(draft.trim())}>
                {t("settings.worktreeFolder.save")}
              </Button>
              {shownFolder !== null ? (
                <Button variant="outline" className="h-11" disabled={busy} onClick={() => void save(null)}>
                  {t("settings.worktreeFolder.useDefault")}
                </Button>
              ) : null}
              <Button variant="ghost" className="h-11" disabled={busy} onClick={() => setEditing(false)}>
                {t("settings.worktreeFolder.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
      </Collapse>
    </div>
  );
}
