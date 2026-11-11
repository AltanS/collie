import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { Switch } from "@/components/ui/switch";
import { OfficialTrickAboutSheet, TrickAboutSheet } from "@/components/trick-about-sheet";
import { SectionLabel } from "@/components/ui/section-label";
import { useArm } from "@/hooks/use-arm";
import { useLocale } from "@/hooks/use-locale";
import { addOfficialTrick, apiErrorFields, fetchOfficialTricks, setTrickAuto, switchTrick, undoTrick } from "@/lib/api";
import { t } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { useBridgeNow } from "@/lib/tricks/clock";
import { placesLine, readsLine, runsOnLine, warningLines, type WarningLine } from "@/lib/tricks/row-words";
import type { OfficialState, OfficialTricksReply, TricksRunsOn, WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";
import { tricksStore, useTricksState, type TricksStore } from "@/lib/tricks/store";
import { trickTimeText } from "@/lib/tricks/time";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";
import { cn } from "@/lib/utils";

// Settings → Tricks (M94 slice 04). One row per trick on this machine, each with one switch. Collie draws
// this page, not the trick: the words are Collie's, the trick's own name is the only text a trick supplies,
// and the switch works whatever state the trick is in, because it only writes the bridge's switch file
// (the same one `collie trick on|off` writes).
//
// A ROW IS THREE LINES, ALWAYS, so nothing moves when a trick changes state:
//   1. the trick's name;
//   2. its places, in words ("belt, session"), or "No parts" for a manifest that declares none. The
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
// bridge that sends no `autoAt` draws no such row. The "Take changes without asking" switch itself is not on
// the card: it is the last group of the trick's About sheet. The card still owns that write (`flipAuto`),
// which flips at once and holds like the trick's own switch, so a failed post goes back and says so once.
//
// A TRICK'S NAME IS A BUTTON (About sheet), with a muted chevron after it as the cue. A tap on the name opens
// a bottom sheet with the trick's full description (components/trick-about-sheet.tsx). The switch stays its
// own tap target. A trick whose manifest has a `description` shows that one muted line (at most two lines)
// under its name; a row without one is drawn as before.
//
// FROM COLLIE, UNDER THE INSTALLED TRICKS (M94). The bridge's `GET /api/tricks/official` lists the official
// tricks this release can add, each with its state here. A section labelled "Official tricks" holds one row per
// entry that is not added: the name (a button that opens the About sheet in its not-added mode), its one
// line, and a small Add. An entry whose id another trick holds (`taken`) is drawn muted with no Add, and
// says so. An entry already added is not in the section: it is a trick row above, and when this release
// names a newer version (`update`) that row carries a quiet line with Update. A tap swaps the word for the
// spinner in the same slot and holds it until the trick shows among the installed ones (the store's list
// rides the snapshot's cadence), so the row never blinks out and back. A failure says why in the status
// line, as the switch does. An empty list, a crew member's (`runsOn`), or a list the phone could not read
// draws no section. The list is read when the card mounts and again when the installed tricks change; it
// costs the bridge a read of its own folder, never a fetch.
//
// NO PROSE but the one muted line at the foot. What a trick may do is the docs' to say.

// The words of a row live in lib/tricks/row-words.ts, shared with the About sheet; they stay importable from here.
export { placesLine, readsLine, runsOnLine, warningLines, type WarningLine };

/** How long a flipped switch keeps its position while the store's list has not caught up. */
export const HOLD_MS = 20_000;

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
}

/**
 * The third line: the reason a trick is not well, else that a new version waits for a yes (`pending`,
 * from a bridge since crew slice 2), else the one note that the Hill is off for a trick that is on and
 * asks Decisions (`hillOff`, the snapshot's; bridge/tricks/hill.ts: they are not posted, the trick keeps
 * running), else where it came from.
 */
export function slotLine(trick: WireTrickInfo, now: number, hillOff = false): SlotLine {
  if (trick.state === "skipped") {
    const reason = trick.refusals?.[0]?.reason ?? trick.error;
    return { text: reason === undefined ? t("settings.tricks.refusedBare") : t("settings.tricks.refused", { reason }), trouble: true };
  }
  const failing = trick.state === "failing" || trick.state === "stopped";
  if (failing && trick.error !== undefined) return { text: trick.error, trouble: true };
  if (trick.on && trick.pending !== undefined) return { text: t("settings.tricks.pending"), trouble: false };
  if (hillOff && trick.on && trick.decides === true) return { text: t("settings.tricks.hillOff"), trouble: false };
  return { text: provenanceLine(trick, now), trouble: false };
}

const trickKey = (trick: Pick<WireTrickInfo, "host" | "id">): string => `${trick.host}/${trick.id}`;

export interface TricksSettingsCardProps {
  /** The store the list is read from. The app's own by default; a test or the playground passes its own. */
  store?: TricksStore;
  /** The switch call. The real route by default. */
  onSwitch?: (host: string, id: string, on: boolean) => Promise<WireTrickInfo>;
  /** The take-changes-without-asking call. The real route by default. */
  onAuto?: (host: string, id: string, on: boolean) => Promise<WireTrickInfo>;
  /** The undo call. The real route by default. */
  onUndo?: (host: string, id: string) => Promise<WireTrickInfo>;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. */
  now?: number;
  /** Draw the switches as one that may not write, for the playground. Default: the device's own say. */
  readOnly?: boolean;
  /** Draw the rows as with the Hill switched off, for the playground. Default: the snapshot's `hillOff`. */
  hillOff?: boolean;
  /** The official list read. The real route by default. */
  onOfficialList?: (signal?: AbortSignal) => Promise<OfficialTricksReply>;
  /** The add or update from that list. The real route by default. */
  onOfficialAdd?: (id: string, mode: "add" | "update") => Promise<{ id: string; state: OfficialState }>;
}

/** The Tricks card, or nothing while the phone holds no tricks reply. */
export function TricksSettingsCard(props: TricksSettingsCardProps) {
  const store = props.store ?? tricksStore;
  const state = useTricksState(store);
  if (state.rev === null) return null;
  return <TricksList {...props} tricks={state.tricks} runsOn={state.runsOn} />;
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
  trick,
  line,
  canWrite,
  undoing,
  onUndo,
}: {
  trick: WireTrickInfo;
  line: string;
  canWrite: boolean;
  undoing: boolean;
  onUndo: () => void;
}) {
  const { armed, tap, disarm } = useArm<"undo">();
  const undoArmed = armed === "undo";
  // An arm was for the version as it read when it was armed: a new one needs a new first tap.
  useEffect(() => disarm(), [trick.autoAt, disarm]);
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
          className={cn("-mr-3 h-11 shrink-0 px-3", undoArmed ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive" : "text-muted-foreground")}
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
      className="relative shrink-0 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']"
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

/** One official row: the name opens the About sheet, the line under it, and Add; a taken one says so instead. */
function OfficialRow({ entry, busy, canWrite, onAdd, onAbout }: { entry: WireOfficialTrick; busy: boolean; canWrite: boolean; onAdd: () => void; onAbout: () => void }) {
  const taken = entry.state === "taken" && !busy;
  return (
    <div data-official={entry.id} data-state={taken ? "taken" : undefined} className="px-4 py-3">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          {taken ? (
            <p className="truncate font-medium text-muted-foreground">{entry.name}</p>
          ) : (
            <button
              type="button"
              data-slot="official-about"
              aria-label={t("settings.tricks.about.open", { name: entry.name })}
              aria-haspopup="dialog"
              onClick={onAbout}
              className="relative flex w-full items-center gap-1 text-left font-medium before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-['']"
            >
              <span className="min-w-0 truncate">{entry.name}</span>
              <Icon name="row-go" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          )}
          <p data-line="description" className="line-clamp-2 break-words text-sm text-muted-foreground">
            {entry.description}
          </p>
          {taken && (
            <p data-line="taken" className="text-xs text-muted-foreground">
              {t(entry.changed === true ? "settings.tricks.official.changed" : entry.unlisted === true ? "settings.tricks.official.takenRepo" : "settings.tricks.official.taken")}
            </p>
          )}
        </div>
        {!taken && <OfficialButton word={t("settings.tricks.official.add")} label={t("settings.tricks.official.addAria", { name: entry.name })} slot="official-add" busy={busy} canWrite={canWrite} onTap={onAdd} />}
      </div>
    </div>
  );
}

/** The status line for a failed add or update, from the bridge's `error` word. */
export function officialFailureLine<TThrown>(thrown: TThrown, mode: "add" | "update", name: string): string {
  const code = apiErrorFields(thrown)?.error;
  const add = mode === "add";
  if (code === "unreachable") return t(add ? "settings.tricks.official.unreachable" : "settings.tricks.official.updateUnreachable");
  // A repository that sent more than a listed commit can be is the same class of refusal as a mismatch.
  if (code === "mismatch" || code === "too-large") return t(add ? "settings.tricks.official.mismatch" : "settings.tricks.official.updateMismatch");
  if (code === "busy") return t("settings.tricks.official.busy");
  if (code === "taken") return t("settings.tricks.official.taken");
  // The new code needs a name the person's own files hold in the trick's folder: nothing was changed.
  if (code === "blocked" && !add) return t("settings.tricks.official.updateBlocked");
  // A version of the list whose files the person changed: Collie never moves or removes them.
  if (code === "changed") return t("settings.tricks.official.changed");
  return add ? t("settings.tricks.official.failed", { name }) : t("settings.tricks.official.updateFailed", { name });
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
  onAbout: () => void;
  /** This release names a newer version of the trick (official `update`), and whether its update is in flight. */
  update?: { busy: boolean; onUpdate: () => void } | undefined;
}

function TrickRow({ trick, clock, checked, canWrite, hillOff, undoing, onFlip, onUndo, onAbout, update }: TrickRowProps) {
  const slot = slotLine(trick, clock, hillOff);
  const changed = autoLine(trick, clock);
  const warnings = warningLines(trick);
  // Before the switch: off, or on with code nobody approved yet. A tap on the switch closes the list.
  const showWarnings = warnings.length > 0 && (!checked || trick.changed === true);
  return (
    <div data-trick={trick.id} className="px-4 py-3">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* The name is the About button. The `::before` reaches the 44px floor above and below the 24px line
              (DESIGN.md §6) without growing the row: the places line under it is not a control. */}
          <button
            type="button"
            data-slot="trick-about"
            aria-label={t("settings.tricks.about.open", { name: trick.name })}
            aria-haspopup="dialog"
            onClick={onAbout}
            className="relative flex w-full items-center gap-1 text-left font-medium before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-['']"
          >
            <span className="min-w-0 truncate">{trick.name}</span>
            {/* The cue that the name opens something: the app's own "this row opens another screen" glyph. */}
            <Icon name="row-go" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
          {trick.description !== undefined && (
            <p data-line="description" className="line-clamp-2 break-words text-sm text-muted-foreground">
              {trick.description}
            </p>
          )}
          <p data-line="places" className="truncate text-sm text-muted-foreground">
            {placesLine(trick.places, trick.agentView === true)}
          </p>
          {/* The one note of an agent view (contract 2): this build reads the keys; the view itself comes later. */}
          {trick.agentView === true && (
            <p data-line="later" className="break-words text-xs text-muted-foreground">
              {t("settings.tricks.agentView.later")}
            </p>
          )}
          {trick.inputs !== undefined && (
            <p data-line="reads" className="break-words text-xs text-muted-foreground">
              {readsLine(trick.inputs)}
            </p>
          )}
          <p data-line="slot" data-trouble={slot.trouble ? "true" : undefined} className="truncate text-xs text-muted-foreground">
            {slot.text}
          </p>
          <Collapse open={showWarnings}>{showWarnings ? <TrickWarnings lines={warnings} /> : null}</Collapse>
        </div>
        <Switch checked={checked} onCheckedChange={onFlip} disabled={!canWrite} aria-label={trick.name} />
      </div>
      {trick.on && changed !== null && <TrickChanges trick={trick} line={changed} canWrite={canWrite} undoing={undoing} onUndo={onUndo} />}
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
  onSwitch = switchTrick,
  onAuto = setTrickAuto,
  onUndo = undoTrick,
  onOfficialList = fetchOfficialTricks,
  onOfficialAdd = addOfficialTrick,
  now,
  readOnly,
  hillOff,
}: TricksSettingsCardProps & { tricks: readonly WireTrickInfo[]; runsOn?: TricksRunsOn }) {
  useLocale();
  const clock = useBridgeNow(now);
  const root = useOptionalRootData();
  const offHill = hillOff ?? root?.hillOff === true;
  const { refused } = usePairing();
  const canWrite = readOnly === undefined ? !isReadOnly(root?.device) && !refused : !readOnly;
  // The position a flipped switch holds until the list agrees, and the switches with a post in flight
  // (a second tap on one of those does nothing; the switch itself stays drawn the same).
  const [held, setHeld] = useState<ReadonlyMap<string, boolean>>(new Map());
  // The same for the take-changes-without-asking switch, and the Undo posts in flight.
  const [heldAuto, setHeldAuto] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [undoing, setUndoing] = useState<ReadonlySet<string>>(new Set());
  // The trick whose About sheet is open, by key. The list's own entry is read at draw time, so the sheet
  // follows a new version of the row, and closes by itself when the trick leaves the list.
  const [aboutKey, setAboutKey] = useState<string | null>(null);
  const flying = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const official = useOfficialList(onOfficialList, tricks);
  // The official adds and updates in flight or held until the lists agree, by trick id.
  const [adding, setAdding] = useState<ReadonlyMap<string, "add" | "update">>(new Map());
  // The official entry whose About sheet is open, by id.
  const [officialAboutId, setOfficialAboutId] = useState<string | null>(null);

  useEffect(() => {
    const open = timers.current;
    return () => {
      for (const timer of open) clearTimeout(timer);
      open.clear();
    };
  }, []);

  // The list caught up with a position that was held: the store speaks again.
  useEffect(() => {
    const caughtUp = tricks.filter((trick) => held.get(trickKey(trick)) === trick.on).map(trickKey);
    if (caughtUp.length === 0) return;
    setHeld((was) => {
      const next = new Map(was);
      for (const key of caughtUp) next.delete(key);
      return next;
    });
  }, [tricks, held]);

  // The list caught up with an auto position that was held.
  useEffect(() => {
    const caughtUp = tricks.filter((trick) => heldAuto.get(trickKey(trick)) === (trick.auto === true)).map(trickKey);
    if (caughtUp.length === 0) return;
    setHeldAuto((was) => {
      const next = new Map(was);
      for (const key of caughtUp) next.delete(key);
      return next;
    });
  }, [tricks, heldAuto]);

  function holdAuto(key: string, on: boolean | null): void {
    setHeldAuto((was) => {
      const next = new Map(was);
      if (on === null) next.delete(key);
      if (on !== null) next.set(key, on);
      return next;
    });
  }

  async function flipAuto(trick: WireTrickInfo, on: boolean): Promise<void> {
    const key = `auto:${trickKey(trick)}`;
    if (flying.current.has(key)) return;
    holdAuto(trickKey(trick), on);
    flying.current.add(key);
    try {
      const info = await onAuto(trick.host, trick.id, on);
      holdAuto(trickKey(trick), info.auto === true);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        holdAuto(trickKey(trick), null);
      }, HOLD_MS);
      timers.current.add(timer);
    } catch {
      holdAuto(trickKey(trick), null);
      setStatus(t("settings.tricks.auto.failed", { name: trick.name }), "error");
    } finally {
      flying.current.delete(key);
    }
  }

  async function undo(trick: WireTrickInfo): Promise<void> {
    const key = trickKey(trick);
    if (undoing.has(key)) return;
    setUndoing((was) => new Set(was).add(key));
    try {
      // The row is the receipt: the line goes once the list shows the earlier version.
      await onUndo(trick.host, trick.id);
    } catch {
      setStatus(t("settings.tricks.undoFailed", { name: trick.name }), "error");
    } finally {
      setUndoing((was) => {
        const next = new Set(was);
        next.delete(key);
        return next;
      });
    }
  }

  function hold(key: string, on: boolean | null): void {
    setHeld((was) => {
      const next = new Map(was);
      if (on === null) next.delete(key);
      if (on !== null) next.set(key, on);
      return next;
    });
  }

  async function flip(trick: WireTrickInfo, on: boolean): Promise<void> {
    const key = trickKey(trick);
    if (flying.current.has(key)) return;
    hold(key, on);
    flying.current.add(key);
    try {
      const info = await onSwitch(trick.host, trick.id, on);
      hold(key, info.on);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        hold(key, null);
      }, HOLD_MS);
      timers.current.add(timer);
    } catch {
      hold(key, null);
      setStatus(t("settings.tricks.switchFailed", { name: trick.name }), "error");
    } finally {
      flying.current.delete(key);
    }
  }

  function release(id: string): void {
    setAdding((was) => {
      if (!was.has(id)) return was;
      const next = new Map(was);
      next.delete(id);
      return next;
    });
  }

  // An add is done when the trick is among the installed ones; an update when the list says it is added.
  // Until then the row keeps its spinner, so it never blinks out and back between the two lists.
  useEffect(() => {
    for (const [id, mode] of adding) {
      if (flying.current.has(`official:${id}`)) continue;
      const entry = official.list?.tricks.find((e) => e.id === id);
      const installed = tricks.some((trick) => trick.id === id);
      if (mode === "add" ? installed && entry?.state !== "absent" : entry?.state === "added") release(id);
    }
  }, [adding, official.list, tricks]);

  async function addOfficial(entry: WireOfficialTrick, mode: "add" | "update"): Promise<void> {
    const key = `official:${entry.id}`;
    if (flying.current.has(key) || adding.has(entry.id)) return;
    flying.current.add(key);
    setAdding((was) => new Map(was).set(entry.id, mode));
    try {
      await onOfficialAdd(entry.id, mode);
      setOfficialAboutId((open) => (open === entry.id ? null : open));
      // A hold that never sees the lists agree (a store that stopped polling) lets go after a while.
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        release(entry.id);
      }, HOLD_MS);
      timers.current.add(timer);
    } catch (error) {
      release(entry.id);
      setStatus(officialFailureLine(error, mode, entry.name), "error");
    } finally {
      flying.current.delete(key);
      official.reread();
    }
  }

  const aboutTrick = aboutKey === null ? undefined : tricks.find((trick) => trickKey(trick) === aboutKey);
  const officialRows = official.list?.runsOn !== undefined ? [] : (official.list?.tricks ?? []).filter((e) => e.state === "absent" || e.state === "taken" || adding.get(e.id) === "add");
  const officialUpdates = new Map((official.list?.tricks ?? []).filter((e) => e.state === "update" || adding.get(e.id) === "update").map((e) => [e.id, e]));
  const officialAbout = officialAboutId === null ? undefined : officialRows.find((e) => e.id === officialAboutId && e.state !== "taken");

  return (
    <>
      <Card className="gap-0 py-0" data-testid="tricks-settings">
        {/* A crew member, a deputy or a deposed lead schedules no trick: the lead does (bridge/index.ts). */}
        {runsOn !== undefined && (
          <p data-line="runs-on" className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
            {runsOnLine(runsOn)}
          </p>
        )}
        <div data-slot="list-group">
          {/* A fresh install (no tricks folder yet) with an official list: the card holds only the list. */}
          {tricks.length === 0 && officialRows.length === 0 && (
            <div className="px-4 py-3">
              <p className="text-sm text-muted-foreground">{t("settings.tricks.none")}</p>
              {/* The command is a literal, not a sentence: it is typed on the machine, so it is never translated. */}
              <p className="truncate font-mono text-xs text-muted-foreground">collie trick init &lt;id&gt;</p>
            </div>
          )}
          {tricks.map((trick) => {
            const checked = held.get(trickKey(trick)) ?? trick.on;
            const onFlip = (on: boolean) => void flip(trick, on);
            // One boundary per row: a row that throws leaves the others drawn, and keeps its own switch.
            return (
              <TrickBoundary
                key={trickKey(trick)}
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
                  undoing={undoing.has(trickKey(trick))}
                  onFlip={onFlip}
                  onUndo={() => void undo(trick)}
                  onAbout={() => setAboutKey(trickKey(trick))}
                  update={officialUpdate(trick)}
                />
              </TrickBoundary>
            );
          })}
        </div>
        {officialRows.length > 0 && (
          <div data-section="official" className={cn("pt-3", (tricks.length > 0 || runsOn !== undefined) && "border-t border-border")}>
            <SectionLabel placement="above" className="px-4">
              {t("settings.tricks.official.label")}
            </SectionLabel>
            <div data-slot="list-group">
              {officialRows.map((entry) => (
                <OfficialRow
                  key={entry.id}
                  entry={entry}
                  busy={adding.has(entry.id)}
                  canWrite={canWrite}
                  onAdd={() => void addOfficial(entry, "add")}
                  onAbout={() => setOfficialAboutId(entry.id)}
                />
              ))}
            </div>
          </div>
        )}
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t("settings.tricks.foot")}</p>
      </Card>
      {/* Its own boundary: a sheet that throws closes, and the card and its switches stay drawn. */}
      {aboutTrick !== undefined && (
        <TrickBoundary fallback="none" resetKey={aboutTrick}>
          <TrickAboutSheet
            trick={aboutTrick}
            runsOn={runsOn}
            open
            onClose={() => setAboutKey(null)}
            auto={heldAuto.get(trickKey(aboutTrick)) ?? aboutTrick.auto === true}
            canWrite={canWrite}
            onAuto={(on) => void flipAuto(aboutTrick, on)}
          />
        </TrickBoundary>
      )}
      {officialAbout !== undefined && (
        <TrickBoundary fallback="none" resetKey={officialAbout}>
          <OfficialTrickAboutSheet
            entry={officialAbout}
            open
            onClose={() => setOfficialAboutId(null)}
            busy={adding.has(officialAbout.id)}
            canWrite={canWrite}
            onAdd={() => void addOfficial(officialAbout, "add")}
          />
        </TrickBoundary>
      )}
    </>
  );

  function officialUpdate(trick: WireTrickInfo): TrickRowProps["update"] {
    const entry = officialUpdates.get(trick.id);
    if (entry === undefined || official.list?.runsOn !== undefined) return undefined;
    return { busy: adding.get(trick.id) === "update", onUpdate: () => void addOfficial(entry, "update") };
  }
}

/**
 * The official list as the card shows it: read once on mount and again whenever the installed tricks
 * change (an id or a commit), or when `reread` asks. A read that fails keeps what the card had, and the
 * first one that fails leaves no list, so no section is drawn.
 */
/** What the card holds of the official list. */
interface OfficialListState {
  list: OfficialTricksReply | null;
  reread: () => void;
}

function useOfficialList(read: (signal?: AbortSignal) => Promise<OfficialTricksReply>, tricks: readonly WireTrickInfo[]): OfficialListState {
  const [list, setList] = useState<OfficialTricksReply | null>(null);
  const [asked, setAsked] = useState(0);
  const installed = tricks.map((trick) => `${trick.id}@${trick.provenance?.sha ?? ""}`).join(",");
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const reply = await reader.current(controller.signal);
        if (!controller.signal.aborted) setList(reply);
      } catch {
        // A failed read keeps what the card had: no list, no section.
      }
    })();
    return () => controller.abort();
  }, [installed, asked]);
  return { list, reread: () => setAsked((n) => n + 1) };
}
