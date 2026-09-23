import type { UploadCapability } from "@/lib/types";
import {
  acceptAttribute,
  attachmentKind,
  composeLine,
  extensionOf,
  insertMarker,
  markerFor,
  markerMissing,
  removeMarker,
  shortName,
  limitMb,
  offersFiles,
  PHOTO_ACCEPT,
  rejectAttachment,
  uploadLimits,
} from "./attachments";

// Pure unit tests — the whole surface is decision functions with no store, no network, no DOM.
// See the header comment in attachments.ts for the contract each test below is pinning.

describe("uploadLimits", () => {
  it("falls back to the pre-attachment contract when the bridge published nothing", () => {
    expect(uploadLimits(null)).toEqual({
      maxBytes: 10 * 1024 * 1024,
      imageTypes: ["png", "jpg", "gif", "webp"],
      textTypes: [],
    });
  });

  it("returns the published block unchanged when the bridge said something", () => {
    const published: UploadCapability = {
      maxBytes: 5 * 1024 * 1024,
      imageTypes: ["png"],
      textTypes: ["md", "txt"],
    };
    expect(uploadLimits(published)).toEqual(published);
  });
});

describe("acceptAttribute", () => {
  it("puts image/* first, then a dotted extension per accepted type from both lists", () => {
    const limits: UploadCapability = {
      maxBytes: 10 * 1024 * 1024,
      imageTypes: ["png", "jpg"],
      textTypes: ["md", "txt"],
    };
    expect(acceptAttribute(limits)).toBe("image/*,.png,.jpg,.md,.txt");
  });

  it("still leads with image/* when one of the two lists is empty", () => {
    const limits: UploadCapability = { maxBytes: 1, imageTypes: [], textTypes: ["rb"] };
    expect(acceptAttribute(limits)).toBe("image/*,.rb");
  });
});

describe("the photos half of the picker", () => {
  it("is image/* and nothing else — the one accept a camera roll is offered for", () => {
    expect(PHOTO_ACCEPT).toBe("image/*");
  });

  it("offersFiles is true only when the bridge takes something that is not an image", () => {
    const images: UploadCapability = { maxBytes: 1, imageTypes: ["png"], textTypes: [] };
    expect(offersFiles(images)).toBe(false);
    expect(offersFiles({ ...images, textTypes: ["md"] })).toBe(true);
  });

  it("the pre-attachment fallback asks nothing: it has one answer to give", () => {
    expect(offersFiles(uploadLimits(null))).toBe(false);
  });
});

describe("extensionOf", () => {
  it.each([
    ["notes.md", "md"],
    ["A.TXT", "txt"],
    ["a.tar.gz", "gz"],
    [".gitignore", null],
    ["README", null],
    ["x.", null],
    ["a.b c", null],
  ] as const)("extensionOf(%j) -> %j", (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});

describe("rejectAttachment", () => {
  const limits: UploadCapability = {
    maxBytes: 10,
    imageTypes: ["png", "jpg", "gif", "webp"],
    textTypes: ["md"],
  };

  it("refuses an oversize file as tooLarge, checked BEFORE type", () => {
    // Also the wrong type (no extension, not image/*) — tooLarge must still win.
    const file = new File(["x".repeat(20)], "mystery", { type: "application/octet-stream" });
    expect(rejectAttachment(file, limits)).toBe("tooLarge");
  });

  it("accepts a file the browser calls image/* even with no extension at all", () => {
    const file = new File(["x"], "IMG_0001", { type: "image/png" });
    expect(rejectAttachment(file, limits)).toBeNull();
  });

  it("accepts notes.md when the published limits list md in textTypes", () => {
    const file = new File(["x"], "notes.md", { type: "text/markdown" });
    expect(rejectAttachment(file, limits)).toBeNull();
  });

  it("refuses app.rb as badType when the limits don't list rb", () => {
    const file = new File(["x"], "app.rb", { type: "text/x-ruby" });
    expect(rejectAttachment(file, limits)).toBe("badType");
  });

  it("refuses a file with no extension and a non-image type as badType", () => {
    const file = new File(["x"], "mystery", { type: "application/octet-stream" });
    expect(rejectAttachment(file, limits)).toBe("badType");
  });
});

describe("limitMb", () => {
  it("rounds bytes to whole megabytes", () => {
    expect(limitMb({ maxBytes: 10 * 1024 * 1024, imageTypes: [], textTypes: [] })).toBe(10);
    expect(limitMb({ maxBytes: 1.6 * 1024 * 1024, imageTypes: [], textTypes: [] })).toBe(2);
    expect(limitMb({ maxBytes: 1.4 * 1024 * 1024, imageTypes: [], textTypes: [] })).toBe(1);
  });
});

// ADR 0060: the marker grammar that lets a chip hold its place in the draft.
describe("markerFor", () => {
  it("names a photo and a file the way Claude Code does", () => {
    expect(markerFor({ n: 1, kind: "image" })).toBe("[Image #1]");
    expect(markerFor({ n: 12, kind: "file" })).toBe("[File #12]");
  });
});

describe("attachmentKind", () => {
  const limits = uploadLimits({ maxBytes: 1, imageTypes: ["png"], textTypes: ["md"] });
  it("takes the browser's image type, and an image extension with no type", () => {
    expect(attachmentKind(new File(["x"], "shot", { type: "image/heic" }), limits)).toBe("image");
    expect(attachmentKind(new File(["x"], "shot.png"), limits)).toBe("image");
    expect(attachmentKind(new File(["x"], "notes.md", { type: "text/markdown" }), limits)).toBe("file");
  });
});

describe("insertMarker", () => {
  it("pads the marker so it never welds to a word, and puts the caret after it", () => {
    expect(insertMarker("see this", 3, "[Image #1]")).toEqual({ text: "see [Image #1] this", caret: 15 });
    expect(insertMarker("hello", 5, "[Image #1]")).toEqual({ text: "hello [Image #1] ", caret: 17 });
    expect(insertMarker("", null, "[File #1]")).toEqual({ text: "[File #1] ", caret: 10 });
  });

  it("goes to the end with no caret, and clamps a stale one", () => {
    expect(insertMarker("ab ", null, "[Image #2]").text).toBe("ab [Image #2] ");
    expect(insertMarker("ab", 99, "[Image #2]").text).toBe("ab [Image #2] ");
  });
});

describe("removeMarker", () => {
  it("takes the marker out with the space after it, else the one before it", () => {
    expect(removeMarker("see [Image #1] this", "[Image #1]")).toBe("see this");
    expect(removeMarker("see [Image #1]", "[Image #1]")).toBe("see");
    expect(removeMarker("[Image #1] [Image #2] ", "[Image #2]")).toBe("[Image #1] ");
  });

  it("leaves other numbers alone", () => {
    expect(removeMarker("[Image #1] [Image #11] ", "[Image #1]")).toBe("[Image #11] ");
  });
});

describe("composeLine", () => {
  const a = { n: 1, path: "/a.png", kind: "image" as const };
  const b = { n: 2, path: "/b.png", kind: "image" as const };

  it("swaps each marker for its path where it stands", () => {
    expect(composeLine("look at [Image #1] and [Image #2]", [a, b])).toBe("look at /a.png and /b.png");
  });

  it("puts a chip whose marker is gone in front, in chip order", () => {
    expect(composeLine("hello", [a, b])).toBe("/a.png /b.png hello");
    expect(composeLine("see [Image #2]", [a, b])).toBe("/a.png see /b.png");
    expect(composeLine("", [a])).toBe("/a.png");
  });

  it("leaves a marker with no chip behind it as typed", () => {
    expect(composeLine("[Image #7] and [File #1]", [a])).toBe("/a.png [Image #7] and [File #1]");
    expect(composeLine("[Image #7] stays", [])).toBe("[Image #7] stays");
  });
});

describe("markerMissing", () => {
  const a = { n: 1, kind: "image" as const };

  it("is false while the marker stands anywhere in the text", () => {
    expect(markerMissing("see [Image #1] here", a)).toBe(false);
  });

  it("is true once the marker is edited away, and for a different number or kind", () => {
    expect(markerMissing("see here", a)).toBe(true);
    expect(markerMissing("see [Image #1", a)).toBe(true);
    expect(markerMissing("[Image #11]", { n: 2, kind: "image" })).toBe(true);
    expect(markerMissing("[File #1]", a)).toBe(true);
  });

  it("agrees with composeLine on which chips go in front", () => {
    const chips = [
      { n: 1, path: "/a.png", kind: "image" as const },
      { n: 2, path: "/b.md", kind: "file" as const },
    ];
    const text = "read [File #2]";
    const inFront = chips.filter((chip) => markerMissing(text, chip)).map((chip) => chip.path);
    expect(inFront).toEqual(["/a.png"]);
    expect(composeLine(text, chips).startsWith(`${inFront.join(" ")} `)).toBe(true);
  });
});

describe("shortName", () => {
  it("cuts a long name to fit a chip and keeps a short one whole", () => {
    expect(shortName("screenshot-2026-09-22.png")).toBe("screenshot-20…");
    expect(shortName("screenshot-2026-09-22.png")).toHaveLength(14);
    expect(shortName("a.png")).toBe("a.png");
  });
});
