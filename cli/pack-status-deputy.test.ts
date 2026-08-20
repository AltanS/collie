import { describe, expect, test } from "bun:test";

import { leadStore, material, member, peerStore, T0 } from "../bridge/pack/fixtures.ts";
import { NO_RUNTIME_FACTS, type PackRuntimeMarker } from "../bridge/pack/staleness.ts";
import { adoptLeadership, rosterRowsOf } from "../bridge/pack/takeover.ts";
import type { StoredWarrant, TrustStoreData } from "../bridge/pack/trust-store.ts";
import { mintWarrant } from "../bridge/pack/warrant.ts";
import type { OpsRecord } from "../bridge/pack/ops-store.ts";
import {
  deputyUnreachableLines,
  leadDeputyLines,
  memberWarrantLines,
  peerWarrantLines,
} from "./pack-status-deputy.ts";
import type { TonedLine } from "./render.ts";

// What `collie pack status` SAYS about the deputy. Pure data in, `TonedLine[]` out — so the whole
// render matrix is pinned here rather than discovered on a live pack at 23:00.
//
// ── TWO OF THESE CASES CAME BACK FROM A LIVE DRILL, AND BOTH READ AS ABSURD ──
// A new lead reported ITSELF as its own deputy and then warned that it could not reach itself; and a
// deputy that had restarted cleanly reported its warrant as "stored, NOT anchored" forever. Neither
// was a wording slip — each was a surface reading the wrong fact — so each has its own case below,
// named for what the operator saw.

const text = (rows: TonedLine[]): string => rows.map((r) => r.text).join("\n");

/** A lead (`desk`) with two peers, having designated `nas` through the shipped transition. */
function designated(now = T0) {
  const base = leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "attic" })] });
  const change = mintWarrant(base, "nas", now);
  if (change === null) throw new Error("fixture: expected a mint");
  return change.next;
}

/** The store a takeover leaves on the machine that took over — a lead holding its own warrant. */
function tookOver(now = T0) {
  const leadData = designated(now);
  // `laptop` is the deputy: a peer of `desk` holding the warrant that names it, plus the roster.
  const deputy: TrustStoreData = {
    ...peerStore({ warrant: { warrant: mintOf(leadData), deputyCertPem: material("laptop").certPem } }),
    standbyRoster: rosterRowsOf(leadData.peers),
  };
  const change = adoptLeadership(deputy, { roster: deputy.standbyRoster!, confirmed: new Set(), now: now + 5 });
  if (change === null) throw new Error("fixture: expected a takeover");
  return change.next;
}

/** A warrant naming `laptop`, minted by `desk`. Separate so the deputy's store can hold it. */
function mintOf(_leadData: TrustStoreData) {
  const base = leadStore({ peers: [member({ memberId: "laptop" }), member({ memberId: "nas" })] });
  const change = mintWarrant(base, "laptop", T0);
  if (change === null) throw new Error("fixture: expected a mint");
  return change.result;
}

function marker(over: Partial<PackRuntimeMarker> = {}): PackRuntimeMarker {
  return {
    ...NO_RUNTIME_FACTS,
    bootedAt: T0,
    pid: 1,
    mode: "peer",
    roster: [],
    checkpointedAt: T0,
    ...over,
  };
}

describe("the lead's deputy line reads the DESIGNATION, never the warrant", () => {
  test("an ordinary designation names the peer and its generation", () => {
    const rows = leadDeputyLines(designated(), T0);
    expect(text(rows)).toContain("deputy nas — warrant generation 1");
  });

  // ── THE LIVE DRILL, BUG 2 ─────────────────────────────────────────────────
  // A takeover KEEPS the warrant — it carries the generation counter and it is the proof for §9's
  // reconciliation — and that warrant names the machine that took over. A surface reading the deputy
  // off it printed `deputy minibuch` on minibuch's own lead status.
  test("after a takeover the new lead names NOBODY, and says the takeover spent it", () => {
    const after = tookOver();
    const rendered = text(leadDeputyLines(after, T0 + 1000));
    expect(rendered).toContain("deputy none");
    expect(rendered).toContain("spent by the takeover of");
    expect(rendered).toContain("collie pack deputy <member>");
    // The absurd reading, gone: the machine does not name itself anywhere on the line.
    expect(rendered).not.toContain(`deputy ${after.self.memberId}`);
    // …and the warrant really is still there, which is what made the old reading possible.
    expect(after.warrant?.warrant.deputyMemberId).toBe(after.self.memberId);
    expect(after.deputy ?? null).toBeNull();
  });

  test("naming a new deputy clears the takeover explanation — the question no longer applies", () => {
    const after = tookOver();
    const renamed = mintWarrant({ ...after, peers: [member({ memberId: "nas" })] }, "nas", T0 + 2000);
    expect(renamed).not.toBeNull();
    expect(renamed!.next.deputySpentAt ?? null).toBeNull();
    const rendered = text(leadDeputyLines(renamed!.next, T0 + 3000));
    expect(rendered).toContain("deputy nas");
    expect(rendered).not.toContain("spent by the takeover");
  });

  test("a revocation is spelled as a revocation, and a pack that never named one as neither", () => {
    const revoked = mintWarrant(designated(), null, T0 + 10);
    expect(text(leadDeputyLines(revoked!.next, T0 + 20))).toContain("deputy none (revoked at generation 2)");
    const never = leadStore({ peers: [member({ memberId: "nas" })] });
    const rendered = text(leadDeputyLines(never, T0));
    expect(rendered).toContain("deputy none —");
    expect(rendered).not.toContain("revoked");
    expect(rendered).not.toContain("takeover");
  });

  test("a lead with no peers says nothing at all — there is nobody to name", () => {
    expect(leadDeputyLines(leadStore(), T0)).toEqual([]);
  });

  test("a designation that names THIS machine is refused as unarmable, never rendered as live", () => {
    const self = { ...designated(), deputy: "desk" };
    const rendered = text(leadDeputyLines(self, T0));
    expect(rendered).toContain("names ITSELF, which cannot be armed");
  });

  test("a designation the warrant contradicts is named, never silently resolved", () => {
    const bent = { ...designated(), deputy: "attic" };
    const rendered = text(leadDeputyLines(bent, T0));
    expect(rendered).toContain('deputy attic — but the warrant on disk names "nas"');
    expect(rendered).toContain("edited by hand");
  });
});

describe("the unreachable-deputy warning", () => {
  test("it fires for a designated peer that is not answering", () => {
    const rendered = text(deputyUnreachableLines(designated(), () => false));
    expect(rendered).toContain('⚠ deputy "nas" is unreachable');
  });

  test("it is silent when that peer is reachable", () => {
    expect(deputyUnreachableLines(designated(), () => true)).toEqual([]);
  });

  // The absurd companion the drill printed: a machine warning that it cannot reach itself.
  test("after a takeover it is SILENT — a lead is never its own unreachable deputy", () => {
    expect(deputyUnreachableLines(tookOver(), () => false)).toEqual([]);
  });

  test("it is silent for a designation that is not an enrolled peer — a different fault, named elsewhere", () => {
    const gone = { ...designated(), peers: [member({ memberId: "attic" })] };
    expect(deputyUnreachableLines(gone, () => false)).toEqual([]);
  });
});

describe("the peer's own warrant line names what THIS machine's restart activated", () => {
  /** A witness peer: pinned to `desk`, anchoring `nas` — not itself the deputy. */
  const witness = (over: Partial<TrustStoreData> = {}): TrustStoreData => {
    const w = mintWarrant(leadStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)!.result;
    return peerStore({ warrant: { warrant: w, deputyCertPem: material("nas").certPem }, ...over });
  };
  /** The DEPUTY itself: `laptop`, holding the warrant that names `laptop`. */
  const deputy = (): TrustStoreData => {
    const stored: StoredWarrant = {
      warrant: mintWarrant(leadStore({ peers: [member({ memberId: "laptop" })] }), "laptop", T0)!.result,
      deputyCertPem: material("laptop").certPem,
    };
    return peerStore({ warrant: stored });
  };

  test("a WITNESS that restarted reports the anchor it built", () => {
    const rendered = text(peerWarrantLines(witness(), marker({ anchoredGeneration: 1 }), T0));
    expect(rendered).toContain('deputy "nas"');
    expect(rendered).toContain("anchored at this boot");
  });

  // ── THE LIVE DRILL, BUG 3 ─────────────────────────────────────────────────
  // The machine the warrant NAMES anchors nothing — a collie does not anchor its own certificate, and
  // `transport.ts`'s `deputyAnchor` refuses exactly that case by name. Deriving the marker from that
  // one path reported the DEPUTY, the one machine this whole feature is about, as never activated.
  test("the DEPUTY that restarted reports its ROLE active, not an anchor it could never build", () => {
    const rendered = text(peerWarrantLines(deputy(), marker({ anchoredGeneration: 1 }), T0));
    expect(rendered).toContain("THIS machine is the deputy");
    expect(rendered).toContain("deputy role ACTIVE at this boot");
    expect(rendered).not.toContain("NOT anchored");
    expect(rendered).not.toContain("NOT active");
  });

  test("before the restart each says it is stored but not yet live, in its own words", () => {
    expect(text(peerWarrantLines(witness(), marker(), T0))).toContain("stored, NOT anchored");
    expect(text(peerWarrantLines(deputy(), marker(), T0))).toContain("stored, NOT active");
    // Both name the same remedy, because it is the same remedy.
    for (const data of [witness(), deputy()]) {
      expect(text(peerWarrantLines(data, marker(), T0))).toContain("Restart here to arm it");
    }
  });

  test("a generation that landed AFTER this boot is not reported as live", () => {
    // The marker carries what the listener came up with; a warrant that arrived a minute later is
    // stored and inert, which is the whole of the two phases.
    const later = mintWarrant(leadStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)!;
    const second = mintWarrant(later.next, "nas", T0 + 1000)!;
    const held = peerStore({ warrant: { warrant: second.result, deputyCertPem: material("nas").certPem } });
    expect(text(peerWarrantLines(held, marker({ anchoredGeneration: 1 }), T0 + 2000))).toContain("stored, NOT anchored");
  });

  test("a peer with no warrant, and a revoked one, are unchanged by any of this", () => {
    expect(text(peerWarrantLines(peerStore(), marker(), T0))).toContain("warrant none");
    const revoked = mintWarrant(mintWarrant(leadStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)!.next, null, T0)!;
    const held = peerStore({ warrant: { warrant: revoked.result, deputyCertPem: null } });
    expect(text(peerWarrantLines(held, marker(), T0))).toContain("REVOKED");
  });
});

// ── THE LIVE DRILL, BUG 5 (§18.17) ──────────────────────────────────────────
// The deputy's own `pack status` said `deputy role ACTIVE at this boot` while the LEAD's said
// `warrant stored, anchor INACTIVE — restart minibuch … a takeover from there is impossible`, about
// the same machine at the same minute. The lead's only anchor evidence was `pack-ops.json`, which
// moves when `pack deputy`'s own restart leg completes and at no other time — so a restart done by an
// update, by the unit, or by a hand on a keyboard left an armed pack rendered as un-armed forever.
describe("the LEAD prefers the member's own activation report over its ops record (§18.17)", () => {
  /** `desk`, holding generation 1 of a warrant naming `nas`. `attic` is the witness. */
  const lead = (): TrustStoreData => designated();
  /** The same lead, one generation later — so a report of `1` is provably BEHIND. */
  const leadAtTwo = (): TrustStoreData => mintWarrant(designated(), "nas", T0 + 1000)!.next;
  const record = (over: Partial<OpsRecord> = {}): OpsRecord => ({
    sshHost: "nas.local",
    path: "/home/op/collie",
    port: 8787,
    recordedAt: T0,
    anchoredGeneration: null,
    anchoredAt: null,
    ...over,
  });

  test("a DEPUTY reporting the current generation is armed — with no ops record at all", () => {
    // The drill's exact state: nothing ever restarted it from here, and it is nonetheless armed.
    const rendered = text(memberWarrantLines(lead(), 1, null, "nas", 1));
    expect(rendered).toContain("its deputy role is ACTIVE");
    expect(rendered).toContain("that machine reports it");
    expect(rendered).not.toContain("INACTIVE");
    expect(rendered).not.toContain("restart nas");
  });

  test("a WITNESS reporting the current generation says ANCHORED — the role picks the word", () => {
    // No wire field carries a role: the lead knows who its own warrant names.
    const rendered = text(memberWarrantLines(lead(), 1, null, "attic", 1));
    expect(rendered).toContain("anchored");
    expect(rendered).not.toContain("deputy role");
    expect(rendered).not.toContain("INACTIVE");
  });

  test("a report BEHIND the issued generation is INACTIVE — even when the record claims otherwise", () => {
    // The record describes a past restart; the report describes the process running now, and the
    // machine wins. A record that outran the report is how a lead would swear a rolled-back peer armed.
    const rendered = text(memberWarrantLines(leadAtTwo(), 2, record({ anchoredGeneration: 2, anchoredAt: T0 }), "nas", 1));
    expect(rendered).toContain("warrant stored, anchor INACTIVE — restart nas");
  });

  test("an ABSENT report falls back to the ops record — the pre-amendment reading, unchanged", () => {
    const armed = text(memberWarrantLines(lead(), 1, record({ anchoredGeneration: 1, anchoredAt: T0 }), "nas", null));
    expect(armed).toContain("stored and anchored");
    const unarmed = text(memberWarrantLines(lead(), 1, record(), "nas", null));
    expect(unarmed).toContain("warrant stored, anchor INACTIVE — restart nas");
    // A caller that passes nothing at all reads exactly as one that reports nothing.
    expect(text(memberWarrantLines(lead(), 1, record(), "nas"))).toBe(unarmed);
  });

  test("a member BEHIND on STORAGE is still reported on storage — activation cannot outrank it", () => {
    // Two independent facts, and the first one that is wrong is the one to say. A machine that does
    // not even hold the warrant has nothing for a restart to arm.
    const rendered = text(memberWarrantLines(leadAtTwo(), 1, null, "nas", 1));
    expect(rendered).toContain("BEHIND this lead's 2");
    expect(rendered).not.toContain("ACTIVE");
  });
});
