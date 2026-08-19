// THE CONFORMANCE FIXTURE REGISTRY — the second half of what registering an adapter means.
//
// `registry.ts` says which multiplexers this build can DRIVE. This says how each of them is PROVED:
// one {@link MuxConformanceFixture} per registered adapter, and `conformance.test.ts` fails an
// adapter that has none. Two lists rather than one field on the factory, because a fixture pulls in a
// fake transport and a seeded world — none of which belongs in the module the bridge starts from.
//
// Adding tmux (M10/04) or zellij (M10/05) is therefore exactly two lines: its factory in
// `MUX_ADAPTERS`, its fixture here. No new test file, ever — the suite iterates.

import type { MuxConformanceFixture } from "./conformance.ts";
import { herdrConformanceFixture } from "./herdr/fixture.ts";

/** One fixture per registered adapter. Keyed by nothing — the suite matches on `fixture.mux`. */
export const MUX_CONFORMANCE_FIXTURES: readonly MuxConformanceFixture[] = [herdrConformanceFixture];

/** The fixture for `mux`, or undefined when the adapter has not contributed one. */
export function fixtureFor(mux: string): MuxConformanceFixture | undefined {
  return MUX_CONFORMANCE_FIXTURES.find((fixture) => fixture.mux === mux);
}
