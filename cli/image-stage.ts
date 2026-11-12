import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { readPostedImage } from "../bridge/hill/media.ts";
import type { HillImageInput } from "../web/src/lib/hill/wire.ts";
import type { Environment } from "./context.ts";

// Staging a picture for the bridge. A picture is named to the bridge by an absolute PATH: the walky
// socket's request line is capped at 64 KiB, so the bytes cannot ride in it. The bridge reads the file
// itself. But the bridge runs as a systemd user unit with `PrivateTmp=yes`, so it has its own `/tmp` and
// `/var/tmp`, and a picture an agent saved there (a screenshot, very often) is a file the bridge cannot
// see. The CLI therefore COPIES such a picture, after the bridge's own checks, into a private folder
// under the user's cache folder, sends that path, and removes the folder when the command is done.
//
//   <XDG_CACHE_HOME or ~/.cache>/collie/image-staging/stage-XXXXXX/<index>.<png|jpg|webp>
//   folders 0700, files 0600
//
// The cache folder is not one the bridge denies (its state and config folders are). A picture anywhere
// else is sent as it is. Nothing here knows which verb or which multiplexer it serves.

/** The folders a bridge under `PrivateTmp` does not share with its user's own processes. */
const PRIVATE_TMP_FOLDERS = ["/tmp/", "/var/tmp/"] as const;

/** The name every staging folder starts with; pruning touches only direct children of this shape. */
const STAGE_FOLDER_RE = /^stage-[A-Za-z0-9]{6}$/u;

/** A staging folder older than this is a crashed command's leftover. */
export const STAGE_MAX_AGE_MS = 60 * 60 * 1000;

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

/** What staging needs of the world: the env and home to find the cache folder, the clock, an override of the root. */
export interface ImageStageDeps {
  readonly env: Environment;
  readonly home: string;
  /** The clock for the age of a leftover folder. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** The staging root. Defaults to `<XDG_CACHE_HOME or ~/.cache>/collie/image-staging`. */
  readonly stagingRoot?: () => string;
}

/** Why staging stopped: the bridge's own wording for a refused picture, or a failed copy with no code. */
export interface ImageStageRefusal {
  readonly ok: false;
  readonly error: string;
  readonly code: "bad_image" | "image_too_large" | null;
}

export interface StagedImages {
  readonly ok: true;
  /** What to send the bridge: the staged path for a picture under /tmp, the given path for the rest. Captions are kept. */
  readonly images: readonly HillImageInput[];
  /** Remove the staging folder. Safe to call twice; call it when the socket op is over, whatever it came to. */
  readonly cleanup: () => void;
  /** Put the original path back in a sentence that names a staged one, so a refusal names the file the agent gave. */
  readonly unstage: (text: string) => string;
}

/** The folder staging copies into: `$XDG_CACHE_HOME` when it is absolute, else `~/.cache`, then `collie/image-staging`. */
export function imageStagingRoot(deps: Pick<ImageStageDeps, "env" | "home">): string {
  const xdg = deps.env.XDG_CACHE_HOME;
  const cache = xdg !== undefined && isAbsolute(xdg) ? xdg : join(deps.home, ".cache");
  return join(cache, "collie", "image-staging");
}

/** Whether the bridge's private /tmp hides this (already resolved) path. */
export function underPrivateTmp(path: string): boolean {
  return PRIVATE_TMP_FOLDERS.some((folder) => path.startsWith(folder));
}

/**
 * Remove the staging folders older than {@link STAGE_MAX_AGE_MS}. Only direct children whose name matches
 * the folder shape are touched, and each is `lstat`ed first: a symlink or a plain file of that name is left
 * alone, and no link is followed. Best effort: a folder that cannot be removed is left for the next run.
 */
export function pruneImageStaging(root: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!STAGE_FOLDER_RE.test(name)) continue;
    const path = join(root, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || now - st.mtimeMs <= STAGE_MAX_AGE_MS) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

function refusal(code: ImageStageRefusal["code"], error: string): ImageStageRefusal {
  return { ok: false, code, error };
}

const NOOP = (): void => undefined;

/**
 * Stage the pictures a command names, as the file header says. `images` hold paths already resolved by
 * `imagePathOf` (absolute, every folder on the way real). A picture under /tmp or /var/tmp is read with the
 * bridge's own checks (`readPostedImage` with no denied folder, so its size cap and its type check hold), and written into one
 * fresh private folder; its refusal comes back with the bridge's wording, which already names the path. Any
 * other picture is passed through. When nothing needs staging, no folder is made and `cleanup` does nothing.
 */
export function stageImagesForBridge(deps: ImageStageDeps, images: readonly HillImageInput[]): StagedImages | ImageStageRefusal {
  const plain: StagedImages = { ok: true, images, cleanup: NOOP, unstage: (text) => text };
  if (!images.some((image) => underPrivateTmp(image.path))) return plain;
  const root = (deps.stagingRoot ?? (() => imageStagingRoot(deps)))();
  let folder: string;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    pruneImageStaging(root, (deps.now ?? Date.now)());
    folder = realpathSync(mkdtempSync(join(root, "stage-")));
    chmodSync(folder, 0o700);
  } catch (err) {
    return refusal(null, `could not copy the picture for the bridge: ${err instanceof Error ? err.message : String(err)}`);
  }
  const cleanup = (): void => rmSync(folder, { recursive: true, force: true });
  const swaps = new Map<string, string>();
  const out: HillImageInput[] = [];
  for (const [index, image] of images.entries()) {
    if (!underPrivateTmp(image.path)) {
      out.push(image);
      continue;
    }
    const read = readPostedImage(image.path, []);
    if (!read.ok) {
      cleanup();
      return refusal(read.code, read.error);
    }
    const target = join(folder, `${String(index)}.${EXTENSIONS[read.mime]}`);
    try {
      writeFileSync(target, read.bytes, { mode: 0o600, flag: "wx" });
      chmodSync(target, 0o600);
    } catch (err) {
      cleanup();
      return refusal(null, `${image.path}: could not copy it for the bridge: ${err instanceof Error ? err.message : String(err)}`);
    }
    swaps.set(target, image.path);
    out.push(image.caption === undefined ? { path: target } : { path: target, caption: image.caption });
  }
  const unstage = (text: string): string => [...swaps].reduce((acc, [staged, original]) => acc.replaceAll(staged, original), text);
  return { ok: true, images: out, cleanup, unstage };
}
