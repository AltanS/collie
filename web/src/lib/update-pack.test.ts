import { describe, expect, it } from "vitest";

import { packAction, packActionLabel, peerRows, peersBehind, peersRolledBack } from "./update-pack";
import type { UpdatePackMember, UpdatePeerLeg } from "./types";

// The pack half of the update card, as pure functions. Ordering, counting and the three button
// labels are pinned here rather than by pulling a card apart in the DOM.

function member(over: Partial<UpdatePackMember> & { name: string }): UpdatePackMember {
  return { version: "1.4.0", verdict: "green", reasons: [], asOf: 1_700_000_000_000, ...over };
}

describe("peerRows", () => {
  it("puts a failed leg first, then red, then unknown, then amber, then green", () => {
    const rows = peerRows(
      [
        member({ name: "green-one" }),
        member({ name: "amber-one", verdict: "amber", reasons: ["no service unit"] }),
        member({ name: "unknown-one", verdict: "unknown", reasons: [] }),
        member({ name: "red-one", verdict: "red", reasons: ["tree is dirty"] }),
        member({ name: "failed-one" }),
      ],
      [{ name: "failed-one", state: "rolled-back", reason: "health gate never went green" }],
    );
    expect(rows.map((r) => r.name)).toEqual([
      "failed-one",
      "red-one",
      "unknown-one",
      "amber-one",
      "green-one",
    ]);
  });

  it("gives a red and an unknown a reason, and gives a green none", () => {
    const rows = peerRows([
      member({ name: "a", verdict: "red", reasons: ["tree is dirty", "disk is low"] }),
      member({ name: "b", verdict: "unknown", reasons: [] }),
      member({ name: "c" }),
    ]);
    expect(rows[0]?.reason).toBe("tree is dirty · disk is low");
    // An unknown with nothing said about it still says why: we asked and heard nothing.
    expect(rows[1]?.reason).toBe("we could not check this machine");
    expect(rows[2]?.reason).toBeNull();
  });

  it("never draws an unknown as green", () => {
    const rows = peerRows([member({ name: "a", verdict: "unknown", reasons: [] })]);
    expect(rows[0]?.word).toBe("unknown");
    expect(rows[0]?.rank).toBeLessThan(5);
  });

  it("a leg outranks the census row for the same machine", () => {
    const rows = peerRows(
      [member({ name: "minibuch", version: "1.3.0" })],
      [{ name: "minibuch", state: "restarting", updatedAt: 42 }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.word).toBe("restarting");
    expect(rows[0]?.inFlight).toBe(true);
    // The version the census knew survives a leg that carries none.
    expect(rows[0]?.version).toBe("1.3.0");
    expect(rows[0]?.asOf).toBe(42);
  });

  it("a peer the census missed but the run is driving still gets a row", () => {
    const rows = peerRows([], [{ name: "shed", state: "verifying" }]);
    expect(rows.map((r) => r.name)).toEqual(["shed"]);
    expect(rows[0]?.version).toBeNull();
  });

  it("solo — no census, no legs, no rows", () => {
    expect(peerRows()).toEqual([]);
  });

  it("a member that never reported carries a null asOf, not a stale stamp", () => {
    const rows = peerRows([member({ name: "shed", verdict: "unknown", reasons: [], asOf: null })]);
    expect(rows[0]?.asOf).toBeNull();
  });
});

describe("peersBehind", () => {
  it("counts only the peers on a version that is not the lead's", () => {
    const pack = [
      member({ name: "a", version: "1.3.0" }),
      member({ name: "b", version: "1.4.0" }),
      // Nobody could learn this one's version. An unknown is reported as unknown on its own row;
      // inflating the count with it would point the operator at a button that cannot help.
      member({ name: "c", version: null, verdict: "unknown" }),
    ];
    expect(peersBehind(pack, "1.4.0")).toBe(1);
    expect(peersBehind(pack, "")).toBe(0);
    expect(peersBehind([], "1.4.0")).toBe(0);
  });
});

describe("a packaged member", () => {
  it("is left out of the peers-behind count — the operator cannot clear it from here", () => {
    const pack = [
      member({ name: "a", version: "1.3.0" }),
      member({ name: "b", version: "1.3.0", installKind: "packaged" }),
    ];
    expect(peersBehind(pack, "1.4.0")).toBe(1);
    // Absent means unknown, and unknown counts as not packaged: an older bridge behaves as before.
    expect(peersBehind([member({ name: "b", version: "1.3.0" })], "1.4.0")).toBe(1);
  });

  it("says what it is waiting on, in neutral weight, whether the census or a leg reports it", () => {
    const fromCensus = peerRows([member({ name: "b", version: "1.3.0", installKind: "packaged" })])[0]!;
    expect(fromCensus.word).toBe("waits for the package manager");
    expect(fromCensus.reason).toBeNull();
    expect(fromCensus.inFlight).toBe(false);
    // Rank 5 is `done`'s bucket — the neutral dot, never the blocked one.
    expect(fromCensus.rank).toBe(5);

    const fromLeg = peerRows([], [{ name: "b", state: "package-managed" }])[0]!;
    expect(fromLeg.word).toBe("waits for the package manager");
    expect(fromLeg.reason).toBeNull();
    expect(fromLeg.rank).toBe(5);
  });
});

describe("peersRolledBack", () => {
  it("counts every leg that ended badly, not only a rollback", () => {
    const legs: UpdatePeerLeg[] = [
      { name: "a", state: "rolled-back" },
      { name: "b", state: "stuck" },
      { name: "c", state: "interrupted" },
      { name: "d", state: "done" },
      { name: "e", state: "verifying" },
    ];
    expect(peersRolledBack(legs)).toBe(3);
    expect(peersRolledBack()).toBe(0);
  });
});

describe("packAction", () => {
  it("names the pack when a release is available and this pack has peers", () => {
    expect(packAction({ releaseAvailable: true, hasPeers: true, behind: 1, rolledBack: 0 })).toBe(
      "update-pack",
    );
    expect(packActionLabel("update-pack", "1.5.0")).toBe("Update pack to 1.5.0");
  });

  it("names only this machine when there are no peers", () => {
    expect(packAction({ releaseAvailable: true, hasPeers: false, behind: 0, rolledBack: 0 })).toBe(
      "update",
    );
    expect(packActionLabel("update", "1.5.0")).toBe("Update to 1.5.0");
  });

  it("offers a retry once the lead is current and a peer is behind or rolled back", () => {
    expect(packAction({ releaseAvailable: false, hasPeers: true, behind: 1, rolledBack: 0 })).toBe(
      "retry-pack",
    );
    expect(packAction({ releaseAvailable: false, hasPeers: true, behind: 0, rolledBack: 1 })).toBe(
      "retry-pack",
    );
    expect(packActionLabel("retry-pack", "1.5.0")).toBe("Retry pack update");
  });

  it("offers nothing when the whole pack is level", () => {
    expect(packAction({ releaseAvailable: false, hasPeers: true, behind: 0, rolledBack: 0 })).toBe("none");
  });

  // ── A LEAD THAT CANNOT TAKE THE RELEASE ITSELF (ADR 0035) ─────────────────

  it("yields the release branch to the peers when this lead cannot take it", () => {
    expect(
      packAction({ releaseAvailable: true, hasPeers: true, behind: 1, rolledBack: 0, leadCanTake: false }),
    ).toBe("retry-pack");
    expect(
      packAction({ releaseAvailable: true, hasPeers: true, behind: 0, rolledBack: 1, leadCanTake: false }),
    ).toBe("retry-pack");
  });

  // THE CONTROL for the pair above: one field differs, and the answer goes back to the button the
  // card disables. Revert the `leadCanTake` branch and the two cases above return `update-pack` —
  // exactly this — while this one keeps passing.
  it("control: the same pack on a lead that CAN take it still names the pack", () => {
    expect(packAction({ releaseAvailable: true, hasPeers: true, behind: 1, rolledBack: 0 })).toBe("update-pack");
    expect(
      packAction({ releaseAvailable: true, hasPeers: true, behind: 1, rolledBack: 0, leadCanTake: true }),
    ).toBe("update-pack");
  });

  it("keeps the release button when there is no peer to yield it to", () => {
    // Nothing for a peers-only run to do, so the disabled button stays: it is the card's only way
    // to say a release exists and this machine is not the one that takes it.
    expect(
      packAction({ releaseAvailable: true, hasPeers: false, behind: 0, rolledBack: 0, leadCanTake: false }),
    ).toBe("update");
    expect(
      packAction({ releaseAvailable: true, hasPeers: true, behind: 0, rolledBack: 0, leadCanTake: false }),
    ).toBe("update-pack");
  });
});
