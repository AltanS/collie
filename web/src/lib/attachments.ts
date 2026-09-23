// ── WHAT THE ATTACH BUTTON MAY OFFER — the phone's half of the upload contract ───────────────────
//
// The bridge decides what it will WRITE (`bridge/uploads.ts`). This file decides what the picker
// OFFERS and what the composer refuses before it spends an uplink. The two are not the same job and
// must not be one list: the bridge's answer is per host and settable per install
// (`COLLIE_MAX_UPLOAD_MB`, `COLLIE_UPLOAD_EXTRA_TYPES`), so the phone ASKS rather than assumes —
// `/api/config` carries `upload`, and lib/operator-config.ts holds it.
//
// The fallback below is what a bridge OLDER than that field means. It is deliberately the contract
// that shipped before attachments existed — four image formats, 10 MB — because that is exactly
// what such a bridge will accept, and offering a `.md` there would only produce a refusal the
// operator cannot act on.
//
// Nothing here is a security boundary. A file that gets past it still meets the bridge's own sniff.

import type { UploadCapability } from "@/lib/types";

/** What a bridge that publishes no `upload` block accepts. See the header. */
const LEGACY: UploadCapability = {
  maxBytes: 10 * 1024 * 1024,
  imageTypes: ["png", "jpg", "gif", "webp"],
  textTypes: [],
};

/** The capability to work from: what the bridge said, or the pre-attachment contract. */
export function uploadLimits(published: UploadCapability | null): UploadCapability {
  return published ?? LEGACY;
}

/**
 * The `accept` attribute for the file input. Pure — the whole decision, unit-tested.
 *
 * Extensions rather than MIME types, and `image/*` beside them: a phone's own camera roll answers
 * `image/*` and would be greyed out by an extension list alone, while Android's picker routinely
 * reports a `.md` as `application/octet-stream` and would be greyed out by a MIME list alone.
 * Offering both is what makes the same button work on both.
 */
export function acceptAttribute(limits: UploadCapability): string {
  const exts = [...limits.imageTypes, ...limits.textTypes].map((ext) => `.${ext}`);
  return ["image/*", ...exts].join(",");
}

/**
 * The `accept` for the PHOTOS half of the picker — `image/*`, and nothing beside it.
 *
 * A phone offers the camera roll only when it can map EVERY entry in `accept` to a gallery. The
 * extension list {@link acceptAttribute} builds is what makes a `.md` pickable, and it is also what
 * makes both Android and iOS drop the gallery and open the file browser alone. The two asks cannot
 * share one input, so they are two, and the attach button asks which one first.
 */
export const PHOTO_ACCEPT = "image/*";

/**
 * Does this host take anything that is not an image?
 *
 * It decides whether the attach button ASKS at all. A bridge that publishes no text types — every
 * bridge older than the field, through {@link uploadLimits}'s fallback — has one answer to give, so
 * the button opens the camera roll directly and the operator never sees a choice with one option.
 */
export function offersFiles(limits: UploadCapability): boolean {
  return limits.textTypes.length > 0;
}

/**
 * Whether this file is worth sending — the same two questions the bridge asks, minus the byte sniff
 * it alone can do. `null` means send it; a string is the reason not to, keyed for `t()`.
 *
 * The extension check is deliberately NOT applied to a file the browser calls an image: the picker
 * offers `image/*`, so a camera roll entry with no extension at all is a legitimate pick, and the
 * bridge will read its signature bytes anyway.
 */
export function rejectAttachment(
  file: File,
  limits: UploadCapability,
): "tooLarge" | "badType" | null {
  if (file.size > limits.maxBytes) return "tooLarge";
  if (file.type.startsWith("image/")) return null;
  const ext = extensionOf(file.name);
  if (ext !== null && [...limits.imageTypes, ...limits.textTypes].includes(ext)) return null;
  return "badType";
}

/**
 * The bare lowercase extension a filename claims, or null. The web mirror of `extFromName` in
 * bridge/uploads.ts — the two trees are type-checked separately, so the rule is restated rather
 * than imported, the arrangement lib/json.ts already uses.
 */
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : null;
}

/** The cap in whole megabytes, for a sentence. Rounded the same way the bridge rounds its own. */
export function limitMb(limits: UploadCapability): number {
  return Math.round(limits.maxBytes / (1024 * 1024));
}

// ── AN ATTACHMENT IS A CHIP, AND ITS MARKER HOLDS ITS PLACE (ADR 0060) ──────────────────────────
//
// The composer used to write the bridge's host path straight into the draft. The path is the right
// thing for the TERMINAL and the wrong thing for the phone: a 70-character run of `/`-joined
// directory names that says nothing to the person holding it. So the draft now carries a short
// marker, `[Image #N]` or `[File #N]`, at the spot the attachment was added (Claude Code's own
// `[Image #1]` convention), a chip above the field shows what it is, and Send swaps each marker for
// its path. The functions below are that whole contract, pure, so the tests can pin it without a
// DOM.

/** A marker placed in a draft: the new text, and where the caret goes after it. */
export interface PlacedMarker {
  text: string;
  caret: number;
}

/** The chip as far as the marker grammar cares: its number and what it is drawn as. */
export interface MarkedAttachment {
  n: number;
  path: string;
  kind: "image" | "file";
}

/** Whether a picked file is drawn (and marked) as a photo or a file. The browser's own word wins;
 *  an extension-only image (a camera-roll entry with no MIME type) still counts as one. */
export function attachmentKind(file: File, limits: UploadCapability): "image" | "file" {
  if (file.type.startsWith("image/")) return "image";
  const ext = extensionOf(file.name);
  return ext !== null && limits.imageTypes.includes(ext) ? "image" : "file";
}

/** The marker text for a chip: `[Image #N]` or `[File #N]`. */
export function markerFor(attachment: Pick<MarkedAttachment, "n" | "kind">): string {
  return `[${attachment.kind === "image" ? "Image" : "File"} #${attachment.n}]`;
}

/**
 * Put a marker into the draft at `caret` (the end when there is none), padded so it never welds to
 * a word: a space before it unless the text there already ends in whitespace, and a space after it
 * unless the text there already starts with some. Returns the new text and where the caret goes,
 * which is past the marker and past the space that follows it.
 */
export function insertMarker(
  text: string,
  caret: number | null,
  marker: string,
): PlacedMarker {
  const at = Math.min(Math.max(caret ?? text.length, 0), text.length);
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = /^\s/.test(after) ? "" : " ";
  const inserted = `${lead}${marker}${trail}`;
  return { text: `${before}${inserted}${after}`, caret: at + inserted.length + (trail === "" ? 1 : 0) };
}

/** Take every copy of a marker out of the draft, with one space beside it (the one after, else the
 *  one before), so removing a chip does not leave a double space where its marker stood. */
export function removeMarker(text: string, marker: string): string {
  let out = text;
  for (let at = out.indexOf(marker); at !== -1; at = out.indexOf(marker, at)) {
    let start = at;
    let end = at + marker.length;
    if (out[end] === " ") end += 1;
    else if (start > 0 && out[start - 1] === " ") start -= 1;
    out = out.slice(0, start) + out.slice(end);
    at = start;
  }
  return out;
}

/**
 * Whether a chip's marker is gone from the draft, so Send will put its path in front of the text
 * rather than where the marker stood. The chip shows this before Send (ADR 0060, point 7), and
 * {@link composeLine} acts on the same answer, so the two cannot disagree.
 */
export function markerMissing(
  text: string,
  attachment: Pick<MarkedAttachment, "n" | "kind">,
): boolean {
  return !text.includes(markerFor(attachment));
}

/**
 * The line Send types into the terminal. Each marker whose number matches a chip becomes that
 * chip's path, where it stands. A chip whose marker is no longer in the text (the operator edited
 * it away) is not dropped: its path goes in front of the text, in chip order, so nothing attached
 * is lost by accident, and the chip says so before Send ({@link markerMissing}). A marker-looking
 * string with no chip behind it is left exactly as typed.
 */
export function composeLine(text: string, attachments: readonly MarkedAttachment[]): string {
  let line = text;
  const orphans: string[] = [];
  for (const attachment of attachments) {
    if (markerMissing(text, attachment)) {
      orphans.push(attachment.path);
      continue;
    }
    line = line.split(markerFor(attachment)).join(attachment.path);
  }
  const words = line.trim();
  return [...orphans, ...(words === "" ? [] : [words])].join(" ");
}

/** A file name cut to fit a chip: at most `max` characters, the cut marked with an ellipsis. */
export function shortName(name: string, max = 14): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}
