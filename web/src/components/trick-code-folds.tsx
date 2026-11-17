import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { FoldPanel } from "@/components/ui/fold-toggle";
import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import { apiErrorFields } from "@/lib/api";
import { formatBytes } from "@/lib/files-view";
import { t } from "@/lib/i18n";
import type { WireCodeFile, WireCodeIndex, WireCodeIndexFile } from "@/lib/tricks/code-wire";
import { markWord } from "@/lib/tricks/code-words";
import { cn } from "@/lib/utils";

// "READ THE CODE": THE CODE OF A TRICK, ONE FOLD FOR EACH FILE (2026-11-17, package F), in a trick's About sheet
// (components/trick-about-sheet.tsx). What a person can read before a switch on, and after.
//
//   * The sheet asks the bridge for the INDEX when it opens: the names, the sizes and how many lines of each
//     file the text search flags. No code in it. A file's code is asked only when its fold opens, once.
//   * Every row is 44 px or more, one tap opens its fold, and the code WRAPS: a long line goes on in the rows
//     after it and nothing scrolls to the side. A line's number sits in a gutter, so a row with no number is
//     the line above going on. Monospace, as text only: React draws the string, never markdown.
//   * A line the text search flagged has a tint, the warning glyph and the kind in one word under it
//     ("Network", "Writes"): never colour alone. The sheet says once that this is a text search and that code
//     can hide more. A flag in the part of a long file that is not shown is counted in a line of words.
//   * What the bridge sends is the approved copy, masked (bridge/tricks/code-view.ts). A line the mask changed
//     shows dots or `?`, and the number of such lines is said. A binary file is a row of its name and size, with
//     no fold: there is nothing to read.
//   * A failed read says so in a muted line and changes nothing else on the sheet.

/** The reads one trick's folds make. The caller binds them to the trick; the sheet never learns a host or an id. */
export interface TrickCodeReader {
  index: () => Promise<WireCodeIndex>;
  file: (file: string) => Promise<WireCodeFile>;
}

/** Why a read failed, as the sheet words it: another machine's trick, a copy that moved, or anything else. */
type Failure = "otherMachine" | "moved" | "failed";

/** A read that failed for a reason the sheet words: what a reader throws when it knows better than the status. */
export class CodeFailure extends Error {
  readonly why: Failure;

  constructor(why: Failure) {
    super(`the code could not be read: ${why}`);
    this.why = why;
  }
}

/** The failure a thrown value is: a {@link CodeFailure}'s own, else the bridge's `error` code off the API error. */
export function failureOf<TThrown>(thrown: TThrown): Failure {
  if (thrown instanceof CodeFailure) return thrown.why;
  const code = apiErrorFields(thrown)?.error;
  if (code === "unknown-host") return "otherMachine";
  return code === "moved" ? "moved" : "failed";
}

type IndexState = { kind: "loading" } | { kind: "ready"; index: WireCodeIndex } | { kind: "failed"; why: Failure };
type FileState = { kind: "loading" } | { kind: "ready"; file: WireCodeFile } | { kind: "failed"; why: Failure };

const ROW = "flex min-h-11 w-full min-w-0 items-center gap-2 px-3.5 py-2 text-left text-sm";

/** One line of muted words under the section label. */
function Said({ line, children }: { line: string; children: string }) {
  return (
    <p data-line={line} className="py-2 text-xs break-words text-muted-foreground">
      {children}
    </p>
  );
}

/** The lines of one file: a gutter of numbers, the code wrapped, and a mark under each flagged line. */
export function CodeLines({ lines, marks }: { lines: readonly string[]; marks: readonly { line: number; kinds: readonly string[] }[] }) {
  const flagged = new Map(marks.map((mark) => [mark.line, mark.kinds]));
  const gutter = `${String(String(lines.length).length + 2)}ch`;
  return (
    <ol data-slot="trick-code-lines" className="list-none rounded-md border border-border bg-muted/40 py-2 font-mono text-xs leading-5 [font-variant-ligatures:none]">
      {lines.map((line, i) => {
        const kinds = flagged.get(i + 1);
        return (
          // The order never changes while the fold is open, and a line has no identity of its own.
          <li key={i} data-code-line={i + 1} data-flagged={kinds === undefined ? undefined : ""} className={cn("min-w-0 pr-3", kinds !== undefined && "bg-status-working/15")}>
            <div className="flex min-w-0">
              <span aria-hidden className="shrink-0 pr-2 text-right text-muted-foreground select-none" style={{ width: gutter }}>
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{line === "" ? " " : line}</span>
            </div>
            {kinds !== undefined && (
              <div data-code-marks="" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1 text-status-working" style={{ paddingLeft: gutter }}>
                <Icon name="warning" aria-hidden className="size-3.5 shrink-0" />
                {kinds.map((kind) => (
                  <span key={kind} data-mark={kind} className="font-sans font-medium">
                    {markWord(kind)}
                  </span>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function failedLine(why: Failure): string {
  if (why === "otherMachine") return t("settings.tricks.about.code.otherMachine");
  return why === "moved" ? t("settings.tricks.about.code.moved") : t("settings.tricks.about.code.failed");
}

/** What sits inside an open fold, from the file the bridge sent. */
function FileBody({ file }: { file: WireCodeFile }) {
  const lines = file.lines ?? [];
  const marksLeft = file.marksLeft ?? 0;
  const masked = file.masked ?? 0;
  const leftOut = file.leftOut ?? 0;
  return (
    <div className="space-y-1.5 px-3.5 pb-3">
      {lines.length === 0 ? <Said line="code-empty">{t("settings.tricks.about.code.empty")}</Said> : <CodeLines lines={lines} marks={file.marks ?? []} />}
      {leftOut > 0 && <Said line="code-left-out">{t("settings.tricks.about.code.leftOut", { size: formatBytes(leftOut) })}</Said>}
      {marksLeft > 0 && <Said line="code-marks-left">{t("settings.tricks.about.code.marksLeft", { n: marksLeft })}</Said>}
      {masked > 0 && <Said line="code-masked">{t("settings.tricks.about.code.masked", { n: masked })}</Said>}
    </div>
  );
}

/** One text file: its row, and its fold, which asks for the code the first time it opens. */
function CodeFold({ fact, read }: { fact: WireCodeIndexFile; read: (file: string) => Promise<WireCodeFile> }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FileState | null>(null);
  const id = useId();
  const asked = useRef(false);
  const load = async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", file: await read(fact.file) });
    } catch (thrown) {
      setState({ kind: "failed", why: failureOf(thrown) });
    }
  };
  const toggle = () => {
    setOpen((was) => !was);
    if (asked.current) return;
    asked.current = true;
    void load();
  };
  return (
    <li data-code-file={fact.file}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-slot="trick-code-toggle"
        onClick={toggle}
        className={cn(ROW, "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
      >
        <span className="min-w-0 flex-1 font-mono text-xs break-all">{fact.file}</span>
        {fact.flagged > 0 && (
          <span data-line="flagged" className="flex shrink-0 items-center gap-1 text-xs text-status-working">
            <Icon name="warning" aria-hidden className="size-3.5" />
            {t("settings.tricks.about.code.flagged", { n: fact.flagged })}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(fact.size)}</span>
        <Icon name="expand" aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      <FoldPanel id={id} open={open} data-slot="trick-code">
        {state?.kind === "loading" && <Said line="code-loading">{t("settings.tricks.about.code.loading")}</Said>}
        {state?.kind === "failed" && <Said line="code-failed">{failedLine(state.why)}</Said>}
        {state?.kind === "ready" && <FileBody file={state.file} />}
      </FoldPanel>
    </li>
  );
}

/** A binary file: a row of its name and size and no fold, because there is nothing to read. */
function BinaryRow({ fact }: { fact: WireCodeIndexFile }) {
  return (
    <li data-code-file={fact.file} data-binary="" className={ROW}>
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-xs break-all">{fact.file}</span>
        <span className="block text-xs text-muted-foreground">{t("settings.tricks.about.code.binary")}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(fact.size)}</span>
    </li>
  );
}

/**
 * The "Read the code" section. `scope` names what the index is of (the trick, whether it is on, the version a
 * switch on approves), so the index is asked again when the row moves under an open sheet.
 */
export function TrickCodeFolds({ reader, scope }: { reader: TrickCodeReader; scope: string }) {
  useLocale();
  const [state, setState] = useState<IndexState>({ kind: "loading" });
  const held = useRef(reader);
  held.current = reader;
  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const index = await held.current.index();
        if (current) setState({ kind: "ready", index });
      } catch (thrown) {
        if (current) setState({ kind: "failed", why: failureOf(thrown) });
      }
    };
    setState({ kind: "loading" });
    void load();
    return () => {
      current = false;
    };
  }, [scope]);
  const label = t("settings.tricks.about.code.title");
  return (
    <section data-section="code" className="pt-4">
      <SectionLabel className="mb-1.5 block">{label}</SectionLabel>
      {state.kind === "loading" && <Said line="code-loading">{t("settings.tricks.about.code.loading")}</Said>}
      {state.kind === "failed" && <Said line="code-failed">{failedLine(state.why)}</Said>}
      {state.kind === "ready" && (
        <>
          <p data-line="code-copy" className="pb-2 text-xs text-muted-foreground">
            {state.index.copy === "approved" ? t("settings.tricks.about.code.approved") : t("settings.tricks.about.code.next")}
          </p>
          <ListGroup as="ul" aria-label={label}>
            {state.index.files.map((fact) => (fact.binary === true ? <BinaryRow key={`${scope}:${fact.file}`} fact={fact} /> : <CodeFold key={`${scope}:${state.index.hash}:${fact.file}`} fact={fact} read={(file) => held.current.file(file)} />))}
          </ListGroup>
          <p data-line="code-note" className="pt-2 text-xs text-muted-foreground">
            {t("settings.tricks.about.code.note")}
          </p>
        </>
      )}
    </section>
  );
}
