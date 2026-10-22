import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { adapterFor } from "./harness";
import { blockOwnsKeyboard } from "./harness/dialog-contract";
import { asJsonObject, asJsonString, type JsonValue } from "./json";
import { paneScopeKey, type Scope } from "./scope";
import { askOf, type Surface } from "./surface/surface";
import type { StartWhat } from "./api";

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

export type InitialScreen = "dialog" | "composer";

/** Positive existing reader evidence only. Revision zero is a valid Herdr read, not a blank read. */
export function firstLaunchScreen(input: {
  harness: string;
  text: string;
  surface?: Surface;
  live: boolean;
  stale: boolean;
}): InitialScreen | null {
  const { harness, text, surface, live, stale } = input;
  if (!live || stale || surface?.composer === "unreachable") return null;
  if (surface?.reason === "stale" || surface?.reason === "torn" || surface?.reason === "contested") return null;
  if (surface !== undefined && askOf(surface.modal) !== null) return "dialog";
  const adapter = adapterFor(harness);
  if (adapter === undefined || text.trim() === "") return null;
  const rows = splitLines(parseAnsi(text));
  // The unread-dialog fallback is not recognition. Use the adapter's actual detectors, unchanged.
  if (adapter.buildBlocks(rows).some((block) => block.kind !== "unread-dialog" && blockOwnsKeyboard(block))) return "dialog";
  return adapter.composerReady?.(rows) === true ? "composer" : null;
}
