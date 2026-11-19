// THE PROJECT PICTURE ON THE WIRE (issue 811, ADR 0160). Shared by the bridge and the phone, so the two
// can never disagree about the shape of a version or the address of a picture.
//
// A pane's view carries `picture`: the version of the picture its project file names, the first 12
// hex of the sha256 of the bytes. The address of the picture carries that version and nothing else
// (`/api/project-picture/<version>`), so the client never names a file, a folder or a pane: the bridge
// serves only a picture it resolved itself from a `collie.toml`. A member's pane adds `?host=`, and the
// lead forwards the read to the member like a blob (CREW_PROTOCOL.md).

/** A picture's version: the first 12 hex of the sha256 of its bytes. */
export const PICTURE_VERSION_RE = /^[0-9a-f]{12}$/;

/** The largest picture a project file may name. */
export const PROJECT_PICTURE_BYTES_MAX = 256 * 1024;
/** Each side of the picture, read from its header without decoding, is in this range. */
export const PROJECT_PICTURE_SIDE_MIN = 64;
export const PROJECT_PICTURE_SIDE_MAX = 1024;

/** Whether a wire value is a picture version. Anything else reads as "no picture". */
export function isPictureVersion(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && PICTURE_VERSION_RE.test(value);
}

/** The path of one picture, under `/api`, for this bridge or for a crew member by host. */
export function projectPicturePath(version: string, host?: string | null): string {
  const base = `/api/project-picture/${version}`;
  return host === undefined || host === null || host === "" ? base : `${base}?host=${encodeURIComponent(host)}`;
}
