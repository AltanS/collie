import { navigate, on, type Handle } from "remix/component";
import { ChevronRight } from "lucide";

import { paneScope } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import { spaceChangesPath } from "@web/lib/nav";
import type { WorkspaceGroup } from "@web/lib/pane-groups";
import type { Scope } from "@web/lib/scope";
import type { ServerSummary, SessionSummary } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import {
  countArrival,
  countFor,
  countSignature,
  targetsIdentity,
  watchChangeCounts,
  type ChangeCountWatch,
  type ChangesLookup,
  type WorkspaceChangeCount,
  type WorkspaceChangeTarget,
} from "../../lib/change-counts";
import { glideForward } from "../../lib/glide";
import { useLocale } from "../../lib/i18n-store";
import { scheduleUpdate } from "../../lib/store";
import { href } from "../../routes";
import { Icon } from "../../ui/icon";
import { ListGroup } from "../../ui/list-group";

// The Files tab's body (ADR 0066, ADR 0085), ported from web/src/routes/home.tsx's ChangesTabBody,
// web/src/components/workspace-changes-list.tsx and change-count.tsx. One row per workspace the
// dashboard shows, its uncommitted change count read every 5 s while the tab is up
// (lib/change-counts.ts), and a tap that glides into `/space/:id/changes` (the `changes` pair: the
// label and the count). Mounted only while the tab is selected, so the reads stop with it.

export interface WorkspaceChangesRow extends WorkspaceChangeTarget {
  label: string;
}

export interface FilesTabProps {
  groups: readonly WorkspaceGroup[];
  scope: Scope;
  servers: readonly ServerSummary[] | undefined;
  sessions: readonly SessionSummary[] | undefined;
  lookup: ChangesLookup;
}

function rowsOf(p: FilesTabProps): WorkspaceChangesRow[] {
  return p.groups.flatMap((g) => {
    const first = g.panes[0];
    if (first === undefined) return [];
    return [{ key: g.key, label: g.label, workspaceId: first.workspaceId, scope: paneScope(p.scope, first, p.servers, p.sessions) }];
  });
}

export function FilesTab(handle: Handle<FilesTabProps>) {
  useLocale(handle);
  let rows: WorkspaceChangesRow[] = [];
  let lookup: ChangesLookup = { depth: 0, nested: false };
  let identity = "";
  let watch: ChangeCountWatch | null = null;
  return () => {
    rows = rowsOf(handle.props);
    const nextLookup = handle.props.lookup;
    const nextIdentity = `${targetsIdentity(rows)}\u0003${nextLookup.depth}\u0003${String(nextLookup.nested)}`;
    lookup = nextLookup;
    if (watch === null) {
      identity = nextIdentity;
      watch = watchChangeCounts(
        () => rows,
        () => lookup,
        () => scheduleUpdate(handle),
        handle.signal,
      );
    } else if (nextIdentity !== identity) {
      identity = nextIdentity;
      watch.retarget();
    }
    const counts = watch.counts();
    return (
      <ListGroup as="ul" aria-label={t("home.changes.listAria")} data-testid="files-tab">
        {rows.map((row) => {
          const count = countFor(counts, row.key);
          const quiet = count.kind === "clean" || count.kind === "no-folder";
          const to = spaceChangesPath(row.workspaceId, row.scope);
          return (
            <li key={row.key}>
              <button
                type="button"
                data-testid="files-row"
                data-glide-origin="changes"
                data-glide-key={to}
                mix={on("click", (event) => {
                  const from = event.currentTarget;
                  glideForward("changes", to, () => void navigate(href(to)), from);
                })}
                class={cn(
                  "count-row flex min-h-13 w-full items-center gap-3 px-3.5 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  quiet && "opacity-60",
                )}
              >
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                  <span data-glide="label" class="max-w-full self-start truncate text-sm font-medium leading-5">
                    {row.label}
                  </span>
                  <span class="flex h-4 items-center text-xs leading-4 text-muted-foreground tabular-nums">
                    <ChangeCountSlot count={count} glide="count" />
                  </span>
                </span>
                <Icon icon={ChevronRight} class="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ListGroup>
    );
  };
}

function countText(count: Exclude<WorkspaceChangeCount, { kind: "loading" }>) {
  switch (count.kind) {
    case "clean":
      return t("home.changes.clean");
    case "no-folder":
      return t("home.changes.noFolder");
    case "unavailable":
      return t("home.changes.unavailable");
    case "changed":
      return (
        <span class="flex items-center gap-2">
          <span>{tn("home.changes.files", count.files)}</span>
          <span class="font-mono text-[11px]">
            <span class="text-status-done">+{count.added}</span> <span class="text-status-blocked">−{count.removed}</span>
          </span>
        </span>
      );
  }
}

/**
 * One count line in a fixed 16 px slot: the skeleton pulses while loading and fades out under the
 * first number (`count-arrive`); a later change plays `count-update` once. The keyframes are web/'s
 * (index.css). The arrival is decided against the signature last shown, so a poll that brings the
 * same count plays nothing.
 */
export function ChangeCountSlot(handle: Handle<{ count: WorkspaceChangeCount; glide?: "count"; class?: string }>) {
  let shown: { sig: string; how: ReturnType<typeof countArrival> } | null = null;
  return () => {
    const { count, glide } = handle.props;
    const sig = countSignature(count);
    if (shown === null) shown = { sig, how: countArrival(null, count) };
    else if (shown.sig !== sig) shown = { sig, how: countArrival(shown.sig, count) };
    const how = shown.how;
    const loading = count.kind === "loading";
    return (
      <span
        class={cn("grid h-4 items-center [grid-template-areas:'slot'] *:[grid-area:slot]", handle.props.class)}
        data-slot="count-line"
        data-state={loading ? "loading" : how}
        data-glide={glide}
      >
        <span aria-hidden="true" class={cn("count-skeleton h-2.5 w-24 rounded-full bg-muted", !loading && "count-skeleton--done")} />
        {loading ? (
          <span class="sr-only">{t("home.changes.loading")}</span>
        ) : (
          <span key={sig} class={cn(how === "arrive" && "count-arrive", how === "update" && "count-update")}>
            {countText(count)}
          </span>
        )}
      </span>
    );
  };
}
