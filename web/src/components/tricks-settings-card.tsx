import { useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { switchTrick } from "@/lib/api";
import { t, type MessageKey } from "@/lib/i18n";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { useBridgeNow } from "@/lib/tricks/clock";
import type { PlaceKind, WireTrickInfo } from "@/lib/tricks/schema";
import { tricksStore, useTricksState, type TricksStore } from "@/lib/tricks/store";
import { trickTimeText } from "@/lib/tricks/time";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";

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
//      manifest was refused. Clipped to one line. The slot is reserved for both, so the row is one
//      height whether or not the trick is well.
//
// THE CARD IS ABSENT UNLESS THE PHONE HOLDS A TRICKS REPLY. The store takes its first reply only when
// the snapshot carries `tricksRev`, and the bridge carries that only when a tricks folder exists, so an
// install without tricks draws no card and no index row (lib/tricks/store.ts `syncTricks`).
//
// THE SWITCH FLIPS AT ONCE and holds the new position until the store's list agrees (it reads the
// bridge's list on the snapshot's cadence). A refused or lost post puts it back and says so in the
// status line, which is the app's one transient channel (lib/status.ts).
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

/** The third line: the reason a trick is not well, or else where it came from. */
export function slotLine(trick: WireTrickInfo, now: number): SlotLine {
  if (trick.state === "skipped") {
    const reason = trick.refusals?.[0]?.reason ?? trick.error;
    return { text: reason === undefined ? t("settings.tricks.refusedBare") : t("settings.tricks.refused", { reason }), trouble: true };
  }
  const failing = trick.state === "failing" || trick.state === "stopped";
  if (failing && trick.error !== undefined) return { text: trick.error, trouble: true };
  return { text: provenanceLine(trick, now), trouble: false };
}

const trickKey = (trick: Pick<WireTrickInfo, "host" | "id">): string => `${trick.host}/${trick.id}`;

export interface TricksSettingsCardProps {
  /** The store the list is read from. The app's own by default; a test or the playground passes its own. */
  store?: TricksStore;
  /** The switch call. The real route by default. */
  onSwitch?: (host: string, id: string, on: boolean) => Promise<WireTrickInfo>;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. */
  now?: number;
  /** Draw the switches as one that may not write, for the playground. Default: the device's own say. */
  readOnly?: boolean;
}

/** The Tricks card, or nothing while the phone holds no tricks reply. */
export function TricksSettingsCard(props: TricksSettingsCardProps) {
  const store = props.store ?? tricksStore;
  const state = useTricksState(store);
  if (state.rev === null) return null;
  return <TricksList {...props} tricks={state.tricks} />;
}

function TrickRow({ trick, clock, checked, canWrite, onFlip }: { trick: WireTrickInfo; clock: number; checked: boolean; canWrite: boolean; onFlip: (on: boolean) => void }) {
  const slot = slotLine(trick, clock);
  return (
    <div data-trick={trick.id} className="flex min-h-11 items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{trick.name}</div>
        <p data-line="places" className="truncate text-sm text-muted-foreground">
          {placesLine(trick.places)}
        </p>
        <p data-line="slot" data-trouble={slot.trouble ? "true" : undefined} className="truncate text-xs text-muted-foreground">
          {slot.text}
        </p>
      </div>
      <Switch checked={checked} onCheckedChange={onFlip} disabled={!canWrite} aria-label={trick.name} />
    </div>
  );
}

function TricksList({ tricks, onSwitch = switchTrick, now, readOnly }: TricksSettingsCardProps & { tricks: readonly WireTrickInfo[] }) {
  useLocale();
  const clock = useBridgeNow(now);
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const canWrite = readOnly === undefined ? !isReadOnly(root?.device) && !refused : !readOnly;
  // The position a flipped switch holds until the list agrees, and the switches with a post in flight
  // (a second tap on one of those does nothing; the switch itself stays drawn the same).
  const [held, setHeld] = useState<ReadonlyMap<string, boolean>>(new Map());
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
      <div data-slot="list-group">
        {tricks.length === 0 && (
          <div className="px-4 py-3">
            <p className="text-sm text-muted-foreground">{t("settings.tricks.none")}</p>
            {/* The command is a literal, not a sentence: it is typed on the machine, so it is never translated. */}
            <p className="truncate font-mono text-xs text-muted-foreground">collie trick init &lt;id&gt;</p>
          </div>
        )}
        {tricks.map((trick) => (
          // One boundary per row: a row that throws leaves the others, and the switches of the others, drawn.
          <TrickBoundary key={trickKey(trick)} fallback="none" resetKey={trick}>
            <TrickRow trick={trick} clock={clock} checked={held.get(trickKey(trick)) ?? trick.on} canWrite={canWrite} onFlip={(on) => void flip(trick, on)} />
          </TrickBoundary>
        ))}
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t("settings.tricks.foot")}</p>
    </Card>
  );
}
