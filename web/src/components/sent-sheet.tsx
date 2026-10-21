import { X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { LIST_ROW_CORNERS_START, ListGroup } from "@/components/ui/list-group";
import { Notice } from "@/components/ui/notice";
import { SearchField } from "@/components/ui/search-field";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { BottomSheet } from "@/components/ui/sheet";
import { useCrew, useHostLabel } from "@/components/crew-provider";
import { type SentChoice, useSentList } from "@/hooks/use-sent-list";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useLocale } from "@/hooks/use-locale";
import { timeAgo } from "@/lib/format";
import { t, tn } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { folderLabel, sentKey } from "@/lib/sent-rows";
import type { SentEntry, SentMachine } from "@/lib/types";

// THE SENT SHEET (M61 spec 02): the shell lines a person sent through Collie, to search and to take
// back into the composer. A tap on a row puts the line in the box and closes the sheet. It never
// sends: Send is the person's own tap, and it runs the ordinary Send Protocol with a new request id.
//
// Under "All machines" a row names its machine; the other two views are one machine, and saying it
// on every row would be noise. The lines live in memory while the sheet is open (hooks/use-sent-list)
// and nowhere else.

export interface SentSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane's folder. Absent: the pane reported none, and "This folder" is not offered. */
  cwd: string | undefined;
  /** The pane's machine. */
  scope: Scope | undefined;
  /** A row was tapped: put this line in the composer. The sheet closes itself after. */
  onPick: (line: string) => void;
}

export function SentSheet({ open, onClose, cwd, scope, onPick }: SentSheetProps) {
  useLocale();
  return (
    <BottomSheet open={open} onClose={onClose} title={t("sent.title")} className="max-h-[85dvh]">
      <SentPanel cwd={cwd} scope={scope} onPick={(line) => { onPick(line); onClose(); }} />
    </BottomSheet>
  );
}

function SentPanel({ cwd, scope, onPick }: Pick<SentSheetProps, "cwd" | "scope" | "onPick">) {
  useLocale();
  const { multi, lead } = useCrew();
  const machineLabel = useHostLabel(scope?.host) ?? t("sent.thisMachine");
  const [choice, setChoice] = useState<SentChoice>(cwd === undefined ? "machine" : "folder");
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState<"forget" | "clear" | null>(null);
  const confirm = usePendingConfirm();
  const list = useSentList({ choice, cwd, query, scope, lead });
  const { view } = list;

  const options: SegmentedOption<SentChoice>[] = [
    ...(cwd === undefined ? [] : [{ value: "folder" as const, label: t("sent.scope.folder") }]),
    { value: "machine", label: t("sent.scope.machine") },
    ...(multi ? [{ value: "all" as const, label: t("sent.scope.all") }] : []),
  ];

  async function forget(entry: SentEntry) {
    setFailed((await list.forget(entry)) ? null : "forget");
  }

  async function clear() {
    if (!confirm.confirm("clear")) return;
    setFailed((await list.clear()) ? null : "clear");
  }

  return (
    <div className="flex flex-col gap-3">
      <SearchField value={query} onChange={setQuery} placeholder={t("sent.search.placeholder")} label={t("sent.search.placeholder")} />
      {options.length > 1 && <Segmented options={options} value={choice} onChange={setChoice} label={t("sent.scope.aria")} />}

      {view.phase === "ready" &&
        view.machines.map((machine) => {
          const words = machineNote(machine, view.off);
          return words === null ? null : (
            <Notice key={machine.host} tone="neutral" variant="box" announce="status">
              {words}
            </Notice>
          );
        })}
      {failed !== null && (
        <Notice tone="caution" variant="box" announce="status">
          {failed === "forget" ? t("sent.forget.error") : t("sent.clear.error")}
        </Notice>
      )}

      <Body list={list} choice={choice} query={query} onPick={onPick} onForget={forget} />

      {view.phase === "ready" && view.more && (
        <Button type="button" variant="outline" className="h-11" disabled={list.loadingMore} onClick={list.loadMore}>
          {t("sent.more")}
        </Button>
      )}
      {view.phase === "ready" && (
        <Button type="button" variant="outline" className="h-11" onClick={() => void clear()}>
          {confirm.pending === "clear" ? t("sent.clear.confirm") : t("sent.clear", { machine: machineLabel })}
        </Button>
      )}
    </div>
  );
}

/** The sentence about one machine that did not take part, or null when there is nothing to say. */
function machineNote(machine: SentMachine, bridgeOff: boolean): string | null {
  const name = machine.label;
  if (!machine.ok) {
    if (machine.reason === "old_version") return t("sent.machine.old", { machine: name });
    if (machine.reason === "timeout") return t("sent.machine.timeout", { machine: name });
    return t("sent.machine.unreachable", { machine: name });
  }
  // The bridge asked being off is said once, as the body; a member being off beside a lead that is on is said here.
  if (machine.off === true && !bridgeOff) return t("sent.machine.off", { machine: name });
  return null;
}

interface BodyProps {
  list: ReturnType<typeof useSentList>;
  choice: SentChoice;
  query: string;
  onPick: (line: string) => void;
  onForget: (entry: SentEntry) => Promise<void>;
}

function Body({ list, choice, query, onPick, onForget }: BodyProps) {
  const { view } = list;
  if (view.phase === "loading") return <Quiet role="status">{t("sent.loading")}</Quiet>;
  if (view.phase === "old") return <Quiet>{t("sent.old")}</Quiet>;
  if (view.phase === "error") {
    return (
      <div className="flex flex-col items-center gap-2 py-4">
        <p className="text-sm text-muted-foreground">{t("sent.error")}</p>
        <Button type="button" variant="outline" className="h-11" onClick={list.retry}>
          {t("sent.retry")}
        </Button>
      </div>
    );
  }
  if (view.entries.length === 0) {
    if (view.off) return <Quiet>{t("sent.off")}</Quiet>;
    return <Quiet>{query.trim() === "" ? t("sent.empty") : t("sent.empty.query", { query: query.trim() })}</Quiet>;
  }
  const labels = new Map(view.machines.map((m) => [m.host, m.label]));
  return (
    <ListGroup as="ul">
      {view.entries.map((entry) => (
        <SentRow
          key={sentKey(entry)}
          entry={entry}
          machine={choice === "all" ? (labels.get(entry.host) ?? entry.host) : null}
          onPick={onPick}
          onForget={onForget}
        />
      ))}
    </ListGroup>
  );
}

function Quiet({ children, role }: { children: string; role?: "status" }) {
  return (
    <p role={role} className="py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

interface SentRowProps {
  entry: SentEntry;
  /** The machine's name, under "All machines" only. */
  machine: string | null;
  onPick: (line: string) => void;
  onForget: (entry: SentEntry) => Promise<void>;
}

function SentRow({ entry, machine, onPick, onForget }: SentRowProps) {
  const folder = folderLabel(entry.cwd);
  return (
    <li className="flex items-stretch">
      <button
        type="button"
        onClick={() => onPick(entry.line)}
        className={`flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 px-3.5 py-2 text-left active:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${LIST_ROW_CORNERS_START}`}
      >
        <span className="truncate font-mono text-sm">{entry.line}</span>
        <span className="flex min-w-0 items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-mono" title={folder.title}>
            {folder.text}
          </span>
          {machine !== null && <span className="shrink-0">{machine}</span>}
          <span className="shrink-0">{timeAgo(entry.at)}</span>
          {entry.count > 1 && (
            <span className="shrink-0 tabular-nums" aria-label={tn("sent.times", entry.count)}>
              ×{entry.count}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        title={t("sent.forget")}
        aria-label={t("sent.forget.aria", { line: entry.line })}
        onClick={() => void onForget(entry)}
        className="grid size-11 shrink-0 place-items-center text-muted-foreground active:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <X className="size-4" aria-hidden />
      </button>
    </li>
  );
}
