// The mux registry — the SINGLE decision site for "which multiplexer is this collie driving".
//
// Maps a configured mux name to the factory that builds its adapter. Adding a multiplexer is one
// entry in {@link MUX_ADAPTERS} plus its module — never a new branch in a route, a loader or an
// `if (mux === "herdr")` anywhere above this line.
//
// ⚠️ THIS IS NOT THE HARNESS SEAM, AND IT IS NOT THE JOURNAL SEAM. There are three axes in this
// codebase and they must not be conflated or keyed off one another:
//
//   • **harness** (`web/src/lib/harness/registry.ts`) — WHAT RUNS IN A PANE. Block grammars and the
//     send guard for the live mirror: claude, codex, pi, omp.
//   • **journal** (`bridge/journal/registry.ts`) — READING THAT AGENT'S OWN LOG off disk.
//   • **mux** (here) — WHAT OWNS THE PANE. Herdr, tmux, zellij.
//
// A harness is what runs *in* a pane; a mux is what the pane *is*. They cross at exactly one point,
// and it is named rather than assumed: a pane's agent-session reference is a declared mux capability
// (`agentSessionRef`), and the journal axis consumes it. A capability question must never be
// answered by a harness lookup, and a harness question must never be answered by the mux name — do
// that and neither axis is pluggable any more.

import type { MuxAdapter } from "./types.ts";

/**
 * Where a multiplexer lives, in the ADAPTER's own terms.
 *
 * `endpoint` is opaque here on purpose — a socket path for one multiplexer, a server socket name or
 * a session name for another — because the registry that routes to an adapter must not also know
 * how each one addresses itself. It is always LOCAL: a mux adapter never reaches across a machine
 * boundary, and this shape must never grow a host (ADR 0011, ADR 0022).
 */
export interface MuxTarget {
  readonly endpoint: string;
  /** Per-call wall-clock budget. */
  readonly timeoutMs: number;
  /**
   * Adapter-private settings, passed through untouched. The registry never reads a key — an adapter
   * that needs a knob documents it in its own module, and one adapter's key is meaningless to
   * another.
   */
  readonly options: Readonly<Record<string, string>>;
}

/**
 * How an adapter gets built.
 *
 * A factory rather than a constructor so the registry can be a plain list of values — the same
 * property that lets the conformance suite (M10/03) iterate every registered adapter instead of
 * naming them one by one.
 */
export interface MuxAdapterFactory {
  /** The configured name this factory answers to. It IS the registry key — see {@link buildMuxRegistry}. */
  readonly mux: string;
  create(target: MuxTarget): MuxAdapter;
}

/**
 * The multiplexers this build can drive.
 *
 * Empty until M10/02 registers Herdr behind the contract; tmux (M10/04) and zellij (M10/05) append
 * one entry each. Deliberately a list of factories and not a map — the map is derived below, so a
 * key can never drift from the factory it points at.
 */
export const MUX_ADAPTERS: readonly MuxAdapterFactory[] = [];

/** The name used when the operator configured none. Herdr, so nothing changes for anyone. */
export const DEFAULT_MUX = "herdr";

/**
 * Build the registry.
 *
 * The map is built FROM each factory's own `mux` field, exactly as the journal and harness
 * registries build theirs, so the key and the thing it resolves to cannot disagree.
 */
export function buildMuxRegistry(
  factories: readonly MuxAdapterFactory[] = MUX_ADAPTERS,
): Record<string, MuxAdapterFactory> {
  return Object.fromEntries(factories.map((factory) => [factory.mux, factory]));
}

/**
 * The factory for `mux`, or undefined when nothing is registered under that name.
 *
 * `Object.hasOwn` rather than a truthy lookup, for the reason the journal registry gives: the name
 * arrives from configuration, and an inherited Object.prototype key ("toString", "constructor",
 * "__proto__", …) must not resolve to something that is not a factory.
 */
export function factoryFor(
  registry: Record<string, MuxAdapterFactory>,
  mux: string | undefined,
): MuxAdapterFactory | undefined {
  return mux !== undefined && Object.hasOwn(registry, mux) ? registry[mux] : undefined;
}

/** The multiplexers this build can drive, sorted — for the config surface, the CLI and tests. */
export function muxNames(registry: Record<string, MuxAdapterFactory>): string[] {
  return Object.keys(registry).toSorted();
}

/**
 * Build the adapter for a configured name, defaulting to {@link DEFAULT_MUX}.
 *
 * Throws on an unknown name, and that is the right shape here rather than the registry's usual
 * "undefined means absent": this runs once at startup off the operator's own configuration, so the
 * only useful outcome of a typo is refusing to start with the valid names in the message. Every
 * other lookup in this file stays total.
 */
export function createMux(
  registry: Record<string, MuxAdapterFactory>,
  mux: string | undefined,
  target: MuxTarget,
): MuxAdapter {
  const name = mux === undefined || mux === "" ? DEFAULT_MUX : mux;
  const factory = factoryFor(registry, name);
  if (factory === undefined) {
    throw new Error(`unknown multiplexer "${name}" — this build drives: ${muxNames(registry).join(", ") || "none"}`);
  }
  return factory.create(target);
}
