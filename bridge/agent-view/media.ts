// Morph's pictures: up to four per screen, read by the bridge from absolute paths an agent names
// (`collie morph show --image <path>`), kept under the bridge's own names, served back to the phone.
//
//   <stateDir>/morph/media/<set id>/<media id>      folder 0700, file 0600
//
// THE HILL'S PARTS, MORPH'S CAPS. The reading and the keeping are the hill's (bridge/hill/media.ts): the
// path checks, the no-symlink open, the leading-bytes type and the all-or-nothing save run through a
// SECOND instance of `HillMediaStore`, rooted at Morph's own folder, so a fix there reaches Morph too.
// Morph does not lean on those functions for its limits. It holds its own, here, before and after the
// read: at most {@link VIEW_MEDIA_MAX} pictures on a screen in all, at most {@link VIEW_MEDIA_BYTES_MAX}
// each by the bytes actually read (the file's size is asked first, and the read is measured after), at
// most {@link VIEW_SET_BYTES_MAX} for the screen's whole set, and PNG, JPEG or WebP by the sniffed bytes
// alone. A refused picture refuses the whole command, and nothing is written.
//
// A SET IS IMMUTABLE. Every command that changes a screen's pictures mints a fresh set id (the hill's
// decision id shape, so the hill's store takes it as an owner) and writes the whole set under it: the
// pictures held are read back from the old folder, checked again, and written beside the new ones. The
// old folder goes when the store prunes the sets no held view names. So a failed write never leaves a
// screen pointing at half a set.

import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { JsonValue } from "../json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import type { ViewRefusalCode } from "./service.ts";
import { sniffImageType } from "../files-view.ts";
import { mintMediaId, type HillMediaFile, type HillMediaStore } from "../hill/media.ts";
import { mintDecisionId } from "../hill/service.ts";
import { HILL_MEDIA_MIMES, type HillMediaMime } from "../../web/src/lib/hill/wire.ts";
import { cleanViewLine, VIEW_CAPTION_MAX, VIEW_MEDIA_BYTES_MAX, VIEW_MEDIA_MAX, VIEW_SET_BYTES_MAX, type ViewMedia } from "../../web/src/lib/agent-view/wire.ts";

/** What Morph needs of the hill's media store. */
export type ViewMediaKeep = Pick<HillMediaStore, "read" | "save" | "bytesOf" | "remove" | "prune">;

/** One picture a command names: an absolute path on this machine, and its caption. */
export interface ViewImageInput {
  readonly path: string;
  readonly caption: string | null;
}

/** The pictures a screen holds now: its set id and the pictures in it. */
export interface ViewPictureSet {
  readonly set: string;
  readonly media: readonly ViewMedia[];
}

/** Why a picture was refused. `unsaved` is the write, not the picture. */
export type ViewPictureCode = "bad_image" | "too_many_images" | "image_too_large" | "unsaved";

export type ViewPicturesAnswer = { readonly ok: true; readonly pictures: ViewPictureSet } | { readonly ok: false; readonly code: ViewPictureCode; readonly error: string };

/** How a set id and a media id are minted; a test pins them. */
export interface ViewMinters {
  readonly set: () => string;
  readonly media: () => string;
}

export const VIEW_MINTERS: ViewMinters = { set: () => mintDecisionId(), media: () => mintMediaId() };

/** Morph's picture caps, as one value so a test can hold the set cap lower than four full pictures reach. */
export interface ViewPictureLimits {
  readonly count: number;
  readonly bytes: number;
  readonly setBytes: number;
}

export const VIEW_PICTURE_LIMITS: ViewPictureLimits = { count: VIEW_MEDIA_MAX, bytes: VIEW_MEDIA_BYTES_MAX, setBytes: VIEW_SET_BYTES_MAX };

const MB = 1024 * 1024;

/** The sentences, in the hill's words where the hill has one. */
export const VIEW_TOO_MANY_IMAGES = `a screen holds at most ${String(VIEW_MEDIA_MAX)} pictures in all, a show's and every later block's together`;
export const VIEW_IMAGE_TOO_LARGE = `a picture is at most ${String(VIEW_MEDIA_BYTES_MAX / MB)} MB`;
export const VIEW_SET_TOO_LARGE = `the pictures of one screen are at most ${String(VIEW_SET_BYTES_MAX / MB)} MB together`;
export const VIEW_BAD_CAPTION = `a picture's caption is one line of 1 to ${String(VIEW_CAPTION_MAX)} characters`;
export const VIEW_NOT_AN_IMAGE = "is not a PNG, JPEG or WebP image (read from its first bytes, not its name)";
export const VIEW_PICTURE_GONE = "a picture of this screen is no longer on disk; draw the screen again with `morph show`";
export const VIEW_NO_PICTURES = "this bridge keeps no pictures";

type ViewPictureRefusal = Extract<ViewPicturesAnswer, { readonly ok: false }>;

function refused(code: ViewPictureCode, error: string): ViewPictureRefusal {
  return { ok: false, code, error };
}

/** The picture types Morph keeps, by the bytes alone. */
function viewMime(bytes: Uint8Array): HillMediaMime | null {
  const type = sniffImageType(bytes);
  return HILL_MEDIA_MIMES.find((mime) => mime === type) ?? null;
}

/** Morph's own check before the read: the size the file says it has. A file that cannot be asked is left to the read, which refuses it with the reason. */
function tooLargeOnDisk(path: string, max: number): boolean {
  if (!isAbsolute(path)) return false;
  try {
    return lstatSync(path).size > max;
  } catch {
    return false;
  }
}

interface ReadPicture {
  readonly file: HillMediaFile;
  readonly media: ViewMedia;
}

function pictureOf({ id, bytes, mime, width, height, caption }: { id: string; bytes: Uint8Array; mime: HillMediaMime; width: number | null; height: number | null; caption: string | null }): ReadPicture {
  const media: ViewMedia = caption === null ? { id, kind: "image", mime, bytes: bytes.length, width, height } : { id, kind: "image", mime, bytes: bytes.length, width, height, caption };
  return { file: { id, bytes }, media };
}

/** Read one named picture: Morph's checks before, the hill's read, Morph's checks after. */
function readOne(keep: ViewMediaKeep, input: ViewImageInput, { id, max }: { id: string; max: number }): ReadPicture | ViewPictureRefusal {
  if (tooLargeOnDisk(input.path, max)) return refused("image_too_large", `${input.path}: ${VIEW_IMAGE_TOO_LARGE}`);
  const read = keep.read(input.path);
  if (!read.ok) return refused(read.code, read.error);
  if (read.bytes.length > max) return refused("image_too_large", `${input.path}: ${VIEW_IMAGE_TOO_LARGE}`);
  const mime = viewMime(read.bytes);
  if (mime === null || mime !== read.mime) return refused("bad_image", `${input.path}: ${VIEW_NOT_AN_IMAGE}`);
  return pictureOf({ id, bytes: read.bytes, mime, width: read.width, height: read.height, caption: input.caption });
}

/** Read one held picture back from its set's folder, checked again as a new one is. */
function readHeld(keep: ViewMediaKeep, { held, media, id, max }: { held: ViewPictureSet; media: ViewMedia; id: string; max: number }): ReadPicture | ViewPictureRefusal {
  const bytes = keep.bytesOf(held.set, media);
  if (bytes === null || bytes.length > max || viewMime(bytes) !== media.mime) return refused("bad_image", VIEW_PICTURE_GONE);
  return pictureOf({ id, bytes, mime: media.mime, width: media.width, height: media.height, caption: media.caption ?? null });
}

function isAnswer(value: ReadPicture | ViewPictureRefusal): value is ViewPictureRefusal {
  return "ok" in value;
}

/** The caption as kept: one clean line, or none; or the refusal. */
function captionOf(input: ViewImageInput): { readonly ok: true; readonly caption: string | null } | ViewPictureRefusal {
  if (input.caption === null) return { ok: true, caption: null };
  const line = cleanViewLine(input.caption, VIEW_CAPTION_MAX);
  return line === null ? refused("bad_image", `${input.path}: ${VIEW_BAD_CAPTION}`) : { ok: true, caption: line };
}

/**
 * A new picture set: the pictures `held` already holds, then the `added` ones, each read and checked by
 * the rules in this file's header, written whole under a fresh set id. On any refusal nothing is
 * written. The caller stores the set on the screen, and removes it again when that store fails.
 */
export function keepPictures({
  keep,
  mint,
  held,
  added,
  limits = VIEW_PICTURE_LIMITS,
}: {
  keep: ViewMediaKeep | undefined;
  mint: ViewMinters;
  held: ViewPictureSet | null;
  added: readonly ViewImageInput[];
  limits?: ViewPictureLimits;
}): ViewPicturesAnswer {
  if (keep === undefined) return refused("bad_image", VIEW_NO_PICTURES);
  const heldMedia = held?.media ?? [];
  if (heldMedia.length + added.length > limits.count) return refused("too_many_images", VIEW_TOO_MANY_IMAGES);
  const captions: Array<string | null> = [];
  for (const input of added) {
    const caption = captionOf(input);
    if (!caption.ok) return caption;
    captions.push(caption.caption);
  }
  const pictures: ReadPicture[] = [];
  for (const media of heldMedia) {
    const read = held === null ? refused("bad_image", VIEW_PICTURE_GONE) : readHeld(keep, { held, media, id: mint.media(), max: limits.bytes });
    if (isAnswer(read)) return read;
    pictures.push(read);
  }
  for (const [i, input] of added.entries()) {
    const read = readOne(keep, { path: input.path, caption: captions[i] ?? null }, { id: mint.media(), max: limits.bytes });
    if (isAnswer(read)) return read;
    pictures.push(read);
  }
  const total = pictures.reduce((sum, picture) => sum + picture.file.bytes.length, 0);
  if (total > limits.setBytes) return refused("image_too_large", VIEW_SET_TOO_LARGE);
  const set = mint.set();
  if (!keep.save(set, pictures.map((picture) => picture.file))) return refused("unsaved", "the bridge could not keep the pictures; nothing changed");
  return { ok: true, pictures: { set, media: pictures.map((picture) => picture.media) } };
}

// ── the socket's fields ──────────────────────────────────────────────────────────────────────────

/** A field the socket could not read, with the code its refusal carries. */
export interface ViewFieldError {
  readonly error: string;
  readonly code: ViewRefusalCode;
}

/** The pictures a request names: `[{ path, caption? }]`, absent or null for none. The bridge reads the files. */
export function readImageFields(raw: JsonValue | undefined): readonly ViewImageInput[] | ViewFieldError {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'pictures are a list of { "path", "caption"? }', code: "bad_image" };
  if (raw.length > VIEW_MEDIA_MAX) return { error: VIEW_TOO_MANY_IMAGES, code: "too_many_images" };
  const out: ViewImageInput[] = [];
  for (const item of raw) {
    const row = asJsonObject(item);
    const path = asJsonString(row?.path);
    const caption = row?.caption === undefined || row.caption === null ? null : asJsonString(row.caption);
    if (path === undefined || caption === undefined) return { error: 'a picture is { "path": "<absolute path>", "caption"?: "<text>" }', code: "bad_image" };
    out.push({ path, caption });
  }
  return out;
}

