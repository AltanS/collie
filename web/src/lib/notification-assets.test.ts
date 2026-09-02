import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Android renders a push notification's `badge` as the small status-bar glyph: it derives the SHAPE
// from the alpha channel and tints the result. An opaque PNG therefore lands as a solid block on the
// corner of the large icon, which is what the maskable home-screen tile (RGB, no alpha) used to do.
// So the badge's alpha channel is a contract, not a detail — assert it on the bytes.

const publicDir = resolve(import.meta.dirname, "../../public");

const PNG_MAGIC = "89504e470d0a1a0a";

/** Parse a PNG's IHDR — the first chunk, at a fixed offset — for its size and colour type. */
function ihdr(name: string) {
  const bytes = readFileSync(resolve(publicDir, name));
  expect(bytes.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes.readUInt8(25),
  };
}

describe("push notification assets", () => {
  it("ships a 96×96 badge with an alpha channel", () => {
    const { width, height, colorType } = ihdr("badge-96x96.png");
    expect([width, height]).toEqual([96, 96]);
    expect(colorType).toBe(6); // RGBA — 6 is the only colour type sw.ts's badge may have
  });

  it("ships a 192×192 notification icon", () => {
    const { width, height } = ihdr("notification-icon-192x192.png");
    expect([width, height]).toEqual([192, 192]);
  });

  it("points sw.ts at those two files and not at the maskable tile", () => {
    const sw = readFileSync(resolve(import.meta.dirname, "../sw.ts"), "utf8");
    expect(sw).toContain('const ICON = "/notification-icon-192x192.png"');
    expect(sw).toContain('const BADGE = "/badge-96x96.png"');
    expect(sw).toContain("badge: BADGE");
  });
});
