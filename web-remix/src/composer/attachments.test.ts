/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";

import { insertMarker, removeMarker } from "@web/lib/attachments";
import { t } from "@web/lib/i18n";
import type { BridgeConfig, UploadCapability, UploadResponse } from "@web/lib/types";

import { clearStatus, status } from "../lib/status";
import {
  PHOTO_ACCEPT,
  createAttachments,
  fileAccept,
  isMarkerMissing,
  offersFiles,
  type AttachmentOptions,
} from "./attachments";

afterEach(clearStatus);

const LIMITS: UploadCapability = { maxBytes: 1000, imageTypes: ["png", "jpg"], textTypes: ["md", "txt"] };
const png = (name = "shot.png", bytes = 10) => new File([new Uint8Array(bytes)], name, { type: "image/png" });
const md = (name = "notes.md") => new File(["# hi"], name, { type: "text/markdown" });

/** An uploader that answers from a queue of results, in call order, and remembers what it was asked. */
function rig(results: Array<UploadResponse | Error> = [], over: Partial<AttachmentOptions> = {}) {
  const calls: Array<{ paneId: string; name: string; scope: unknown }> = [];
  const revoked: string[] = [];
  let urls = 0;
  const queue = [...results];
  const attachments = createAttachments("%7", undefined, {
    uploader: async (paneId, file, scope) => {
      calls.push({ paneId, name: file.name, scope });
      const next = queue.shift() ?? { ok: true as const, path: `/up/${file.name}` };
      if (next instanceof Error) throw next;
      return next;
    },
    limits: () => LIMITS,
    refusal: () => undefined,
    preview: { create: () => `blob:${urls++}`, revoke: (url) => revoked.push(url) },
    ...over,
  });
  const markers: string[] = [];
  const insert = (marker: string): void => {
    markers.push(marker);
  };
  return { attachments, calls, revoked, markers, insert };
}

describe("marker numbering", () => {
  test("numbers in pick order, by kind, and inserts each marker once its upload lands", async () => {
    const r = rig();
    await r.attachments.add([png("a.png"), md(), png("b.png")], r.insert);
    expect(r.markers).toEqual(["[Image #1]", "[File #2]", "[Image #3]"]);
    expect(r.calls.map((c) => c.name)).toEqual(["a.png", "notes.md", "b.png"]);
    expect(r.attachments.list.get().map((a) => [a.marker, a.state, a.path])).toEqual([
      ["[Image #1]", "ready", "/up/a.png"],
      ["[File #2]", "ready", "/up/notes.md"],
      ["[Image #3]", "ready", "/up/b.png"],
    ]);
    expect(r.calls[0]?.paneId).toBe("%7");
  });

  test("a removed chip's number is never reused; clear() restarts at 1", async () => {
    const r = rig();
    await r.attachments.add([png("a.png"), png("b.png")], r.insert);
    const first = r.attachments.list.get()[0];
    expect(first).toBeDefined();
    r.attachments.remove(first?.id ?? "", () => {});
    await r.attachments.add([png("c.png")], r.insert);
    expect(r.markers.at(-1)).toBe("[Image #3]");
    r.attachments.clear();
    expect(r.attachments.list.get()).toEqual([]);
    await r.attachments.add([png("d.png")], r.insert);
    expect(r.markers.at(-1)).toBe("[Image #1]");
  });

  test("a failed upload leaves no chip and gives its number back", async () => {
    const r = rig([{ ok: false, error: "disk full" }]);
    await r.attachments.add([png("a.png")], r.insert);
    expect(r.attachments.list.get()).toEqual([]);
    expect(r.markers).toEqual([]);
    expect(status.get()).toMatchObject({ text: "disk full", tone: "error" });
    await r.attachments.add([png("b.png")], r.insert);
    expect(r.markers).toEqual(["[Image #1]"]);
    expect(status.get()).toMatchObject({ text: t("composer.upload.success"), tone: "success" });
  });

  test("a thrown transport error is a status line, not a rejection", async () => {
    const r = rig([new Error("network down")]);
    await r.attachments.add([png()], r.insert);
    expect(r.attachments.list.get()).toEqual([]);
    expect(status.get()).toMatchObject({ text: "network down", tone: "error" });
  });
});

describe("resolve: markers become paths for the send", () => {
  test("each marker is swapped where it stands", async () => {
    const r = rig();
    await r.attachments.add([png("a.png"), md()], r.insert);
    expect(r.attachments.resolve("look at [Image #1] and read [File #2] please")).toBe(
      "look at /up/a.png and read /up/notes.md please",
    );
  });

  test("a chip whose marker was edited away goes in front, in chip order", async () => {
    const r = rig();
    await r.attachments.add([png("a.png"), md()], r.insert);
    expect(r.attachments.resolve("only [File #2] here")).toBe("/up/a.png only /up/notes.md here");
    expect(r.attachments.resolve("")).toBe("/up/a.png /up/notes.md");
  });

  test("a marker-looking string with no chip behind it is left as typed", async () => {
    const r = rig();
    expect(r.attachments.resolve("[Image #9] stays")).toBe("[Image #9] stays");
  });

  test("a chip still uploading is not in the line", async () => {
    let finish: (res: UploadResponse) => void = () => {};
    const r = rig([], { uploader: () => new Promise<UploadResponse>((resolve) => (finish = resolve)) });
    const done = r.attachments.add([png("a.png")], r.insert);
    expect(r.attachments.uploading()).toBe(true);
    expect(r.attachments.list.get()[0]?.state).toBe("uploading");
    expect(r.attachments.resolve("hello")).toBe("hello");
    finish({ ok: true, path: "/up/a.png" });
    await done;
    expect(r.attachments.uploading()).toBe(false);
    expect(r.attachments.resolve("[Image #1]")).toBe("/up/a.png");
  });

  test("the markers the chips carry round-trip through the web insert and remove helpers", async () => {
    const r = rig();
    let text = "see";
    await r.attachments.add([png()], (marker) => {
      text = insertMarker(text, null, marker).text;
    });
    expect(text).toBe("see [Image #1] ");
    const chip = r.attachments.list.get()[0];
    expect(chip && isMarkerMissing(text, chip)).toBe(false);
    r.attachments.remove(chip?.id ?? "", (marker) => {
      text = removeMarker(text, marker);
    });
    expect(text).toBe("see ");
  });
});

describe("validation refusals", () => {
  test("too large is refused before any upload, with the cap in whole megabytes", async () => {
    const r = rig([], { limits: () => ({ ...LIMITS, maxBytes: 10 * 1024 * 1024 }) });
    await r.attachments.add([png("big.png", 10 * 1024 * 1024 + 1)], r.insert);
    expect(r.calls).toEqual([]);
    expect(status.get()).toMatchObject({ text: t("composer.upload.tooLarge", { max: 10 }), tone: "error" });
    expect(r.attachments.list.get()).toEqual([]);
  });

  test("a bad type is refused by name", async () => {
    const r = rig();
    await r.attachments.add([new File(["x"], "run.exe", { type: "application/octet-stream" })], r.insert);
    expect(r.calls).toEqual([]);
    expect(status.get()).toMatchObject({ text: t("composer.upload.badType", { name: "run.exe" }), tone: "error" });
  });

  test("an image with no extension is fine: the browser's own word wins", async () => {
    const r = rig();
    await r.attachments.add([new File(["x"], "image", { type: "image/jpeg" })], r.insert);
    expect(r.calls).toHaveLength(1);
  });

  test("a refused batch member does not stop the rest", async () => {
    const r = rig();
    await r.attachments.add([new File(["x"], "run.exe"), png("ok.png")], r.insert);
    expect(r.calls.map((c) => c.name)).toEqual(["ok.png"]);
    expect(r.markers).toEqual(["[Image #1]"]);
  });

  test("a read-only device is refused with its own sentence", async () => {
    const r = rig([], { refusal: () => "This device is read-only." });
    await r.attachments.add([png()], r.insert);
    expect(r.calls).toEqual([]);
    expect(status.get()).toMatchObject({ text: "This device is read-only.", tone: "error" });
  });

  test("no published upload block means the pre-attachment contract: images only", async () => {
    const r = rig([], { limits: () => undefined });
    await r.attachments.add([md()], r.insert);
    expect(r.calls).toEqual([]);
    expect(status.get()?.text).toBe(t("composer.upload.badType", { name: "notes.md" }));
  });
});

describe("chips that vanish mid-flight", () => {
  test("removing an uploading chip drops its late result: no marker, no chip", async () => {
    let finish: (res: UploadResponse) => void = () => {};
    const r = rig([], { uploader: () => new Promise<UploadResponse>((resolve) => (finish = resolve)) });
    const done = r.attachments.add([png()], r.insert);
    const removed: string[] = [];
    r.attachments.remove(r.attachments.list.get()[0]?.id ?? "", (m) => removed.push(m));
    finish({ ok: true, path: "/up/x.png" });
    await done;
    expect(r.markers).toEqual([]);
    expect(removed).toEqual([]);
    expect(r.attachments.list.get()).toEqual([]);
  });

  test("previews are revoked on remove, on clear and when the signal aborts", async () => {
    const controller = new AbortController();
    const r = rig([], { signal: controller.signal });
    await r.attachments.add([png("a.png"), png("b.png"), png("c.png")], r.insert);
    r.attachments.remove(r.attachments.list.get()[0]?.id ?? "", () => {});
    expect(r.revoked).toEqual(["blob:0"]);
    controller.abort();
    expect(r.revoked.toSorted()).toEqual(["blob:0", "blob:1", "blob:2"]);
  });

  test("an aborted route stops a batch between files", async () => {
    const controller = new AbortController();
    const r = rig([], { signal: controller.signal });
    controller.abort();
    await r.attachments.add([png()], r.insert);
    expect(r.calls).toEqual([]);
  });
});

describe("draft persistence: snapshot and restore", () => {
  test("a snapshot holds ready chips and the next number; restore brings them back as tiles", async () => {
    const r = rig();
    await r.attachments.add([png("a.png"), md()], r.insert);
    const saved = r.attachments.snapshot();
    expect(saved).toEqual({
      attachments: [
        { n: 1, path: "/up/a.png", name: "a.png", kind: "image" },
        { n: 2, path: "/up/notes.md", name: "notes.md", kind: "file" },
      ],
      next: 3,
    });
    const fresh = rig();
    fresh.attachments.restore(saved.attachments, saved.next);
    expect(fresh.attachments.list.get().map((a) => [a.marker, a.state, a.previewUrl])).toEqual([
      ["[Image #1]", "ready", undefined],
      ["[File #2]", "ready", undefined],
    ]);
    await fresh.attachments.add([png("c.png")], fresh.insert);
    expect(fresh.markers).toEqual(["[Image #3]"]);
    expect(fresh.attachments.resolve("[Image #1] [File #2] [Image #3]")).toBe("/up/a.png /up/notes.md /up/c.png");
  });
});

describe("what the picker offers", () => {
  // SAFETY: BridgeConfig has many required fields; the picker helpers read only `upload`.
  const cfg = (upload?: UploadCapability): BridgeConfig => ({ upload }) as BridgeConfig;

  test("photos are image/*, and the full list names every extension beside it", () => {
    expect(PHOTO_ACCEPT).toBe("image/*");
    expect(fileAccept(cfg(LIMITS))).toBe("image/*,.png,.jpg,.md,.txt");
  });

  test("a bridge older than the field offers four image formats and no file choice", () => {
    expect(fileAccept(cfg())).toBe("image/*,.png,.jpg,.gif,.webp");
    expect(fileAccept(undefined)).toBe("image/*,.png,.jpg,.gif,.webp");
    expect(offersFiles(cfg())).toBe(false);
    expect(offersFiles(cfg(LIMITS))).toBe(true);
  });
});
