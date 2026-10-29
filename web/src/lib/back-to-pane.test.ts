import { stepsBackToPane } from "./back-to-pane";

const trail = (...hrefs: string[]) => new Map(hrefs.map((href, i) => [i, href]));

describe("stepsBackToPane", () => {
  it("pops the whole Changes walk back to the pane", () => {
    const entries = trail(
      "/",
      "/pane/w1:p1",
      "/pane/w1:p1/changes",
      "/pane/w1:p1/changes?repo=.&path=a.ts",
      "/pane/w1:p1/changes?repo=.&path=b.ts",
    );
    expect(stepsBackToPane("/pane/w1:p1", 4, entries)).toBe(3);
  });

  it("is one step when the pane is the entry just behind", () => {
    expect(stepsBackToPane("/pane/w1:p1", 1, trail("/pane/w1:p1"))).toBe(1);
  });

  it("matches an encoded address and ignores the query and hash on the pane", () => {
    const entries = trail("/pane/w1%3Ap1?h=lead#top", "/pane/w1%3Ap1/changes/files");
    expect(stepsBackToPane("/pane/w1:p1", 2, entries)).toBe(2);
  });

  it("does not cross a screen that is not under this pane's Changes", () => {
    const entries = trail("/pane/w1:p1", "/settings", "/pane/w1:p1/changes");
    expect(stepsBackToPane("/pane/w1:p1", 2, entries)).toBeNull();
  });

  it("does not take another pane's Changes for this one's", () => {
    const entries = trail("/pane/w1:p1", "/pane/w1:p10/changes", "/pane/w1:p1/changes");
    expect(stepsBackToPane("/pane/w1:p1", 2, entries)).toBeNull();
  });

  it("finds nothing without an index or with a gap in the trail", () => {
    expect(stepsBackToPane("/pane/w1:p1", undefined, trail("/pane/w1:p1"))).toBeNull();
    expect(stepsBackToPane("/pane/w1:p1", 3, new Map([[2, "/pane/w1:p1/changes"]]))).toBeNull();
  });
});
