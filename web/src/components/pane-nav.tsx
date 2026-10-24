import { useState, type ReactNode } from "react";

import { PaneNavHandle, PaneNavOverlay } from "@/components/pane-nav-overlay";
import type { PaneNav } from "@/hooks/use-display-prefs";
import { useNav } from "@/hooks/use-nav";
import { usePaneNavGesture } from "@/hooks/use-pane-nav-gesture";
import { usePaneNavMap } from "@/hooks/use-pane-nav-map";
import { panePath } from "@/lib/nav";
import { keyAt, type NavLayout } from "@/lib/pane-nav-gesture";
import type { Scope } from "@/lib/scope";
import type { AgentView, ServerSummary, TabView } from "@/lib/types";
import { columnKeyOf, scopeOfPane } from "@/lib/wide-layout";

// PANE NAVIGATION BY GESTURE, AS THE PANE SCREEN USES IT (M70 spec 03, ADR 0121). One hook that joins
// the map (hooks/use-pane-nav-map.ts), the touches (hooks/use-pane-nav-gesture.ts), the overlay and the
// joystick handle (components/pane-nav-overlay.tsx), and the move itself.
//
// THE MOVE IS `nav.side` TO THE TARGET PANE, exactly as the space header's up and down are (ADR 0067):
// a pane-to-pane move is sideways, so the way up is kept. On a large screen the strip follows the URL
// (ADR 0120), so the gesture moves the focus between columns and spaces with no code of its own there.

interface Options {
  /** Settings → Pane navigation, read at mount like the hand. */
  method: PaneNav;
  agent: AgentView | undefined;
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
  tabs: readonly TabView[] | undefined;
  servers: readonly ServerSummary[] | undefined;
  scope: Scope | undefined;
  /** A quick drag up on the joystick handle; absent where the pane has no switcher sheet. */
  onSwitcher?: (() => void) | undefined;
}

export interface PaneNavigation {
  /** The ref callback for the reading area: the Chat stream or the terminal mirror. */
  setReading: (node: HTMLElement | null) => void;
  /** The overlay, portalled; null while nothing is armed. */
  overlay: ReactNode;
  /** The joystick handle band for above the belt, or undefined when the method is not Joystick. */
  handle: ReactNode | undefined;
}

export function usePaneNavigation({ method, agent, agents, shellPanes, tabs, servers, scope, onSwitcher }: Options): PaneNavigation {
  const nav = useNav();
  const [reading, setReading] = useState<HTMLElement | null>(null);
  const [handleNode, setHandleNode] = useState<HTMLDivElement | null>(null);
  const map = usePaneNavMap({ agent, agents, shellPanes, tabs, servers, scope });
  const here = agent === undefined ? null : columnKeyOf(agent, map.places);
  const state = usePaneNavGesture({
    method,
    reading,
    handle: handleNode,
    layout: map.layout,
    onCommit: (target: NavLayout) => {
      const key = keyAt(target);
      const pane = key === null || key === here ? undefined : map.paneOf(key);
      if (pane !== undefined) nav.side(panePath(pane.paneId, scopeOfPane(pane, map.places)));
    },
    onSwitcher,
  });
  return {
    setReading,
    overlay: <PaneNavOverlay state={state} spaces={map.spaces} paneOf={map.paneOf} servers={servers} />,
    handle: method === "joystick" && map.layout !== null ? <PaneNavHandle setNode={setHandleNode} /> : undefined,
  };
}
