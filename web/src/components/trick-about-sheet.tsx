import { useId, useState, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { ProseText } from "@/components/ui/diff-lines";
import { FoldPanel, MoreToggle } from "@/components/ui/fold-toggle";
import { ListGroup } from "@/components/ui/list-group";
import { OneOf } from "@/components/ui/one-of";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { originLine, placesLine, readsLine, runsOnLine, warningLines } from "@/lib/tricks/row-words";
import type { TricksRunsOn, WireOfficialTrick, WireTrickInfo, WireTrickRules } from "@/lib/tricks/schema";

// A trick's About sheet: what a person reads before they switch a trick on. Opened by a tap on the trick's
// name in Settings → Tricks (components/tricks-settings-card.tsx); the switch there is its own tap target.
//
// FROM TOP TO BOTTOM
//   1. the trick's name as the sheet's title, and under it the manifest's one-line `description`;
//   2. the manifest's `about` text as paragraphs (a blank line splits them), or, when the trick has neither
//      an `about` nor a `description`, one muted line saying so. With an `about` or a `description`, a small muted line under it says the author wrote the
//      text and Collie did not check it; the rows below are the bridge's own facts. Plain text: no markdown, no HTML and no link is drawn, so React draws it as text and a
//      line break inside a paragraph is kept as one;
//   3. "What it does": ONLY facts the bridge already sends for the row. Where it draws, what it reads from
//      the agent sessions, the environment names it asks for, and the warnings of the text search of its
//      code (the same words the card shows before the switch). A row is left out when its fact is absent,
//      and the whole group when every row is;
//   4. "Where it comes from": the repository and short commit, or that it was added on this machine, and the
//      one line a bridge that runs no tricks says;
//   3b. "Read the instructions": for a trick with `rules` (contract 2), a fold with the rules file's text
//      whole, monospace, wrapped, never markdown (`RulesFold`). "What it does" names the agent view's two
//      rights lines and the rules line;
//   5. "Updates": the "Take changes without asking" switch with its hint, for a trick that is switched on
//      and only on a bridge that runs tricks (a crew member runs none, so it has nothing to take). It is the
//      same field `collie trick auto` writes. The switch shows only here, not on the card; the card owns the
//      write state (`flipAuto`): it flips at once, holds its position until the list agrees, and says a failed
//      write in the status line, as the trick's own switch does. Never for a trick with `rules`: it never
//      takes changes without asking (the bridge refuses the write too).
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
}

/** The rows of "What it does", from the wire's facts alone. Empty when the wire carries none. */
function doesRows(trick: WireTrickInfo): FactRow[] {
  const rows: FactRow[] = [];
  const places = Array.isArray(trick.places) ? trick.places : [];
  const view = trick.agentView === true;
  if (places.length > 0 || view) rows.push({ key: "draws", node: t("settings.tricks.about.draws", { places: placesLine(places, view) }) });
  if (view) {
    rows.push({ key: "agent-view", node: t("settings.tricks.about.agentView") });
    rows.push({ key: "agent-view-tap", node: t("settings.tricks.about.agentViewTap") });
  }
  if (trick.rules !== undefined) rows.push({ key: "rules", node: t("settings.tricks.about.rules") });
  if (trick.inputs !== undefined) rows.push({ key: "reads", node: readsLine(trick.inputs) });
  if (trick.env !== undefined && trick.env.length > 0) rows.push({ key: "env", node: t("settings.tricks.about.env", { names: trick.env.join(", ") }) });
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
  return rows;
}

function FactGroup({ label, rows, slot }: { label: string; rows: readonly FactRow[]; slot: string }) {
  return (
    <section data-section={slot} className="pt-4">
      <SectionLabel className="mb-1.5 block">{label}</SectionLabel>
      <ListGroup as="ul" aria-label={label}>
        {rows.map((row) => (
          <li key={row.key} className="px-3.5 py-2.5 text-sm break-words">
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
}

/** The About sheet of one trick. Closes as every sheet does: the close button, the scrim, Escape, a pull down. */
export function TrickAboutSheet({ trick, runsOn, open, onClose, auto, canWrite = true, onAuto }: TrickAboutSheetProps) {
  useLocale();
  const paragraphs = trick.about === undefined ? [] : aboutParagraphs(trick.about);
  const does = doesRows(trick);
  const comes: FactRow[] = [{ key: "origin", node: originLine(trick.provenance) }];
  if (runsOn !== undefined) comes.push({ key: "runs-on", node: runsOnLine(runsOn) });
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
        <FactGroup slot="from" label={t("settings.tricks.about.from")} rows={comes} />
        {/* A trick that gives agents instructions never takes changes without asking: no switch to offer. */}
        {trick.on && runsOn === undefined && onAuto !== undefined && trick.rules === undefined && trick.rulesUnshown !== true && trick.agentView !== true && <UpdatesGroup auto={auto ?? trick.auto === true} canWrite={canWrite} onAuto={onAuto} />}
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
}

/** The About sheet of an official entry that is not added yet. */
export function OfficialTrickAboutSheet({ entry, open, onClose, busy, canWrite, onAdd }: OfficialTrickAboutSheetProps) {
  useLocale();
  const comes: FactRow[] = [
    { key: "origin", node: t("settings.tricks.by.repo", { repo: entry.repoName, sha: entry.commit.slice(0, 7) }) },
    { key: "checks", node: t("settings.tricks.official.checks") },
  ];
  return (
    <BottomSheet open={open} onClose={onClose} title={entry.name}>
      <div data-slot="trick-about-body" data-official={entry.id}>
        <p data-line="description" className="text-sm font-medium break-words">
          {entry.description}
        </p>
        {entry.givesRules === true && <FactGroup slot="does" label={t("settings.tricks.about.does")} rows={[{ key: "rules", node: t("settings.tricks.about.rules") }]} />}
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
