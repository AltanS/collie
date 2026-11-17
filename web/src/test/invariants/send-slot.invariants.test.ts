// M102 spec 15, part 1a on the phone, the pure half: EVERY Surface (2880, the full product of its
// fields) times the three facts the composer keeps (gone, read-only, offline: 8), through the Send slot
// and the way out. 23 040 cases, all of them, no sample.
//
//   I1  on a pane that is not gone, not read-only and online, a key can be sent (the Keys dock is open
//       and sendable), for every Surface.
//   I4  on a pane that is online and writable, for every Surface that is not a known secret and not a
//       read ask, the Send slot leads to the bridge with a road to the override: `send`, `manual`,
//       `running` or `draft`. `wait` and `unreachable` lead nowhere the override can go (red, spec 03).

import { describe, expect, it } from "vitest";

import { sendSlot, type ComposerFacts, type SendSlot } from "@/lib/send-slot";
import { ASK_CHANNELS } from "@/lib/surface/surface";
import { wayOut } from "@/lib/way-out";

import { allSurfaces, ASK_KINDS, COMPOSERS, MODALS, overrideReaches, REASONS, TURNS } from "./surfaces";
import { product } from "./seed";

const FACTS: readonly ComposerFacts[] = product({ gone: [false, true], readOnly: [false, true], offline: [false, true] });
const SURFACES = allSurfaces();
const ONLINE: ComposerFacts = { gone: false, readOnly: false, offline: false };

/** The slots from which a tap reaches the bridge on a road that ends in the override or in the person's own choice. */
const REACHES: ReadonlySet<SendSlot> = new Set<SendSlot>(["send", "manual", "running", "draft"]);

describe("M102-15 part 1a, the phone's send slot over every Surface and every fact", () => {
  it("covers the whole product: 3 turns, 12 modals, 4 composers, 5 reasons, 2 fields, 2 stale frames, 8 facts", () => {
    expect(TURNS).toHaveLength(3);
    expect(MODALS).toHaveLength(3 + ASK_KINDS.length * ASK_CHANNELS.length);
    expect(COMPOSERS).toHaveLength(4);
    expect(REASONS).toHaveLength(5);
    expect(SURFACES).toHaveLength(2880);
    expect(FACTS).toHaveLength(8);
  });

  it("I1: on a pane that is not gone, not read-only and online, a key can be sent, on every Surface", () => {
    const stuck = SURFACES.filter((c) => !wayOut(c.surface, ONLINE, { keysCapable: true }).keysSendable).map((c) => c.id);
    expect(stuck).toEqual([]);
  });

  it("I1: the Keys dock opens on every Surface for every fact but a pane that is gone and a device that may not write", () => {
    const shut = SURFACES.flatMap((c) =>
      FACTS.filter((f) => !f.gone && !f.readOnly)
        .filter((f) => !wayOut(c.surface, f, { keysCapable: true }).keysOpen)
        .map((f) => `${c.id} offline=${String(f.offline)}`),
    );
    expect(shut).toEqual([]);
  });

  it("the slot is a pure function: the same Surface and facts give the same slot", () => {
    for (const c of SURFACES) for (const f of FACTS) expect(sendSlot(c.surface, f)).toBe(sendSlot(c.surface, f));
  });

  it("I4 (the part that holds today): a Surface the manual Send reads keeps a road to the bridge", () => {
    const reach = SURFACES.filter((c) => overrideReaches(c.surface)).filter((c) => sendSlot(c.surface, ONLINE) === "manual");
    expect(reach.length).toBeGreaterThan(0);
  });

  it(`I4: every Surface that is no secret and no read ask leads to the bridge with a road to the override`, () => {
    const nowhere = SURFACES.filter((c) => overrideReaches(c.surface))
      .map((c) => ({ id: c.id, slot: sendSlot(c.surface, ONLINE) }))
      .filter((x) => !REACHES.has(x.slot))
      .map((x) => `${x.slot}: ${x.id}`);
    expect(nowhere).toEqual([]);
  });
});
