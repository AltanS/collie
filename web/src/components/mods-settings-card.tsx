import { useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { switchMod } from "@/lib/api";
import { t, type MessageKey } from "@/lib/i18n";
import { useBridgeNow } from "@/lib/mods/clock";
import type { PlaceKind, WireModInfo } from "@/lib/mods/schema";
import { modsStore, useModsState, type ModsStore } from "@/lib/mods/store";
import { modTimeText } from "@/lib/mods/time";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";

// Settings → Mods (M94 slice 04). One row per mod on this machine, each with one switch. Collie draws
// this page, not the mod: the words are Collie's, the mod's own name is the only text a mod supplies,
// and the switch works whatever state the mod is in, because it only writes the bridge's switch file
// (the same one `collie mod on|off` writes).
//
// A ROW IS THREE LINES, ALWAYS, so nothing moves when a mod changes state:
//   1. the mod's name;
//   2. its places, in words ("belt, session"), or "No parts" for a manifest that declares none. The
//      places are the manifest's declared kinds, not the parts held right now, so a mod that is off or
//      between runs does not change this line;
//   3. ONE slot, which reads the provenance (who added it, from where, when) for a healthy mod and the
//      masked last error for a mod that is failing or stopped, or the first refusal for a mod whose
//      manifest was refused. Clipped to one line. The slot is reserved for both, so the row is one
//      height whether or not the mod is well.
//
// THE CARD IS ABSENT UNLESS THE PHONE HOLDS A MODS REPLY. The store takes its first reply only when
// the snapshot carries `modsRev`, and the bridge carries that only when a mods folder exists, so an
// install without mods draws no card and no index row (lib/mods/store.ts `syncMods`).
//
// THE SWITCH FLIPS AT ONCE and holds the new position until the store's list agrees (it reads the
// bridge's list on the snapshot's cadence). A refused or lost post puts it back and says so in the
// status line, which is the app's one transient channel (lib/status.ts).
//
// NO PROSE but the one muted line at the foot. What a mod may do is the docs' to say.

/** How long a flipped switch keeps its position while the store's list has not caught up. */
export const HOLD_MS = 20_000;

/** Whether the phone holds a mods reply: the one condition for the card and for its index row. */
export function useModsPresent(store: ModsStore = modsStore): boolean {
  return useModsState(store).rev !== null;
}

/** The place words of a mod, each kind once, in the manifest's order. */
export function placesLine(places: readonly PlaceKind[]): string {
  const words = [...new Set(places)].map((place) => t(`settings.mods.place.${place}` satisfies MessageKey));
  return words.length === 0 ? t("settings.mods.places.none") : words.join(", ");
}

/** Who added the mod, from where and when: "Added by agent · 2 h ago", "From owner/repo @ 3f2a91c · 8 Nov, 09:38". */
export function provenanceLine(mod: WireModInfo, now: number): string {
  const by = mod.provenance;
  const what = whoWords(by);
  const time = by?.at === undefined ? null : modTimeText(by.at, "ago", now);
  return time === null ? what : t("settings.mods.withTime", { what, time });
}

function whoWords(by: WireModInfo["provenance"]): string {
  if (by === undefined || by.via === "folder") return t("settings.mods.by.folder");
  if (by.via === "cli") return t("settings.mods.by.cli");
  if (by.via === "agent") return t("settings.mods.by.agent");
  if (by.repo === undefined) return t("settings.mods.by.repoNone");
  if (by.sha === undefined) return t("settings.mods.by.repoBare", { repo: by.repo });
  return t("settings.mods.by.repo", { repo: by.repo, sha: by.sha.slice(0, 7) });
}

/** The third line of a row, and whether it is a trouble report rather than a provenance. */
export interface SlotLine {
  text: string;
  trouble: boolean;
}

/** The third line: the reason a mod is not well, or else where it came from. */
export function slotLine(mod: WireModInfo, now: number): SlotLine {
  if (mod.state === "skipped") {
    const reason = mod.refusals?.[0]?.reason ?? mod.error;
    return { text: reason === undefined ? t("settings.mods.refusedBare") : t("settings.mods.refused", { reason }), trouble: true };
  }
  const failing = mod.state === "failing" || mod.state === "stopped";
  if (failing && mod.error !== undefined) return { text: mod.error, trouble: true };
  return { text: provenanceLine(mod, now), trouble: false };
}

const modKey = (mod: Pick<WireModInfo, "host" | "id">): string => `${mod.host}/${mod.id}`;

export interface ModsSettingsCardProps {
  /** The store the list is read from. The app's own by default; a test or the playground passes its own. */
  store?: ModsStore;
  /** The switch call. The real route by default. */
  onSwitch?: (host: string, id: string, on: boolean) => Promise<WireModInfo>;
  /** Pin the clock (epoch ms on the bridge's clock), for a test or a playground card. */
  now?: number;
  /** Draw the switches as one that may not write, for the playground. Default: the device's own say. */
  readOnly?: boolean;
}

/** The Mods card, or nothing while the phone holds no mods reply. */
export function ModsSettingsCard(props: ModsSettingsCardProps) {
  const store = props.store ?? modsStore;
  const state = useModsState(store);
  if (state.rev === null) return null;
  return <ModsList {...props} mods={state.mods} />;
}

function ModsList({ mods, onSwitch = switchMod, now, readOnly }: ModsSettingsCardProps & { mods: readonly WireModInfo[] }) {
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
    const caughtUp = mods.filter((mod) => held.get(modKey(mod)) === mod.on).map(modKey);
    if (caughtUp.length === 0) return;
    setHeld((was) => {
      const next = new Map(was);
      for (const key of caughtUp) next.delete(key);
      return next;
    });
  }, [mods, held]);

  function hold(key: string, on: boolean | null): void {
    setHeld((was) => {
      const next = new Map(was);
      if (on === null) next.delete(key);
      if (on !== null) next.set(key, on);
      return next;
    });
  }

  async function flip(mod: WireModInfo, on: boolean): Promise<void> {
    const key = modKey(mod);
    if (flying.current.has(key)) return;
    hold(key, on);
    flying.current.add(key);
    try {
      const info = await onSwitch(mod.host, mod.id, on);
      hold(key, info.on);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        hold(key, null);
      }, HOLD_MS);
      timers.current.add(timer);
    } catch {
      hold(key, null);
      setStatus(t("settings.mods.switchFailed", { name: mod.name }), "error");
    } finally {
      flying.current.delete(key);
    }
  }

  return (
    <Card className="gap-0 py-0" data-testid="mods-settings">
      <div data-slot="list-group">
        {mods.length === 0 && (
          <div className="px-4 py-3">
            <p className="text-sm text-muted-foreground">{t("settings.mods.none")}</p>
            {/* The command is a literal, not a sentence: it is typed on the machine, so it is never translated. */}
            <p className="truncate font-mono text-xs text-muted-foreground">collie mod init &lt;id&gt;</p>
          </div>
        )}
        {mods.map((mod) => {
          const key = modKey(mod);
          const slot = slotLine(mod, clock);
          return (
            <div key={key} data-mod={mod.id} className="flex min-h-11 items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{mod.name}</div>
                <p data-line="places" className="truncate text-sm text-muted-foreground">
                  {placesLine(mod.places)}
                </p>
                <p data-line="slot" data-trouble={slot.trouble ? "true" : undefined} className="truncate text-xs text-muted-foreground">
                  {slot.text}
                </p>
              </div>
              <Switch
                checked={held.get(key) ?? mod.on}
                onCheckedChange={(on) => void flip(mod, on)}
                disabled={!canWrite}
                aria-label={mod.name}
              />
            </div>
          );
        })}
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t("settings.mods.foot")}</p>
    </Card>
  );
}
