import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { Switch } from "@/components/ui/switch";
import { useArm } from "@/hooks/use-arm";
import { useLocale } from "@/hooks/use-locale";
import { setTrickAuto, switchTrick, undoTrick } from "@/lib/api";
import { t, type MessageKey } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { useBridgeNow } from "@/lib/tricks/clock";
import { TRICK_WARNING_KINDS, TRICK_WARNINGS_MAX, type PlaceKind, type TrickWarningKind, type TricksRunsOn, type WireTrickInfo } from "@/lib/tricks/schema";
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
// UNDER A TRICK THAT IS ON, ITS CHANGES (crew slice 3). One more row, drawn for every trick that is on and
// for none that is off, so a row keeps its height while its trick stays on: "Take changes without asking"
// with its hint and a switch (the field `collie trick auto` writes; it flips at once and holds like the
// trick's own switch). When the version that runs was taken without asking (`autoAt`, from a bridge since
// crew slice 3), a quiet line says when, with Undo beside it: one tap arms it ("Undo?"), a second one
// goes back to the version before (`useArm`, the Hill's Dismiss rule). A bridge that sends no `auto`
// draws the switch off; one that sends no `autoAt` draws no Undo line.
//
// NO PROSE but the one muted line at the foot. What a trick may do is the docs' to say.

/** How long a flipped switch keeps its position while the store's list has not caught up. */
export const HOLD_MS = 20_000;

/** Whether the phone holds a tricks reply: the one condition for the card and for its index row. */
export function useTricksPresent(store: TricksStore = tricksStore): boolean {
  return useTricksState(store).rev !== null;
}

/** The place words of a trick, each kind once, in the manifest's order. */
export function placesLine(places: readonly PlaceKind[] | undefined): string {
  // A trick entry with no `places` (an older bridge, a broken reply) is a manifest that declares none.
  const held: readonly PlaceKind[] = Array.isArray(places) ? places : [];
  const words = [...new Set(held)].map((place) => t(`settings.tricks.place.${place}` satisfies MessageKey));
  return words.length === 0 ? t("settings.tricks.places.none") : words.join(", ");
}

/** Who added the trick, from where and when: "Added by agent · 2 h ago", "From owner/repo @ 3f2a91c · 8 Nov, 09:38". */
export function provenanceLine(trick: WireTrickInfo, now: number): string {
  const by = trick.provenance;
  const what = whoWords(by);
  const time = by?.at === undefined ? null : trickTimeText(by.at, "ago", now);
  return time === null ? what : t("settings.tricks.withTime", { what, time });
}

function whoWords(by: WireTrickInfo["provenance"]): string {
  if (by === undefined || by.via === "folder") return t("settings.tricks.by.folder");
  if (by.via === "cli") return t("settings.tricks.by.cli");
  if (by.via === "agent") return t("settings.tricks.by.agent");
  if (by.repo === undefined) return t("settings.tricks.by.repoNone");
  if (by.sha === undefined) return t("settings.tricks.by.repoBare", { repo: by.repo });
  return t("settings.tricks.by.repo", { repo: by.repo, sha: by.sha.slice(0, 7) });
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

/** One warning as the row shows it: the phone's own words for a kind it knows, the bridge's for another. */
export interface WarningLine {
  kind: string;
  text: string;
}

function isKnownKind(kind: string): kind is TrickWarningKind {
  return TRICK_WARNING_KINDS.some((known) => known === kind);
}

/**
 * The warnings a trick's row carries, in the phone's own words for a kind it knows and the bridge's for
 * another. The wire reader (lib/tricks/wire.ts `readWarnings`) already left out a malformed entry.
 */
export function warningLines(trick: Pick<WireTrickInfo, "warnings">): WarningLine[] {
  const held = Array.isArray(trick.warnings) ? trick.warnings.slice(0, TRICK_WARNINGS_MAX) : [];
  return held.map(({ kind, text }) => ({ kind, text: isKnownKind(kind) ? t(`settings.tricks.warn.${kind}` satisfies MessageKey) : text }));
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

/** The changes row under a trick that is on: the auto switch with its hint, and the Undo line when there is one. */
function TrickChanges({
  trick,
  clock,
  auto,
  canWrite,
  undoing,
  onAuto,
  onUndo,
}: {
  trick: WireTrickInfo;
  clock: number;
  auto: boolean;
  canWrite: boolean;
  undoing: boolean;
  onAuto: (on: boolean) => void;
  onUndo: () => void;
}) {
  const { armed, tap, disarm } = useArm<"undo">();
  const line = autoLine(trick, clock);
  const undoArmed = armed === "undo";
  // An arm was for the version as it read when it was armed: a new one needs a new first tap.
  useEffect(() => disarm(), [trick.autoAt, disarm]);
  return (
    <div data-line="changes" className="mt-3 border-t border-border pt-3">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm">{t("settings.tricks.auto.label")}</div>
          <p className="text-xs text-muted-foreground">{t("settings.tricks.auto.hint")}</p>
        </div>
        <Switch checked={auto} onCheckedChange={onAuto} disabled={!canWrite} aria-label={t("settings.tricks.auto.label")} />
      </div>
      {line !== null && (
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
      )}
    </div>
  );
}

interface TrickRowProps {
  trick: WireTrickInfo;
  clock: number;
  checked: boolean;
  auto: boolean;
  canWrite: boolean;
  hillOff: boolean;
  undoing: boolean;
  onFlip: (on: boolean) => void;
  onAuto: (on: boolean) => void;
  onUndo: () => void;
}

/** What a contract 2 trick reads, in one sentence: schema.ts `inputsSentence` in the phone's words. */
export function readsLine(inputs: NonNullable<WireTrickInfo["inputs"]>): string {
  const globs = inputs.globs.join(", ");
  return inputs.crew ? t("settings.tricks.reads.crew", { globs }) : t("settings.tricks.reads.solo", { globs });
}

function TrickRow({ trick, clock, checked, auto, canWrite, hillOff, undoing, onFlip, onAuto, onUndo }: TrickRowProps) {
  const slot = slotLine(trick, clock, hillOff);
  const warnings = warningLines(trick);
  // Before the switch: off, or on with code nobody approved yet. A tap on the switch closes the list.
  const showWarnings = warnings.length > 0 && (!checked || trick.changed === true);
  return (
    <div data-trick={trick.id} className="px-4 py-3">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{trick.name}</div>
          <p data-line="places" className="truncate text-sm text-muted-foreground">
            {placesLine(trick.places)}
          </p>
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
      {trick.on && <TrickChanges trick={trick} clock={clock} auto={auto} canWrite={canWrite} undoing={undoing} onAuto={onAuto} onUndo={onUndo} />}
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

/** "Tricks run on the lead of this crew (desk). This machine runs none." for a bridge that runs none. */
export function runsOnLine(runsOn: TricksRunsOn): string {
  return runsOn.lead === undefined ? t("settings.tricks.runsOn") : t("settings.tricks.runsOn.lead", { lead: runsOn.lead });
}

function TricksList({
  tricks,
  runsOn,
  onSwitch = switchTrick,
  onAuto = setTrickAuto,
  onUndo = undoTrick,
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
  const flying = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

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

  return (
    <Card className="gap-0 py-0" data-testid="tricks-settings">
      {/* A crew member, a deputy or a deposed lead schedules no trick: the lead does (bridge/index.ts). */}
      {runsOn !== undefined && (
        <p data-line="runs-on" className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
          {runsOnLine(runsOn)}
        </p>
      )}
      <div data-slot="list-group">
        {tricks.length === 0 && (
          <div className="px-4 py-3">
            <p className="text-sm text-muted-foreground">{t("settings.tricks.none")}</p>
            {/* The command is a literal, not a sentence: it is typed on the machine, so it is never translated. */}
            <p className="truncate font-mono text-xs text-muted-foreground">collie trick init &lt;id&gt;</p>
          </div>
        )}
        {tricks.map((trick) => {
          const checked = held.get(trickKey(trick)) ?? trick.on;
          const auto = heldAuto.get(trickKey(trick)) ?? trick.auto === true;
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
                auto={auto}
                canWrite={canWrite}
                hillOff={offHill}
                undoing={undoing.has(trickKey(trick))}
                onFlip={onFlip}
                onAuto={(on) => void flipAuto(trick, on)}
                onUndo={() => void undo(trick)}
              />
            </TrickBoundary>
          );
        })}
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t("settings.tricks.foot")}</p>
    </Card>
  );
}
