import { describe, expect, it } from "vitest";

import type { Row } from "./data";
import { checkAgainstKnown, nextKnown, type KnownTarget } from "./known";

const row = (over: Partial<Row> = {}): Row => ({
  screen: "dashboard",
  group: "Dashboard",
  size: "390x844",
  name: "Chip",
  selector: "#chip",
  tag: "button",
  box: [30, 30],
  hit: [30, 30],
  hitShare: 1,
  gap: 8,
  gapTo: null,
  events: [],
  shiftPx: null,
  verdict: "small",
  flags: [],
  severity: 10,
  ...over,
});
const known = (over: Partial<KnownTarget> = {}): KnownTarget => ({ screen: "dashboard", selector: "#chip", name: "Chip", why: "a design decision", ...over });

describe("the census as a check", () => {
  it("a small target on the list is known and fails nothing", () => {
    const r = checkAgainstKnown([row()], [known()]);
    expect(r.fresh).toEqual([]);
    expect(r.fixed).toEqual([]);
    expect(r.seen).toBe(1);
  });

  it("a NEW small target fails", () => {
    const r = checkAgainstKnown([row(), row({ name: "Brand new", selector: "#new" })], [known()]);
    expect(r.fresh.map((x) => x.name)).toEqual(["Brand new"]);
  });

  it("a NEW covered target fails", () => {
    const r = checkAgainstKnown([row({ name: "Under", selector: "#under", verdict: "covered" })], []);
    expect(r.fresh.map((x) => x.name)).toEqual(["Under"]);
  });

  it("a target that is ok, shifts or has dead time is not the check's business", () => {
    const rows = [row({ verdict: "ok" }), row({ name: "b", verdict: "shifts" }), row({ name: "c", verdict: "dead-time" })];
    expect(checkAgainstKnown(rows, []).fresh).toEqual([]);
  });

  it("the two phone sizes are one target", () => {
    const r = checkAgainstKnown([row({ size: "390x844" }), row({ size: "360x780" })], [known()]);
    expect(r.fresh).toEqual([]);
    expect(r.seen).toBe(1);
  });

  it("the same name on another screen is another target", () => {
    const r = checkAgainstKnown([row({ screen: "settings" })], [known()]);
    expect(r.fresh).toHaveLength(1);
  });

  it("a known target that is now fine is reported as fixed and fails nothing", () => {
    const r = checkAgainstKnown([row({ verdict: "ok" })], [known()]);
    expect(r.fresh).toEqual([]);
    expect(r.fixed.map((x) => x.name)).toEqual(["Chip"]);
  });

  it("the worst new target comes first", () => {
    const r = checkAgainstKnown([row({ name: "a", severity: 5 }), row({ name: "b", severity: 50 })], []);
    expect(r.fresh.map((x) => x.name)).toEqual(["b", "a"]);
  });

  it("--update keeps the reason of a target that was known and starts the rest empty", () => {
    const next = nextKnown([row(), row({ name: "Fresh", selector: "#f" }), row({ name: "ok one", verdict: "ok" })], [known()]);
    expect(next.map((t) => [t.name, t.why])).toEqual([
      ["Chip", "a design decision"],
      ["Fresh", ""],
    ]);
  });
});
