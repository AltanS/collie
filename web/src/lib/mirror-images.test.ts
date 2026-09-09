import { describe, expect, it } from "vitest";

import {
  alignImagesFromEnd,
  blankPlaceholders,
  hasImagePlaceholder,
  imageClusters,
  IMAGE_PLACEHOLDER,
  isPlaceholderOnlyLine,
  transcriptImages,
} from "./mirror-images";
import type { StyledLine } from "./blocks";
import type { TranscriptEntry } from "./types";

// The mirror's side of terminal graphics, as pure functions. The alignment is the one that carries a
// decision rather than a mechanism: there is no id-to-blob mapping to be had (mirror-images.ts's
// header says why), so the match is by order and a cluster with no image left shows a badge.

const line = (text: string): StyledLine => ({ segments: [{ text, style: {}, muted: false }] });
const P = IMAGE_PLACEHOLDER;

describe("finding the placeholders", () => {
  it("sees a placeholder cell, and does not see an ordinary line", () => {
    expect(hasImagePlaceholder(line(`${P}${P}`))).toBe(true);
    expect(hasImagePlaceholder(line("ordinary output"))).toBe(false);
  });

  it("groups consecutive placeholder lines into ONE cluster per image", () => {
    const lines = [line("before"), line(`${P}${P}`), line(`${P}${P}`), line("after")];
    expect(imageClusters(lines)).toEqual([{ start: 1, end: 2 }]);
  });

  it("keeps two images apart when an ordinary line sits between them", () => {
    const lines = [line(P), line("caption"), line(P)];
    expect(imageClusters(lines)).toEqual([
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ]);
  });

  it("tells a placeholder-only line from one that also carries text", () => {
    expect(isPlaceholderOnlyLine(line(`  ${P}${P}  `))).toBe(true);
    expect(isPlaceholderOnlyLine(line(`Screenshot: ${P}`))).toBe(false);
    expect(isPlaceholderOnlyLine(line("no image here"))).toBe(false);
  });

  it("blanks a placeholder run to spaces of EXACTLY the same length", () => {
    // Equal length is what keeps every find offset after the image pointing at the right character.
    const original = `Screenshot: ${P}̅̍ ok`;
    const blanked = blankPlaceholders(line(original));
    const text = blanked.segments.map((s) => s.text).join("");
    expect(text).toHaveLength(original.length);
    expect(text).toBe(`Screenshot: ${" ".repeat(4)} ok`);
    expect(text).not.toContain(P);
  });

  it("returns an untouched line when there is nothing to blank", () => {
    const plain = line("plain");
    expect(blankPlaceholders(plain)).toBe(plain);
  });
});

describe("aligning images to clusters, from the end", () => {
  it("gives the last cluster the most recent image", () => {
    expect(alignImagesFromEnd(2, ["/api/blobs/a", "/api/blobs/b"])).toEqual([
      "/api/blobs/a",
      "/api/blobs/b",
    ]);
  });

  it("leaves the earliest clusters unmatched rather than repeating an image", () => {
    expect(alignImagesFromEnd(3, ["/api/blobs/a"])).toEqual([null, null, "/api/blobs/a"]);
  });

  it("drops the oldest images when the journal holds more than the screen shows", () => {
    expect(alignImagesFromEnd(1, ["/api/blobs/a", "/api/blobs/b", "/api/blobs/c"])).toEqual([
      "/api/blobs/c",
    ]);
  });

  it("answers nothing for no clusters, and all badges for no images", () => {
    expect(alignImagesFromEnd(0, ["/api/blobs/a"])).toEqual([]);
    expect(alignImagesFromEnd(2, [])).toEqual([null, null]);
  });
});

describe("reading the images out of a page of turns", () => {
  const turn = (parts: TranscriptEntry["parts"]): TranscriptEntry => ({
    uuid: "u",
    ts: "",
    role: "assistant",
    parts,
  });

  it("takes an image part and a tool result's image, in the order they were written", () => {
    const entries = [
      turn([{ kind: "image", url: "/api/blobs/a" }]),
      turn([{ kind: "text", text: "looking" }]),
      turn([{ kind: "tool", name: "screenshot", summary: "", result: { text: "", imageUrl: "/api/blobs/b" } }]),
    ];
    expect(transcriptImages(entries)).toEqual(["/api/blobs/a", "/api/blobs/b"]);
  });

  it("keeps a duplicate: two identical screenshots are two images on the screen", () => {
    const entries = [
      turn([{ kind: "image", url: "/api/blobs/a" }]),
      turn([{ kind: "image", url: "/api/blobs/a" }]),
    ];
    expect(transcriptImages(entries)).toEqual(["/api/blobs/a", "/api/blobs/a"]);
  });

  it("answers empty for turns with no image anywhere", () => {
    expect(transcriptImages([turn([{ kind: "text", text: "hello" }])])).toEqual([]);
  });
});
