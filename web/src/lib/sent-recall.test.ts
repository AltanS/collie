import { describe, expect, it } from "vitest";

import { entry } from "@/test/sent-fixtures";
import { appendPage, EMPTY_DRAFT, folderLabel, recallLines, recallText, scopeOfHost, sentKey, stepRecall, withoutEntry } from "./sent-recall";

describe("recallLines", () => {
  it("lists this folder's lines first, then the machine's, each line once", () => {
    const folder = [entry({ line: "make test" }), entry({ line: "git status" })];
    const machine = [entry({ line: "ls" }), entry({ line: "git status" }), entry({ line: "make test" }), entry({ line: "htop" })];
    expect(recallLines(folder, machine)).toEqual(["make test", "git status", "ls", "htop"]);
  });

  it("is the machine's lines when the pane has no folder to ask for", () => {
    expect(recallLines([], [entry({ line: "ls" })])).toEqual(["ls"]);
  });

  it("is empty with nothing sent", () => {
    expect(recallLines([], [])).toEqual([]);
  });
});

describe("stepRecall", () => {
  it("steps older with ArrowUp from the empty box and stops on the oldest line", () => {
    let at = EMPTY_DRAFT;
    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      at = stepRecall(at, "ArrowUp", 3);
      seen.push(at);
    }
    expect(seen).toEqual([0, 1, 2, 2, 2]);
  });

  it("steps newer with ArrowDown and stops on the empty box", () => {
    expect(stepRecall(2, "ArrowDown", 3)).toBe(1);
    expect(stepRecall(0, "ArrowDown", 3)).toBe(EMPTY_DRAFT);
    expect(stepRecall(EMPTY_DRAFT, "ArrowDown", 3)).toBe(EMPTY_DRAFT);
  });

  it("stays on the empty box when there are no lines", () => {
    expect(stepRecall(EMPTY_DRAFT, "ArrowUp", 0)).toBe(EMPTY_DRAFT);
    expect(stepRecall(0, "ArrowDown", 0)).toBe(EMPTY_DRAFT);
  });
});

describe("recallText", () => {
  it("is the line at the position and nothing at the empty box", () => {
    expect(recallText(["a", "b"], 1)).toBe("b");
    expect(recallText(["a", "b"], EMPTY_DRAFT)).toBe("");
    expect(recallText([], 0)).toBe("");
  });
});

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
