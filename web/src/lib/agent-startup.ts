import { asJsonObject, asJsonString, type JsonValue } from "./json";
import { paneScopeKey, type Scope } from "./scope";
import { askOf, type Surface } from "./surface/surface";
import type { StartWhat } from "./api";

/**
 * How long the phone keeps Send gated for a launch whose first screen it never reads. The bridge's
 * launch window has the same bound (bridge/launch-window.ts, LAUNCH_WINDOW_MS); past it the bridge
 * sends as it would to any pane, so the phone stops holding the button for it.
 */
export const STARTUP_GATE_MS = 120_000;

/** Navigation intent, not pane metadata or a claim about the terminal's current keyboard. */
export interface AgentLaunch {
  readonly id: string;
  readonly paneKey: string;
  readonly harness: string;
}

/** Only named agents and rows whose existing metadata names a harness wait for a first screen. */
export function startupHarness(what: StartWhat, rowHarness?: string): string | undefined {
  if (what.kind === "harness") return what.id;
  if (what.kind === "row") return rowHarness;
  return undefined;
}

/** A history entry cannot apply its launch to the same-numbered pane on another host or session. */
export function readAgentLaunch(state: JsonValue | undefined, paneId: string, scope?: Scope): AgentLaunch | undefined {
  const launch = asJsonObject(asJsonObject(state)?.agentLaunch);
  const id = asJsonString(launch?.id);
  const paneKey = asJsonString(launch?.paneKey);
  const harness = asJsonString(launch?.harness);
  if (!id || !harness || paneKey !== paneScopeKey(scope, paneId)) return undefined;
  return { id, paneKey, harness };
}

/**
 * Whether the bridge has read the launched agent's first screen: the multiplexer names the harness and
 * its Surface shows a dialog or an input box. This is the read that ends the bridge's launch window
 * (`LaunchWindow.drawn`), so the phone opens Send when the bridge stops refusing it. A shell row, an
 * unread pane, a stale, torn or contested read, or a box proven not to take keys is not that screen.
 */
export function firstScreenRead(harness: string, agent: string | undefined, surface: Surface | undefined): boolean {
  if (agent !== harness || surface === undefined) return false;
  if (surface.reason !== undefined || surface.staleFrame === true) return false;
  if (askOf(surface.modal) !== null || surface.modal === "unreadable") return true;
  return surface.composer === "empty" || surface.composer === "draft";
}
