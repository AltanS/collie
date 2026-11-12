import type { ReactNode } from "react";

import { sessionOfMark } from "@/components/belt-trick-mark";
import { Collapse } from "@/components/ui/collapse";
import { TabBarExtraItem, type TabBarExtra } from "@/components/ui/tab-bar";
import { TileStrip, TileStripItem } from "@/components/ui/tile-strip";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { useBridgeNow } from "@/lib/tricks/clock";
import { isPastWindow } from "@/lib/tricks/frame";
import { trickIconOf } from "@/lib/tricks/icons";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { partKey, type PlaceItem, type WireTrickPart } from "@/lib/tricks/schema";
import { useTrickPart, useTrickParts, tricksStore, type TricksStore } from "@/lib/tricks/store";
import { inkOf } from "@/lib/tricks/tone";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE TRICKS' ITEMS ON THE DASHBOARD (2026-11-10, the owner's pick "A5" from the Hill look playground).
// Two places of a trick's `item` (lib/tricks/schema.ts `PlaceItem`): an icon over a short name, an
// optional badge and a tone.
//
// - `dashboard`: one tile per trick in a strip at the top of the Dashboard view's list, under the
//   header and above the summary line (`TrickDashboardStrip`, on `ui/tile-strip.tsx`). No strip at all
//   while no trick has a `dashboard` part; it arrives and leaves through `Collapse` (DESIGN.md §11).
// - `tabbar`: one item per trick in the Dashboard's bottom bar, after the Hill, in the bar's scrolling
//   run (`trickTabbarExtras`, on `ui/tab-bar.tsx` `TabBarExtraItem`).
//
// THE ITEM IS NOT A CONTROL OF THE TRICK. It has no intent and no status shape. A tap opens the trick's
// own session when it has one, one level down, as a belt mark with no intent does; without one the item
// is drawn the same and takes no tap. Past its fresh window the item loses its tone (lib/tricks/tone.ts).
// Each item stands in its own `TrickBoundary` (fallback none), so an item that throws draws nothing and
// leaves its neighbours drawn, as the belt's marks do.

interface ItemFacts {
  item: PlaceItem;
  /** The trick's id, the item's `data-trick` handle. */
  trickId: string;
  trickName: string;
  stale: boolean;
  /** The icon in the item's ink: the part's icon, else the trick's own. */
  glyph: ReactNode;
  /** The whole name for a screen reader, the badge included. */
  name: string;
}

/** What one held part of a place draws, or null when the part is not held or not of that place. */
function useItemFacts(key: string, at: "dashboard" | "tabbar", store: TricksStore, glyphClass: string): ItemFacts | null {
  const { part, trick } = useTrickPart(key, store);
  const now = useBridgeNow();
  const value = part?.value;
  if (part === undefined || value === undefined || value.at !== at) return null;
  const item = value.item;
  // A part that arrived with no `item` (or one that is no object) draws nothing, as a part that is not held does.
  if (item === undefined || item === null) return null;
  const trickName = trick?.name ?? part.trick;
  const stale = part.stale === true || isPastWindow(part, now);
  const Glyph = trickIconOf(item.icon ?? trick?.icon);
  const glyph = <Glyph aria-hidden className={cn(glyphClass, inkOf(item.tone, stale))} />;
  const face = item.badge === undefined || item.badge === 0 ? item.label : `${item.label} ${item.badge}`;
  return { item, trickId: part.trick, trickName, stale, glyph, name: t("tricks.mark.named", { trick: trickName, face }) };
}

function DashboardTile({ partKey: key, session, onOpenSession, store }: { partKey: string; session: AgentView | undefined; onOpenSession: (pane: AgentView) => void; store: TricksStore }) {
  useLocale();
  const facts = useItemFacts(key, "dashboard", store, "size-5");
  if (facts === null) return null;
  const data = { "data-trick": facts.trickId, "data-stale": facts.stale ? "true" : undefined };
  if (session === undefined) return <TileStripItem label={facts.item.label} icon={facts.glyph} badge={facts.item.badge} name={facts.name} data={data} />;
  return (
    <TileStripItem
      label={facts.item.label}
      icon={facts.glyph}
      badge={facts.item.badge}
      name={`${facts.name}. ${t("tricks.mark.open", { trick: facts.trickName })}`}
      onSelect={() => onOpenSession(session)}
      data={data}
    />
  );
}

/**
 * The strip of `dashboard` tiles, in manifest order (`useTrickParts`). Nothing at all while no trick has
 * a `dashboard` part. The Dashboard view's only; the route draws it on no other tab.
 */
export function TrickDashboardStrip({
  sessions,
  onOpenSession,
  store = tricksStore,
}: {
  /** The trick sessions (`HomeData.trickSessions`), where a tap goes. */
  sessions: readonly AgentView[];
  onOpenSession: (pane: AgentView) => void;
  store?: TricksStore;
}) {
  useLocale();
  const parts = useTrickParts("dashboard", undefined, store);
  return (
    <Collapse open={parts.length > 0}>
      {parts.length > 0 ? (
        <div data-slot="trick-dashboard-strip" className="border-b border-border py-2">
          <TileStrip label={t("tricks.space.title")}>
            {parts.map((part) => {
              const key = partKey(part);
              return (
                // One boundary per tile: a tile that throws leaves the strip's other tiles drawn, and draws nothing itself.
                <TrickBoundary key={key} fallback="none" resetKey={`${key}@${part.rev}`}>
                  <DashboardTile partKey={key} session={sessionOfMark(part, sessions)} onOpenSession={onOpenSession} store={store} />
                </TrickBoundary>
              );
            })}
          </TileStrip>
        </div>
      ) : null}
    </Collapse>
  );
}

function TabbarItem({
  partKey: key,
  session,
  onOpenSession,
  current,
  store,
}: {
  partKey: string;
  session: AgentView | undefined;
  onOpenSession: (pane: AgentView) => void;
  current: boolean;
  store: TricksStore;
}) {
  useLocale();
  const facts = useItemFacts(key, "tabbar", store, "size-5");
  if (facts === null) return null;
  const data = { "data-trick": facts.trickId, "data-stale": facts.stale ? "true" : undefined };
  if (session === undefined) return <TabBarExtraItem label={facts.item.label} icon={facts.glyph} badge={facts.item.badge} name={facts.name} current={current} data={data} />;
  return (
    <TabBarExtraItem
      label={facts.item.label}
      icon={facts.glyph}
      badge={facts.item.badge}
      name={`${facts.name}. ${t("tricks.mark.open", { trick: facts.trickName })}`}
      onSelect={() => onOpenSession(session)}
      current={current}
      data={data}
    />
  );
}

/** A trick by its address: the host that runs it and its id. */
export interface TrickRef {
  host: string;
  trick: string;
}

/**
 * The bar's scrolling run of `tabbar` items, ready for `TabBar` `extras`, in the caller's order (the
 * manifest order of `useTrickParts`). `current` names the trick whose Session the bar is drawn on: its
 * item wears the selected look.
 */
export function trickTabbarExtras(opts: {
  parts: readonly WireTrickPart[];
  sessions: readonly AgentView[];
  onOpenSession: (pane: AgentView) => void;
  current?: TrickRef;
  store?: TricksStore;
}): TabBarExtra[] {
  const store = opts.store ?? tricksStore;
  const { current } = opts;
  return opts.parts.map((part) => {
    const key = partKey(part);
    const on = current !== undefined && current.host === part.host && current.trick === part.trick;
    return {
      key,
      // One boundary per item: an item that throws leaves the bar's other items drawn, and draws nothing itself.
      node: (
        <TrickBoundary fallback="none" resetKey={`${key}@${part.rev}`}>
          <TabbarItem partKey={key} session={sessionOfMark(part, opts.sessions)} onOpenSession={opts.onOpenSession} current={on} store={store} />
        </TrickBoundary>
      ),
    };
  });
}
