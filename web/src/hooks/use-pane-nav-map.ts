import { useMemo } from "react";

import { useOptionalRootData } from "@/lib/route-data";
import { navLayoutOf, type NavLayout } from "@/lib/pane-nav-gesture";
import type { Scope } from "@/lib/scope";
import type { AgentView, ServerSummary, TabView } from "@/lib/types";
import { columnKeyOf, EMPTY_STRIP, landingOf, spaceKeyOf, spacesInOrder, type Places } from "@/lib/wide-layout";
import { useSpaceStrips } from "@/lib/wide-layout-store";

const NO_SCOPE: Scope = {};

/** One space of the navigation map, as the overlay draws it. */
export interface NavMapSpace {
  readonly label: string;
  readonly panes: readonly AgentView[];
}

/** The map a navigation gesture moves over (ADR 0121), and how to read a key of it back. */
export interface PaneNavMap {
  /** The map with the cursor on the pane on screen, or null when that pane is in no space. */
  readonly layout: NavLayout | null;
  /** Each space's label and panes, index for index with `layout.spaces`. */
  readonly spaces: readonly NavMapSpace[];
  /** The pane a map key stands for. */
  readonly paneOf: (key: string) => AgentView | undefined;
  /** Where the pane lives, for `panePath`: its own machine and session. */
  readonly places: Places;
}

interface Options {
  agent: AgentView | undefined;
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
  tabs: readonly TabView[] | undefined;
  servers: readonly ServerSummary[] | undefined;
  /** The route's scope; absent is the ambient one. */
  scope: Scope | undefined;
}

/**
 * The spaces and panes the gesture moves through, in the order the space header and the sidebar use
 * (lib/wide-layout.ts `spacesInOrder`), keyed on each pane's full address. A move into another space
 * lands where the space header's up and down land (`landingOf`): the pane that space last had in focus
 * on a large screen, else its first pane. So the gesture and the header never disagree.
 */
export function usePaneNavMap({ agent, agents, shellPanes, tabs, servers, scope }: Options): PaneNavMap {
  const sessions = useOptionalRootData()?.sessions;
  const stored = useSpaceStrips();
  return useMemo(() => {
    const places: Places = { scope: scope ?? NO_SCOPE, servers, sessions };
    const groups = spacesInOrder(agents, shellPanes, { order: "fixed", tabs, servers });
    const byKey = new Map<string, AgentView>();
    const defs = groups.map((g) => {
      const keys = g.panes.map((p) => {
        const key = columnKeyOf(p, places);
        byKey.set(key, p);
        return key;
      });
      const first = g.panes[0];
      const strip = first === undefined ? EMPTY_STRIP : (stored.get(spaceKeyOf(first, places)) ?? EMPTY_STRIP);
      return { panes: keys, landing: landingOf(strip, keys) };
    });
    const here = agent === undefined ? null : columnKeyOf(agent, places);
    return {
      layout: here === null ? null : navLayoutOf(defs, here),
      spaces: groups.map((g) => ({ label: g.label, panes: g.panes })),
      paneOf: (key: string) => byKey.get(key),
      places,
    };
  }, [agent, agents, shellPanes, tabs, servers, sessions, scope, stored]);
}
