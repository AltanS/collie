import { TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Select } from "@/components/ui/select";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { CommandOption } from "@/lib/new-page";

// THE SHELL HALF OF THE NEW PAGE'S WHAT-TO-START (ADR 0095): the Command select and what hangs off it.
// "Just a shell" and the configured rows, then a "Recent" group with the machine's one-off history,
// then "Type a command…". The select's list is `commandOptions()`'s (lib/new-page.ts); this draws it.
//
// Two rows can sit under the select, and each is reserved only while its option is chosen, so the
// choice itself is the only thing that moves the page (DESIGN.md §2):
//   - "Type a command…" chosen: one text field for the line, Enter starts;
//   - a Recent entry chosen: "Remove from history" and "Clear history" (the second behind a confirm).
// The component owns the confirm sheet and nothing else: the page keeps the line, the history and the
// start, and the playground mounts this with fixtures.

/** The text field's row and what it needs. */
export interface TypedLine {
  line: string;
  onLine: (line: string) => void;
  /** Enter was pressed in the field: start. */
  onGo: () => void;
}

/** The history actions' row and what they need. */
export interface RecentActions {
  /** A history write is in flight: both actions wait. */
  busy: boolean;
  onRemove: () => void;
  onClear: () => void;
}

export interface CommandPickerProps {
  options: readonly CommandOption[];
  /** The chosen option's key. */
  value: string;
  onChoose: (key: string) => void;
  /** Set while "Type a command…" is chosen. */
  typed: TypedLine | null;
  /** Set while a Recent entry is chosen. */
  recent: RecentActions | null;
}

// A text link on its own line owes the same 44px floor as a button (DESIGN.md §6).
const LINK =
  "inline-flex min-h-11 items-center text-xs underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";

export function CommandPicker({ options, value, onChoose, typed, recent }: CommandPickerProps) {
  useLocale();
  const [confirming, setConfirming] = useState(false);
  const rows = options.filter((o) => o.group === "rows");
  const history = options.filter((o) => o.group === "recent");
  const typeOption = options.find((o) => o.group === "typed");
  return (
    <div className="flex flex-col">
      <Select
        aria-label={t("newPage.kind.command")}
        value={value}
        lead={<TerminalSquare className="size-4" />}
        onChange={(event) => onChoose(event.target.value)}
      >
        {rows.map((o) => (
          <option key={o.key} value={o.key} disabled={o.disabled}>
            {o.text}
          </option>
        ))}
        {history.length > 0 && (
          <optgroup label={t("newPage.recent.group")}>
            {history.map((o) => (
              <option key={o.key} value={o.key} disabled={o.disabled}>
                {o.text}
              </option>
            ))}
          </optgroup>
        )}
        {typeOption !== undefined && (
          <option value={typeOption.key} disabled={typeOption.disabled}>
            {typeOption.text}
          </option>
        )}
      </Select>
      <Collapse open={typed !== null}>{typed !== null ? <TypedField typed={typed} /> : null}</Collapse>
      <Collapse open={recent !== null}>
        {recent !== null ? (
          <div className="flex flex-wrap items-center gap-x-4">
            <button type="button" className={LINK} disabled={recent.busy} onClick={recent.onRemove}>
              {t("newPage.recent.remove")}
            </button>
            <button type="button" className={LINK} disabled={recent.busy} onClick={() => setConfirming(true)}>
              {t("newPage.recent.clear")}
            </button>
          </div>
        ) : null}
      </Collapse>
      {/* Outside both Collapses: a sheet is `fixed`, and the clip of a closing row must not hold it. */}
      <BottomSheet open={confirming} onClose={() => setConfirming(false)} title={t("newPage.recent.clear.title")}>
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("newPage.recent.clear.body")}</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={() => setConfirming(false)}>
              {t("dialog.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11 flex-1"
              disabled={recent === null || recent.busy}
              onClick={() => {
                setConfirming(false);
                recent?.onClear();
              }}
            >
              {t("newPage.recent.clear")}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}

/**
 * The line field: monospace, and every correction the keyboard offers turned off, since a command is
 * not prose. "go" on the return key says what Enter does here. It takes focus when it appears, which
 * is the person's own choice of the option, from an effect and not `autoFocus` (the attribute acts only
 * on the first mount of the page).
 */
function TypedField({ typed }: { typed: TypedLine }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <div className="flex flex-col gap-1 pt-2">
      <input
        ref={input}
        type="text"
        value={typed.line}
        onChange={(e) => typed.onLine(e.target.value)}
        onKeyDown={(e) => {
          // A key that confirms an IME composition is not "go".
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            typed.onGo();
          }
        }}
        aria-label={t("newPage.typed.label")}
        placeholder="make test"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        className="h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <p className="text-[11px] leading-tight text-muted-foreground">{t("newPage.typed.note")}</p>
    </div>
  );
}
