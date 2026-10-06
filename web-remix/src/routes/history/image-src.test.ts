import { describe, expect, test } from "bun:test";

import { imagePath } from "./image-src";

const HASH = "a".repeat(64);

describe("imagePath", () => {
  test("a blob path of this collie loads", () => {
    expect(imagePath(`/api/blobs/${HASH}`)).toBe(`/api/blobs/${HASH}`);
  });
  test("a blob on another machine carries its host", () => {
    expect(imagePath(`/api/blobs/${HASH}`, { host: "cellar" })).toBe(`/api/blobs/${HASH}?host=cellar`);
  });
  test("inline image bytes load", () => {
    expect(imagePath("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });
  test("a remote URL never does", () => {
    expect(imagePath("https://example.com/x.png")).toBeNull();
    expect(imagePath("/api/blobs/short")).toBeNull();
  });
});
