import { useId, useState, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProseText } from "@/components/ui/diff-lines";
import { FoldPanel, MoreToggle } from "@/components/ui/fold-toggle";
import { ListGroup } from "@/components/ui/list-group";
import { OneOf } from "@/components/ui/one-of";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { tokenUseWhy, useTokenUseShown } from "@/components/token-use-label";
import { TrickCodeFolds, type TrickCodeReader } from "@/components/trick-code-folds";
import { TrickSettingsGroup } from "@/components/trick-settings-group";
import { valueSentence } from "@/components/trick-value";
import { useLocale } from "@/hooks/use-locale";
import { dateOnly, wholeNumber } from "@/lib/format";
import { isWebLink, linkHost } from "@/lib/hill/reader";
import { t, tn } from "@/lib/i18n";
import { spanWords } from "@/lib/tricks/code-words";
import { WATCH_WINDOW_MS } from "@/lib/tricks/limits";
import { HostWords } from "@/lib/tricks/render";
import { originLine, runsOnLine, showsInPlaces, warningLines } from "@/lib/tricks/row-words";
import { isSourceUrl, runsWithNoPhone, type FieldValue, type TricksRunsOn, type WireOfficialTrick, type WireRepoFacts, type WireTrickInfo, type WireTrickRules } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";
import { useTrickParts } from "@/lib/tricks/store";
import { trickTokenUse, type TrickTokenFacts } from "@/lib/tricks/token-use";

// A trick's About sheet: what a person reads before they switch a trick on. Opened by a tap on the trick's
// name in Settings → Tricks (components/tricks-settings-card.tsx); the switch there is its own tap target.
//
// FROM TOP TO BOTTOM
//   1. the trick's name as the sheet's title, and under it the manifest's one-line `description`;
//   2. the manifest's `about` text as paragraphs (a blank line splits them), or, when the trick has neither
//      an `about` nor a `description`, one muted line saying so. With an `about` or a `description`, a small muted line under it says the author wrote the
//      text and Collie did not check it; the rows below are the bridge's own facts. Plain text: no markdown, no HTML and no link is drawn, so React draws it as text and a
//      line break inside a paragraph is kept as one;
//   3. "What it does": ONLY facts the bridge already sends for the row. Where it shows, in plain words (`showsInPlaces`), what it reads from
//      the agent sessions, the environment names it asks for, and the warnings of the text search of its
//      code (the same words the card shows before the switch). A row is left out when its fact is absent,
//      and the whole group when every row is;
//   4. "Where it comes from": the repository and short commit, or that it was added on this machine, and the
//      one line a bridge that runs no tricks says. For a trick from a repository, a link row to it in the
//      Hill Decision link's shape and rule (`isWebLink`, `linkHost`): the open-external glyph, the words, and
//      the host IN FULL (`HostWords`, it breaks after a dot, never cut). For a `github.com` repository, once
//      the bridge has read them (bridge/tricks/repo-facts.ts; the phone never reads GitHub), the stars and
//      the date of the last commit are a second small line INSIDE that row: the row is 44 px with or without
//      it, so the facts arriving move nothing in a sheet anchored at the bottom. A failed read shows nothing.
//      Then "Version 1.2.0" when the manifest names one;
//   3b. "Read the instructions": for a trick with `rules` (contract 2), a fold with the rules file's text
//      whole, monospace, wrapped, never markdown (`RulesFold`). "What it does" names the agent view's two
//      rights lines and the rules line;
//   4b. "Settings" (contract 3): a trick's `[[field]]` values, one 44 px row each (trick-settings-group.tsx);
//   5. "Updates": the "Take changes without asking" switch with its hint, for a trick that is switched on
//      and only on a bridge that runs tricks (a crew member runs none, so it has nothing to take). It is the
//      same field `collie trick auto` writes. The switch shows only here, not on the card; the card owns the
//      write state (`flipAuto`): it flips at once, holds its position until the list agrees, and says a failed
//      write in the status line, as the trick's own switch does. Never for a trick with `rules`: it never
//      takes changes without asking (the bridge refuses the write too).
//   6. "Read the code" (package F, 2026-11-17): one fold for each code file of the trick, for every trick, also one
//      that is on (components/trick-code-folds.tsx). Only when the card hands the sheet a `readCode`. The code is
//      the approved copy's, masked; the sheet says once that the marks are a text search. "What it does" also
//      carries the `run` line and the timer in plain words (lib/tricks/code-words.ts `timerLine`).
//
// NOT ADDED YET (`OfficialTrickAboutSheet`, Official tricks): the same sheet for an entry of the official list
// that is not on this machine. Only what the list knows: the name, its one line, and "Where it comes from"
// (the repository and short commit, and that Collie checks the code before it adds it). No "What it does":
// the manifest is not here yet, so there is nothing true to say. One primary Add at the foot; the card owns
// the write and closes the sheet once the bridge took it. An entry whose list pins rules (`givesRules`) shows
// the rules line and says to read them after the add: the list carries only their hash, nothing is fetched
// before Add, and the added trick stays off until its own About sheet showed them and the person switched it on.

/** The paragraphs of an `about` text: split on a blank line, each trimmed, none empty. */
export function aboutParagraphs(about: string): string[] {
  return about
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

interface FactRow {
  key: string;
  node: ReactNode;
  /** The row draws its own 44 px box (a link): the group adds no padding around it. */
  bare?: true;
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
    { key: "menu", node: t("settings.tricks.about.menu") },
    { key: "menu-tap", node: t("settings.tricks.about.menuTap") },
  ];
}

/** The `float` place's rows: what it can draw, and, when a held part says `opens = "page"`, what a tap on it does. */
function floatRows(opensPage: boolean): FactRow[] {
  const rows: FactRow[] = [{ key: "float", node: t("settings.tricks.about.float") }];
  if (opensPage) rows.push({ key: "float-opens", node: t("settings.tricks.about.floatOpens") });
  return rows;
}

/** The rows of "What it does", from the wire's facts alone. Empty when the wire carries none. */
/** The first row of "What it does" when the trick makes an agent read or write more: why, in one sentence. */
function tokenRows(subject: TrickTokenFacts): FactRow[] {
  const reason = trickTokenUse(subject);
  if (reason === null) return [];
  return [{ key: "tokens", node: <span data-line="tokens">{tokenUseWhy(reason)}</span> }];
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
      node: (
        <span className="block">
          <span className="block">{t("settings.tricks.about.run")}</span>
          <code data-line="run" data-slot="trick-value" className={cn(badgeVariants({ variant: "value" }), "mt-1 flex h-auto w-full justify-start overflow-visible px-1.5 py-1 text-left font-mono text-xs leading-snug font-medium break-all whitespace-pre-wrap")}>
            {trick.run}
          </code>
        </span>
      ),
    },
    { key: "timer", node: <span data-line="timer">{timerWords(trick.everyMs)}</span> },
  ];
}

/** The key of the line for each `access` word the row may carry, `unknown` included (review 3, item 4). */
const ACCESS_LINE_KEYS = {
  see: "settings.tricks.about.access.see",
  read: "settings.tricks.about.access.read",
  unknown: "settings.tricks.about.access.unknown",
} as const satisfies Readonly<Record<NonNullable<WireTrickInfo["access"]>, string>>;

function doesRows(trick: WireTrickInfo, tokens: boolean, opensPage = false): FactRow[] {
  const rows: FactRow[] = tokens ? tokenRows(trick) : [];
  const places = Array.isArray(trick.places) ? trick.places : [];
  const view = trick.agentView === true;
  // Where it shows, in words a person can find on the phone (2026-11-17), the same line as the approval cards'.
  const shows = showsInPlaces(places, view);
  if (shows !== null) rows.push({ key: "shows", node: <span data-line="shows">{valueSentence("settings.tricks.about.shows", { places: shows })}</span> });
  if (view) {
    rows.push({ key: "agent-view", node: t("settings.tricks.about.agentView") });
    rows.push({ key: "agent-view-tap", node: t("settings.tricks.about.agentViewTap") });
  }
  // Contract 2: rows in a session's settings. What a tap there does is said beside it (MENU_WORDS, MENU_TAP_WORDS).
  if (places.includes("menu")) rows.push(...menuRows());
  // The `float` right: what it can draw and what it never does (FLOAT_WORDS), and the tap, when a held part opens its page.
  if (places.includes("float")) rows.push(...floatRows(opensPage));
  if (trick.rules !== undefined) rows.push({ key: "rules", node: t("settings.tricks.about.rules") });
  rows.push(...runRows(trick));
  if (trick.inputs !== undefined) rows.push({ key: "reads", node: readsWords(trick.inputs) });
  if (trick.env !== undefined && trick.env.length > 0) rows.push({ key: "env", node: valueSentence("settings.tricks.about.env", { names: trick.env.join(", ") }) });
  // `on` and `watch` are rights (M105 step one): the same two lines as the proposal card's chips.
  if (trick.events !== undefined && trick.events.length > 0) rows.push({ key: "on", node: t("settings.tricks.about.on") });
  if (trick.watch !== undefined && trick.watch.length > 0) rows.push({ key: "watch", node: valueSentence("settings.tricks.about.watch", { paths: trick.watch.join(", ") }) });
  // `access` (M105 spec 04): the one line of the level the trick declares. `none` has no line, and a level this
  // phone does not know has one fixed line (review 3, item 4). The card's honest line stands just before it (spec
  // 05, decision 10): the level says what the trick reads through Collie, and the trick runs as you all the same.
  if (trick.access !== undefined) {
    rows.push({ key: "runs-as-you", node: <span data-line="runs-as-you">{t("settings.tricks.about.runsAsYou")}</span> });
    rows.push({ key: "access", node: <span data-line="access">{t(ACCESS_LINE_KEYS[trick.access])}</span> });
  }
  // `drafts = "session"`: its buttons may fill the reply box of the session you are in, and never send. The cards' line.
  if (trick.draftsSession === true) rows.push({ key: "drafts", node: <span data-line="drafts">{t("settings.tricks.about.drafts")}</span> });
  for (const line of warningLines(trick)) {
    rows.push({
      key: `warn:${line.kind}`,
      node: (
        <span data-warning={line.kind} className="flex items-start gap-1.5">
          <Icon name="warning" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">{line.text}</span>
        </span>
      ),
    });
  }
  // The one line of a trick that reacts, after the rights lines and the warnings (2026-11-17): it starts with no phone open.
  if (runsWithNoPhone({ run: trick.run, on: trick.events, watch: trick.watch })) rows.push({ key: "keeps-running", node: <span data-line="keeps-running">{t("settings.tricks.about.keepsRunning")}</span> });
  return rows;
}

function FactGroup({ label, rows, slot }: { label: string; rows: readonly FactRow[]; slot: string }) {
  return (
    <section data-section={slot} className="pt-4">
      <SectionLabel className="mb-1.5 block">{label}</SectionLabel>
      <ListGroup as="ul" aria-label={label}>
        {rows.map((row) => (
          <li key={row.key} className={row.bare === true ? "min-w-0" : "px-3.5 py-2.5 text-sm break-words"}>
            {row.node}
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

/** The Updates group: the auto switch and its hint, in the card's own row shape. */
function UpdatesGroup({ auto, canWrite, onAuto }: { auto: boolean; canWrite: boolean; onAuto: (on: boolean) => void }) {
  return (
    <section data-section="updates" className="pt-4">
      <SectionLabel className="mb-1.5 block">{t("settings.tricks.about.updates")}</SectionLabel>
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm">{t("settings.tricks.about.auto.label")}</div>
          <p className="text-xs text-muted-foreground">{t("settings.tricks.about.auto.hint")}</p>
        </div>
        <Switch checked={auto} onCheckedChange={onAuto} disabled={!canWrite} aria-label={t("settings.tricks.about.auto.label")} />
      </div>
    </section>
  );
}

export interface TrickAboutSheetProps {
  trick: WireTrickInfo;
  /** What a bridge that runs no tricks says (the store's `runsOn`). Absent on a bridge that runs them. */
  runsOn?: TricksRunsOn | undefined;
  open: boolean;
  onClose: () => void;
  /** The auto switch's position (the card holds it while a write is in flight). Default: the wire's `auto`. */
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
}

/** The About sheet of one trick. Closes as every sheet does: the close button, the scrim, Escape, a pull down. */
export function TrickAboutSheet({ trick, runsOn, open, onClose, auto, canWrite = true, onAuto, onValue, timeZone, readCode }: TrickAboutSheetProps) {
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
  return (
    <BottomSheet open={open} onClose={onClose} title={trick.name}>
      <div data-slot="trick-about-body">
        {trick.description !== undefined && (
          <p data-line="description" className="text-sm font-medium break-words">
            {trick.description}
          </p>
        )}
        {/* No description and no about: the one muted line. A description alone is the text, so no such line. */}
        {(paragraphs.length > 0 || trick.description === undefined) && (
          <div data-section="about" className={trick.description === undefined ? "" : "pt-3"}>
            {paragraphs.length === 0 && <p className="text-sm text-muted-foreground">{t("settings.tricks.about.none")}</p>}
            {paragraphs.map((paragraph, index) => (
              // The order never changes while the sheet is open and a paragraph has no identity of its own.
              <p key={index} className="text-sm break-words whitespace-pre-line [&:not(:first-child)]:mt-3">
                {paragraph}
              </p>
            ))}
          </div>
        )}
        {(trick.about !== undefined || trick.description !== undefined) && (
          <p data-line="author-note" className="pt-2 text-xs text-muted-foreground">
            {t("settings.tricks.about.authorNote")}
          </p>
        )}
        {does.length > 0 && <FactGroup slot="does" label={t("settings.tricks.about.does")} rows={does} />}
        {trick.rules !== undefined && <RulesFold rules={trick.rules} />}
        {trick.rulesUnshown === true && (
          <p data-line="rules-unshown" className="pt-3 text-sm break-words text-muted-foreground">
            {t("settings.tricks.about.rulesUnshown")}
          </p>
        )}
        {/* Contract 3: the settings the person keeps (trick-settings-group.tsx). */}
        {onValue !== undefined && <TrickSettingsGroup trick={trick} canWrite={canWrite} onLead={runsOn !== undefined} onValue={onValue} />}
        <FactGroup slot="from" label={t("settings.tricks.about.from")} rows={comes} />
        {/* A trick that gives agents instructions never takes changes without asking: no switch to offer. */}
        {trick.on && runsOn === undefined && onAuto !== undefined && trick.rules === undefined && trick.rulesUnshown !== true && trick.agentView !== true && <UpdatesGroup auto={auto ?? trick.auto === true} canWrite={canWrite} onAuto={onAuto} />}
        {/* The version a read shows moves with the row: the switch (the copy that runs, or the folder) and the hash a switch on approves. */}
        {readCode !== undefined && <TrickCodeFolds reader={readCode} scope={`${trick.host}/${trick.id}/${String(trick.on)}/${trick.approves ?? ""}`} />}
      </div>
    </BottomSheet>
  );
}

export interface OfficialTrickAboutSheetProps {
  entry: WireOfficialTrick;
  open: boolean;
  onClose: () => void;
  /** An add of this entry is in flight. */
  busy: boolean;
  /** Whether this device may write. */
  canWrite: boolean;
  onAdd: () => void;
  /** The zone the last commit's date is written in. Tests pin it; the app leaves it to the device. */
  timeZone?: string;
}

/** The About sheet of an official entry that is not added yet. */
export function OfficialTrickAboutSheet({ entry, open, onClose, busy, canWrite, onAdd, timeZone }: OfficialTrickAboutSheetProps) {
  useLocale();
  const tokens = useTokenUseShown();
  const does = [...(tokens ? tokenRows(entry) : []), ...(entry.addsMenu === true ? menuRows() : [])];
  if (entry.givesRules === true) does.push({ key: "rules", node: t("settings.tricks.about.rules") });
  const comes = present([
    { key: "origin", node: t("settings.tricks.by.repo", { repo: entry.repoName, sha: entry.commit.slice(0, 7) }) },
    repoLinkRow(entry.repo, entry.repoFacts, timeZone),
    { key: "checks", node: t("settings.tricks.official.checks") },
  ]);
  return (
    <BottomSheet open={open} onClose={onClose} title={entry.name}>
      <div data-slot="trick-about-body" data-official={entry.id}>
        <p data-line="description" className="text-sm font-medium break-words">
          {entry.description}
        </p>
        {does.length > 0 && <FactGroup slot="does" label={t("settings.tricks.about.does")} rows={does} />}
        {/* The list pins the rules but does not carry them, and nothing is fetched before Add (review 8 V-N3). */}
        {entry.givesRules === true && (
          <p data-line="rules-after-add" className="pt-3 text-sm break-words text-muted-foreground">
            {t("settings.tricks.about.rulesAfterAdd")}
          </p>
        )}
        <FactGroup slot="from" label={t("settings.tricks.about.from")} rows={comes} />
        <div className="pt-6">
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
        </div>
      </div>
    </BottomSheet>
  );
}
