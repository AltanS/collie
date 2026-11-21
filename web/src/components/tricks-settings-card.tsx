import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { ROW_OPEN_BUTTON, ROW_OPEN_CONTROL, ROW_OPEN_ROW, ROW_OPEN_SWITCH } from "@/components/ui/row-open";
import { Switch } from "@/components/ui/switch";
import { TokenUseChip } from "@/components/token-use-label";
import { OriginLabel } from "@/components/trick-detail";
import { RepoAddRow, type RepoAddCall, type RepoListCall } from "@/components/tricks-repo-sheet";
import { useArm, useDisarmOn } from "@/hooks/use-arm";
import { useLocale } from "@/hooks/use-locale";
import { useOfficialList, useTrickWrites, type TrickWriteCalls } from "@/hooks/use-trick-writes";
import { t } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { useBridgeNow } from "@/lib/tricks/clock";
import { trickListRows, type TrickOrigin } from "@/lib/tricks/list-order";
import { placesLine, readsLine, runsOnLine, warningLines, type WarningLine } from "@/lib/tricks/row-words";
import { ACCESS_UNKNOWN, type OfficialTricksReply, type TricksRunsOn, type WireOfficialTrick, type WireTrickInfo } from "@/lib/tricks/schema";
import { tricksStore, useTricksState, type TricksStore } from "@/lib/tricks/store";
import { trickTimeText } from "@/lib/tricks/time";
import { trickTokenUse } from "@/lib/tricks/token-use";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { isReadOnly } from "@/lib/types";
import { cn } from "@/lib/utils";
import { trickDetailKey, trickDetailPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { useOpenTrickCard } from "@/components/trick-cards";
import { useTrickCards } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";

// Settings → Tricks and the Hill (M94 slice 04). One row per trick on this machine, each with one switch. Collie draws
// this page, not the trick: the words are Collie's, the trick's own name is the only text a trick supplies,
// and the switch works whatever state the trick is in, because it only writes the bridge's switch file
// (the same one `collie trick on|off` writes).
//
// A ROW IS THREE LINES, ALWAYS, so nothing moves when a trick changes state:
//   1. the trick's name;
//   2. its places, in words ("belt, page"), or "No parts" for a manifest that declares none. The
//      places are the manifest's declared kinds, not the parts held right now, so a trick that is off or
//      between runs does not change this line;
//   3. ONE slot, which reads the provenance (who added it, from where, when) for a healthy trick and the
//      masked last error for a trick that is failing or stopped, or the first refusal for a trick whose
//      manifest was refused, or "A new version waits for your yes." for a trick that is on and whose
//      folder moved past the version a person approved (it keeps running that version; the switch,
//      switched on again, approves the new one). Clipped to one line. The slot is reserved for all of
//      them, so the row is one height whether or not the trick is well.
//
// UNDER THEM, BEFORE THE SWITCH, THE WARNINGS (review 15). The bridge puts what a text search of the code
// flags on the row of a trick that is off or changed (bridge/tricks/scan.ts), one per kind. The row lists
// them in quiet words, with one line that they are a text search and not a proof, while the switch is off
// or the trick changed. They never refuse and never ask a second tap: the switch stays one tap. The list
// comes and goes through `Collapse`, the one way an in-flow part appears; a tap on the switch closes it.
// A bridge that sends no warnings (an older one) draws the three lines as before.
//
// THE CARD IS ABSENT UNLESS THE PHONE HOLDS A TRICKS REPLY. The store takes its first reply only when
// the snapshot carries `tricksRev`, and the bridge carries that only when a tricks folder exists, so an
// install without tricks draws no card and no index row (lib/tricks/store.ts `syncTricks`).
//
// THE SWITCH FLIPS AT ONCE and holds the new position until the store's list agrees (it reads the
// bridge's list on the snapshot's cadence). A refused or lost post puts it back and says so in the
// status line, which is the app's one transient channel (lib/status.ts).
//
// UNDER A TRICK THAT TOOK A CHANGE WITHOUT ASKING (crew slice 3). When the version that runs was taken without
// asking (`autoAt`, from a bridge since crew slice 3), a quiet line says when, with Undo beside it: one tap
// arms it ("Undo?"), a second one goes back to the version before (`useArm`, the Hill's Dismiss rule). A
// bridge that sends no `autoAt` draws no such row. The "Update this trick without asking" switch itself is not on
// the card: it is a group of the trick's details page, whose write (`flipAuto`, hooks/use-trick-writes.ts) flips at
// once and holds like the trick's own switch, so a failed post goes back and says so once.
//
// THE WHOLE ROW OPENS THE TRICK'S DETAILS PAGE (2026-11-12, a page since 2026-11-21), with a muted chevron after
// the name as the cue. The name is the one link (`ui/row-open.ts`): its stretched layer covers the row, so a tap on
// the description, the places, the source line or the empty space opens the details page, one level below this
// list (`settings/tricks/<host>:<id>`, routes/settings-trick.tsx, components/trick-detail.tsx). A link, so the
// phone's back returns here, where the page keeps its scroll (SettingsPage `keepScroll`). The switch, Add, Update and
// Undo are siblings of that link, lifted above the layer, and stay their own targets: a tap on them never opens it. A trick whose manifest has
// a `description` shows that one muted line (at most two lines) under its name; a row without one is drawn as before.
//
// ONE LIST, EACH TRICK ONCE (2026-11-12). The bridge's `GET /api/tricks/official` lists the official tricks
// this release can add, each with its state here. The card draws them and the installed tricks as one list in
// the order of `lib/tricks/list-order.ts`: the official ones first, in the release list's order (Morph
// first), then the community's by name. A row carries a small label, "Official" or "Community". An official
// entry that is not added holds its place with the shape of an installed row (its name, a link that opens
// its details page in the not-added mode, its one line, where it draws, where it comes from) and a small Add;
// after Add the installed trick takes the same place, under the same key, with its switch. A state change
// alters the row, never its place. An entry whose id another trick holds (`taken`) is no row of its own: that
// trick is a community row, and says why in one quiet line. When this release names a newer version
// (`update`) the row carries a quiet line with Update. A tap swaps the word for the spinner in the same slot
// and holds it until the trick shows among the installed ones (the store's list rides the snapshot's
// cadence), so the row never blinks out and back. A failure says why in the status line, as the switch does.
// THE ROWS WAIT FOR THE LIST'S FIRST ANSWER (or its failure), so no row is drawn in one place and moved to
// another a moment later. A crew member's list (`runsOn`) or one the phone could not read orders every trick
// by name and labels none. The list is read when the card mounts and again when the installed tricks change;
// it costs the bridge a read of its own folder, never a fetch.
//
// THE HILL IS NOT HERE. It had a built-in row above the person's tricks from 2026-11-11 to 2026-11-13; the Hill
// is an experiment now, and its one switch is on Settings, Tricks and the Hill (components/hill-switch-card.tsx). A row
// here says only that a trick's own Decisions wait for the Hill (`hillOff`). A card of Collie's own about a
// trick needs no Hill (M96 spec 14): a row whose new version waits opens that card from its slot line, and the
// cards about new tricks are a group of their own above this card (components/trick-cards.tsx).
//
// TRICKS SWITCHED OFF AS A WHOLE (2026-11-17, components/tricks-switch-card.tsx). The list stays readable and each
// row's switch shows that trick's OWN position, which the big switch never moves. Every control that writes is
// disabled (the switches, Add, Update, Undo and the details page's auto switch), one line at the top of the card
// says why, and the details page still opens. The bridge answers 409 `tricks-off` to those writes anyway.
//
// NO PROSE but the one muted line at the foot. What a trick may do is the docs' to say.

// The words of a row live in lib/tricks/row-words.ts, shared with the details page; they stay importable from here.
export { placesLine, readsLine, runsOnLine, warningLines, type WarningLine };
// The writes moved to hooks/use-trick-writes.ts, shared with the details page; these stay importable from here.
export { FACTS_REREAD_MS, HOLD_MS, officialFailureLine } from "@/hooks/use-trick-writes";

/** Whether the phone holds a tricks reply: the one condition for the card and for its index row. */
export function useTricksPresent(store: TricksStore = tricksStore): boolean {
  return useTricksState(store).rev !== null;
}

/** Who added the trick, from where and when: "Added by agent · 2 h ago", "From owner/repo @ 3f2a91c · 8 Nov, 09:38". */
export function provenanceLine(trick: WireTrickInfo, now: number): string {
  const by = trick.provenance;
  const what = whoWords(by);
  const time = by?.at === undefined ? null : trickTimeText(by.at, "ago", now);
  return time === null ? what : t("settings.tricks.withTime", { what, time });
}

function whoWords(by: WireTrickInfo["provenance"]): string {
  if (by?.proposed !== undefined) return by.proposed.by === "agent" ? t("settings.tricks.by.proposedAgent", { host: by.proposed.host }) : t("settings.tricks.by.proposedUnconfirmed", { host: by.proposed.host });
  if (by === undefined || by.via === "folder") return t("settings.tricks.by.folder");
  if (by.via === "cli") return t("settings.tricks.by.cli");
  if (by.via === "agent") return t("settings.tricks.by.agent");
  if (by.repo === undefined) return t("settings.tricks.by.repoNone");
  if (by.sha === undefined) return t("settings.tricks.by.repoBare", { repo: by.repo });
  // From the official repository, but not a version of the official list: never read as the list.
  return t(by.unlisted === true ? "settings.tricks.by.repoUnlisted" : "settings.tricks.by.repo", { repo: by.repo, sha: by.sha.slice(0, 7) });
}

/** The third line of a row, and whether it is a trouble report rather than a provenance. */
export interface SlotLine {
  text: string;
  trouble: boolean;
  /** The line says a new version waits for a yes: the row opens its card from it, when the phone holds one. */
  waits?: true;
}

/**
 * The third line: the reason a trick is not well (a trick stopped for its rights in the phone's own words,
 * fault B; a part the bridge refused, in any state), else that a new version waits for a yes (`pending`,
 * from a bridge since crew slice 2, or `versionWaits`: the phone holds an open card of Collie's own about a
 * new version of it; the row opens that card, with the Hill on or off, M96 spec 14), else the one note that
 * the Hill is off for a trick that is on and asks Decisions (`hillOff`, the snapshot's; bridge/tricks/hill.ts:
 * they are not posted, the trick keeps running), else that its file watch checks on a clock
 * (`watchPollSeconds`), else that the local API it reads through is off here (`accessOff`), else where it came from.
 */
export function slotLine(trick: WireTrickInfo, now: number, hillOff = false, versionWaits = false): SlotLine {
  if (trick.state === "skipped") {
    const reason = trick.refusals?.[0]?.reason ?? trick.error;
    return { text: reason === undefined ? t("settings.tricks.cannotRunBare") : t("settings.tricks.cannotRun", { reason }), trouble: true };
  }
  // A part the bridge refused, in every other state (the first full trick run, 2026-11-16, decision 5): the
  // trick runs, but what it drew is not shown, and the row is the one place that says why. Its own words
  // (`partNotShown`), not those of `skipped`; a note the parser only ignored is not a refusal. A reason is
  // a whole sentence that names its own key, so no path rides in front of it.
  const refused = trick.refusals?.find((r) => r.code !== "ignored" && r.code !== "more");
  // Fault B: the bridge's flag, in the phone's words; its `error` is the same line in the bridge's English.
  // Such a trick comes as off (stopped is not on): its switch shows off, and one tap on is the approval.
  if (trick.rightsMoved === true) return { text: t("settings.tricks.rightsMoved"), trouble: true };
  const failing = trick.state === "failing" || trick.state === "stopped";
  if (failing && trick.error !== undefined) return { text: trick.error, trouble: true };
  if (refused !== undefined) return { text: t("settings.tricks.partNotShown", { reason: refused.reason }), trouble: true };
  // Contract 3: a required setting is empty, or the saved ones do not read. The row opens the details page,
  // where the Settings group is. The trick still runs and draws its own setup part.
  if (trick.valuesUnread === true) return { text: t("settings.tricks.valuesUnread"), trouble: true };
  if (trick.needsSetup === true) return { text: t("settings.tricks.needsSetup"), trouble: false };
  // The new version's card is Collie's own: it needs no Hill (spec 14), and the row opens it.
  if (trick.on && (trick.pending !== undefined || versionWaits)) return { text: t("settings.tricks.pending"), trouble: false, waits: true };
  if (hillOff && trick.on && trick.decides === true) return { text: t("settings.tricks.hillOff"), trouble: false };
  // The file watch could not be set up and the bridge checks on a clock: one plain line of its own, never
  // after the "part is not shown" prefix, because nothing was refused. Only while the trick is on.
  if (trick.on && trick.watchPollSeconds !== undefined) return { text: t("settings.tricks.watchPolled", { seconds: trick.watchPollSeconds }), trouble: false };
  // The trick declares `access` and Collie's local API is off on this bridge: `t.api` answers an error. Said once.
  if (trick.on && trick.accessOff === true) return { text: t("settings.tricks.accessOff"), trouble: false };
  return { text: provenanceLine(trick, now), trouble: false };
}

export interface TricksSettingsCardProps extends TrickWriteCalls {
  /** The store the list is read from. The app's own by default; a test or the playground passes its own. */
  store?: TricksStore;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. */
  now?: number;
  /** Draw the switches as one that may not write, for the playground. Default: the device's own say. */
  readOnly?: boolean;
  /** Draw the rows as with the Hill switched off, for the playground. Default: the snapshot's `hillOff`. */
  hillOff?: boolean;
  /** Draw the list as with tricks switched off, for the playground. Default: the snapshot's `tricksOff`, or the reply's `off`. */
  tricksOff?: boolean;
  /** The official list read. The real route by default. */
  onOfficialList?: (signal?: AbortSignal) => Promise<OfficialTricksReply>;
  /** The read of a repository's trick list ("Add from a repository"). The real route by default. */
  onRepoList?: RepoListCall;
  /** The add of one trick of that list. The real route by default. */
  onRepoAdd?: RepoAddCall;
}

/** The Tricks card, or nothing while the phone holds no tricks reply. */
export function TricksSettingsCard(props: TricksSettingsCardProps) {
  const store = props.store ?? tricksStore;
  const state = useTricksState(store);
  if (state.rev === null) return null;
  // A Windows bridge runs no trick (bridge/tricks/service.ts `gated`): no rows and no list read. The switch
  // card above says the Windows line, once on the page (components/tricks-switch-card.tsx), so this card draws nothing.
  if (state.gate === "windows") return null;
  return <TricksList {...props} tricks={state.tricks} runsOn={state.runsOn} replyOff={state.off === true} />;
}

/** The warnings under a row: one quiet line each, then the line that they are a text search. */
function TrickWarnings({ lines }: { lines: readonly WarningLine[] }) {
  return (
    <div data-line="warnings" className="pt-2">
      <ul aria-label={t("settings.tricks.warn.label")} className="space-y-1">
        {lines.map((line) => (
          <li key={line.kind} data-warning={line.kind} className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Icon name="warning" className="mt-px size-3 shrink-0" />
            <span className="min-w-0">{line.text}</span>
          </li>
        ))}
      </ul>
      <p className="pt-1 text-xs text-muted-foreground">{t("settings.tricks.warn.honesty")}</p>
    </div>
  );
}

/** "Updated 3 min ago, automatically." for a version taken without asking, or null when there is none to undo. */
export function autoLine(trick: Pick<WireTrickInfo, "on" | "autoAt">, now: number): string | null {
  if (!trick.on || trick.autoAt === undefined) return null;
  const ago = trickTimeText(trick.autoAt, "ago", now);
  return ago === null ? null : t("settings.tricks.autoAt", { ago });
}

/** The row under a trick that is on and took a change without asking: when, and the Undo beside it. */
function TrickChanges({
  autoAt,
  line,
  canWrite,
  undoing,
  onUndo,
}: {
  autoAt: string | undefined;
  line: string;
  canWrite: boolean;
  undoing: boolean;
  onUndo: () => void;
}) {
  const { armed, tap, disarm } = useArm<"undo">();
  const undoArmed = armed === "undo";
  // An arm was for the version as it read when it was armed: a new one needs a new first tap.
  useDisarmOn(autoAt, disarm);
  return (
    <div data-line="changes" className="mt-3 border-t border-border pt-3">
      <div data-line="auto-at" className="flex min-h-11 items-center justify-between gap-4">
        <p className="min-w-0 truncate text-xs text-muted-foreground">{line}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="trick-undo"
          disabled={!canWrite || undoing}
          onClick={() => {
            if (tap("undo") === "fire") onUndo();
          }}
          className={cn(ROW_OPEN_CONTROL, "-mr-3 h-11 shrink-0 px-3", undoArmed ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive" : "text-muted-foreground")}
        >
          {/* Both words in one slot, sized by the wider, so arming moves nothing beside it (DESIGN.md §2). */}
          <OneOf
            active={undoArmed ? "armed" : "rest"}
            className="inline-grid"
            options={[
              { key: "rest", node: t("settings.tricks.undo") },
              { key: "armed", node: t("settings.tricks.undoArmed") },
            ]}
          />
        </Button>
      </div>
    </div>
  );
}

/** The quiet line under an installed trick when this release names a newer version of it, with Update beside it. */
function OfficialUpdateLine({ name, busy, canWrite, onUpdate }: { name: string; busy: boolean; canWrite: boolean; onUpdate: () => void }) {
  return (
    <div data-line="official-update" className="mt-3 border-t border-border pt-3">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <p className="min-w-0 text-xs text-muted-foreground">{t("settings.tricks.official.updateLine")}</p>
        <OfficialButton word={t("settings.tricks.official.update")} label={t("settings.tricks.official.updateAria", { name })} slot="official-update" busy={busy} canWrite={canWrite} onTap={onUpdate} />
      </div>
    </div>
  );
}

/** The small Add or Update: its word and the spinner share one slot, so the button keeps its size while it works. */
function OfficialButton({ word, label, slot, busy, canWrite, onTap }: { word: string; label: string; slot: string; busy: boolean; canWrite: boolean; onTap: () => void }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-slot={slot}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={!canWrite || busy}
      onClick={onTap}
      // The `::before` reaches the 44px floor above and below the 32px button (DESIGN.md §6).
      className={cn(ROW_OPEN_CONTROL, "shrink-0 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']")}
    >
      <OneOf
        active={busy ? "busy" : "rest"}
        className="inline-grid place-items-center"
        options={[
          { key: "rest", node: word },
          { key: "busy", node: <Icon name="busy" className="size-4 animate-spin" aria-hidden /> },
        ]}
      />
    </Button>
  );
}

/**
 * THE NAME LINE OF A ROW (2026-11-12): the name with its chevron, then the labels (Official or Community, and
 * "Uses agent tokens") as ONE group. The line wraps: the labels stay beside the name while they fit, else
 * the whole group moves to a line of its own right under the name. So a name is never cut while a second
 * line has room; only a name wider than the line alone truncates, and the chip cuts its words only when the
 * group alone is wider than the row. The labels are the trick's facts, the same before and after Add and
 * whether it is on, so a row's height follows its width and language, never its state.
 */
const NAME_LINE = "flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-left font-medium";

/** The labels' group: one flex item, never split across lines; the chip inside it shrinks last. */
const LABELS = "flex max-w-full min-w-0 items-center gap-1";

/** The name and the chevron: the name keeps its width up to the line's, then truncates. */
function RowName({ name }: { name: string }) {
  return (
    <span data-slot="row-name" className="flex max-w-full min-w-0 items-center gap-1">
      <span className="min-w-0 truncate">{name}</span>
      {/* The cue that the name opens something: the app's own "this row opens another screen" glyph. */}
      <Icon name="row-go" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </span>
  );
}

/** The quiet line of a community trick whose id an official entry names: why that entry is not added here. */
export function takenLine(entry: Pick<WireOfficialTrick, "changed" | "unlisted">): string {
  if (entry.changed === true) return t("settings.tricks.official.changed");
  return t(entry.unlisted === true ? "settings.tricks.official.takenRepo" : "settings.tricks.official.taken");
}

/** The link a row's name is: to the details page, with the list as the entry it came from, so Back steps back here. */
function RowLink({ to, name, slot, children }: { to: string; name: string; slot: string; children: ReactNode }) {
  const { pathname, search } = useLocation();
  return (
    <Link to={to} state={{ from: `${pathname}${search}` }} data-slot={slot} data-row-open="" aria-label={t("settings.tricks.about.open", { name })} className={cn(ROW_OPEN_BUTTON, NAME_LINE)}>
      {children}
    </Link>
  );
}

/**
 * An official entry that is not added yet, in the shape of an installed row, so Add changes the row and moves
 * nothing: the name (it opens the details page), the label, its one line, where it draws, where it comes from, and Add.
 */
function OfficialRow({ entry, busy, canWrite, onAdd, to }: { entry: WireOfficialTrick; busy: boolean; canWrite: boolean; onAdd: () => void; to: string }) {
  const places = entry.places ?? [];
  const view = entry.agentView === true;
  return (
    <div data-official={entry.id} className={cn(ROW_OPEN_ROW, "px-4 py-3")}>
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <RowLink to={to} name={entry.name} slot="official-about">
            <RowName name={entry.name} />
            <span data-slot="row-labels" className={LABELS}>
              <OriginLabel origin="official" />
              {trickTokenUse(entry) !== null && <TokenUseChip />}
            </span>
          </RowLink>
          <p data-line="description" className="line-clamp-2 break-words text-sm text-muted-foreground">
            {entry.description}
          </p>
          {(places.length > 0 || view) && (
            <p data-line="places" className="truncate text-sm text-muted-foreground">
              {placesLine(places, view)}
            </p>
          )}
          <p data-line="slot" className="truncate text-xs text-muted-foreground">
            {t("settings.tricks.by.repo", { repo: entry.repoName, sha: entry.commit.slice(0, 7) })}
          </p>
        </div>
        <OfficialButton word={t("settings.tricks.official.add")} label={t("settings.tricks.official.addAria", { name: entry.name })} slot="official-add" busy={busy} canWrite={canWrite} onTap={onAdd} />
      </div>
    </div>
  );
}

interface TrickRowProps {
  trick: WireTrickInfo;
  clock: number;
  checked: boolean;
  canWrite: boolean;
  hillOff: boolean;
  undoing: boolean;
  onFlip: (on: boolean) => void;
  onUndo: () => void;
  /** The trick's details page. */
  to: string;
  /** This release names a newer version of the trick (official `update`), and whether its update is in flight. */
  update?: { busy: boolean; onUpdate: () => void } | undefined;
  /** Where the trick comes from, for the label after its name. Undefined: not known, no label. */
  origin?: TrickOrigin | undefined;
  /** An official entry of this id that the trick holds (`taken`): the row says why it is not the list's. */
  taken?: WireOfficialTrick | undefined;
  /** Opens the open card of Collie's own about a new version of this trick, when the phone holds one (spec 14). */
  onCard?: (() => void) | undefined;
}

/**
 * The slot line as its own target, above the row's stretched layer: it opens the waiting version's card. The
 * line keeps its drawn height; a transparent `::before` reaches 14px above and below, the 44px floor
 * (DESIGN.md §6), as a Notice's action does (ui/notice.tsx `NOTICE_ACTION_TAP`).
 *
 * The button itself never clips: `truncate` is `overflow: hidden`, and on the button it would cut the
 * `::before` to the drawn 16px (the tap floor would be lost, the row's layer would take those taps) and make the
 * box scrollable by its 14px, so a scroll (a focus, a script) moved the glyphs out of sight and left only the
 * underline. The text sits in an inner `SLOT_OPENS_TEXT` block that truncates, as the plain `<p>` line does.
 */
const SLOT_OPENS = "relative z-10 block w-full text-left text-xs text-muted-foreground underline decoration-dotted underline-offset-2 before:absolute before:inset-x-0 before:-inset-y-3.5 before:content-['']";
const SLOT_OPENS_TEXT = "block truncate";

function TrickRow({ trick, clock, checked, canWrite, hillOff, undoing, onFlip, onUndo, to, update, origin, taken, onCard }: TrickRowProps) {
  const slot = slotLine(trick, clock, hillOff, onCard !== undefined);
  const changed = autoLine(trick, clock);
  const warnings = warningLines(trick);
  // Before the switch: off, or on with code nobody approved yet. A tap on the switch closes the list.
  const showWarnings = warnings.length > 0 && (!checked || trick.changed === true);
  return (
    <div data-trick={trick.id} className={cn(ROW_OPEN_ROW, "px-4 py-3")}>
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* The name is the link to the details page, and its stretched layer is the whole row (ui/row-open.ts): the
              lines under it are no controls, so a tap on any of them opens the page. */}
          <RowLink to={to} name={trick.name} slot="trick-about">
            <RowName name={trick.name} />
            {(origin !== undefined || trickTokenUse(trick) !== null) && (
              <span data-slot="row-labels" className={LABELS}>
                {origin !== undefined && <OriginLabel origin={origin} />}
                {trickTokenUse(trick) !== null && <TokenUseChip />}
              </span>
            )}
          </RowLink>
          {trick.description !== undefined && (
            <p data-line="description" className="line-clamp-2 break-words text-sm text-muted-foreground">
              {trick.description}
            </p>
          )}
          <p data-line="places" className="truncate text-sm text-muted-foreground">
            {placesLine(trick.places, trick.agentView === true)}
          </p>
          {trick.rulesUnshown === true && (
            <p data-line="rules-unshown" className="break-words text-xs text-muted-foreground">
              {t("settings.tricks.about.rulesUnshown")}
            </p>
          )}
          {trick.access === ACCESS_UNKNOWN && (
            <p data-line="access-unknown" className="break-words text-xs text-muted-foreground">
              {t("settings.tricks.about.access.unknown")}
            </p>
          )}
          {trick.inputs !== undefined && (
            <p data-line="reads" className="break-words text-xs text-muted-foreground">
              {readsLine(trick.inputs)}
            </p>
          )}
          {slot.waits === true && onCard !== undefined ? (
            <button type="button" data-line="slot" data-slot="trick-card-open" onClick={onCard} className={SLOT_OPENS}>
              <span className={SLOT_OPENS_TEXT}>{slot.text}</span>
            </button>
          ) : (
            <p data-line="slot" data-trouble={slot.trouble ? "true" : undefined} className="truncate text-xs text-muted-foreground">
              {slot.text}
            </p>
          )}
          {taken !== undefined && (
            <p data-line="taken" className="text-xs text-muted-foreground">
              {takenLine(taken)}
            </p>
          )}
          <Collapse open={showWarnings}>{showWarnings ? <TrickWarnings lines={warnings} /> : null}</Collapse>
        </div>
        {/* Rules this phone cannot show (review 8 V-N5), or a level of access it does not know (review 3, item 4): no
            yes from here; a trick that is on can still go off. */}
        <Switch checked={checked} onCheckedChange={onFlip} disabled={!canWrite || ((trick.rulesUnshown === true || trick.access === ACCESS_UNKNOWN) && !checked)} aria-label={trick.name} className={ROW_OPEN_SWITCH} />
      </div>
      {trick.on && changed !== null && <TrickChanges autoAt={trick.autoAt} line={changed} canWrite={canWrite} undoing={undoing} onUndo={onUndo} />}
      {update !== undefined && <OfficialUpdateLine name={trick.name} busy={update.busy} canWrite={canWrite} onUpdate={update.onUpdate} />}
    </div>
  );
}

/**
 * What a row that throws draws instead: the trick's id as text and the same switch, in the same frame. The
 * off switch works whatever state a trick is in, so a row that cannot be drawn still keeps it. Only the id,
 * the host and the switch's own state are read here.
 */
function SwitchOnlyRow({ id, checked, canWrite, onFlip }: { id: string; checked: boolean; canWrite: boolean; onFlip: (on: boolean) => void }) {
  return (
    <div data-trick={id} data-fallback="" className="flex min-h-11 items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1 truncate font-medium">{id}</div>
      <Switch checked={checked} onCheckedChange={onFlip} disabled={!canWrite} aria-label={id} />
    </div>
  );
}

function TricksList({
  tricks,
  runsOn,
  onOfficialList,
  onRepoList,
  onRepoAdd,
  now,
  readOnly,
  hillOff,
  tricksOff,
  replyOff = false,
  ...calls
}: TricksSettingsCardProps & { tricks: readonly WireTrickInfo[]; runsOn?: TricksRunsOn; replyOff?: boolean }) {
  useLocale();
  const clock = useBridgeNow(now);
  const root = useOptionalRootData();
  const scope = useScope();
  const offHill = hillOff ?? root?.hillOff === true;
  // The open cards of Collie's own about a trick (spec 14): a new version's opens from its trick's row.
  const cards = useTrickCards();
  const openCard = useOpenTrickCard();
  const { refused } = usePairing();
  const mayWrite = readOnly === undefined ? !isReadOnly(root?.device) && !refused : !readOnly;
  // Tricks switched off as a whole (the snapshot's `tricksOff`, or the reply's `off`): the rows stay readable
  // and the details page opens, but every control that writes is disabled, because the bridge would refuse it.
  const off = tricksOff ?? (root?.tricksOff === true || replyOff);
  const canWrite = mayWrite && !off;
  const official = useOfficialList(onOfficialList, tricks);
  const writes = useTrickWrites(calls, tricks, official);
  const { adding } = writes;

  const rows = trickListRows(tricks, official.list);
  const officialUpdates = new Map((official.list?.tricks ?? []).filter((e) => e.state === "update" || adding.get(e.id) === "update").map((e) => [e.id, e]));

  return (
    <Card className="gap-0 py-0" data-testid="tricks-settings">
      {/* Said once, here, for every disabled control below. */}
      {off && (
        <p data-line="tricks-off" className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
          {t("settings.tricks.switch.offLineTricks")}
        </p>
      )}
      {/* A crew member, a deputy or a deposed lead schedules no trick: the lead does (bridge/index.ts). */}
      {runsOn !== undefined && (
        <p data-line="runs-on" className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
          {runsOnLine(runsOn)}
        </p>
      )}
      <div data-slot="list-group">
        {/* No trick and no official entry: the empty line and the command. */}
        {official.settled && rows.length === 0 && (
          <div className="px-4 py-3">
            <p className="text-sm text-muted-foreground">{t("settings.tricks.none")}</p>
            {/* The command is a literal, not a sentence: it is typed on the machine, so it is never translated. */}
            <p className="truncate font-mono text-xs text-muted-foreground">collie trick init &lt;id&gt;</p>
          </div>
        )}
        {/* The rows wait for the official list's first answer, so none is drawn in one place and moved later. */}
        {official.settled &&
          rows.map((row) => {
            if (row.kind === "official") {
              const entry = row.entry;
              // An add the list already says, while the trick is not listed yet, keeps its spinner.
              const busy = adding.has(entry.id) || entry.state !== "absent";
              return <OfficialRow key={row.key} entry={entry} busy={busy} canWrite={canWrite} onAdd={() => void writes.addOfficial(entry, "add")} to={trickDetailPath(entry.id, scope)} />;
            }
            const trick = row.trick;
            const checked = writes.checkedOf(trick);
            const onFlip = (on: boolean) => void writes.flip(trick, on);
            // One boundary per row: a row that throws leaves the others drawn, and keeps its own switch.
            return (
              <TrickBoundary
                key={row.key}
                fallback="none"
                fallbackNode={<SwitchOnlyRow id={String(trick.id)} checked={checked} canWrite={canWrite} onFlip={onFlip} />}
                resetKey={trick}
              >
                <TrickRow
                  trick={trick}
                  clock={clock}
                  checked={checked}
                  canWrite={canWrite}
                  hillOff={offHill}
                  undoing={writes.undoing(trick)}
                  onFlip={onFlip}
                  onUndo={() => void writes.undo(trick)}
                  to={trickDetailPath(trickDetailKey(trick.host, trick.id), scope)}
                  update={officialUpdate(trick)}
                  origin={row.origin}
                  taken={row.entry?.state === "taken" ? row.entry : undefined}
                  onCard={versionCardOpener(cards, trick, openCard)}
                />
              </TrickBoundary>
            );
          })}
        {/* A crew member runs no trick, so it adds none (runsOn). */}
        {official.settled && runsOn === undefined && <RepoAddRow tricksOff={off} readOnly={!mayWrite} onList={onRepoList} onAdd={onRepoAdd} />}
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t("settings.tricks.foot")}</p>
    </Card>
  );

  function officialUpdate(trick: WireTrickInfo): TrickRowProps["update"] {
    const entry = officialUpdates.get(trick.id);
    if (entry === undefined || official.list?.runsOn !== undefined) return undefined;
    return { busy: adding.get(trick.id) === "update", onUpdate: () => void writes.addOfficial(entry, "update") };
  }
}

/**
 * The opener of the open card about a new version of `trick` (a version the runner found, or one a proposal
 * sent), or undefined when the phone holds none. A card about a NEW trick has no row of its own: it is in
 * the group above (components/trick-cards.tsx).
 */
export function versionCardOpener(cards: readonly HillDecision[], trick: Pick<WireTrickInfo, "id">, open: (decision: HillDecision) => void): (() => void) | undefined {
  const card = cards.find((decision) => decision.from.ref?.id === trick.id && (decision.from.ref.type === "version" || decision.from.ref.type === "proposal"));
  return card === undefined ? undefined : () => open(card);
}
