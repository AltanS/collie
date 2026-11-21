import { describe, expect, it } from "vitest";

import { compareCommunity, trickListRows, type TrickListRow } from "./list-order";
import type { OfficialState, OfficialTricksReply, WireOfficialTrick, WireTrickInfo } from "./schema";

const COMMIT = "0c1e5d82346486815073fedcdb994bc4c2041b55";

function entry(id: string, state: OfficialState = "absent"): WireOfficialTrick {
  return { id, name: id, description: `${id} line.`, repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: COMMIT, state };
}

function trick(id: string, name: string, extra: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return { host: "lodge", id, name, icon: "plug", on: false, state: "off", places: ["belt"], ...extra };
}

/** The list in the order this release carries it: Morph first. */
function list(states: Partial<Record<string, OfficialState>> = {}): OfficialTricksReply {
  return { tricks: ["morph", "design-review", "pr-inbox", "running-builds"].map((id) => entry(id, states[id] ?? "absent")) };
}

/** A row as `kind:id:label`, the shape the table reads. */
function rowWords(rows: readonly TrickListRow[]): string[] {
  return rows.map((row) => (row.kind === "official" ? `add:${row.entry.id}` : `${row.origin ?? "none"}:${row.trick.id}`));
}

describe("trickListRows: the order of Settings, Tricks and the Hill", () => {
  const cases: { name: string; tricks: WireTrickInfo[]; list: OfficialTricksReply | null; rows: string[] }[] = [
    {
      name: "nothing added: the official list alone, Morph first",
      tricks: [],
      list: list(),
      rows: ["add:morph", "add:design-review", "add:pr-inbox", "add:running-builds"],
    },
    {
      name: "an added official trick keeps its place in the list's order",
      tricks: [trick("pr-inbox", "PR Inbox")],
      list: list({ "pr-inbox": "added" }),
      rows: ["add:morph", "add:design-review", "official:pr-inbox", "add:running-builds"],
    },
    {
      name: "an official trick with a newer version waiting is still official, in place",
      tricks: [trick("morph", "Morph", { on: true, state: "ok" })],
      list: list({ morph: "update" }),
      rows: ["official:morph", "add:design-review", "add:pr-inbox", "add:running-builds"],
    },
    {
      name: "community tricks come after, by name, whatever their state",
      tricks: [trick("zeta", "Zeta", { on: true, state: "ok" }), trick("alpha", "alpha"), trick("mid", "Mid", { state: "failing", on: true })],
      list: list(),
      rows: ["add:morph", "add:design-review", "add:pr-inbox", "add:running-builds", "community:alpha", "community:mid", "community:zeta"],
    },
    {
      name: "a taken entry is no official row: its trick is a community row",
      tricks: [trick("pr-inbox", "My PR list")],
      list: list({ "pr-inbox": "taken" }),
      rows: ["add:morph", "add:design-review", "add:running-builds", "community:pr-inbox"],
    },
    {
      name: "an add that the official list already says, before the trick is listed, keeps the row official",
      tricks: [],
      list: list({ morph: "added" }),
      rows: ["add:morph", "add:design-review", "add:pr-inbox", "add:running-builds"],
    },
    {
      name: "the trick listed before the official list says added: the trick takes the entry's place",
      tricks: [trick("morph", "Morph")],
      list: list(),
      rows: ["official:morph", "add:design-review", "add:pr-inbox", "add:running-builds"],
    },
    {
      name: "no official list: every trick by name, no label",
      tricks: [trick("pr-inbox", "PR Inbox"), trick("clock", "Clock")],
      list: null,
      rows: ["none:clock", "none:pr-inbox"],
    },
    {
      name: "a crew member's empty list with runsOn reads as unknown, not as community",
      tricks: [trick("legs", "Browser leg")],
      list: { tricks: [], runsOn: { lead: "desk" } },
      rows: ["none:legs"],
    },
    {
      name: "an empty list of this machine: every trick is the community's",
      tricks: [trick("legs", "Browser leg")],
      list: { tricks: [] },
      rows: ["community:legs"],
    },
  ];

  it.each(cases)("$name", ({ tricks, list: official, rows }) => {
    expect(rowWords(trickListRows(tricks, official))).toEqual(rows);
  });

  it("no trick id appears twice, and every trick appears once", () => {
    const tricks = [trick("morph", "Morph"), trick("pr-inbox", "Mine"), trick("legs", "Legs"), trick("clock", "Clock")];
    const rows = trickListRows(tricks, list({ morph: "added", "pr-inbox": "taken" }));
    const ids = rows.map((row) => (row.kind === "official" ? row.entry.id : row.trick.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of tricks) expect(ids.filter((id) => id === t.id)).toHaveLength(1);
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a state change moves no row: off, on, failing, stopped for its rights, waiting, each in the same place", () => {
    const official = list({ "design-review": "added" });
    const base = [trick("design-review", "Design Review"), trick("legs", "Browser leg"), trick("clock", "Clock")];
    const order = rowWords(trickListRows(base, official));
    const states: Partial<WireTrickInfo>[] = [
      { on: true, state: "ok" },
      { on: false, state: "stopped", rightsMoved: true },
      { on: true, state: "failing", error: "exit 2" },
      { on: true, state: "ok", changed: true, pending: { hash: "a".repeat(64), files: { added: 1, changed: 0, removed: 0 }, powersChanged: false, warnings: [] } },
      { on: false, state: "skipped" },
    ];
    for (const change of states) {
      for (const id of ["design-review", "legs", "clock"]) {
        const moved = base.map((t) => (t.id === id ? Object.assign(structuredClone(t), change) : t));
        expect(rowWords(trickListRows(moved, official)), `${id} ${JSON.stringify(change)}`).toEqual(order);
      }
    }
  });

  it("the row of an official entry keeps its key from Add to installed", () => {
    const before = trickListRows([], list());
    const after = trickListRows([trick("pr-inbox", "PR Inbox")], list({ "pr-inbox": "added" }));
    const at = before.findIndex((row) => row.key === "o:pr-inbox");
    expect(at).toBe(2);
    expect(after[at]?.key).toBe("o:pr-inbox");
    expect(after[at]?.kind).toBe("trick");
  });
});

describe("compareCommunity", () => {
  const t = (name: string, id: string, host = "lodge") => ({ name, id, host });
  it("orders by a locale-blind lower-case name, then id, then host", () => {
    const sorted = [t("beta", "b"), t("Alpha", "z"), t("alpha", "a"), t("Émile", "e"), t("Zed", "zed"), t("alpha", "a", "workshop")].toSorted(compareCommunity);
    expect(sorted.map((x) => `${x.name}/${x.id}/${x.host}`)).toEqual(["alpha/a/lodge", "alpha/a/workshop", "Alpha/z/lodge", "beta/b/lodge", "Zed/zed/lodge", "Émile/e/lodge"]);
  });
});
