import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, CornerLeftUp, Folder } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { LIST_ROW_CORNERS, ListGroup } from "@/components/ui/list-group";
import { fetchFolderBrowse, type FilesAnswer } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
import type { FolderBrowseResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";

// The New page's folder browser (#467), the Browse row under Favourites and Recent. Tapping it opens
// the sub-folders of whatever the Folder field holds, read off the chosen machine through
// `GET /api/folders/browse` (bridge/folder-browse.ts). The bridge walks up to the nearest folder that
// exists and answers the rest of the text as a name filter, so `~/src/ple` lists `~/src` narrowed to
// `ple…`: the thumb list and the typeahead in one read.
//
// THE FIELD IS THE ADDRESS. Nothing here keeps its own idea of where it is: a tap on a folder, a
// crumb or Up writes that folder into the field (shortened with `~`), and the list follows the field.
// Typing in the field while the list is open reads again after a short pause, so the field stays a
// free text box. Use this folder fills the field and moves on to Start, as a Recent tap does. A text
// the bridge will not browse leaves the field alone and says so in one line.
//
// Reads only, and only while open: one read on open, one per tap, one per pause in typing. Never
// polled. Touch first: every row is 44px, and nothing here has a keyboard shortcut.

/** The pause after the last keystroke before the list reads again. */
export const BROWSE_DEBOUNCE_MS = 300;

type BrowseAnswer = FilesAnswer<FolderBrowseResponse> | { outcome: "failed" };

interface FolderBrowseProps {
  /** The Folder field's text, as typed. */
  value: string;
  /** The chosen machine's home, to shorten paths to `~`. "" before it is known. */
  home: string;
  /** The machine the page would start on: absent is this collie. */
  scope: Scope | undefined;
  /** Move the field to this text (a tap on a folder, a crumb or Up). Never a create. */
  onNavigate: (text: string) => void;
  /** Fill the field with this folder and move on to Start, as a Recent tap does. Never a create. */
  onUse: (text: string) => void;
  /** The read. The bridge's route in the app; a playground card stands in a fixed tree. */
  read?: typeof fetchFolderBrowse;
}

/** `name` under `path`, with the separator `path` already uses (a Windows member answers `\`). */
function childOf(path: string, name: string): string {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return path.endsWith(sep) ? `${path}${name}` : `${path}${sep}${name}`;
}

interface Crumb {
  label: string;
  /** The field text a tap moves to; `null` for a crumb that cannot be tapped. */
  text: string | null;
}

/**
 * The breadcrumb of `path`: `~` and each folder below it, each one tap away. A path the home does not
 * shorten (home not known yet, another spelling) is one crumb, and Up still goes up.
 */
export function browseCrumbs(path: string, home: string): Crumb[] {
  const shown = shortenHome(path, home);
  if (shown !== "~" && !shown.startsWith("~/")) return [{ label: shown, text: null }];
  const parts = shown === "~" ? [] : shown.slice(2).split("/").filter(Boolean);
  return [{ label: "~", text: "~" }, ...parts.map((label, i) => ({ label, text: `~/${parts.slice(0, i + 1).join("/")}` }))];
}

const ROW =
  "flex min-h-11 w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

export function FolderBrowse({ value, home, scope, onNavigate, onUse, read = fetchFolderBrowse }: FolderBrowseProps) {
  useLocale();
  const panelId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<BrowseAnswer | null>(null);
  // The text the next read is for when it should not wait: the open itself, and a tap.
  const immediate = useRef<string | null>(null);
  const host = scope?.host;
  const session = scope?.session;

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    const wait = immediate.current === value ? 0 : BROWSE_DEBOUNCE_MS;
    immediate.current = null;
    const load = async (): Promise<void> => {
      let got: BrowseAnswer;
      try {
        got = await read(value.trim(), { host, session }, ctrl.signal);
      } catch {
        got = { outcome: "failed" };
      }
      if (!ctrl.signal.aborted) setAnswer(got);
    };
    const timer = setTimeout(() => void load(), wait);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, value, host, session, read]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    immediate.current = value;
    setAnswer(null);
    setOpen(true);
  }

  function go(text: string) {
    immediate.current = text;
    onNavigate(text);
  }

  function use(path: string) {
    setOpen(false);
    onUse(shortenHome(path, home));
  }

  return (
    <div className="flex flex-col gap-2">
      <ListGroup>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
          className={cn(ROW, LIST_ROW_CORNERS)}
        >
          <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-sm">{t("newPage.browse")}</span>
          <ChevronDown
            aria-hidden
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
      </ListGroup>
      <Collapse open={open}>
        {open ? (
          <div id={panelId} className="flex flex-col gap-2">
            <BrowseBody answer={answer} home={home} listId={listId} onGo={go} onUse={use} />
          </div>
        ) : null}
      </Collapse>
    </div>
  );
}

interface BrowseBodyProps {
  answer: BrowseAnswer | null;
  home: string;
  listId: string;
  onGo: (text: string) => void;
  onUse: (path: string) => void;
}

/** One quiet line in the list's place: loading, or why there is no list. */
function Line({ children }: { children: string }) {
  return <p className="min-h-11 py-3 text-xs text-muted-foreground">{children}</p>;
}

function BrowseBody({ answer, home, listId, onGo, onUse }: BrowseBodyProps) {
  if (answer === null) return <Line>{t("newPage.browse.loading")}</Line>;
  switch (answer.outcome) {
    case "unknown-path":
    case "failed":
      return <Line>{t("newPage.browse.nothing")}</Line>;
    case "stale":
      return <Line>{t("newPage.browse.stale")}</Line>;
    case "not-paired":
    case "not-authorised":
      return <Line>{t("newPage.browse.refused")}</Line>;
    case "body":
      return <Listing body={answer.body} home={home} listId={listId} onGo={onGo} onUse={onUse} />;
  }
}

interface ListingProps {
  body: FolderBrowseResponse;
  home: string;
  listId: string;
  onGo: (text: string) => void;
  onUse: (path: string) => void;
}

function Listing({ body, home, listId, onGo, onUse }: ListingProps) {
  const crumbs = browseCrumbs(body.path, home);
  return (
    <>
      {/* Both lines of a path are mono: a folder is a machine-authored identifier (DESIGN.md §5). */}
      <nav aria-label={t("newPage.browse.path")} className="flex flex-wrap items-center font-mono text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={`${String(i)}:${c.label}`} className="flex items-center">
              {i > 0 ? (
                <span aria-hidden className="px-0.5 text-muted-foreground">
                  /
                </span>
              ) : null}
              {last || c.text === null ? (
                <span aria-current={last ? "location" : undefined} className="flex min-h-11 items-center px-1">
                  {c.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onGo(c.text!)}
                  className="flex min-h-11 items-center px-1 text-muted-foreground underline-offset-4 active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {c.label}
                </button>
              )}
            </span>
          );
        })}
      </nav>
      {body.filter !== "" ? (
        <p className="text-xs text-muted-foreground">{t("newPage.browse.matching", { filter: body.filter })}</p>
      ) : null}
      {body.parent !== null || body.folders.length > 0 ? (
        <ListGroup as="ul" id={listId} aria-label={t("newPage.browse.list")}>
          {body.parent !== null ? (
            <li>
              <button
                type="button"
                onClick={() => onGo(shortenHome(body.parent!, home))}
                aria-label={t("newPage.browse.upTo", { path: shortenHome(body.parent, home) })}
                className={cn(ROW, LIST_ROW_CORNERS)}
              >
                <CornerLeftUp aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm">{t("newPage.browse.up")}</span>
              </button>
            </li>
          ) : null}
          {body.folders.map((f) => {
            const shown = shortenHome(childOf(body.path, f.name), home);
            return (
              <li key={f.name}>
                <button
                  type="button"
                  onClick={() => onGo(shown)}
                  aria-label={f.git ? t("newPage.browse.openRepo", { name: f.name }) : t("newPage.browse.open", { name: f.name })}
                  className={cn(ROW, LIST_ROW_CORNERS)}
                >
                  <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{f.name}</span>
                  {/* A text badge, never a disc: a disc is a status (DESIGN.md §3). "git" is a name. */}
                  {f.git ? (
                    <Badge aria-hidden variant="outline" className="font-mono text-[11px] text-muted-foreground">
                      git
                    </Badge>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ListGroup>
      ) : null}
      {body.folders.length === 0 ? <p className="text-xs text-muted-foreground">{t("newPage.browse.empty")}</p> : null}
      {body.truncated ? <p className="text-xs text-muted-foreground">{t("newPage.browse.more")}</p> : null}
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => onUse(body.path)}>
        {t("newPage.browse.use")}
      </Button>
    </>
  );
}
