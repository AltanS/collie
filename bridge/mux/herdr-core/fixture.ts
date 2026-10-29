// HERDR-CORE'S CONFORMANCE FIXTURE: the real `HerdrCoreMux` over the in-memory core of
// fake-core.ts, so the conformance engine (../conformance.ts) drives the whole translation layer
// (layout, key spelling, event routing, refusal mapping) without a socket.
//
// TWO SPACES, as herdr-app can have, plus the implicit space of a terminal herdr-app does not show.
// No `focusOutOfBand`: the core has no focus at all, so the world is held to the opposite promise,
// no pane focused and `setFocus` unsupported (MuxConformanceWorld.focusOutOfBand).

import type { MuxConformanceFixture, MuxConformanceWorld } from "../conformance.ts";
import { HERDR_CORE_MUX, HerdrCoreMux } from "./adapter.ts";
import { FakeHcCore } from "./fake-core.ts";

/** The world for one conformance run. Exported for tests that need the fake beside the adapter. */
export function herdrCoreWorld(fake: FakeHcCore): MuxConformanceWorld {
  return {
    adapter: new HerdrCoreMux(fake, "/home/dev"),
    writes: () => fake.writes(),
    reconnect: () => fake.reconnect(),
    restartMux: () => fake.restartMux(),
    renameOutOfBand: (paneId, label) => fake.renameOutOfBand(paneId, label),
    setProgramTitle: (paneId, title) => fake.setProgramTitle(paneId, title),
    changePane: (paneId) => fake.changePane(paneId),
    endPane: (paneId) => fake.endPane(paneId),
    pokeTopologyOutOfBand: () => fake.pokeTopologyOutOfBand(),
    pokeTopology: () => fake.pokeTopology(),
    pokePane: (paneId) => fake.pokePane(paneId),
    close: () => {
      fake.shutdown();
      return Promise.resolve();
    },
  };
}

/** herdr-core's entry in the fixture registry (../fixtures.ts). */
export const herdrCoreConformanceFixture: MuxConformanceFixture = {
  mux: HERDR_CORE_MUX,
  create(): Promise<MuxConformanceWorld> {
    return Promise.resolve(herdrCoreWorld(new FakeHcCore()));
  },
};
