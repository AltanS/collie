import type { ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { OneOf } from "@/components/ui/one-of";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { originLine, placesLine, readsLine, runsOnLine, warningLines } from "@/lib/tricks/row-words";
import type { TricksRunsOn, WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";

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
//   5. "Updates": the "Take changes without asking" switch with its hint, for a trick that is switched on
//      and only on a bridge that runs tricks (a crew member runs none, so it has nothing to take). It is the
//      same field `collie trick auto` writes. The switch shows only here, not on the card; the card owns the
//      write state (`flipAuto`): it flips at once, holds its position until the list agrees, and says a failed
//      write in the status line, as the trick's own switch does.
//
// NOT ADDED YET (`OfficialTrickAboutSheet`, From Collie): the same sheet for an entry of the official list
// that is not on this machine. Only what the list knows: the name, its one line, and "Where it comes from"
// (the repository and short commit, and that Collie checks the code before it adds it). No "What it does":
// the manifest is not here yet, so there is nothing true to say. One primary Add at the foot; the card owns
// the write and closes the sheet once the bridge took it.

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
  if (places.length > 0) rows.push({ key: "draws", node: t("settings.tricks.about.draws", { places: placesLine(places) }) });
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
        <FactGroup slot="from" label={t("settings.tricks.about.from")} rows={comes} />
        {trick.on && runsOn === undefined && onAuto !== undefined && <UpdatesGroup auto={auto ?? trick.auto === true} canWrite={canWrite} onAuto={onAuto} />}
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

/** The About sheet of a From Collie entry that is not added yet. */
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
