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
