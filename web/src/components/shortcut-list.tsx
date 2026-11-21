import type { ReactNode, Ref } from "react";

import { MatchText, type MatchRange } from "@/components/ui/match-text";
import { Notice } from "@/components/ui/notice";
import { SearchField } from "@/components/ui/search-field";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { ACTIONS, GROUPS, MODES, type ActionDef, type ActionGroup, type ActionId, type ModeId } from "@/lib/shortcuts/actions";
import type { ShortcutListContext } from "@/lib/shortcuts/help";
import { chordKeycaps } from "@/lib/shortcuts/parse";
import type { Binding, Keymap } from "@/lib/shortcuts/types";
import { cn } from "@/lib/utils";

// THE SHORTCUT LIST (M108, `prefix+?`). Presentational: it draws the rows the action table and the
// built keymap give it and owns nothing else. No global key listener, no open or close, no panel: the
// caller puts it in a sheet, a panel or a page and passes the filter text in and out. The rows are
// generated from `actions.ts`, so the list cannot drift from what runs (Herdr keeps its own by hand
// and it drifts).
//
// Words: all of them are en.ts keys, English only until the next translation pass
// (`PENDING_TRANSLATION`). Key caps are not translated.

/** One way to press an action: the prefix chord (empty when the binding is direct), then the key. */
export interface Combo {
  readonly viaPrefix: boolean;
  readonly prefixCaps: readonly string[];
  readonly caps: readonly string[];
}

const DEFS: readonly ActionDef<ActionId>[] = ACTIONS;

function primaryPrefix(keymap: Keymap): Keymap["prefix"][number] {
  const first = keymap.prefix[0];
  if (first === undefined) throw new Error("The keymap has no prefix chord");
  return first;
}

/** `1..9` is nine bindings: one `1–9` cap at the end of the first binding's chord. */
function collapseIndexed(input: { bindings: readonly Binding[]; keymap: Keymap }): Combo[] {
  const { bindings, keymap } = input;
  const first = bindings[0];
  const last = bindings[bindings.length - 1];
  if (first === undefined || last === undefined) return [];
  const caps = chordKeycaps({ chord: first.chord, mac: keymap.mac });
  const range = bindings.length > 1 ? `${first.index ?? ""}–${last.index ?? ""}` : (caps[caps.length - 1] ?? "");
  const prefixCaps = first.prefix ? chordKeycaps({ chord: primaryPrefix(keymap), mac: keymap.mac }) : [];
  return [{ viaPrefix: first.prefix, prefixCaps, caps: [...caps.slice(0, -1), range] }];
}

/** The ways to press an action as key caps, in the order of the keymap. Empty means unset. */
export function actionCombos(input: { keymap: Keymap; id: ActionId }): Combo[] {
  const { keymap, id } = input;
  const bindings = keymap.bindings.get(id) ?? [];
  const def = DEFS.find((candidate) => candidate.id === id);
  if (def?.indexed === true) return collapseIndexed({ bindings, keymap });
  return bindings.map((binding) => ({
    viaPrefix: binding.prefix,
    prefixCaps: binding.prefix ? chordKeycaps({ chord: primaryPrefix(keymap), mac: keymap.mac }) : [],
    caps: chordKeycaps({ chord: binding.chord, mac: keymap.mac }),
  }));
}

export interface ShortcutRow {
  readonly id: ActionId;
  readonly group: ActionGroup;
  readonly label: string;
  /** The sticky mode whose keys these are, for a row that only works inside one. */
  readonly scope: ModeId | undefined;
  readonly combos: readonly Combo[];
}

/** Every action of the table as a row, in table order. */
export function shortcutRows(keymap: Keymap): ShortcutRow[] {
  return DEFS.map((def) => ({
    id: def.id,
    group: def.group,
    label: t(def.labelKey),
    scope: def.scope,
    combos: actionCombos({ keymap, id: def.id }),
  }));
}

function modeWord(mode: ModeId): string {
  const def = MODES.find((candidate) => candidate.id === mode);
  if (def === undefined) throw new Error(`No mode ${mode}`);
  return t(def.labelKey);
}

function haystack(row: ShortcutRow): string {
  const caps = row.combos.map((combo) => [...combo.prefixCaps, ...combo.caps].join(" "));
  const group = t(GROUPS.find((candidate) => candidate.id === row.group)?.labelKey ?? "shortcuts.group.global");
  const mode = row.scope === undefined ? "" : modeWord(row.scope);
  return [row.label, row.id, group, mode, ...caps].join(" ").toLowerCase();
}

/** The rows whose words, group, mode or keys hold every word of the filter. An empty filter keeps all. */
export function filterShortcutRows(input: { rows: readonly ShortcutRow[]; query: string }): ShortcutRow[] {
  const words = input.query.toLowerCase().split(/\s+/u).filter((word) => word !== "");
  if (words.length === 0) return [...input.rows];
  return input.rows.filter((row) => {
    const text = haystack(row);
    return words.every((word) => text.includes(word));
  });
}

function labelRanges(input: { label: string; query: string }): MatchRange[] {
  const needle = input.query.trim().toLowerCase();
  if (needle === "") return [];
  const at = input.label.toLowerCase().indexOf(needle);
  return at < 0 ? [] : [[at, at + needle.length]];
}

/**
 * One key cap. Mono, because a key is a machine identifier the reader compares letter by letter
 * (DESIGN.md §5). A 2px corner, a full border and the card ground, so it reads as a key and not a chip.
 * `muted` is the prefix chord, which every row of a prefix list repeats.
 */
export function Keycap({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-card px-1 font-mono text-[11px] leading-none",
        muted ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {children}
    </kbd>
  );
}

/** A chord's caps side by side. */
export function Keycaps({ caps, muted = false }: { caps: readonly string[]; muted?: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {caps.map((cap, at) => (
        <Keycap key={`${cap}-${at}`} muted={muted}>
          {cap}
        </Keycap>
      ))}
    </span>
  );
}

function ComboCaps({ combo, isDimmed }: { combo: Combo; isDimmed: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {combo.viaPrefix && <Keycaps caps={combo.prefixCaps} muted />}
      <Keycaps caps={combo.caps} muted={isDimmed} />
    </span>
  );
}

function RowKeys({ combos, isDimmed }: { combos: readonly Combo[]; isDimmed: boolean }) {
  if (combos.length === 0) return <span className="text-xs text-muted-foreground">{t("shortcuts.list.unset")}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {combos.map((combo, at) => (
        <span key={at} className="inline-flex items-center gap-1.5">
          {at > 0 && <span aria-hidden className="text-xs text-muted-foreground">/</span>}
          <ComboCaps combo={combo} isDimmed={isDimmed} />
        </span>
      ))}
    </span>
  );
}

/** `isDimmed` is a row that does nothing on this screen: the muted ink, the keys still drawn. */
function Row({ row, query, isDimmed }: { row: ShortcutRow; query: string; isDimmed: boolean }) {
  const unset = row.combos.length === 0;
  return (
    <li className="flex min-h-9 items-center gap-4 py-1 text-sm">
      <span className="w-48 shrink-0">
        <RowKeys combos={row.combos} isDimmed={isDimmed} />
      </span>
      <span className={cn("min-w-0 flex-1 leading-snug", (unset || isDimmed) && "text-muted-foreground")}>
        <MatchText text={row.label} ranges={labelRanges({ label: row.label, query })} />
        {row.scope !== undefined && <span className="ml-2 text-[11px] text-muted-foreground">{modeWord(row.scope)}</span>}
      </span>
    </li>
  );
}

function Group({ group, rows, query }: { group: ActionGroup; rows: readonly ShortcutRow[]; query: string }) {
  const def = GROUPS.find((candidate) => candidate.id === group);
  if (def === undefined) throw new Error(`No group ${group}`);
  return (
    <section aria-label={t(def.labelKey)} className="mb-4 break-inside-avoid">
      <div className="border-b border-border pb-1">
        <SectionLabel>{t(def.labelKey)}</SectionLabel>
      </div>
      <ul className="divide-y divide-border/60">
        {rows.map((row) => (
          <Row key={row.id} row={row} query={query} isDimmed={false} />
        ))}
      </ul>
    </section>
  );
}

interface ShortcutListBaseProps {
  keymap: Keymap;
  /** The filter text. The caller owns it, so `/` and Esc stay the caller's keys. */
  query: string;
  onQueryChange: (query: string) => void;
  /** The filter field's input, so the sheet can focus it (the `/` key). */
  filterRef?: Ref<HTMLInputElement>;
  className?: string;
}

/**
 * `screen` leads with what works on the screen under the list (`available`), and ends with one section
 * of the rest. `all` is every action in its plain group, whatever the screen: the Settings row's list.
 */
export type ShortcutListProps = ShortcutListBaseProps &
  ({ context: "screen"; available: ReadonlySet<ActionId> } | { context: "all"; available?: undefined });

/** The actions of the table that are available here, then the rest. `all` has no rest. */
function splitByScreen(input: { rows: readonly ShortcutRow[]; context: ShortcutListContext; available: ReadonlySet<ActionId> | undefined }) {
  const { rows, context, available } = input;
  if (context === "all") return { here: rows, elsewhere: [] };
  if (available === undefined) throw new Error("A list in the screen context needs the available actions");
  return { here: rows.filter((row) => available.has(row.id)), elsewhere: rows.filter((row) => !available.has(row.id)) };
}

/** Every action that does nothing here, flat, in table order, in the muted ink. Keys still drawn. */
function NotHere({ rows, query }: { rows: readonly ShortcutRow[]; query: string }) {
  return (
    <section aria-label={t("shortcuts.list.notHere")} data-slot="shortcut-list-not-here" className="mb-4 break-inside-avoid">
      <div className="border-b border-border pb-1">
        <SectionLabel>{t("shortcuts.list.notHere")}</SectionLabel>
      </div>
      <ul className="divide-y divide-border/60">
        {rows.map((row) => (
          <Row key={row.id} row={row} query={query} isDimmed />
        ))}
      </ul>
    </section>
  );
}

/**
 * The list: a filter field on top, then the groups of the action table, and under them what the
 * operator's file got wrong. A binding the file left unset reads "unset". The nine `1..9` bindings of
 * an indexed action are one row. In the `screen` context the groups hold the actions that work here
 * (a group with none is left out) and one last section, "Not on this screen", holds the rest, dimmed;
 * the filter reads both parts. The diagnostics stand in a foot under the scrolling groups, so they
 * are in view whatever the filter says: they are about the file and not about a row.
 */
export function ShortcutList({ keymap, query, onQueryChange, filterRef, className, context, available }: ShortcutListProps) {
  useLocale();
  const shown = filterShortcutRows({ rows: shortcutRows(keymap), query });
  const { here, elsewhere } = splitByScreen({ rows: shown, context, available });
  const slash = (
    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
      <Keycap>/</Keycap>
    </span>
  );
  return (
    <div data-slot="shortcut-list" data-context={context} className={cn("flex min-h-0 flex-col", className)}>
      <div className="shrink-0 border-b border-rule px-4 py-3">
        <SearchField ref={filterRef} value={query} onChange={onQueryChange} placeholder={t("shortcuts.list.filter")} label={t("shortcuts.list.filter")} trailing={slash} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-1">
        {shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("shortcuts.list.empty", { query: query.trim() })}
          </p>
        ) : (
          <div>
            {GROUPS.map((group) => {
              const rows = here.filter((row) => row.group === group.id);
              return rows.length === 0 ? null : <Group key={group.id} group={group.id} rows={rows} query={query} />;
            })}
            {elsewhere.length > 0 && <NotHere rows={elsewhere} query={query} />}
          </div>
        )}
      </div>
      <div data-slot="shortcut-list-foot" className="shrink-0 border-t border-rule px-4 py-3">
        <Diagnostics keymap={keymap} />
        <p className="text-xs text-muted-foreground">{t("shortcuts.list.file")}</p>
      </div>
    </div>
  );
}

/** What the operator's `shortcuts.toml` got wrong: each dropped binding with the reason. Nothing when it loaded clean. */
function Diagnostics({ keymap }: { keymap: Keymap }) {
  if (keymap.diagnostics.length === 0) return null;
  const count = keymap.diagnostics.length;
  return (
    <Notice variant="box" tone="caution" announce="none" className="mb-2">
      <span className="font-semibold">{t("shortcuts.list.dropped", { count })}</span>
      <ul className="mt-1 flex flex-col gap-1 font-normal">
        {keymap.diagnostics.map((diagnostic, at) => (
          <li key={at} className="flex flex-wrap items-baseline gap-x-2">
            <code className="font-mono text-[11px]">
              {diagnostic.action}
              {diagnostic.binding === "" ? "" : ` = ${diagnostic.binding}`}
            </code>
            <span>{diagnostic.message}</span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
