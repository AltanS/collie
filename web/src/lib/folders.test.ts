import { folderName, hasFolders, NO_FOLDERS, visibleFolders } from "./folders";

// The pure half of the new-space sheet's folder list (#289). The read, the star and the sheet around
// them are driven in components/new-space-sheet.test.tsx.

describe("folderName — the name a row leads with", () => {
  it("is the last segment", () => {
    expect(folderName("/home/you/src/web")).toBe("web");
    expect(folderName("/srv/api/")).toBe("api");
    expect(folderName("relative")).toBe("relative");
  });

  it("the root names itself", () => {
    expect(folderName("/")).toBe("/");
  });
});

describe("visibleFolders — home is never drawn", () => {
  it("drops home from both lists, however either side spells the trailing slash", () => {
    const out = visibleFolders({
      recent: ["/home/you", "/home/you/a"],
      favourites: ["/home/you/", "/srv/b"],
      home: "/home/you/",
    });
    expect(out).toEqual({ recent: ["/home/you/a"], favourites: ["/srv/b"], home: "/home/you/" });
  });

  it("keeps a folder that merely shares home as a prefix", () => {
    expect(visibleFolders({ recent: ["/home/youth"], favourites: [], home: "/home/you" }).recent).toEqual([
      "/home/youth",
    ]);
  });

  it("drops nothing when the machine did not say where home is", () => {
    expect(visibleFolders({ recent: ["/home/you"], favourites: [], home: "" }).recent).toEqual(["/home/you"]);
  });
});

describe("hasFolders", () => {
  it("is false for an empty list and true when either list has a row", () => {
    expect(hasFolders(NO_FOLDERS)).toBe(false);
    expect(hasFolders({ recent: ["/a"], favourites: [], home: "" })).toBe(true);
    expect(hasFolders({ recent: [], favourites: ["/a"], home: "" })).toBe(true);
  });
});
