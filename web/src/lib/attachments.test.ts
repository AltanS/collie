import type { UploadCapability } from "@/lib/types";
import {
  acceptAttribute,
  extensionOf,
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
