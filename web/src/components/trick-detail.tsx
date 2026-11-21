import { useId, useState, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProseText } from "@/components/ui/diff-lines";
import { FoldPanel, MoreToggle } from "@/components/ui/fold-toggle";
import { ListGroup } from "@/components/ui/list-group";
import { OneOf } from "@/components/ui/one-of";
import { SectionLabel } from "@/components/ui/section-label";
import { Switch } from "@/components/ui/switch";
import { TokenUseChip, tokenUseWhy, useTokenUseShown } from "@/components/token-use-label";
import { TrickCodeFolds, type TrickCodeReader } from "@/components/trick-code-folds";
import { TrickRemoveSection, type RemoveProblem } from "@/components/trick-remove-section";
import { TrickSettingsGroup } from "@/components/trick-settings-group";
import { valueSentence } from "@/components/trick-value";
import { SettingSlot } from "@/components/setting-slot";
import { useLocale } from "@/hooks/use-locale";
import { dateOnly, wholeNumber } from "@/lib/format";
import { isWebLink, linkHost } from "@/lib/hill/reader";
import { t, tn } from "@/lib/i18n";
import { spanWords } from "@/lib/tricks/code-words";
import { trickIconOf } from "@/lib/tricks/icons";
import type { TrickOrigin } from "@/lib/tricks/list-order";
import { WATCH_WINDOW_MS } from "@/lib/tricks/limits";
import { HostWords } from "@/lib/tricks/render";
import { originLine, runsOnLine, showsInPlaces, warningLines } from "@/lib/tricks/row-words";
import { ACCESS_UNKNOWN, isSourceUrl, runsWithNoPhone, type FieldValue, type TricksRunsOn, type WireOfficialTrick, type WireRepoFacts, type WireTrickInfo, type WireTrickRules } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";
import { useTrickParts } from "@/lib/tricks/store";
import { trickTokenUse, type TrickTokenFacts } from "@/lib/tricks/token-use";

// A TRICK'S DETAILS PAGE (a bottom sheet until 2026-11-21, "About"): what a person reads before they switch a trick
// on, and after. Drawn by routes/settings-trick.tsx at `settings/tricks/<host>:<id>`, one level below Settings,
// Tricks, and reached from a trick's row there (components/tricks-settings-card.tsx) and from the header of the
// trick's own page (routes/trick-session.tsx). The words and the facts are the sheet's, every one, in the sheet's
// order; the page adds a head and gives each group a section label, a list group and a small neutral icon per row.
// Colour stays neutral for every kind of trick: nothing here may look checked, safe or verified (DESIGN.md §4).
//
// FROM TOP TO BOTTOM
//   0. the head: the trick's icon in a neutral tile, its name, its labels ("Official" or "Community", and "Uses
//      agent tokens", the list's own badges), and the trick's switch with its state in words. The switch is the
//      list's: one tap, a switch on approves the code the page shows (`approves`), refused where the list refuses;
//   1. "About": the manifest's one-line `description`, then the `about` text as paragraphs (a blank line splits
//      them), or, when the trick has neither an `about` nor a `description`, one muted line saying so. With an
//      `about` or a `description`, a small muted line UNDER IT, in the same box, says the author wrote the text and
//      Collie did not check it; the rows below are the bridge's own facts. Plain text: no markdown, no HTML and no
//      link is drawn, so React draws it as text and a line break inside a paragraph is kept as one;
//   2. "What it does": ONLY facts the bridge already sends for the row. Where it shows, in plain words (`showsInPlaces`), what it reads from
//      the agent sessions, the environment names it asks for, and the warnings of the text search of its
//      code (the same words the card shows before the switch). A row is left out when its fact is absent,
//      and the whole group when every row is. Each row leads with a small muted glyph of its kind (`FactKind`):
//      where it shows, what it adds, what starts it, when it runs, what it may read, why it uses tokens, and the
//      warning glyph for a warning. A fact's glyph is muted; the warning glyph alone takes the caution tone of
//      the code folds' "flagged" mark (`text-status-working`), on the glyph only, the words in their normal colour
//      (2026-11-21): a warning is a risk statement. Colour on this page goes toward caution, never toward "safe";
//   2b. "Read the instructions": for a trick with `rules` (contract 2), a fold with the rules file's text
//      whole, monospace, wrapped, never markdown (`RulesFold`). "What it does" names the agent view's two
//      rights lines and the rules line;
//   3. "Settings" (contract 3): a trick's `[[field]]` values, one 44 px row each (trick-settings-group.tsx);
//   4. "Where it comes from": the repository and short commit, or that it was added on this machine, and the
//      one line a bridge that runs no tricks says. For a trick from a repository, a link row to it in the
//      Hill Decision link's shape and rule (`isWebLink`, `linkHost`): the open-external glyph, the words, and
//      the host IN FULL (`HostWords`, it breaks after a dot, never cut). For a `github.com` repository, once
//      the bridge has read them (bridge/tricks/repo-facts.ts; the phone never reads GitHub), the stars and
//      the date of the last commit are a second small line INSIDE that row: the row is 44 px with or without
//      it, so the facts arriving move nothing. A failed read shows nothing.
//      Then "Version 1.2.0" when the manifest names one;
//   5. "Updates": the "Update this trick without asking" switch with its hint, for a trick that is switched on
//      and only on a bridge that runs tricks (a crew member runs none, so it has nothing to take). It is the
//      same field `collie trick auto` writes. The switch shows only here, not on the card; the route owns the
//      write state (`flipAuto`, hooks/use-trick-writes.ts): it flips at once, holds its position until the list
//      agrees, and says a failed write in the status line, as the trick's own switch does. Never for a trick with
//      `rules`: it never takes changes without asking (the bridge refuses the write too).
//   6. "Read the code" (package F, 2026-11-17): one fold for each code file of the trick, for every trick, also one
//      that is on (components/trick-code-folds.tsx). Only when the route hands the page a `readCode`. The code is
//      the approved copy's, masked; the page says once that the marks are a text search. "What it does" also
//      carries the `run` line and the timer in plain words (lib/tricks/code-words.ts `timerLine`).
//
// NO REMOVE. `collie trick remove <id>` exists on the machine and no bridge route does, so the page offers none
// (2026-11-21): a remove from the phone needs its own route first.
//
// NOT ADDED YET (`OfficialTrickDetail`, Official tricks): the same page for an entry of the official list that
// is not on this machine. Only what the list knows: the name, its one line, and "Where it comes from"
// (the repository and short commit, and that Collie checks the code before it adds it). No "What it does":
// the manifest is not here yet, so there is nothing true to say. One primary Add at the foot; the route owns the
// write, and the page becomes the added trick's once the bridge took it. An entry whose list pins rules (`givesRules`) shows
// the rules line and says to read them after the add: the list carries only their hash, nothing is fetched
// before Add, and the added trick stays off until its own details page showed them and the person switched it on.

/** The paragraphs of an `about` text: split on a blank line, each trimmed, none empty. */
export function aboutParagraphs(about: string): string[] {
  return about
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/** The kind of a row of "What it does", for the small muted glyph it leads with. */
type FactKind = "shows" | "adds" | "starts" | "runs" | "reads" | "tokens" | "warn";

const FACT_GLYPH = {
  shows: "trick-fact-shows",
  adds: "trick-fact-adds",
  starts: "trick-fact-starts",
  runs: "trick-fact-runs",
  reads: "trick-fact-reads",
  tokens: "trick-fact-tokens",
  warn: "warning",
} as const satisfies Readonly<Record<FactKind, IconKey>>;

interface FactRow {
  key: string;
  node: ReactNode;
  /** The row draws its own 44 px box (a link): the group adds no padding around it. */
  bare?: true;
  /** The glyph the row leads with. Absent: none (the rows of "Where it comes from"). */
  kind?: FactKind;
}

/** The stars and the last commit of a repository, one line: "1,234 stars, last commit Nov 10, 2026". */
export function repoFactsLine(facts: WireRepoFacts, timeZone?: string): string {
  return t("settings.tricks.about.repoFacts", {
    stars: tn("settings.tricks.about.stars", facts.stars, { stars: wholeNumber(facts.stars) }),
    commit: t("settings.tricks.about.lastCommit", { date: dateOnly(Date.parse(facts.pushedAt), timeZone) }),
  });
}

/**
 * The link row to a trick's repository, or null when `url` is not a web link the sheet may draw. The Hill
 * Decision link's shape and rule; the host whole. The facts show only for `github.com`, the one host the
 * bridge reads them from.
 */
function repoLinkRow(url: string | undefined, facts: WireRepoFacts | undefined, timeZone?: string): FactRow | null {
  if (url === undefined || !isSourceUrl(url) || !isWebLink(url)) return null;
  const host = linkHost(url);
  const line = facts !== undefined && host === "github.com" ? repoFactsLine(facts, timeZone) : null;
  return {
    key: "repo-link",
    bare: true,
    node: (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        data-slot="trick-repo-link"
        className="flex min-h-11 min-w-0 items-center gap-2 px-3.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Icon name="open-external" aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{t("settings.tricks.about.repoOpen")}</span>
          {line !== null && (
            <span data-line="repo-facts" className="block truncate text-xs leading-4 font-normal text-muted-foreground">
              {line}
            </span>
          )}
        </span>
        <span className="max-w-[50%] shrink-0 pl-2 text-right font-normal">
          <HostWords host={host} line />
        </span>
      </a>
    ),
  };
}

/** The version row, when the manifest names one. */
function versionRow(version: string | undefined): FactRow | null {
  if (version === undefined) return null;
  return { key: "version", node: <span data-line="version">{valueSentence("settings.tricks.about.version", { version })}</span> };
}

/** The rows that are drawn: a row that is null has nothing true to say. */
function present(rows: readonly (FactRow | null)[]): FactRow[] {
  return rows.filter((row): row is FactRow => row !== null);
}

/** The two rows of the `menu` place: what it adds, and what a tap on one of its rows does. */
function menuRows(): FactRow[] {
  return [
    { key: "menu", kind: "adds", node: t("settings.tricks.about.menu") },
    { key: "menu-tap", kind: "adds", node: t("settings.tricks.about.menuTap") },
  ];
}

/** The `float` place's rows: what it can draw, and, when a held part says `opens = "page"`, what a tap on it does. */
function floatRows(opensPage: boolean): FactRow[] {
  const rows: FactRow[] = [{ key: "float", kind: "adds", node: t("settings.tricks.about.float") }];
  if (opensPage) rows.push({ key: "float-opens", kind: "adds", node: t("settings.tricks.about.floatOpens") });
  return rows;
}

/** The first row of "What it does" when the trick makes an agent read or write more: why, in one sentence. */
function tokenRows(subject: TrickTokenFacts): FactRow[] {
  const reason = trickTokenUse(subject);
  if (reason === null) return [];
  return [{ key: "tokens", kind: "tokens", node: <span data-line="tokens">{tokenUseWhy(reason)}</span> }];
}

/** The timer in plain words, its two spans as values. A trick with no `every` has the one plain line. */
function timerWords(everyMs: number | undefined): ReactNode {
  if (everyMs === undefined) return t("settings.tricks.about.noTimer");
  return valueSentence("settings.tricks.about.timer", { every: spanWords(everyMs), window: spanWords(WATCH_WINDOW_MS) });
}

/** What a contract 2 trick reads, in one sentence (row-words.ts `readsLine`), its globs as one value. */
function readsWords(inputs: NonNullable<WireTrickInfo["inputs"]>): ReactNode {
  return valueSentence(inputs.crew ? "settings.tricks.reads.crew" : "settings.tricks.reads.solo", { globs: inputs.globs.join(", ") });
}

/** How the program starts and when: the run line, whole and wrapped, and the timer in plain words. A trick with no program has neither. */
function runRows(trick: Pick<WireTrickInfo, "run" | "everyMs">): FactRow[] {
  if (trick.run === undefined) return [];
  return [
    {
      key: "run",
      kind: "starts",
      node: (
        <span className="block">
          <span className="block">{t("settings.tricks.about.run")}</span>
          <code data-line="run" data-slot="trick-value" className={cn(badgeVariants({ variant: "value" }), "mt-1 flex h-auto w-full justify-start overflow-visible px-1.5 py-1 text-left font-mono text-xs leading-snug font-medium break-all whitespace-pre-wrap")}>
            {trick.run}
          </code>
        </span>
      ),
    },
    { key: "timer", kind: "runs", node: <span data-line="timer">{timerWords(trick.everyMs)}</span> },
  ];
}

/** The key of the line for each `access` word the row may carry, `unknown` included (review 3, item 4). */
const ACCESS_LINE_KEYS = {
  see: "settings.tricks.about.access.see",
  read: "settings.tricks.about.access.read",
  unknown: "settings.tricks.about.access.unknown",
} as const satisfies Readonly<Record<NonNullable<WireTrickInfo["access"]>, string>>;

/** The rows of "What it does", from the wire's facts alone, in the sheet's order. Empty when the wire carries none. */
function doesRows(trick: WireTrickInfo, tokens: boolean, opensPage = false): FactRow[] {
  const rows: FactRow[] = tokens ? tokenRows(trick) : [];
  const places = Array.isArray(trick.places) ? trick.places : [];
  const view = trick.agentView === true;
  // Where it shows, in words a person can find on the phone (2026-11-17), the same line as the approval cards'.
  const shows = showsInPlaces(places, view);
  if (shows !== null) rows.push({ key: "shows", kind: "shows", node: <span data-line="shows">{valueSentence("settings.tricks.about.shows", { places: shows })}</span> });
  if (view) {
    rows.push({ key: "agent-view", kind: "adds", node: t("settings.tricks.about.agentView") });
    rows.push({ key: "agent-view-tap", kind: "adds", node: t("settings.tricks.about.agentViewTap") });
  }
  // Contract 2: rows in a session's settings. What a tap there does is said beside it (MENU_WORDS, MENU_TAP_WORDS).
  if (places.includes("menu")) rows.push(...menuRows());
  // The `float` right: what it can draw and what it never does (FLOAT_WORDS), and the tap, when a held part opens its page.
  if (places.includes("float")) rows.push(...floatRows(opensPage));
  if (trick.rules !== undefined) rows.push({ key: "rules", kind: "adds", node: t("settings.tricks.about.rules") });
  rows.push(...runRows(trick));
  if (trick.inputs !== undefined) rows.push({ key: "reads", kind: "reads", node: readsWords(trick.inputs) });
  if (trick.env !== undefined && trick.env.length > 0) rows.push({ key: "env", kind: "reads", node: valueSentence("settings.tricks.about.env", { names: trick.env.join(", ") }) });
  // `on` and `watch` are rights (M105 step one): the same two lines as the proposal card's chips.
  if (trick.events !== undefined && trick.events.length > 0) rows.push({ key: "on", kind: "runs", node: t("settings.tricks.about.on") });
  if (trick.watch !== undefined && trick.watch.length > 0) rows.push({ key: "watch", kind: "runs", node: valueSentence("settings.tricks.about.watch", { paths: trick.watch.join(", ") }) });
  // `access` (M105 spec 04): the one line of the level the trick declares. `none` has no line, and a level this
  // phone does not know has one fixed line (review 3, item 4). The card's honest line stands just before it (spec
  // 05, decision 10): the level says what the trick reads through Collie, and the trick runs as you all the same.
  if (trick.access !== undefined) {
    rows.push({ key: "runs-as-you", kind: "reads", node: <span data-line="runs-as-you">{t("settings.tricks.about.runsAsYou")}</span> });
    rows.push({ key: "access", kind: "reads", node: <span data-line="access">{t(ACCESS_LINE_KEYS[trick.access])}</span> });
  }
  // `drafts = "session"`: its buttons may fill the reply box of the session you are in, and never send. The cards' line.
  if (trick.draftsSession === true) rows.push({ key: "drafts", kind: "adds", node: <span data-line="drafts">{t("settings.tricks.about.drafts")}</span> });
  for (const line of warningLines(trick)) {
    // The warning glyph leads the row in the caution tone (FactLine): a text search's flag, never a verdict.
    rows.push({ key: `warn:${line.kind}`, kind: "warn", node: <span data-warning={line.kind}>{line.text}</span> });
  }
  // The one line of a trick that reacts, after the rights lines and the warnings (2026-11-17): it starts with no phone open.
  if (runsWithNoPhone({ run: trick.run, on: trick.events, watch: trick.watch })) rows.push({ key: "keeps-running", kind: "runs", node: <span data-line="keeps-running">{t("settings.tricks.about.keepsRunning")}</span> });
  return rows;
}

/** The space above a section of the page, and its label: the page's second level, under the head. */
const SECTION = "pt-6";
const SECTION_LABEL = "mb-2 block";

/** The tone of a fact's glyph: muted, and the caution tone of a flagged code line for a warning. */
export const FACT_GLYPH_TONE = { fact: "text-muted-foreground", warn: "text-status-working" } as const;

/** A row's words, after its glyph when it has a kind. The glyph is hidden from assistive tech. */
function FactLine({ row }: { row: FactRow }) {
  if (row.kind === undefined) return row.node;
  return (
    <span className="flex items-start gap-2.5">
      <Icon name={FACT_GLYPH[row.kind]} data-fact={row.kind} aria-hidden className={cn("mt-0.5 size-4 shrink-0", row.kind === "warn" ? FACT_GLYPH_TONE.warn : FACT_GLYPH_TONE.fact)} />
      <span className="min-w-0 flex-1">{row.node}</span>
    </span>
  );
}

function FactGroup({ label, rows, slot }: { label: string; rows: readonly FactRow[]; slot: string }) {
  return (
    <section data-section={slot} className={SECTION}>
      <SectionLabel className={SECTION_LABEL}>{label}</SectionLabel>
      <ListGroup as="ul" aria-label={label}>
        {rows.map((row) => (
          <li key={row.key} className={row.bare === true ? "min-w-0" : "px-3.5 py-2.5 text-sm break-words"}>
            <FactLine row={row} />
          </li>
        ))}
      </ListGroup>
    </section>
  );
}

/**
 * The instructions a trick gives the person's agents (contract 2), behind one fold: the file's bytes as
 * written, every line, in monospace and wrapped. Never markdown, never cut: React draws the string as text,
 * so the text on the screen is the text the agent reads. The bridge and the wire reader both held it to
 * printable ASCII and line breaks, so no character can hide or turn a line around.
 */
function RulesFold({ rules }: { rules: WireTrickRules }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section data-section="rules" className="pt-3">
      <MoreToggle
        open={open}
        onToggle={() => setOpen((was) => !was)}
        controls={id}
        data-slot="trick-rules-toggle"
        className="-ml-3"
        more={t("settings.tricks.about.rulesOpen")}
        less={t("settings.tricks.about.rulesClose")}
      />
      <FoldPanel id={id} open={open} data-slot="trick-rules">
        <p className="pb-1 font-mono text-xs text-muted-foreground">{rules.file}</p>
        <ProseText data-line="rules-text" text={rules.text} className="rounded-md border border-border bg-muted/40" />
      </FoldPanel>
    </section>
  );
}

/** The Updates group: the auto switch and its hint, in the card's own row shape, as one row of a list group. */
function UpdatesGroup({ auto, canWrite, onAuto }: { auto: boolean; canWrite: boolean; onAuto: (on: boolean) => void }) {
  return (
    <section data-section="updates" className={SECTION}>
      <SectionLabel className={SECTION_LABEL}>{t("settings.tricks.about.updates")}</SectionLabel>
      <ListGroup>
        <div className="flex min-h-11 items-center justify-between gap-4 px-3.5 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm">{t("settings.tricks.about.autoUpdate.label")}</div>
            <p className="text-xs text-muted-foreground">{t("settings.tricks.about.auto.hint")}</p>
          </div>
          <Switch checked={auto} onCheckedChange={onAuto} disabled={!canWrite} aria-label={t("settings.tricks.about.autoUpdate.label")} />
        </div>
      </ListGroup>
    </section>
  );
}

/** The small label after a trick's name: where it comes from, "Official" or "Community". The list's and the page's. */
/**
 * The app's accent for an official trick (2026-11-21): an official trick is Collie's own, and the page says who
 * checks it. The accent is the control-on blue, a fact of who made it, never a verdict: no green, no check mark,
 * no shield. Every other origin stays neutral.
 */
export const OFFICIAL_TONE = { label: "border-control-on-foreground/40 bg-control-on text-control-on-foreground", tile: "border-control-on-foreground/40 bg-control-on text-control-on-foreground" } as const;

export function OriginLabel({ origin }: { origin: TrickOrigin }) {
  return (
    <Badge variant="outline" data-slot="trick-origin" data-origin={origin} className={cn("px-1.5 py-0 text-[11px] leading-4 font-normal", origin === "official" ? OFFICIAL_TONE.label : "text-muted-foreground")}>
      {t(origin === "official" ? "settings.tricks.origin.official" : "settings.tricks.origin.community")}
    </Badge>
  );
}

/**
 * THE HEAD: the trick's icon in a tile, its name, and its labels, then, for a trick on this machine, its switch with
 * the state in words. The tile is a neutral frame, in the official accent for an official trick (`OFFICIAL_TONE`):
 * a fact of identity, never a status. The name is the page's heading (`h1`, 20 px, semibold); the header's
 * title says "Trick details", so the name stands once.
 */
function DetailHead({ icon, name, origin, tokens, children }: { icon: string | undefined; name: string; origin: TrickOrigin | undefined; tokens: boolean; children?: ReactNode }) {
  const Glyph = trickIconOf(icon);
  return (
    <header data-section="head" className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span aria-hidden data-slot="trick-detail-icon" className={cn("inline-flex size-12 shrink-0 items-center justify-center rounded-sm border", origin === "official" ? OFFICIAL_TONE.tile : "border-border bg-card text-primary")}>
          <Glyph className="size-6" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <h1 data-slot="trick-detail-name" className="text-xl leading-7 font-semibold tracking-tight break-words">
            {name}
          </h1>
          {(origin !== undefined || tokens) && (
            <div data-slot="trick-detail-labels" className="mt-1 flex flex-wrap items-center gap-1">
              {origin !== undefined && <OriginLabel origin={origin} />}
              {tokens && <TokenUseChip />}
            </div>
          )}
        </div>
      </div>
      {children}
    </header>
  );
}

/** The trick's own switch in the head, with its state in words: the list row's switch, the same tap and the same refusals. */
function HeadSwitch({ name, checked, disabled, onFlip }: { name: string; checked: boolean; disabled: boolean; onFlip: (on: boolean) => void }) {
  return (
    <ListGroup>
      <div data-slot="trick-detail-switch" className="flex min-h-11 items-center justify-between gap-4 px-3.5 py-2">
        {/* Both words in one slot, sized by the wider, so a flip moves nothing beside it (DESIGN.md §2). */}
        <OneOf
          active={checked ? "on" : "off"}
          className="inline-grid text-sm font-medium"
          options={[
            { key: "on", node: t("settings.tricks.detail.on") },
            { key: "off", node: t("settings.tricks.detail.off") },
          ]}
        />
        <Switch checked={checked} onCheckedChange={onFlip} disabled={disabled} aria-label={name} />
      </div>
    </ListGroup>
  );
}

/**
 * "About": the author's words and, in the same box right under them, the line that Collie did not check them. With
 * neither an about nor a description, the one muted line, and no such note. `note` is false for an official entry
 * that is not added yet: its line is the list's, and the sheet drew no note under it either.
 */
function AboutGroup({ description, paragraphs, note }: { description: string | undefined; paragraphs: readonly string[]; note: boolean }) {
  return (
    <section data-section="about-group" className={SECTION}>
      <SectionLabel className={SECTION_LABEL}>{t("settings.tricks.detail.about")}</SectionLabel>
      <ListGroup>
        <div className="px-3.5 py-3">
          {description !== undefined && (
            <p data-line="description" className="text-sm font-medium break-words">
              {description}
            </p>
          )}
          {/* No description and no about: the one muted line. A description alone is the text, so no such line. */}
          {(paragraphs.length > 0 || description === undefined) && (
            <div data-section="about" className={description === undefined ? "" : "pt-3"}>
              {paragraphs.length === 0 && <p className="text-sm text-muted-foreground">{t("settings.tricks.about.none")}</p>}
              {paragraphs.map((paragraph, index) => (
                // The order never changes while the page is open and a paragraph has no identity of its own.
                <p key={index} className="text-sm break-words whitespace-pre-line [&:not(:first-child)]:mt-3">
                  {paragraph}
                </p>
              ))}
            </div>
          )}
        </div>
        {note && (
          <p data-line="author-note" className="px-3.5 py-2 text-xs text-muted-foreground">
            {t("settings.tricks.about.authorNote")}
          </p>
        )}
      </ListGroup>
    </section>
  );
}

export interface TrickDetailProps {
  trick: WireTrickInfo;
  /** What a bridge that runs no tricks says (the store's `runsOn`). Absent on a bridge that runs them. */
  runsOn?: TricksRunsOn | undefined;
  /** Where the trick comes from, for the label in the head. Undefined: not known, no label. */
  origin?: TrickOrigin | undefined;
  /** The trick's switch: its position (held while a flip waits for the list) and the flip. Without it no switch. */
  checked?: boolean;
  onFlip?: (on: boolean) => void;
  /** The auto switch's position (the route holds it while a write is in flight). Default: the wire's `auto`. */
  auto?: boolean;
  /** Whether this device may write. Default true. */
  canWrite?: boolean;
  /** The write. Without it the Updates group is not drawn. */
  onAuto?: (on: boolean) => void;
  /** Save one of the trick's settings (contract 3); answers a failure's words or null. Without it no Settings group. */
  onValue?: (key: string, value: FieldValue | null) => Promise<string | null>;
  /** The zone the last commit's date is written in. Tests pin it; the app leaves it to the device. */
  timeZone?: string;
  /** The reads behind the "Read the code" folds, bound to this trick. Without it the section is not drawn. */
  readCode?: TrickCodeReader;
  /** Remove the trick from this machine (ADR 0168), with the ask's request id: null when it went, else what to show. Without it no Remove section. */
  onRemove?: (rid: string) => Promise<RemoveProblem | null>;
}

/** The details of one trick on a machine: the head, then the sheet's groups in the sheet's order. */
export function TrickDetail({ trick, runsOn, origin, checked, onFlip, auto, canWrite = true, onAuto, onValue, timeZone, readCode, onRemove }: TrickDetailProps) {
  useLocale();
  const paragraphs = trick.about === undefined ? [] : aboutParagraphs(trick.about);
  const tokens = useTokenUseShown();
  // A held `float` part of this trick that says `opens = "page"`: the tap line is true only then.
  const floats = useTrickParts("float");
  const opensPage = floats.some((part) => part.host === trick.host && part.trick === trick.id && part.value.at === "float" && part.value.opens === "page");
  const does = doesRows(trick, tokens, opensPage);
  const fromRepo = trick.provenance?.via === "repo" ? trick.provenance.url : undefined;
  const comes = present([
    { key: "origin", node: originLine(trick.provenance) },
    repoLinkRow(fromRepo, trick.repoFacts, timeZone),
    versionRow(trick.version),
    runsOn === undefined ? null : { key: "runs-on", node: runsOnLine(runsOn) },
  ]);
  const on = checked ?? trick.on;
  // Rules this phone cannot show (review 8 V-N5), or a level of access it does not know (review 3, item 4): no
  // yes from here, as on the list; a trick that is on can still go off.
  const noYes = (trick.rulesUnshown === true || trick.access === ACCESS_UNKNOWN) && !on;
  return (
    <div data-slot="trick-detail" data-detail-trick={trick.id}>
      <DetailHead icon={trick.icon} name={trick.name} origin={origin} tokens={tokens && trickTokenUse(trick) !== null}>
        {onFlip !== undefined && (
          <SettingSlot ids={["tricks.list"]}>
            <HeadSwitch name={trick.name} checked={on} disabled={!canWrite || noYes} onFlip={onFlip} />
          </SettingSlot>
        )}
      </DetailHead>
      {/* The author's words: the about text, or the one line that there is none, and the note under them. */}
      <SettingSlot ids={["tricks.trick.about"]}>
        <AboutGroup description={trick.description} paragraphs={paragraphs} note={trick.about !== undefined || trick.description !== undefined} />
      </SettingSlot>
      {does.length > 0 && <FactGroup slot="does" label={t("settings.tricks.about.does")} rows={does} />}
      {trick.rules !== undefined && (
        <SettingSlot ids={["tricks.trick.rules"]}>
          <RulesFold rules={trick.rules} />
        </SettingSlot>
      )}
      {trick.rulesUnshown === true && (
        <p data-line="rules-unshown" className="pt-3 text-sm break-words text-muted-foreground">
          {t("settings.tricks.about.rulesUnshown")}
        </p>
      )}
      {/* Contract 3: the settings the person keeps (trick-settings-group.tsx). */}
      {onValue !== undefined && (
        <SettingSlot ids={["tricks.trick.fields"]}>
          <TrickSettingsGroup trick={trick} canWrite={canWrite} onLead={runsOn !== undefined} onValue={onValue} />
        </SettingSlot>
      )}
      <SettingSlot ids={["tricks.trick.repo"]}>
        <FactGroup slot="from" label={t("settings.tricks.about.from")} rows={comes} />
      </SettingSlot>
      {/* A trick that gives agents instructions never takes changes without asking: no switch to offer. */}
      {trick.on && runsOn === undefined && onAuto !== undefined && trick.rules === undefined && trick.rulesUnshown !== true && trick.agentView !== true && (
        <SettingSlot ids={["tricks.trick.autoUpdate"]}>
          <UpdatesGroup auto={auto ?? trick.auto === true} canWrite={canWrite} onAuto={onAuto} />
        </SettingSlot>
      )}
      {/* The version a read shows moves with the row: the switch (the copy that runs, or the folder) and the hash a switch on approves. */}
      {readCode !== undefined && (
        <SettingSlot ids={["tricks.trick.code"]}>
          <TrickCodeFolds reader={readCode} scope={`${trick.host}/${trick.id}/${String(trick.on)}/${trick.approves ?? ""}`} />
        </SettingSlot>
      )}
      {/* The last section: the one place that removes a trick. A trick that is on, also one held on by a flip, cannot go. */}
      {onRemove !== undefined && (
        <SettingSlot ids={["tricks.trick.remove"]}>
          <TrickRemoveSection name={trick.name} on={on || trick.on} canWrite={canWrite} onRemove={onRemove} />
        </SettingSlot>
      )}
    </div>
  );
}

export interface OfficialTrickDetailProps {
  entry: WireOfficialTrick;
  /** An add of this entry is in flight. */
  busy: boolean;
  /** Whether this device may write. */
  canWrite: boolean;
  onAdd: () => void;
  /** The zone the last commit's date is written in. Tests pin it; the app leaves it to the device. */
  timeZone?: string;
}

/** The details of an official entry that is not added yet. */
export function OfficialTrickDetail({ entry, busy, canWrite, onAdd, timeZone }: OfficialTrickDetailProps) {
  useLocale();
  const tokens = useTokenUseShown();
  const does = [...(tokens ? tokenRows(entry) : []), ...(entry.addsMenu === true ? menuRows() : [])];
  if (entry.givesRules === true) does.push({ key: "rules", kind: "adds", node: t("settings.tricks.about.rules") });
  const comes = present([
    { key: "origin", node: t("settings.tricks.by.repo", { repo: entry.repoName, sha: entry.commit.slice(0, 7) }) },
    repoLinkRow(entry.repo, entry.repoFacts, timeZone),
    { key: "checks", node: t("settings.tricks.official.checks") },
  ]);
  return (
    <div data-slot="trick-detail" data-detail-official={entry.id}>
      <DetailHead icon={undefined} name={entry.name} origin="official" tokens={tokens && trickTokenUse(entry) !== null} />
      <SettingSlot ids={["tricks.trick.about"]}>
        <AboutGroup description={entry.description} paragraphs={[]} note={false} />
      </SettingSlot>
      {does.length > 0 && <FactGroup slot="does" label={t("settings.tricks.about.does")} rows={does} />}
      {/* The list pins the rules but does not carry them, and nothing is fetched before Add (review 8 V-N3). */}
      {entry.givesRules === true && (
        <p data-line="rules-after-add" className="pt-3 text-sm break-words text-muted-foreground">
          {t("settings.tricks.about.rulesAfterAdd")}
        </p>
      )}
      <SettingSlot ids={["tricks.trick.repo"]}>
        <FactGroup slot="from" label={t("settings.tricks.about.from")} rows={comes} />
      </SettingSlot>
      <SettingSlot ids={["tricks.official.add"]} className="pt-6">
        <Button type="button" data-slot="official-add" className="h-11 w-full" disabled={!canWrite || busy} aria-busy={busy || undefined} onClick={onAdd}>
          {/* The word and the spinner share one slot, so the button keeps its size while it works. */}
          <OneOf
            active={busy ? "busy" : "rest"}
            className="inline-grid place-items-center"
            options={[
              { key: "rest", node: t("settings.tricks.official.add") },
              { key: "busy", node: <Icon name="busy" className="size-4 animate-spin" aria-hidden /> },
            ]}
          />
        </Button>
      </SettingSlot>
    </div>
  );
}
