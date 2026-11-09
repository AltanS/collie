import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons/icon";

import { AgentIcon } from "@/components/agent-icon";
import { NoPromptsBadge } from "@/components/no-prompts-badge";
import { Badge } from "@/components/ui/badge";
import { Collapse } from "@/components/ui/collapse";
import { LIST_ROW_CORNERS, ListGroup } from "@/components/ui/list-group";
import { Notice } from "@/components/ui/notice";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useNoPromptsGuard } from "@/hooks/use-no-prompts-guard";
import type { StartAsk, StartOutcome } from "@/hooks/use-spaces";
import type { StartWhat } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { LaunchersState } from "@/lib/launchers";
import { newPath } from "@/lib/nav";
import { unavailableText } from "@/lib/new-page";
import { launchersLoaded, sheetRows, type SheetRow } from "@/lib/new-tab-sheet";
import type { Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
import { cn } from "@/lib/utils";
import { mintRequestId } from "@/lib/worktree-name";

// THE NEW TAB SHEET (M91 spec 01, ADR 0131). Behind the "+" of a workspace's tab row and of a dashboard
// heading: the machine's launcher rows, then "Just a shell", then "More options". A tap opens a new tab in
// that workspace, in its folder, running the row, and the phone steps into it.
//
// IT STARTS THROUGH THE NEW PAGE'S ONE START (`useSpaceActions().start`, passed in by the caller so its
// write gates are the caller's): `beside` names a pane of the workspace, so the bridge opens a TAB beside
// it and takes that pane's folder. A row with a pinned folder runs there, and says so. "Just a shell" goes
// through the legacy tab create, `api.createTab` with no folder, which is what the "+" always sent.
//
// ONE START AT A TIME. While one is in flight the tapped row spins and every row is inert. A refusal stays
// in the open sheet as a notice. An outcome nobody can confirm (`unknown`) stays too, with the New page's
// words, and a second tap on that row resends the SAME request id, so a start that did run lands on its
// receipt instead of opening a second tab (ADR 0091). Any other row mints a fresh id.
//
// A ROW THAT SKIPS PERMISSION PROMPTS is confirmed first, by the one guard every launch path uses (ADR 0094).

export interface NewTabBeside {
  /** A pane of the workspace: the bridge opens the tab beside it, in its folder. */
  paneId: string;
  workspaceId: string;
  /** That pane's folder, shown under the title. */
  cwd: string;
}

export interface NewTabSheetProps {
  open: boolean;
  onClose: () => void;
  /** The workspace's name, for the title. */
  label: string;
  beside: NewTabBeside;
  /** The workspace's machine and session: where the start is sent and the phone steps. */
  scope: Scope | undefined;
  /** That machine's launcher list (`useLaunchers(scope)`). */
  launchers: LaunchersState;
  start: (ask: StartAsk, at?: Scope) => Promise<StartOutcome>;
}

const SHELL_KEY = "shell";

// `shell`: the outcome of "Just a shell" is unknown. That row is the plain create, which carries no request id,
// so its notice promises no safe retry.
type SheetNotice = { kind: "refused"; message: string } | { kind: "unknown"; shell: boolean };

export function NewTabSheet({ open, onClose, label, beside, scope, launchers, start }: NewTabSheetProps) {
  useLocale();
  const nav = useNav();
  const { guard, sheet: noPromptsSheet } = useNoPromptsGuard();
  const loaded = launchersLoaded(launchers, scope);
  const rows = sheetRows(launchers, scope);
  const home = loaded ? launchers.home : "";

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<SheetNotice | null>(null);
  // The request id of the last start nobody could confirm, kept for a retry of the same row.
  const unknownAsk = useRef<{ key: string; id: string } | null>(null);
  // A new opening starts clean: no notice from the last workspace, no retry id. The opening counter
  // lets a start that finishes after its sheet closed (Escape, the backdrop, a drag while it was in
  // flight) say nothing into the next opening. It guards a caller that keeps the sheet mounted (its
  // tests, the playground); `useNewTabOrSheet` unmounts it on close and guards with its own `close`.
  const opening = useRef(0);
  useEffect(() => {
    if (open) return;
    opening.current += 1;
    setNotice(null);
    unknownAsk.current = null;
  }, [open]);

  async function run(key: string, what: StartWhat, rowHarness: string | undefined) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyKey(key);
    setNotice(null);
    const requestId = unknownAsk.current?.key === key ? unknownAsk.current.id : mintRequestId();
    const ask: StartAsk = { what, requestId, beside: { paneId: beside.paneId, workspaceId: beside.workspaceId } };
    if (rowHarness !== undefined) ask.rowHarness = rowHarness;
    if (what.kind === "shell") ask.legacyShell = true;
    const startedIn = opening.current;
    const outcome = await start(ask, scope);
    busyRef.current = false;
    setBusyKey(null);
    // Closed while it ran: a `done` has already moved the phone, and anything else belongs to a sheet
    // that is gone.
    if (opening.current !== startedIn) return;
    if (outcome.kind === "done") {
      unknownAsk.current = null;
      onClose();
      return;
    }
    if (outcome.kind === "unknown") {
      const shell = what.kind === "shell";
      // Only a start by id can be retried safely: the plain create has no receipt to land on.
      unknownAsk.current = shell ? null : { key, id: requestId };
      setNotice({ kind: "unknown", shell });
      return;
    }
    unknownAsk.current = null;
    // An empty refusal is a second start the hook turned away: the first one is already on screen.
    if (outcome.message !== "") setNotice({ kind: "refused", message: outcome.message });
  }

  function tapRow(row: SheetRow) {
    if (busyRef.current || row.unavailable !== null) return;
    // An agent row's harness rides along so the new pane knows what is starting; a command row has none.
    const rowHarness = row.what.kind === "row" ? row.harness : undefined;
    guard({
      item: row,
      machine: scope?.host ?? "",
      folder: shortenHome(row.cwd ?? beside.cwd, home),
      go: () => void run(row.key, row.what, rowHarness),
    });
  }

  function more() {
    onClose();
    nav.down(newPath({ machine: scope?.host, beside: beside.paneId, session: scope?.session }));
  }

  const busy = busyKey !== null;
  const folder = shortenHome(beside.cwd, home);
  return (
    <>
      <BottomSheet open={open} onClose={onClose} title={t("newTab.title", { workspace: label })}>
        <div data-slot="new-tab-sheet" aria-busy={busy || undefined} className="flex flex-col gap-3">
          <p className="-mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="folder-open" aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-mono">{t("newTab.folder", { folder })}</span>
          </p>
          <Collapse open={notice !== null}>
            {notice === null ? null : notice.kind === "refused" ? (
              <Notice tone="danger" variant="box" announce="alert">
                {notice.message}
              </Notice>
            ) : (
              <Notice tone="caution" variant="box" announce="status">
                {notice.shell ? t("newTab.shellUnknown") : t("newPage.unknown")}
              </Notice>
            )}
          </Collapse>
          {!loaded ? (
            <p data-slot="new-tab-loading" role="status" className="text-xs text-muted-foreground">
              {t("newTab.loading")}
            </p>
          ) : null}
          <RowGroup label={t("newTab.group.agents")} rows={rows.agents} busyKey={busyKey} home={home} onTap={tapRow} />
          <RowGroup label={t("newTab.group.commands")} rows={rows.commands} busyKey={busyKey} home={home} onTap={tapRow} />
          <ListGroup>
            <SheetButton
              icon={<Icon name="new-shell" aria-hidden className="size-5 text-muted-foreground" />}
              label={t("newPage.shell.option")}
              disabled={busy}
              spinning={busyKey === SHELL_KEY}
              onClick={() => void run(SHELL_KEY, { kind: "shell" }, undefined)}
            />
            <SheetButton
              icon={<Icon name="row-go" aria-hidden className="size-5 text-muted-foreground" />}
              label={t("newTab.more")}
              disabled={busy}
              spinning={false}
              onClick={more}
            />
          </ListGroup>
        </div>
      </BottomSheet>
      {noPromptsSheet}
    </>
  );
}

function RowGroup({
  label,
  rows,
  busyKey,
  home,
  onTap,
}: {
  label: string;
  rows: readonly SheetRow[];
  busyKey: string | null;
  home: string;
  onTap: (row: SheetRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col">
      <SectionLabel placement="above">{label}</SectionLabel>
      <ListGroup>
        {rows.map((row) => (
          <SheetButton
            key={row.key}
            icon={
              row.harness !== undefined ? (
                <AgentIcon agent={row.harness} className="size-5 rounded-sm" />
              ) : (
                <Icon name="new-shell" aria-hidden className="size-5 text-muted-foreground" />
              )
            }
            label={row.label}
            detail={rowDetail(row, home)}
            badges={
              <>
                {row.noPrompts ? <NoPromptsBadge /> : null}
                {row.fromLead ? <Badge variant="outline">{t("newTab.fromLead")}</Badge> : null}
              </>
            }
            mono={row.unavailable === null && row.cwd === undefined && row.command !== undefined}
            disabled={busyKey !== null || row.unavailable !== null}
            spinning={busyKey === row.key}
            onClick={() => onTap(row)}
          />
        ))}
      </ListGroup>
    </section>
  );
}

/** The row's second line: why it cannot start, else where it always runs, else the line it types. */
function rowDetail(row: SheetRow, home: string): string | undefined {
  if (row.unavailable !== null) return unavailableText(row.unavailable);
  if (row.cwd !== undefined) return t("newPage.where.pinned", { folder: shortenHome(row.cwd, home) });
  return row.command;
}

function SheetButton({
  icon,
  label,
  detail,
  badges,
  mono = false,
  disabled,
  spinning,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string | undefined;
  badges?: ReactNode;
  /** The detail is a command line, set in mono. */
  mono?: boolean;
  disabled: boolean;
  spinning: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={spinning || undefined}
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition-colors hover:bg-muted/50 active:bg-muted disabled:opacity-50",
        // The tapped row stays at full ink while it spins: it is the one thing happening.
        spinning && "disabled:opacity-100",
        LIST_ROW_CORNERS,
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{label}</span>
          {badges}
        </span>
        {detail !== undefined ? (
          <span className={cn("truncate text-[11px] leading-tight text-muted-foreground", mono && "font-mono")}>{detail}</span>
        ) : null}
      </span>
      {/* A reserved slot, so the spinner coming and going moves nothing (DESIGN.md §2). */}
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
        {spinning ? <Icon name="busy" className="size-4 animate-spin" /> : null}
      </span>
    </button>
  );
}
