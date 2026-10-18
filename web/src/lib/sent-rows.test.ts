import { describe, expect, it } from "vitest";

import { entry } from "@/test/sent-fixtures";
import { appendPage, folderLabel, scopeOfHost, sentKey, withoutEntry } from "./sent-rows";

describe("appendPage and withoutEntry", () => {
  const a = entry({ line: "a", id: "a".repeat(16) });
  const b = entry({ line: "b", id: "b".repeat(16) });
  const bWorkshop = entry({ line: "b", id: "b".repeat(16), host: "workshop" });

  it("keeps the newest row of a line that comes back on a later page", () => {
    const older = { ...a, at: a.at - 1000, count: 1 };
    expect(appendPage([a], [older, b])).toEqual([a, b]);
  });

  it("treats one line on two machines as two rows", () => {
    expect(appendPage([b], [bWorkshop])).toEqual([b, bWorkshop]);
    expect(sentKey(b)).not.toBe(sentKey(bWorkshop));
  });

  it("drops only the forgotten line of the forgotten machine", () => {
    expect(withoutEntry([a, b, bWorkshop], b)).toEqual([a, bWorkshop]);
  });
});

describe("folderLabel", () => {
  it("names home as a tilde", () => {
    expect(folderLabel(null)).toEqual({ text: "~", title: undefined });
  });

  it("keeps a short path whole", () => {
    expect(folderLabel("/srv/app")).toEqual({ text: "/srv/app", title: undefined });
  });

  it("keeps the last two folders of a deep path and the whole path as the title", () => {
    expect(folderLabel("/home/altan/projects/collie")).toEqual({ text: "…/projects/collie", title: "/home/altan/projects/collie" });
  });
});

describe("scopeOfHost", () => {
  it("addresses the lead, and a solo bridge, by no host", () => {
    expect(scopeOfHost("bluefin", "bluefin")).toBeUndefined();
    expect(scopeOfHost("bluefin", undefined)).toBeUndefined();
  });

  it("addresses a member by its id", () => {
    expect(scopeOfHost("workshop", "bluefin")).toEqual({ host: "workshop" });
  });
});
