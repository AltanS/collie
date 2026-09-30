import { describe, expect, it } from "vitest";

import {
  alignImagesFromEnd,
  blankPlaceholders,
  hasImagePlaceholder,
  imageClusters,
  IMAGE_PLACEHOLDER,
  isPlaceholderOnlyLine,
  newestTurnImage,
  transcriptImages,
  turnImageCard,
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

// #292: pi draws by direct placement, which leaves no placeholder on the grid, so the mirror shows
// the newest turn's picture from the journal instead. These pin which picture that is, and that it
// never doubles a picture a placeholder cluster already shows.
describe("the newest turn's picture", () => {
  const entry = (uuid: string, role: TranscriptEntry["role"], parts: TranscriptEntry["parts"]): TranscriptEntry => ({
    uuid,
    ts: "",
    role,
    parts,
  });
  const prompt = (uuid: string) => entry(uuid, "user", [{ kind: "text", text: "Read ./dot.png and reply OK" }]);
  // The shape pi 0.87.1 writes, read live on 2026-09-26: the picture is the read tool's result, in
  // the entry BEFORE the reply, not in the reply itself.
  const read = (uuid: string, url: string) =>
    entry(uuid, "assistant", [
      { kind: "tool", name: "read", summary: "./dot.png", result: { text: "Read image file [image/png]", imageUrl: url } },
    ]);
  const reply = (uuid: string) => entry(uuid, "assistant", [{ kind: "text", text: "OK" }]);

  it("takes the picture a tool returned earlier in the turn, behind the reply", () => {
    expect(newestTurnImage([prompt("u1"), read("a1", "/api/blobs/a"), reply("a2")])).toBe("/api/blobs/a");
  });

  it("takes the NEWEST picture when the turn holds several", () => {
    const entries = [
      prompt("u1"),
      read("a1", "/api/blobs/a"),
      entry("a2", "assistant", [
        { kind: "image", url: "/api/blobs/b" },
        { kind: "image", url: "/api/blobs/c" },
      ]),
      reply("a3"),
    ];
    expect(newestTurnImage(entries)).toBe("/api/blobs/c");
  });

  it("stops at the operator's last prompt: an older turn's picture stays in History", () => {
    expect(newestTurnImage([prompt("u1"), read("a1", "/api/blobs/a"), reply("a2"), prompt("u2"), reply("a3")])).toBeNull();
  });

  it("does not take the operator's own attachment, which no agent drew", () => {
    const attached = entry("u1", "user", [{ kind: "image", url: "/api/blobs/a" }]);
    expect(newestTurnImage([attached, reply("a1")])).toBeNull();
  });

  it("walks past a rewound turn, and a rewound PROMPT does not stop the walk", () => {
    // pi keeps every branch in one log, and it is the harness this function exists for (#292). So the
    // newest rows can belong to a path the agent left. An abandoned prompt must not end the walk
    // either, or the picture of the turn that IS current would be missed.
    const entries = [
      prompt("u1"),
      read("a1", "/api/blobs/a"),
      { ...prompt("u2"), abandoned: true as const },
      { ...read("a2", "/api/blobs/b"), abandoned: true as const },
    ];
    expect(newestTurnImage(entries)).toBe("/api/blobs/a");
  });

  it("answers null for a page with no picture, and for no page at all", () => {
    expect(newestTurnImage([prompt("u1"), reply("a1")])).toBeNull();
    expect(newestTurnImage([])).toBeNull();
  });

  it("shows the card when no placeholder cluster is on screen", () => {
    expect(turnImageCard("/api/blobs/a", 0, ["/api/blobs/a"])).toBe("/api/blobs/a");
  });

  it("stands down when a placeholder cluster already shows the same picture", () => {
    // Clusters take the newest pictures from the end, so the last cluster holds this one.
    expect(turnImageCard("/api/blobs/b", 1, ["/api/blobs/a", "/api/blobs/b"])).toBeNull();
  });

  it("still shows when the clusters on screen hold other pictures", () => {
    expect(turnImageCard("/api/blobs/c", 1, ["/api/blobs/a", "/api/blobs/b"])).toBe("/api/blobs/c");
  });

  it("answers null when the turn has no picture", () => {
    expect(turnImageCard(null, 0, [])).toBeNull();
  });
});
